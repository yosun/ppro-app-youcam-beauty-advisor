// Text hygiene. Everything an agent or a client sends is untrusted text: it is
// cleaned here before it is stored, shown or spoken. No Node-only imports.

import { LIMITS } from "./constants.ts";

// Control characters are exactly what these patterns exist to remove.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** One line of display text: control characters out, whitespace collapsed. */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
      .trim()
  );
}

/** Multi-line text from a client: control characters out, blank runs capped. */
export function cleanClientText(
  value: unknown,
  max: number = LIMITS.clientMessageChars,
): string {
  if (typeof value !== "string") return "";
  return value
    .replace(CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max)
    .trim();
}

// The content floor. It is deliberately narrow: a beauty consultation says
// "photo shoot", "lip bomb" and "naked palette" all the time, and none of them
// should be blocked. Only sexual content and nudity are out of place.
const SEXUAL = /\b(?:porn\w*|genitals?|fetish\w*|rapes?|rapists?)\b/i;
// "Nude" and "naked" are everyday makeup words (a nude lip, a naked palette),
// so only talk of nude pictures or bodies is blocked.
const NUDITY =
  /\b(?:nudes?|naked)\s+(?:photos?|pics?|pictures?|selfies?|images?|videos?|bod(?:y|ies)|models?)\b|\bsend\s+nudes\b|\bget(?:ting)?\s+naked\b/i;

export function violatesContentFloor(text: string): boolean {
  return SEXUAL.test(text) || NUDITY.test(text);
}

export type CleanedAgentText =
  { ok: true; text: string } | { ok: false; reason: "empty" | "blocked" };

/**
 * Prepares an agent's message for the transcript. Links and markdown are
 * removed (the app renders plain text and the same words may be spoken), long
 * text is cut at a word, and text that breaks the content floor is refused.
 */
export function cleanAgentText(
  value: unknown,
  max: number = LIMITS.agentMessageChars,
): CleanedAgentText {
  if (typeof value !== "string") return { ok: false, reason: "empty" };
  let text = value
    .replace(CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\*\*|__|^#+\s*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return { ok: false, reason: "empty" };
  if (violatesContentFloor(text)) return { ok: false, reason: "blocked" };
  if (text.length > max)
    text = `${text.slice(0, max - 10).replace(/\s+\S*$/, "")}…`;
  return { ok: true, text };
}

/**
 * One line of agent-written display text (a card title, a step, a notice):
 * links and markdown removed, whitespace collapsed, cut to `max`. Returns an
 * empty string for text that breaks the content floor.
 */
export function cleanDisplayLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const line = cleanLine(
    value
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\bwww\.\S+/gi, "")
      .replace(/\*\*|__|`/g, ""),
    max,
  );
  return violatesContentFloor(line) ? "" : line;
}

/** A hex color as `#RRGGBB`, or null. Accepts the `#` or not, any case. */
export function normalizeHex(value: unknown): string | null {
  return typeof value === "string" && /^#?[0-9A-Fa-f]{6}$/.test(value.trim())
    ? `#${value.trim().replace("#", "").toUpperCase()}`
    : null;
}

const SPEECH_MAX = 600;

/**
 * The words of an agent message as they should be spoken: no links, markdown,
 * emoji, bullets or numbering, a stop after every line, and at most about 35
 * seconds of speech, cut at a sentence. Voice agents read this instead of the
 * written text.
 */
export function speakable(body: string, max = SPEECH_MAX): string {
  const plain = body
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#>~|]+/g, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .split(/\n+/)
    // A list reads as sentences: no bullets or numbers, a stop after each.
    .map((line) =>
      line
        .replace(/^\s*(?:\d+[.)]|[-•])\s+/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .map((line) => (/[.!?:;,…]$/.test(line) ? line : `${line}.`))
    .join(" ");
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const stop = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
  );
  return stop > max / 2
    ? cut.slice(0, stop + 1)
    : `${cut.replace(/\s+\S*$/, "")}.`;
}
