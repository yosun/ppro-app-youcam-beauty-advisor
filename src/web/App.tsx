import { useEffect, useState } from "react";
import type { Manifest } from "../protocol/manifest.ts";
import { DevPanel } from "./components/DevPanel.tsx";
import { Consult } from "./Consult.tsx";
import {
  clearCredentials,
  readCredentials,
  saveCredentials,
  type Credentials,
} from "./credentials.ts";
import { useSession } from "./use-session.ts";

type Setup =
  | { state: "loading" }
  | { state: "ready"; starters: readonly string[]; standalone: boolean }
  | { state: "failed" };

function useSetup(): Setup {
  const [setup, setSetup] = useState<Setup>({ state: "loading" });
  useEffect(() => {
    let live = true;
    fetch("/.well-known/ppro-app.json")
      .then((response) =>
        response.ok ? (response.json() as Promise<Manifest>) : Promise.reject(),
      )
      .then(
        (manifest) =>
          live &&
          setSetup({
            state: "ready",
            starters: manifest.advisor.starters,
            standalone: manifest.capabilities.standalone,
          }),
      )
      .catch(() => live && setSetup({ state: "failed" }));
    return () => {
      live = false;
    };
  }, []);
  return setup;
}

function Frame({
  children,
  dev,
}: {
  children: React.ReactNode;
  dev?: React.ReactNode;
}) {
  return (
    <main className="stage" data-dev={dev ? "true" : undefined}>
      <div className="frame">{children}</div>
      {dev}
    </main>
  );
}

function Launcher({
  onStart,
  standalone,
}: {
  onStart: (credentials: Credentials) => void;
  standalone: boolean;
}) {
  const [advisor, setAdvisor] = useState("Aria");
  const [you, setYou] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/ppro/v1/demo/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          advisor_name: advisor.trim() || undefined,
          client_name: you.trim() || undefined,
        }),
      });
      if (!response.ok) throw new Error();
      const created = (await response.json()) as {
        session: { id: string };
        tokens: { agent: string; client: string };
        urls: { api: string; mcp: string | null };
      };
      onStart({
        id: created.session.id,
        token: created.tokens.client,
        dev: {
          agentToken: created.tokens.agent,
          api: created.urls.api,
          mcp: created.urls.mcp,
        },
      });
    } catch {
      setError("Could not start a consultation. Try again in a moment.");
      setBusy(false);
    }
  }

  if (!standalone)
    return (
      <div className="launcher">
        <h1>Beauty Advisor</h1>
        <p>
          This consultation is started by the page that hosts it. Open the link
          you were given.
        </p>
      </div>
    );
  return (
    <form
      className="launcher"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <h1>Beauty Advisor</h1>
      <p>
        A YouCam-powered beauty consultation, run by an AI advisor that controls
        this whole app. Start a demo, then connect an agent to be the advisor.
      </p>
      <label>
        Advisor’s name
        <input
          type="text"
          value={advisor}
          maxLength={40}
          onChange={(event) => setAdvisor(event.target.value)}
        />
      </label>
      <label>
        Your name (optional)
        <input
          type="text"
          value={you}
          maxLength={40}
          onChange={(event) => setYou(event.target.value)}
        />
      </label>
      <button type="submit" className="button" data-primary="" disabled={busy}>
        {busy ? "Starting…" : "Start a demo consultation"}
      </button>
      {error && <small role="alert">{error}</small>}
      <small>
        Demo results are labeled and simulated unless the server has a YouCam
        API key.
      </small>
    </form>
  );
}

function Session({
  credentials,
  starters,
  onRestart,
}: {
  credentials: Credentials;
  starters: readonly string[];
  onRestart: (() => void) | null;
}) {
  const handle = useSession({
    baseUrl: window.location.origin,
    sessionId: credentials.id,
    token: credentials.token,
  });
  const dev = credentials.dev ? (
    <DevPanel dev={credentials.dev} sessionId={credentials.id} />
  ) : undefined;
  return (
    <Frame dev={dev}>
      <Consult handle={handle} starters={starters} onRestart={onRestart} />
    </Frame>
  );
}

export function App() {
  const setup = useSetup();
  const [credentials, setCredentials] = useState<Credentials | null>(() =>
    readCredentials(window.location),
  );

  if (setup.state === "loading")
    return (
      <Frame>
        <div className="launcher">
          <p>Loading…</p>
        </div>
      </Frame>
    );
  if (setup.state === "failed")
    return (
      <Frame>
        <div className="launcher">
          <h1>Beauty Advisor</h1>
          <p>The server is not reachable right now.</p>
        </div>
      </Frame>
    );
  if (!credentials)
    return (
      <Frame>
        <Launcher
          standalone={setup.standalone}
          onStart={(created) => {
            saveCredentials(created);
            setCredentials(created);
          }}
        />
      </Frame>
    );
  return (
    <Session
      key={credentials.id}
      credentials={credentials}
      starters={setup.starters}
      onRestart={
        setup.standalone
          ? () => {
              clearCredentials();
              setCredentials(null);
            }
          : null
      }
    />
  );
}
