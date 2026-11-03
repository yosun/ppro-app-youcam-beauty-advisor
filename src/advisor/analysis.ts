import { createHash } from "node:crypto";
import { normalizeHex } from "../protocol/text.ts";
import type { YouCamLook } from "./youcam.ts";

// Helpers for reading YouCam results and for simulating them when no API key
// is configured. Everything here is pure.

export const SKIN_CONCERNS = {
  acne: "Acne",
  pore: "Pores",
  texture: "Texture",
  wrinkle: "Wrinkles",
  redness: "Redness",
  oiliness: "Oiliness",
  moisture: "Hydration",
  dark_circle_v2: "Dark circles",
  eye_bag: "Eye bags",
  radiance: "Radiance",
  firmness: "Firmness",
  age_spot: "Spots",
  tear_trough: "Tear trough",
  droopy_upper_eyelid: "Upper eyelid",
  droopy_lower_eyelid: "Lower eyelid",
  skin_type: "Skin type",
} as const;
export type SkinConcern = keyof typeof SKIN_CONCERNS;
export const DEFAULT_SKIN_CONCERNS: SkinConcern[] = [
  "acne",
  "pore",
  "texture",
  "wrinkle",
  "redness",
  "oiliness",
  "moisture",
  "dark_circle_v2",
];

// Feature shapes and colors only. Age, gender and "golden ratio" scoring are
// deliberately not offered in a beauty consultation.
export const FACE_FEATURES = {
  faceShape: "Face shape",
  eyeShape: "Eye shape",
  eyeSize: "Eye size",
  eyeAngle: "Eye angle",
  eyeDistance: "Eye spacing",
  eyelid: "Eyelid",
  eyebrowShape: "Brow shape",
  eyebrowThickness: "Brow thickness",
  lipShape: "Lip shape",
  noseWidth: "Nose width",
  noseLength: "Nose length",
  cheekbones: "Cheekbones",
  eyeColor: "Eye color",
  hairColor: "Hair color",
  eyebrowColor: "Brow color",
  lipColor: "Lip color",
} as const;
export type FaceFeature = keyof typeof FACE_FEATURES;
export const DEFAULT_FACE_FEATURES: FaceFeature[] = [
  "faceShape",
  "eyeShape",
  "lipShape",
  "eyebrowShape",
  "cheekbones",
];

export const LOOK_CATEGORIES = [
  "Daily",
  "Work",
  "Party",
  "Wedding",
  "Makeup Artist",
  "K-Pop",
  "Red Carpet",
  "Fashion Week",
  "Celebrity",
  "Spring",
  "Summer",
  "Valentine",
  "Halloween",
] as const;

/** The looks offered in simulated mode. */
export const SIMULATED_LOOKS: YouCamLook[] = [
  { id: "all_buttercup", title: "Buttercup", category: "Daily" },
  { id: "all_pure", title: "Pure", category: "Daily" },
  { id: "all_sunny", title: "Sunny", category: "Daily" },
  { id: "all_happy_rose", title: "Happy Rose", category: "Daily" },
  { id: "all_pink_perfect", title: "Pink Perfect", category: "Work" },
  { id: "all_berry_boss", title: "Berry Boss", category: "Work" },
  { id: "all_elegant", title: "Elegant", category: "Party" },
  { id: "all_cat_eyes", title: "Cat Eyes", category: "Party" },
  { id: "all_classic", title: "Classic", category: "Wedding" },
  { id: "all_ethereal", title: "Ethereal", category: "Wedding" },
  { id: "all_glossy_gal", title: "Glossy Gal", category: "K-Pop" },
  { id: "all_opulence", title: "Opulence", category: "Red Carpet" },
];

export function skinRating(score: number) {
  return score >= 85
    ? "excellent"
    : score >= 70
      ? "good"
      : score >= 55
        ? "fair"
        : score >= 40
          ? "needs care"
          : "needs attention";
}

