import type { BeautyState, BeautyView } from "../advisor/types.ts";
import type { PproEvent, Session } from "../protocol/types.ts";

// Keeps a session snapshot current by applying the events that follow it. The
// events carry whole values (a message, a part of the app state, the UI), so
// the app never refetches to learn what the advisor just did. Pure, so it is
// tested without a browser.

export type BeautySession = Session<BeautyState, BeautyView>;

/** True when `event` is the very next one after the snapshot. */
export function isNext(session: BeautySession, event: PproEvent) {
  return event.rev === session.rev + 1;
}

export function applyEvent(
  session: BeautySession,
  event: PproEvent,
): BeautySession {
  const next: BeautySession = { ...session, rev: event.rev };
  switch (event.type) {
    case "message.created": {
      const { message } = event.data;
      // The snapshot may already hold it (it was read between two events).
      if (session.messages.some((m) => m.seq === message.seq)) break;
      next.messages = [...session.messages, message];
      next.messageCount = Math.max(session.messageCount, message.seq);
      break;
    }
    case "photo.added":
      if (!session.photos.some((p) => p.id === event.data.photo.id))
        next.photos = [...session.photos, event.data.photo];
      break;
    case "photo.deleted":
      next.photos = session.photos.filter((p) => p.id !== event.data.photoId);
      break;
    case "app.updated":
      next.app = {
        ...session.app,
        [event.data.kind]: event.data.value,
      } as BeautyState;
      break;
    case "ui.changed":
      next.ui = event.data.ui as BeautySession["ui"];
      break;
    case "presence.changed":
      next.presence = event.data.presence;
      break;
    case "budget.updated":
      next.budget = { ...event.data };
      break;
    case "consent.updated":
      next.consent = { ...event.data.consent };
      break;
    case "session.ended":
      next.phase = "ended";
      next.endedAt = event.at;
      next.endReason = event.data.reason;
      next.photos = [];
      next.presence = "idle";
      break;
    default:
      // tool.*, client.action, photo.rejected, session.*: nothing to show in
      // the snapshot (the UI reacts to some of them separately).
      break;
  }
  return next;
}
