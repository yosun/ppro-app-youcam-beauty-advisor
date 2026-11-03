import type { PproEvent } from "../protocol/types.ts";

// The conversation between this app (in an iframe) and the page that embeds
// it (a Populi Professional, or any host). It is deliberately narrow:
//
//   app -> host   { source: "ppro-app", v: 1, type, data }
//     ready    the app is up                      { sessionId, rev }
//     screen   the client's screen changed        { screen, target }
//     ended    the consultation ended             { reason }
//   host -> app   { source: "ppro-host", v: 1, type, data }
//     theme    restyle the accent color           { accent: "#RRGGBB" }
//
// What never travels this way: chat messages, photos, results, notices. They
// are private to the client, and a host that needs them reads them from the
// API with its own credentials. The code enforces that the app posts only to
// the exact origin the session was created for (never "*") and listens only
// to window.parent at that same origin.

export const BRIDGE_VERSION = 1;

export type Bridge = {
  ready(sessionId: string, rev: number): void;
  event(event: PproEvent): void;
  dispose(): void;
};

const NONE: Bridge = { ready() {}, event() {}, dispose() {} };

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Colors a host may set. Anything else is ignored. */
export function acceptTheme(data: unknown): { accent: string } | null {
  const accent = (data as { accent?: unknown } | null)?.accent;
  return typeof accent === "string" && HEX.test(accent) ? { accent } : null;
}

export function createBridge(
  hostOrigin: string | null,
  onTheme: (theme: { accent: string }) => void,
  win: Window = window,
): Bridge {
  if (!hostOrigin || win.parent === win) return NONE;
  const post = (type: string, data: unknown) =>
    win.parent.postMessage(
      { source: "ppro-app", v: BRIDGE_VERSION, type, data },
      hostOrigin,
    );
  const listener = (message: MessageEvent) => {
    if (message.source !== win.parent || message.origin !== hostOrigin) return;
    const body = message.data as {
      source?: unknown;
      v?: unknown;
      type?: unknown;
      data?: unknown;
    } | null;
    if (!body || body.source !== "ppro-host" || body.v !== BRIDGE_VERSION)
      return;
    if (body.type === "theme") {
      const theme = acceptTheme(body.data);
      if (theme) onTheme(theme);
    }
  };
  win.addEventListener("message", listener);
  return {
    ready: (sessionId, rev) => post("ready", { sessionId, rev }),
    event: (event) => {
      if (event.type === "ui.changed")
        post("screen", {
          screen: event.data.ui.screen,
          target: event.data.ui.target,
        });
      else if (event.type === "session.ended")
        post("ended", { reason: event.data.reason });
    },
    dispose: () => win.removeEventListener("message", listener),
  };
}
