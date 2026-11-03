// Full-face YouCam makeup recipes for the YouCam Beauty Advisor.
//
// YouCam's Makeup Virtual Try-On applies up to 13 effect categories in one
// task (1 unit). Patterned categories must name a label from YouCam's public
// pattern catalogs (https://plugins-media.makeupar.com/wcm-saas/patterns/)
// and supply exactly as many palettes as the pattern has colors, or the task
// fails with InvalidParameters. The models choose from the short, described
// menus below; this module turns a choice into a valid effects payload and
// drops anything it cannot validate.

import { normalizeHex } from "../protocol/text.ts";

export { normalizeHex };

export type EyeshadowPattern = {
  label: string;
  colors: number;
  style: "soft" | "bold";
  description: string;
};

/** Described eyeshadow placements from YouCam's eyeshadow.json. */
export const EYESHADOW_PATTERNS: readonly EyeshadowPattern[] = [
  {
    label: "1color1",
    colors: 1,
    style: "soft",
    description: "One sheer shade across the lid, diffused toward the crease.",
  },
  {
    label: "1color2",
    colors: 1,
    style: "soft",
    description:
      "One sheer shade blended across the lid and softly around the eye.",
  },
  {
    label: "2colors1",
    colors: 2,
    style: "soft",
    description:
      "Light inner lid, slightly deeper outer lid, close to the lash line.",
  },
  {
    label: "2colors2",
    colors: 2,
    style: "soft",
    description:
      "Light inner lid fading to a deeper outer lid: a simple gradient at the lash line.",
  },
  {
    label: "2colors4",
    colors: 2,
    style: "soft",
    description:
      "One tone across the upper lid, a second along the outer lower lash line.",
  },
  {
    label: "2colors6",
    colors: 2,
    style: "soft",
    description:
      "Light inner lid, deeper shade blended over the outer lid and corner.",
  },
  {
    label: "3colors1",
    colors: 3,
    style: "soft",
    description:
      "Light inner corner, medium center, deeper outer corner, kept near the lash line.",
  },
  {
    label: "3colors3",
    colors: 3,
    style: "soft",
    description:
      "Light inner corner, soft crease shade, deeper tone on the outer lower lash line.",
  },
  {
    label: "3colors10",
    colors: 3,
    style: "soft",
    description:
      "Light inner corner, medium lid and crease, deeper outer corner, softly blended.",
  },
  {
    label: "3colors8",
    colors: 3,
    style: "bold",
    description:
      "Light inner corner, rich lid shade, deeper tone along the outer lower lashes.",
  },
  {
    label: "3colors12",
    colors: 3,
    style: "bold",
    description:
      "Rich lid color with a deeper winged outer corner and a light inner lower lash line.",
  },
  {
    label: "3colors367",
    colors: 3,
    style: "bold",
    description:
      "Sculpted smoky eye: layered lid, crease and outer corner, touch of lower lashes.",
  },
];

export type SimplePattern = { label: string; description: string };

/** Described single-color eyeliner shapes from YouCam's eyeliner.json. */
export const EYELINER_PATTERNS: readonly SimplePattern[] = [
  {
    label: "HalfRim19",
    description:
      "Thin upper line with a short horizontal tail. Subtle, elongating.",
  },
  {
    label: "HalfRim21",
    description:
      "Thin upper line ending in a short tapered tip; faint lower liner.",
  },
  {
    label: "HalfRim61",
    description:
      "Soft, shadow-like upper line that fades outward. Very natural.",
  },
  {
    label: "Upper116",
    description:
      "Soft upper line fading into a short blurred tip. Diffused definition.",
  },
  {
    label: "Upper60",
    description: "Upper line thickening into a sleek, upturned cat-eye wing.",
  },
  {
    label: "FullRim3",
    description: "Upturned wing with a thin lower line: a defined cat eye.",
  },
  {
    label: "Smoke21",
    description: "Smoky liner diffused along upper and lower lash lines.",
  },
  {
    label: "FullRim56",
    description: "Clean liner framing the whole upper and lower lash line.",
  },
];

