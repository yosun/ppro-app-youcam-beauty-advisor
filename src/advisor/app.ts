import { z } from "zod";
import type {
  AppDefinition,
  ScreenSpec,
  TargetResolution,
  TargetSpec,
} from "../protocol/app-definition.ts";
import {
  APP_ID,
  APP_NAME,
  APP_VERSION,
  DISCLAIMER,
  PROVIDER_NAME,
  PROVIDER_URL,
  SKILL_ID,
  SKILL_NAME,
  STARTERS,
} from "../protocol/constants.ts";
import { envNumber } from "../support/env.ts";
import { GUARDRAILS, advisorInstructions } from "./instructions.ts";
import { parseTarget, SCREENS, SCREEN_TITLES, type Screen } from "./screens.ts";
import { beautyStateSchema, beautyViewSchema } from "./state-schema.ts";
import { BEAUTY_TOOLS } from "./tools.ts";
import {
  EMPTY_VIEW,
  emptyBeautyState,
  type BeautyState,
  type BeautyView,
} from "./types.ts";
import { youcamMode } from "./youcam.ts";

const SCREEN_SPECS: readonly ScreenSpec[] = [
  {
    id: "chat",
    title: SCREEN_TITLES.chat,
    description:
      "The conversation, with each tool result as a card, and the photo capture.",
    filledBy: "messages",
  },
  {
    id: "skin",
    title: SCREEN_TITLES.skin,
    description:
      "Skin report: a score per concern, what needs the most care first, with overlays.",
    filledBy: "skin",
  },
  {
    id: "face",
    title: SCREEN_TITLES.face,
    description:
      "Face shape and features, and the skin tone and facial colors as swatches.",
    filledBy: "face, tone",
  },
  {
    id: "look",
    title: SCREEN_TITLES.look,
    description: "The presented look as a before-and-after of the try-on.",
    filledBy: "card.image",
  },
  {
    id: "steps",
    title: SCREEN_TITLES.steps,
    description: "The steps to get the presented look.",
    filledBy: "card.steps",
  },
  {
    id: "shades",
    title: SCREEN_TITLES.shades,
    description: "The exact shades of the look, with hex codes to copy.",
    filledBy: "card.shades",
  },
  {
    id: "picks",
    title: SCREEN_TITLES.picks,
    description: "Specific recommended products and shades.",
    filledBy: "picks",
  },
];

const TARGET_SPECS: readonly TargetSpec[] = [
  {
    section: "chat",
    screen: "chat",
    item: "none",
    description: "The conversation.",
  },
  {
    section: "skin",
    screen: "skin",
    item: "YouCam concern key, for example acne",
    description: "The skin report, or one concern.",
  },
  {
    section: "face",
    screen: "face",
    item: "index into face.attributes",
    description: "Face shape and features, or one attribute.",
  },
  {
    section: "tone",
    screen: "face",
    item: "index into tone.attributes",
    description: "Skin tone and colors, or one color.",
  },
  {
    section: "look",
    screen: "look",
    item: "none",
    description: "The before-and-after.",
  },
  {
    section: "steps",
    screen: "steps",
    item: "none",
    description: "The whole steps list.",
  },
  {
    section: "step",
    screen: "steps",
    item: "index into card.steps",
    description: "One step.",
  },
  {
    section: "shades",
    screen: "shades",
    item: "none",
    description: "The whole shade list.",
  },
  {
    section: "shade",
    screen: "shades",
    item: "index into card.shades",
    description: "One shade.",
  },
  {
    section: "picks",
    screen: "picks",
    item: "none",
    description: "All product picks.",
  },
  {
    section: "pick",
    screen: "picks",
    item: "index into picks",
    description: "One product pick.",
  },
];

export function availableScreens(state: BeautyState): Screen[] {
  const out: Screen[] = ["chat"];
  if (state.skin) out.push("skin");
  if (state.face || state.tone) out.push("face");
  if (state.card?.image) out.push("look");
  if (state.card?.steps.length) out.push("steps");
  if (state.card?.shades.length) out.push("shades");
  if (state.picks.length) out.push("picks");
  return out;
}