// YouCam result keys arrive in several casings (faceShape, faceshape,
// face_shape); match them to the labels this app uses.
const KNOWN_LABELS = new Map<string, string>(
  Object.entries({ ...FACE_FEATURES, ...SKIN_CONCERNS }).map(([key, label]) => [
    key.replace(/_/g, "").toLowerCase(),
    label,
  ]),
);

export function humanize(key: string) {
  const known = KNOWN_LABELS.get(key.replace(/[_-]/g, "").toLowerCase());
  if (known) return known;
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Estimated age, gender and attractiveness-style scores are never shown or
// passed to the agent. "age_spot" is a skin concern and stays.
export function isSensitiveKey(key: string) {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return (
    normalized === "agegender" ||
    /(^|_)(age|gender|sex|race|ethnicity|attractiveness|beauty_score)$/.test(
      normalized,
    )
  );
}

// Photo-quality checks YouCam reports alongside results (face_quality). They
// are not attributes of the client and are left out of the results.
const PHOTO_QUALITY_KEYS = new Set([
  "facequality",
  "hasface",
  "area",
  "frontal",
  "lighting",
  "faceangle",
  "quality",
  "status",
  "taskstatus",
  "errorcode",
]);

export type RawAttribute = { name: string; value: string; color?: string };

/**
 * Flattens a YouCam face or color result into short, displayable attributes,
 * e.g. {faceshape:"Heart", eyelid:{left_shape,right_shape},
 * color:{eye_color:"#543423", eye_color_name:"Brown"}}.
 */
export function flattenAttributes(value: unknown, max = 32): RawAttribute[] {
  const raw: RawAttribute[] = [];
  const visit = (node: unknown, path: string[], depth: number) => {
    if (raw.length >= max * 2 || depth > 4) return;
    if (Array.isArray(node)) {
      const texts = node.filter(
        (item) => typeof item === "string" || typeof item === "number",
      );
      if (texts.length === node.length && texts.length) {
        visit(texts.slice(0, 4).join(", "), path, depth + 1);
        return;
      }
      node.slice(0, 6).forEach((item) => visit(item, path, depth + 1));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(
        node as Record<string, unknown>,
      )) {
        const normalized = key.replace(/[_-]/g, "").toLowerCase();
        if (
          isSensitiveKey(key) ||
          /url|mask|thumb|image/i.test(key) ||
          PHOTO_QUALITY_KEYS.has(normalized)
        )
          continue;
        visit(child, [...path, key], depth + 1);
      }
      return;
    }
    if (node === null || node === undefined || typeof node === "boolean")
      return;
    const text = String(node).trim();
    if (!text || text.length > 80 || /^https?:/i.test(text)) return;
    const leaf = path.at(-1) || "value";
    const parent = path.at(-2);
    const side = /^(left|right)_?(?:shape|type|size|value)?$/i.exec(leaf)?.[1];
    const name = side
      ? `${humanize(parent || "feature")} (${side.toLowerCase()})`
      : parent &&
          /^(label|value|name|type|result|hex|color|code|level|shape)$/i.test(
            leaf,
          )
        ? humanize(parent)
        : humanize(leaf);
    const display =
      typeof node === "number" ? String(Math.round(node * 100) / 100) : text;
    const color = /^#?[0-9a-f]{6}$/i.test(text)
      ? `#${text.replace("#", "").toUpperCase()}`
      : undefined;
    raw.push({ name, value: color || display, ...(color ? { color } : {}) });
  };
  visit(value, [], 0);
  // "Eye color #543423" + "Eye color name Brown" become one swatch entry,
  // and identical left/right readings collapse into one line.
  const out: RawAttribute[] = [];
  for (const item of raw) {
    const base = item.name.replace(/ name$/i, "");
    if (base !== item.name) {
      const swatch = out.find((entry) => entry.name === base && entry.color);
      if (swatch) {
        swatch.value = item.value;
        continue;
      }
    }
    const pair = /^(.*) \((left|right)\)$/.exec(item.name);
    if (pair) {
      const other = out.find(
        (entry) =>
          entry.name ===
          `${pair[1]} (${pair[2] === "left" ? "right" : "left"})`,
      );
      if (other && other.value === item.value) {
        other.name = pair[1];
        continue;
      }
    }
    if (
      !out.some(
        (entry) => entry.name === item.name && entry.value === item.value,
      )
    )
      out.push({ ...item, name: base !== item.name ? base : item.name });
  }
  return out.slice(0, max);
}

