import { useEffect, useState } from "react";
import type { BeautyAdvisorClient } from "../client/index.ts";

// Images are private to the session, so `<img src>` cannot fetch them (it sends
// no Authorization header). They are fetched with the client token and shown
// from object URLs, which are revoked when nothing shows them any more.

type Entry = { url: Promise<string>; users: number };
const cache = new Map<string, Entry>();

function key(client: BeautyAdvisorClient, id: string) {
  return `${client.baseUrl}|${id}`;
}

function acquire(client: BeautyAdvisorClient, id: string): Promise<string> {
  const k = key(client, id);
  let entry = cache.get(k);
  if (!entry) {
    entry = {
      url: client.image(id).then((blob) => URL.createObjectURL(blob)),
      users: 0,
    };
    cache.set(k, entry);
  }
  entry.users += 1;
  return entry.url;
}

function release(client: BeautyAdvisorClient, id: string) {
  const k = key(client, id);
  const entry = cache.get(k);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  // Leave a moment for a screen that is about to show it again.
  setTimeout(() => {
    const again = cache.get(k);
    if (again && again.users <= 0) {
      cache.delete(k);
      again.url.then(
        (url) => URL.revokeObjectURL(url),
        () => undefined,
      );
    }
  }, 30_000);
}

export type ImageState =
  | { status: "loading"; url: null }
  | { status: "ready"; url: string }
  | { status: "gone"; url: null };

/** An object URL for a session image, or its loading or missing state. */
export function useImage(
  client: BeautyAdvisorClient,
  id: string | null | undefined,
): ImageState {
  const [state, setState] = useState<{ id: string | null; value: ImageState }>({
    id: null,
    value: { status: "loading", url: null },
  });
  useEffect(() => {
    if (!id) return;
    let live = true;
    acquire(client, id).then(
      (url) => live && setState({ id, value: { status: "ready", url } }),
      () => live && setState({ id, value: { status: "gone", url: null } }),
    );
    return () => {
      live = false;
      release(client, id);
    };
  }, [client, id]);
  if (!id) return { status: "gone", url: null };
  return state.id === id ? state.value : { status: "loading", url: null };
}
