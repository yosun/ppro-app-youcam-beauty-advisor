// Targets: the shared way to point at part of an app.
//
// A target is `section` or `section:item`. The *grammar* is part of the PPRO
// App API; which sections exist and which screen each one lives on is up to
// the app, and the manifest lists them. Every result an app returns names the
// exact target of each item in it, so an agent never builds one by hand.

export type TargetParts = { section: string; item: string | null };

const TARGET = /^([a-z][a-z0-9-]{1,23})(?::([A-Za-z0-9_.-]{1,40}))?$/;

/** Splits a target into section and item, or returns null when malformed. */
export function splitTarget(value: unknown): TargetParts | null {
  if (typeof value !== "string") return null;
  const match = TARGET.exec(value);
  if (!match) return null;
  return { section: match[1], item: match[2] ?? null };
}

export function formatTarget(section: string, item?: string | number | null) {
  return item === undefined || item === null ? section : `${section}:${item}`;
}
