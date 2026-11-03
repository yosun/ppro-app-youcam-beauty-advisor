import { useState } from "react";
import { Check, Copy, PlugZap } from "lucide-react";
import type { Credentials } from "../credentials.ts";

// Standalone demo only: how to be this session's advisor from outside the
// browser. The advisor's token appears masked; the copy buttons carry the full
// value. A real host never shows this: it keeps the advisor's token on its
// server and gives the browser only the client's link.

type Dev = NonNullable<Credentials["dev"]>;

function Block({
  title,
  text,
  shown,
}: {
  title: string;
  text: string;
  shown: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <h3>{title}</h3>
      <pre>{shown}</pre>
      <button
        type="button"
        className="dev-copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard access can be refused; the masked text stays visible.
          }
        }}
      >
        {copied ? (
          <Check size={12} aria-hidden="true" />
        ) : (
          <Copy size={12} aria-hidden="true" />
        )}{" "}
        {copied ? "Copied" : "Copy"}
      </button>
    </>
  );
}

export function DevPanel({ dev, sessionId }: { dev: Dev; sessionId: string }) {
  const token = dev.agentToken;
  const masked = `${token.slice(0, 8)}…${token.slice(-4)}`;
  const api = dev.api.replace(/\/ppro\/v1$/, "");
  const both = (value: string) => ({
    text: value.replaceAll("«token»", token),
    shown: value.replaceAll("«token»", masked),
  });
  const run = both(
    `PPRO_URL=${api} PPRO_AGENT_TOKEN=«token» npm run agent:demo`,
  );
  const curl = both(
    `curl -s ${api}/ppro/v1/sessions/current \\\n  -H "Authorization: Bearer «token»"`,
  );
  const tool = both(
    `curl -s -X POST ${api}/ppro/v1/sessions/current/tools/ui_request_photo \\\n  -H "Authorization: Bearer «token»" -H "Content-Type: application/json" -d '{}'`,
  );
  const mcp = dev.mcp
    ? both(
        `claude mcp add --transport http beauty-advisor ${dev.mcp} \\\n  --header "Authorization: Bearer «token»"`,
      )
    : null;
  return (
    <aside className="dev" aria-label="Connect an agent">
      <h2>
        <PlugZap
          size={16}
          aria-hidden="true"
          style={{ verticalAlign: "-2px" }}
        />{" "}
        Be the advisor
      </h2>
      <p>
        You are the client in the phone. Connect any agent to session{" "}
        <code>{sessionId.slice(0, 12)}…</code> and it can run this whole app
        through the PPRO App API. The advisor token is a secret: this panel only
        exists in standalone demo mode.
      </p>
      <Block title="Run the scripted advisor" {...run} />
      <Block title="Read the session" {...curl} />
      <Block title="Make the app ask for a selfie" {...tool} />
      {mcp && <Block title="Attach over MCP" {...mcp} />}
      <p>
        Docs: <code>docs/AGENT-GUIDE.md</code> · API:{" "}
        <code>docs/PPRO-APP-API.md</code>
      </p>
    </aside>
  );
}