/** Every target that exists in the current state. */
export function validTargets(state: BeautyState): string[] {
  const out: string[] = ["chat"];
  if (state.skin) {
    out.push("skin", ...state.skin.scores.map((score) => score.target));
  }
  if (state.face)
    out.push("face", ...state.face.attributes.map((item) => item.target));
  if (state.tone)
    out.push("tone", ...state.tone.attributes.map((item) => item.target));
  if (state.card?.image) out.push("look");
  if (state.card?.steps.length)
    out.push("steps", ...state.card.steps.map((_, i) => `step:${i}`));
  if (state.card?.shades.length)
    out.push("shades", ...state.card.shades.map((_, i) => `shade:${i}`));
  if (state.picks.length)
    out.push("picks", ...state.picks.map((p) => p.target));
  return out;
}

export function resolveTarget(
  state: BeautyState,
  target: string,
): TargetResolution {
  const parsed = parseTarget(target);
  const valid = validTargets(state);
  const bad = (message: string): TargetResolution => ({
    ok: false,
    message,
    valid,
  });
  if (!parsed)
    return bad(
      `"${target.slice(0, 40)}" is not a target of this app. Targets look like skin, skin:acne, step:1 or shade:0.`,
    );
  if (!valid.includes(target)) {
    const available = availableScreens(state);
    return bad(
      available.includes(parsed.screen)
        ? `Nothing at "${target}" in this session.`
        : `Nothing to show for "${target}" yet: the ${SCREEN_TITLES[parsed.screen]} screen has no content.`,
    );
  }
  return { ok: true, screen: parsed.screen };
}

export function summarize(state: BeautyState): Record<string, unknown> {
  return {
    skin: state.skin
      ? {
          concerns: state.skin.scores.length,
          needs_most_care: state.skin.scores.slice(0, 3).map((s) => s.label),
          skin_type: state.skin.skinType,
          simulated: state.skin.simulated,
        }
      : null,
    face: state.face
      ? Object.fromEntries(state.face.attributes.map((a) => [a.name, a.value]))
      : null,
    tone: state.tone
      ? Object.fromEntries(state.tone.attributes.map((a) => [a.name, a.value]))
      : null,
    try_ons: state.tryOns.map((t) => ({
      id: t.id,
      title: t.title,
      image_id: t.imageId,
    })),
    look: state.card
      ? {
          title: state.card.title,
          steps: state.card.steps.length,
          shades: state.card.shades.length,
          has_try_on_image: Boolean(state.card.image),
          has_before_photo: Boolean(state.card.before),
        }
      : null,
    picks: state.picks.map((p) => `${p.brand} ${p.name}`),
    measurements: state.measurements,
  };
}

export function dropMedia(state: BeautyState, ids: ReadonlySet<string>) {
  if (state.skin) {
    state.skin.images = state.skin.images.filter((image) => !ids.has(image.id));
    for (const score of state.skin.scores)
      if (score.imageId && ids.has(score.imageId)) score.imageId = null;
  }
  state.tryOns = state.tryOns.filter(
    (item) => !ids.has(item.imageId) && !ids.has(item.photoId),
  );
  if (state.card) {
    if (state.card.image && ids.has(state.card.image.id)) {
      state.card.image = null;
    }
    if (state.card.before && ids.has(state.card.before.id)) {
      state.card.before = null;
    }
  }
}

export const beautyAdvisor: AppDefinition<BeautyState, BeautyView> = {
  id: APP_ID,
  name: APP_NAME,
  version: APP_VERSION,
  description:
    "A beauty and skincare advisor app built on YouCam AI. The client shares a selfie; the advisor analyzes skin, face shape and colors, tries on makeup, presents a look with steps and exact shades, and recommends products. Every screen and action is controllable by an external agent.",
  skill: { id: SKILL_ID, name: SKILL_NAME },
  provider: { name: PROVIDER_NAME, url: PROVIDER_URL },
  disclaimer: DISCLAIMER,
  guardrails: GUARDRAILS,
  starters: STARTERS,
  messageKinds: ["analysis", "try_on", "looks", "picks", "card", "notice"],
  screens: SCREEN_SPECS,
  targets: TARGET_SPECS,
  stateSchema: z.toJSONSchema(beautyStateSchema, {
    target: "draft-2020-12",
    io: "output",
  }) as Record<string, unknown>,
  tools: BEAUTY_TOOLS,
  initialState: emptyBeautyState,
  initialView: () => ({ ...EMPTY_VIEW }),
  viewSchema: beautyViewSchema.partial().strict(),
  availableScreens,
  resolveTarget,
  summarize,
  validTargets,
  dropMedia,
  engineMode: youcamMode,
  sessionUnits: () => envNumber("YOUCAM_UNITS_PER_SESSION", 100),
  instructions: advisorInstructions,
};

export { SCREENS };