/** Described lash styles from YouCam's eyelashes.json. */
export const LASH_PATTERNS: readonly SimplePattern[] = [
  {
    label: "Upper1",
    description: "Neatly separated upper lashes with a soft curl. Natural.",
  },
  {
    label: "Natural17",
    description: "Fine, lifted upper lashes with soft lower lashes. Fresh.",
  },
  {
    label: "Upper&Lower2",
    description:
      "Evenly curled upper lashes with fine lower lashes. Defined everyday.",
  },
  {
    label: "UpperDense3",
    description: "Dark separated lashes, longest at the center. Opens the eye.",
  },
  {
    label: "Winged35",
    description:
      "Long, full lashes sweeping to the outer corner. Dramatic lift.",
  },
];

export const BLUSH_PLACEMENTS = {
  apples: "Circle1",
  lifted: "Oblique1",
  draped: "Oblong1",
} as const;
export type BlushPlacement = keyof typeof BLUSH_PLACEMENTS;

// Contour and highlighter catalogs are organized by face shape. YouCam's
// face-shape labels (see analysis.ts) map onto them here.
const CONTOUR_BY_FACE: Record<string, string> = {
  heart: "HeartFace2",
  invtriangle: "Invtriangle1",
  oval: "OvalFace6",
  round: "RoundFace4",
  triangle: "TriangleFace2",
  diamond: "OvalFace6",
};
const HIGHLIGHT_BY_FACE: Record<string, string> = {
  heart: "HeartFace4",
  invtriangle: "Invtriangle2",
  oblong: "Oblong11",
  oval: "OvalFace2",
  round: "RoundFace3",
  square: "SquareFace3",
  triangle: "TriangleFace3",
  diamond: "OvalFace2",
};

function faceKey(faceShape: string | null | undefined) {
  return String(faceShape || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/face$/, "");
}

export function contourPatternFor(faceShape: string | null | undefined) {
  return CONTOUR_BY_FACE[faceKey(faceShape)] || null;
}

export function highlightPatternFor(faceShape: string | null | undefined) {
  return HIGHLIGHT_BY_FACE[faceKey(faceShape)] || HIGHLIGHT_BY_FACE.oval;
}

export type Intensity = "soft" | "medium" | "bold";

/** One try-on as chosen by a model. Every part is optional. */
export type MakeupRecipe = {
  name: string;
  intensity: Intensity;
  eyeshadow?: {
    pattern: string;
    colors: string[];
    finish?: "matte" | "shimmer";
  } | null;
  eyeliner?: { pattern: string; color: string } | null;
  lashes?: { pattern: string; color?: string } | null;
  blush?: { color: string; placement?: BlushPlacement } | null;
  lip?: {
    color: string;
    finish?: "matte" | "satin" | "gloss" | "sheer";
  } | null;
  foundation?: { color: string; coverage?: "sheer" | "medium" } | null;
  contour?: boolean;
  highlight?: boolean;
};

export type RecipeSwatch = { part: string; color: string; finish: string };

