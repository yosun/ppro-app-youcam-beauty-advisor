// Where this browser's session comes from. A host launches the app with
// `/?s=<session id>#t=<client token>`. The token is in the URL *fragment*, which
// is never sent to a server or written to a log, and it is removed from the
// address bar as soon as it is read. It is kept for this tab only
// (sessionStorage) so a reload does not lose the session.

export type Credentials = {
  id: string;
  token: string;
  /** Standalone demo only: the advisor's token and how to reach the API. */
  dev?: { agentToken: string; api: string; mcp: string | null };
};

const KEY = "ppro:credentials";
const SESSION_ID = /^ses_[A-Za-z0-9]{22}$/;

/** Parses a launch URL's session id and token, or null. */
export function parseLaunch(
  href: string,
): { id: string; token: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const id = url.searchParams.get("s");
  const token = new URLSearchParams(url.hash.replace(/^#/, "")).get("t");
  return id &&
    token &&
    SESSION_ID.test(id) &&
    /^p1\.[\w-]+\.[\w-]+$/.test(token)
    ? { id, token }
    : null;
}

export function readCredentials(
  location: Pick<Location, "href" | "pathname">,
  storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage,
  history: Pick<History, "replaceState"> = window.history,
): Credentials | null {
  const launch = parseLaunch(location.href);
  if (launch) {
    storage.setItem(KEY, JSON.stringify(launch));
    // Remove the session and the token from the address bar.
    history.replaceState(null, "", location.pathname);
    return launch;
  }
  try {
    const stored = JSON.parse(
      storage.getItem(KEY) ?? "null",
    ) as Credentials | null;
    return stored &&
      SESSION_ID.test(stored.id) &&
      typeof stored.token === "string"
      ? stored
      : null;
  } catch {
    return null;
  }
}

export function saveCredentials(
  credentials: Credentials,
  storage: Pick<Storage, "setItem"> = sessionStorage,
) {
  storage.setItem(KEY, JSON.stringify(credentials));
}

export function clearCredentials(
  storage: Pick<Storage, "removeItem"> = sessionStorage,
) {
  storage.removeItem(KEY);
}
