import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";

// Serves the built web app (dist/web). It is a single-page app: any path that
// is not a file falls back to index.html. Files are read only from inside the
// web root, and API paths are never answered with HTML.

const here = dirname(fileURLToPath(import.meta.url));
// Compiled, this file is dist/server/static.js and the app is dist/web. Run
// from source (tsx), it is src/server/static.ts and the built app is dist/web
// at the repository root. src/web holds the *source* index.html, which must
// never be served.
const fromSource = basename(dirname(here)) === "src";
const ROOTS = [
  fromSource ? join(here, "..", "..", "dist", "web") : join(here, "..", "web"),
];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

let rootCache: string | null | undefined;

async function webRoot(): Promise<string | null> {
  if (rootCache !== undefined) return rootCache;
  for (const candidate of ROOTS) {
    try {
      if ((await stat(join(candidate, "index.html"))).isFile()) {
        rootCache = candidate;
        return candidate;
      }
    } catch {
      // Try the next location.
    }
  }
  rootCache = null;
  return null;
}

/** Forgets the located web root. For tests that build the app in place. */
export function resetWebRoot() {
  rootCache = undefined;
}

async function readIfFile(path: string) {
  try {
    if ((await stat(path)).isFile()) return await readFile(path);
  } catch {
    // Not there.
  }
  return null;
}

export async function serveWeb(c: Context) {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    // A malformed escape such as "%E0%A4%A" is the caller's mistake, not ours.
    return c.text("Bad request", 400);
  }
  if (pathname.startsWith("/ppro/") || pathname === "/mcp")
    return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
  const root = await webRoot();
  if (!root)
    return c.text(
      "The web app is not built. Run `npm run build`, or `npm run dev` for development.",
      503,
    );
  const relative = normalize(pathname).replace(/^([/\\])+/, "");
  const target = join(root, relative);
  // normalize() resolves "..", so a path that escaped the root no longer
  // starts with it.
  const inside = target === root || target.startsWith(root + sep);
  let file = inside && relative ? await readIfFile(target) : null;
  let type = TYPES[extname(target).toLowerCase()];
  if (!file) {
    // A missing asset is a 404; a missing page is the app.
    if (extname(pathname)) return c.text("Not found", 404);
    file = await readIfFile(join(root, "index.html"));
    type = TYPES[".html"];
  }
  if (!file) return c.text("Not found", 404);
  const hashed = /\/assets\/.+-[A-Za-z0-9_-]{6,}\./.test(pathname);
  return c.body(new Uint8Array(file), 200, {
    "Content-Type": type ?? "application/octet-stream",
    "Cache-Control": hashed
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
}
