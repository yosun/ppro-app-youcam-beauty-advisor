// The YouCam Beauty Advisor's screens and targets.
//
//   chat                  the conversation
//   skin | skin:acne      the skin report, or one concern (by YouCam key)
//   face | face:2         face shape and features, or one attribute (index)
//   tone | tone:0         skin tone and colors, or one attribute (index)
//   look                  the before-and-after of the presented look
//   steps | step:1        the steps list, or one step (index)
//   shades | shade:0      the shade list, or one shade (index)
//   picks | pick:3        product picks, or one pick (index)

import { splitTarget } from "../protocol/targets.ts";

export const SCREENS = [
  "chat",
  "skin",
  "face",
  "look",
  "steps",
  "shades",
  "picks",
] as const;
export type Screen = (typeof SCREENS)[number];

export const SCREEN_TITLES: Record<Screen, string> = {
  chat: "Chat",
  skin: "Skin",
  face: "Face",
  look: "Look",
  steps: "Steps",
  shades: "Shades",
  picks: "Picks",
};

/** Which screen each target section lives on. */
export const SECTION_SCREEN = {
  chat: "chat",
  skin: "skin",
  face: "face",
  tone: "face",
  look: "look",
  steps: "steps",
  step: "steps",
  shades: "shades",
  shade: "shades",
  picks: "picks",
  pick: "picks",
} as const satisfies Record<string, Screen>;
export type Section = keyof typeof SECTION_SCREEN;

export function isScreen(value: unknown): value is Screen {
  return (
    typeof value === "string" && (SCREENS as readonly string[]).includes(value)
  );
}

export type ParsedTarget = {
  section: Section;
  /** The part after the colon, or null when the target names a section. */
  item: string | null;
  screen: Screen;
};

/** Parses one of this app's targets, or returns null. */
export function parseTarget(value: unknown): ParsedTarget | null {
  const parts = splitTarget(value);
  if (!parts || !Object.hasOwn(SECTION_SCREEN, parts.section)) return null;
  const section = parts.section as Section;
  return { section, item: parts.item, screen: SECTION_SCREEN[section] };
}

/** The screen a target lives on, or null for an unknown target. */
export function screenOfTarget(value: unknown): Screen | null {
  return parseTarget(value)?.screen ?? null;
}

/** The numeric item of a target (`step:1` gives 1), or null. */
export function targetIndex(value: unknown): number | null {
  const item = parseTarget(value)?.item;
  if (item === null || item === undefined || !/^\d{1,2}$/.test(item)) {
    return null;
  }
  return Number(item);
}