function channels(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(rgb: number[]) {
  return `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`;
}

/** Mixes a color toward black (amount < 0) or white (amount > 0). */
export function shade(hex: string, amount: number) {
  const target = amount < 0 ? 0 : 255;
  const weight = Math.min(1, Math.abs(amount));
  return toHex(channels(hex).map((c) => c + (target - c) * weight));
}

export function mix(a: string, b: string, weight = 0.5) {
  const left = channels(a);
  const right = channels(b);
  return toHex(
    left.map((c, index) => c * (1 - weight) + right[index] * weight),
  );
}

const strengths: Record<Intensity, number> = { soft: 40, medium: 60, bold: 80 };

/**
 * Builds a validated YouCam makeup-vto effects payload. Unknown patterns,
 * wrong color counts and invalid colors drop that part rather than failing
 * the whole task. `skinColor` (YouCam's measured skin tone) shades contour
 * and highlighter and is the fallback for foundation.
 */
export function recipeEffects(
  recipe: MakeupRecipe,
  measured: { skinColor?: string | null; faceShape?: string | null } = {},
) {
  const strength = strengths[recipe.intensity] ?? strengths.medium;
  const effects: Record<string, unknown>[] = [];
  const swatches: RecipeSwatch[] = [];
  const skin = normalizeHex(measured.skinColor);

  // A skin tint is always the measured skin color when YouCam has one, so a
  // try-on never lightens or darkens anyone's skin.
  const foundation = recipe.foundation
    ? skin || normalizeHex(recipe.foundation.color)
    : null;
  if (foundation) {
    const sheer = recipe.foundation?.coverage !== "medium";
    effects.push({
      category: "foundation",
      palettes: [
        {
          color: foundation,
          colorIntensity: sheer ? 18 : 30,
          glowIntensity: 25,
          coverageIntensity: sheer ? 20 : 40,
        },
      ],
    });
    swatches.push({
      part: "Skin tint",
      color: foundation,
      finish: sheer ? "sheer" : "medium coverage",
    });
  }

  if (recipe.contour && skin) {
    const pattern = contourPatternFor(measured.faceShape);
    if (pattern) {
      const color = shade(mix(skin, "#6B4A3A", 0.25), -0.22);
      effects.push({
        category: "contour",
        pattern: { name: pattern },
        palettes: [{ color, colorIntensity: Math.max(25, strength - 25) }],
      });
      swatches.push({ part: "Contour", color, finish: "matte" });
    }
  }

  if (recipe.highlight) {
    const color = skin ? shade(mix(skin, "#F6E3C6", 0.5), 0.18) : "#F5E6D3";
    effects.push({
      category: "highlighter",
      pattern: { name: highlightPatternFor(measured.faceShape) },
      palettes: [
        {
          color,
          colorIntensity: Math.min(35, Math.max(20, strength - 30)),
          glowIntensity: 40,
          shimmerIntensity: 25,
          shimmerDensity: 35,
          shimmerSize: 25,
        },
      ],
    });
    swatches.push({ part: "Highlight", color, finish: "glow" });
  }

  const shadow = recipe.eyeshadow;
  const shadowPattern = shadow
    ? EYESHADOW_PATTERNS.find((item) => item.label === shadow.pattern)
    : undefined;
  const shadowColors = (shadow?.colors || [])
    .map(normalizeHex)
    .filter((color): color is string => Boolean(color));
  // A pattern needs exactly its own number of palettes. A short list is
  // extended with progressively deeper shades of its last color.
  if (shadowPattern)
    while (shadowColors.length && shadowColors.length < shadowPattern.colors)
      shadowColors.push(shade(shadowColors.at(-1)!, -0.2));
  if (shadowPattern && shadowColors.length >= shadowPattern.colors) {
    const shimmer = shadow?.finish === "shimmer";
    effects.push({
      category: "eye_shadow",
      pattern: { name: shadowPattern.label },
      palettes: shadowColors.slice(0, shadowPattern.colors).map((color) => ({
        color,
        texture: shimmer ? "shimmer" : "matte",
        colorIntensity: strength,
        ...(shimmer ? { shimmerColor: "#FFFFFF", shimmerIntensity: 40 } : {}),
      })),
    });
    shadowColors.slice(0, shadowPattern.colors).forEach((color, index, list) =>
      swatches.push({
        part:
          list.length === 1
            ? "Eyeshadow"
            : `Eyeshadow ${["light", "mid", "deep"][Math.round((index / Math.max(1, list.length - 1)) * 2)]}`,
        color,
        finish: shimmer ? "shimmer" : "matte",
      }),
    );
  }

  const liner = recipe.eyeliner;
  const linerPattern = liner
    ? EYELINER_PATTERNS.find((item) => item.label === liner.pattern)
    : undefined;
  const linerColor = normalizeHex(liner?.color);
  if (linerPattern && linerColor) {
    effects.push({
      category: "eye_liner",
      pattern: { name: linerPattern.label },
      palettes: [
        {
          color: linerColor,
          texture: "matte",
          colorIntensity: Math.min(90, strength + 10),
        },
      ],
    });
    swatches.push({ part: "Liner", color: linerColor, finish: "matte" });
  }

  const lashes = recipe.lashes;
  const lashPattern = lashes
    ? LASH_PATTERNS.find((item) => item.label === lashes.pattern)
    : undefined;
  if (lashPattern) {
    effects.push({
      category: "eyelashes",
      pattern: { name: lashPattern.label },
      palettes: [
        {
          color: normalizeHex(lashes?.color) || "#1A1414",
          colorIntensity: Math.min(90, strength + 10),
        },
      ],
    });
  }

  const blushColor = normalizeHex(recipe.blush?.color);
  if (blushColor) {
    const placement =
      recipe.blush?.placement && recipe.blush.placement in BLUSH_PLACEMENTS
        ? recipe.blush.placement
        : "lifted";
    effects.push({
      category: "blush",
      pattern: { name: BLUSH_PLACEMENTS[placement] },
      palettes: [
        {
          color: blushColor,
          texture: "matte",
          colorIntensity: Math.max(30, strength - 15),
        },
      ],
    });
    swatches.push({ part: "Blush", color: blushColor, finish: placement });
  }

  const lipColor = normalizeHex(recipe.lip?.color);
  if (lipColor) {
    const finish = ["matte", "satin", "gloss", "sheer"].includes(
      String(recipe.lip?.finish),
    )
      ? String(recipe.lip?.finish)
      : "satin";
    effects.push({
      category: "lip_color",
      shape: { name: "original" },
      style: { type: "full" },
      palettes: [
        {
          color: lipColor,
          texture: finish,
          colorIntensity: strength,
          ...(finish === "gloss" || finish === "sheer"
            ? { gloss: 60, transparencyIntensity: finish === "sheer" ? 55 : 30 }
            : {}),
        },
      ],
    });
    swatches.push({ part: "Lips", color: lipColor, finish });
  }

  // Keep the try-on honest: makeup only, minimal skin retouching. YouCam
  // applies a default smoothing of 50 when this effect is omitted.
  if (effects.length)
    effects.push({
      category: "skin_smooth",
      skinSmoothStrength: 20,
      skinSmoothColorIntensity: 0,
    });
  return { effects, swatches };
}

/**
 * The menus as compact text for a tool description, so a model sees every
 * valid pattern label and what it does without a separate lookup call.
 */
export function makeupMenuText(): string {
  const shadow = EYESHADOW_PATTERNS.map(
    (item) =>
      `${item.label} (${item.colors} color${item.colors === 1 ? "" : "s"}, ${item.style}): ${item.description}`,
  ).join("\n");
  const simple = (items: readonly SimplePattern[]) =>
    items.map((item) => `${item.label}: ${item.description}`).join("\n");
  return [
    "EYESHADOW PATTERNS (give exactly as many colors as the pattern lists):",
    shadow,
    "EYELINER PATTERNS:",
    simple(EYELINER_PATTERNS),
    "LASH PATTERNS:",
    simple(LASH_PATTERNS),
    "BLUSH PLACEMENTS: apples (round color on the apples of the cheeks), lifted (diagonal sweep from cheek toward the temple), draped (horizontal wash across the cheekbone).",
  ].join("\n");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads an untrusted recipe (model output or stored JSON) into a MakeupRecipe. */
export function parseRecipe(
  value: unknown,
  fallbackName = "Your look",
): MakeupRecipe {
  const raw = record(value);
  const intensity = ["soft", "medium", "bold"].includes(String(raw.intensity))
    ? (raw.intensity as Intensity)
    : "medium";
  const part = (key: string) => {
    const item = record(raw[key]);
    return Object.keys(item).length ? item : null;
  };
  const shadow = part("eyeshadow");
  const liner = part("eyeliner");
  const lashes = part("lashes");
  const blush = part("blush");
  const lip = part("lip");
  const foundation = part("foundation");
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 32)
      : fallbackName;
  return {
    name,
    intensity,
    eyeshadow: shadow
      ? {
          pattern: String(shadow.pattern || ""),
          colors: Array.isArray(shadow.colors)
            ? shadow.colors.map((item) => String(item)).slice(0, 3)
            : [],
          finish: shadow.finish === "shimmer" ? "shimmer" : "matte",
        }
      : null,
    eyeliner: liner
      ? {
          pattern: String(liner.pattern || ""),
          color: String(liner.color || ""),
        }
      : null,
    lashes: lashes ? { pattern: String(lashes.pattern || "") } : null,
    blush: blush
      ? {
          color: String(blush.color || ""),
          placement:
            String(blush.placement) in BLUSH_PLACEMENTS
              ? (blush.placement as BlushPlacement)
              : undefined,
        }
      : null,
    lip: lip
      ? {
          color: String(lip.color || ""),
          finish: ["matte", "satin", "gloss", "sheer"].includes(
            String(lip.finish),
          )
            ? (lip.finish as "matte" | "satin" | "gloss" | "sheer")
            : undefined,
        }
      : null,
    foundation: foundation
      ? {
          color: String(foundation.color || ""),
          coverage: foundation.coverage === "medium" ? "medium" : "sheer",
        }
      : null,
    contour: raw.contour === true,
    highlight: raw.highlight === true,
  };
}
