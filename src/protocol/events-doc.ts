import type { EventType } from "./types.ts";

// One line per event type, published in the manifest and the spec. The data
// shapes are in types.ts (EventMap); apps do not add event types.
export const EVENT_DOCS: Record<EventType, string> = {
  "session.started": "The session exists. Always rev 1.",
  "session.ended":
    "The consultation ended (client, agent, host or time ran out). Photos and result images are gone. Nothing newer will come.",
  "session.warning": "About 5 or 1 minutes remain.",
  "consent.updated":
    "The client confirmed or changed their adult and photo-analysis consent.",
  "message.created":
    "A transcript entry: the client's message or photo, the advisor's reply, or a tool result card.",
  "photo.added": "The client shared a photo. Its bytes never appear in events.",
  "photo.rejected":
    "A photo was refused (too small, wrong format). The message is safe to relay.",
  "photo.deleted": "The client deleted a photo and every image made from it.",
  "tool.started": "A tool call began running.",
  "tool.completed": "A tool call finished, successfully or not.",
  "app.updated":
    "One top-level part of the app state changed; `value` is its new value.",
  "ui.changed":
    "What the client sees changed: the screen, the pointer, a notice, a photo request. `by` says who caused it.",
  "client.action":
    "The client copied or saved something. Informational; nothing else changed.",
  "presence.changed":
    "The advisor's presence changed (thinking, speaking, ...).",
  "budget.updated": "Provider units were spent.",
};
