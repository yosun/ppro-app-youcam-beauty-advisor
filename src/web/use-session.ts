import { useEffect, useMemo, useRef, useState } from "react";
import {
  AdvisorClient,
  PproError,
  type BeautyAdvisorClient,
} from "../client/index.ts";
import type { PproEvent } from "../protocol/types.ts";
import { applyEvent, isNext, type BeautySession } from "./apply-event.ts";

// Holds the session this browser is part of: one snapshot, then the live
// events applied to it. The connection is a long-poll loop, so it works
// through any proxy and resumes by rev after a drop.

export type Status = "loading" | "live" | "offline" | "ended" | "error";

export type SessionHandle = {
  session: BeautySession | null;
  status: Status;
  error: string | null;
  client: BeautyAdvisorClient;
  /** Events as they arrive, for reactions that are not state (a rejected photo). */
  onEvent: (listener: (event: PproEvent) => void) => () => void;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export function useSession(input: {
  baseUrl: string;
  sessionId: string;
  token: string;
}): SessionHandle {
  const { baseUrl, sessionId, token } = input;
  const client = useMemo(
    () =>
      new AdvisorClient({ baseUrl, token, sessionId }) as BeautyAdvisorClient,
    [baseUrl, token, sessionId],
  );
  const [session, setSession] = useState<BeautySession | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const listeners = useRef(new Set<(event: PproEvent) => void>());

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let current: BeautySession | null = null;
    let backoff = 500;

    async function run() {
      while (!signal.aborted) {
        try {
          if (!current) {
            current = await client.state({ messages: 300 });
            setSession(current);
            setStatus(current.phase === "ended" ? "ended" : "live");
            setError(null);
          }
          if (current.phase === "ended") return;
          const batch = await client.poll(current.rev, {
            wait: 20,
            signal,
          });
          if (signal.aborted) return;
          let next = current;
          for (const event of batch.events) {
            if (!isNext(next, event)) {
              // A gap: read the session again instead of guessing.
              current = null;
              break;
            }
            next = applyEvent(next, event);
            for (const listener of listeners.current) listener(event);
          }
          if (!current) continue;
          current = next;
          if (batch.events.length) setSession(current);
          setStatus(current.phase === "ended" ? "ended" : "live");
          backoff = 500;
        } catch (caught) {
          if (signal.aborted) return;
          if (caught instanceof PproError) {
            if (caught.status === 410) {
              current = null;
              continue;
            }
            if (caught.status === 401 || caught.status === 404) {
              setStatus("error");
              setError(
                caught.status === 401
                  ? "This link has expired. Ask for a new one."
                  : "This consultation is no longer available.",
              );
              return;
            }
          }
          setStatus("offline");
          await sleep(backoff, signal);
          backoff = Math.min(backoff * 2, 8000);
        }
      }
    }
    void run();
    return () => controller.abort();
  }, [client]);

  const onEvent = useMemo(
    () => (listener: (event: PproEvent) => void) => {
      listeners.current.add(listener);
      return () => {
        listeners.current.delete(listener);
      };
    },
    [],
  );

  return { session, status, error, client, onEvent };
}