/** Every https link in a result, in order, without duplicates. */
export function httpsUrls(value: unknown, max: number) {
  const urls: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (urls.length >= max || depth > 5) return;
    if (typeof node === "string") {
      if (/^https:\/\//i.test(node) && !urls.includes(node)) urls.push(node);
      return;
    }
    if (Array.isArray(node)) node.forEach((item) => visit(item, depth + 1));
    else if (node && typeof node === "object")
      Object.values(node as Record<string, unknown>).forEach((item) =>
        visit(item, depth + 1),
      );
  };
  visit(value, 0);
  return urls;
}

/** A stable pseudo-score from the photo's hash, for simulated mode. */
export function simulatedScore(sha: string, key: string) {
  const hash = createHash("sha256").update(`${sha}:${key}`).digest();
  return 52 + (hash[0] % 41);
}

// --- Structured readers for YouCam's face and color results -------------------

/** Structured YouCam Face Attributes result, with readable two-sided values. */
export type MeasuredFace = Partial<
  Record<
    | "faceShape"
    | "eyeShape"
    | "eyelid"
    | "eyeSize"
    | "eyeAngle"
    | "eyeDistance"
    | "browShape"
    | "browThickness"
    | "browDistance"
    | "lipShape"
    | "noseWidth"
    | "noseLength"
    | "cheekbones",
    string
  >
>;

/** Structured YouCam Facial Color Tones result. Colors are #RRGGBB. */
export type MeasuredColors = Partial<
  Record<
    | "skinColor"
    | "eyeColor"
    | "eyeColorName"
    | "lipColor"
    | "browColor"
    | "hairColor"
    | "hairColorName",
    string
  >
>;

const MEASURED_FACE_LABELS: Record<keyof MeasuredFace, string> = {
  faceShape: "Face shape",
  eyeShape: "Eye shape",
  eyelid: "Eyelid",
  eyeSize: "Eye size",
  eyeAngle: "Eye angle",
  eyeDistance: "Eye spacing",
  browShape: "Brow shape",
  browThickness: "Brow thickness",
  browDistance: "Brow spacing",
  lipShape: "Lip shape",
  noseWidth: "Nose width",
  noseLength: "Nose length",
  cheekbones: "Cheekbones",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function label(value: unknown) {
  if (Array.isArray(value))
    return value
      .filter((item) => typeof item === "string" && item.trim())
      .slice(0, 3)
      .join(", ");
  return typeof value === "string" ? value.trim().slice(0, 40) : "";
}

function sided(left: unknown, right: unknown) {
  const a = label(left);
  const b = label(right);
  if (!a || !b) return a || b;
  return a === b ? a : `${a} (left), ${b} (right)`;
}

function pick(node: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = label(node[key]);
    if (value && !/^unknown$/i.test(value)) return value;
  }
  return "";
}

/** Reads YouCam's face-attr-analysis results (faceshape, eyelid{}, eyebrow{}, ...). */
export function readFaceResults(value: unknown): MeasuredFace {
  const results = record(record(value).results ?? value);
  const eyelid = record(results.eyelid);
  const brow = record(results.eyebrow);
  const nose = record(results.nose);
  const cheek = record(results.cheekbone ?? results.cheekbones);
  const measured: MeasuredFace = {
    faceShape: pick(results, "faceshape", "faceShape", "face_shape"),
    eyeShape: sided(eyelid.left_shape, eyelid.right_shape),
    eyelid: sided(eyelid.left_eyelid, eyelid.right_eyelid),
    eyeSize: pick(eyelid, "size"),
    eyeAngle: sided(eyelid.left_angle, eyelid.right_angle),
    eyeDistance: pick(eyelid, "setting"),
    browShape: sided(brow.left_shape, brow.right_shape),
    browThickness: sided(brow.left_body_thickness, brow.right_body_thickness),
    browDistance: pick(brow, "gap"),
    lipShape: pick(results, "lipshape", "lipShape", "lip_shape"),
    noseWidth: pick(nose, "width"),
    noseLength: pick(nose, "length"),
    // YouCam spells the summary key "overrall" in v2.0 results.
    cheekbones:
      pick(cheek, "overall", "overrall") || sided(cheek.left, cheek.right),
  };
  for (const key of Object.keys(measured) as (keyof MeasuredFace)[])
    if (!measured[key] || /^unknown$/i.test(measured[key]!))
      delete measured[key];
  return measured;
}

/** Reads YouCam's skin-tone-analysis results ({color:{skin_color,...}}). */
export function readToneResults(value: unknown): MeasuredColors {
  const results = record(record(value).results ?? value);
  const color = record(results.color ?? results);
  const measured: MeasuredColors = {
    skinColor: normalizeHex(color.skin_color) || undefined,
    eyeColor: normalizeHex(color.eye_color) || undefined,
    eyeColorName: label(color.eye_color_name) || undefined,
    lipColor: normalizeHex(color.lip_color) || undefined,
    browColor: normalizeHex(color.eyebrow_color) || undefined,
    hairColor: normalizeHex(color.hair_color) || undefined,
    hairColorName: label(color.hair_color_name) || undefined,
  };
  for (const key of Object.keys(measured) as (keyof MeasuredColors)[])
    if (!measured[key]) delete measured[key];
  return measured;
}

export function faceAttributes(measured: MeasuredFace): RawAttribute[] {
  return (Object.keys(MEASURED_FACE_LABELS) as (keyof MeasuredFace)[])
    .filter((key) => measured[key])
    .map((key) => ({ name: MEASURED_FACE_LABELS[key], value: measured[key]! }));
}

export function colorAttributes(measured: MeasuredColors): RawAttribute[] {
  const out: RawAttribute[] = [];
  const add = (name: string, color?: string, named?: string) => {
    if (color) out.push({ name, value: named || color, color });
  };
  add("Skin tone", measured.skinColor);
  add("Eye color", measured.eyeColor, measured.eyeColorName);
  add("Lip color", measured.lipColor);
  add("Brow color", measured.browColor);
  add("Hair color", measured.hairColor, measured.hairColorName);
  return out;
}

/** Deterministic readings for simulated mode (no API key). */
export function simulatedColors(): MeasuredColors {
  return {
    skinColor: "#C99B7A",
    eyeColor: "#4B3621",
    eyeColorName: "Brown",
    lipColor: "#B5656B",
    browColor: "#3F2E24",
    hairColor: "#3B2A20",
    hairColorName: "Brown",
  };
}

const SIMULATED_FACE: Record<string, string> = {
  faceShape: "Oval",
  eyeShape: "Almond",
  eyelid: "Double-lid",
  lipShape: "Full",
  eyebrowShape: "Soft Angled",
  cheekbones: "High Cheekbone",
};

const FEATURE_TO_MEASURED: Record<string, keyof MeasuredFace> = {
  eyebrowShape: "browShape",
  eyebrowThickness: "browThickness",
  eyebrowDistance: "browDistance",
};

export function simulatedFace(features: string[]): MeasuredFace {
  const out: MeasuredFace = {};
  for (const feature of features) {
    // Color features come from the tone analysis, not the face analysis.
    if (/color$/i.test(feature)) continue;
    const key = (FEATURE_TO_MEASURED[feature] || feature) as keyof MeasuredFace;
    if (!(key in MEASURED_FACE_LABELS)) continue;
    out[key] = SIMULATED_FACE[feature] || "Average";
  }
  return out;
}
