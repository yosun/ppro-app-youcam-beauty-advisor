// The YouCam Beauty Advisor's own state: what the `app` object of a session
// holds and what its tools return. Plain types plus a few constant lists, so
// the web app can import it without pulling in any server code.

import type { ImageRef } from "../protocol/types.ts";

export type SkinScore = {
  /** YouCam's key for the concern, e.g. "acne" or "dark_circle_v2". */
  concern: string;
  label: string;
  /** 0 to 100. Higher is healthier. */
  score: number;
  rating: string;
  /** Overlay showing where YouCam measured the concern, when it made one. */
  imageId: string | null;
  /** The target that points at this row: `skin:<concern>`. */
  target: string;
};

export type SkinReport = {
  photoId: string;
  at: number;
  scores: SkinScore[];
  skinType: string | null;
  images: ImageRef[];
  units: number;
  simulated: boolean;
};

export type Attribute = {
  name: string;
  value: string;
  /** `#RRGGBB` when the attribute is a color. */
  color?: string;
  /** `face:<n>` or `tone:<n>`. */
  target: string;
};

export type AttributeReport = {
  photoId: string;
  at: number;
  attributes: Attribute[];
  units: number;
  simulated: boolean;
};

export type TryOnKind = "look" | "makeup" | "full_face";

export type Swatch = { part: string; color: string; finish: string };

export type TryOn = {
  id: string;
  kind: TryOnKind;
  title: string;
  category: string | null;
  imageId: string;
  photoId: string;
  swatches: Swatch[];
  units: number;
  simulated: boolean;
  at: number;
};

/** A curated look from YouCam's catalog. */
export type LookSummary = { id: string; title: string; category: string };

export const PRODUCT_CATEGORIES = [
  "primer",
  "skin tint",
  "foundation",
  "concealer",
  "powder",
  "setting spray",
  "bronzer",
  "contour",
  "blush",
  "highlighter",
  "brow",
  "eyeshadow",
  "eyeliner",
  "mascara",
  "lashes",
  "lip liner",
  "lipstick",
  "lip tint",
  "lip gloss",
  "lip balm",
  "cleanser",
  "moisturizer",
  "sunscreen",
  "serum",
  "brush or tool",
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const PRODUCT_TIERS = ["drugstore", "mid-range", "prestige"] as const;
export type ProductTier = (typeof PRODUCT_TIERS)[number];

export type ProductPick = {
  category: ProductCategory;
  brand: string;
  name: string;
  /** Empty when the product has no shades. */
  shade: string;
  why: string;
  tier: ProductTier;
  /** Present only when the operator configured a search-link template. */
  url?: string;
  /** `pick:<n>`. */
  target: string;
};

export const SHADE_AREAS = ["lips", "cheeks", "eyes", "face", "brows"] as const;
export type ShadeArea = (typeof SHADE_AREAS)[number];

export type CardShade = { label: string; hex: string; area: ShadeArea | null };

export type CardImage = { id: string; alt: string; caption: string };

/** The look the advisor presents: drives the Look, Steps and Shades screens. */
export type LookCard = {
  title: string;
  /** A neutral restatement of the client's question, never their raw words. */
  question: string | null;
  steps: string[];
  shades: CardShade[];
  /** The try-on result, shown as the "after". */
  image: CardImage | null;
  /** The client's own photo, shown as the "before" on their device only. */
  before: CardImage | null;
  disclaimer: string;
  at: number;
};

/** Facts measured so far that later tools use (skin color shades a contour). */
export type Measurements = {
  skinColor: string | null;
  faceShape: string | null;
};

/** The `app` object of a session. */
export type BeautyState = {
  skin: SkinReport | null;
  face: AttributeReport | null;
  tone: AttributeReport | null;
  tryOns: TryOn[];
  looks: LookSummary[];
  picks: ProductPick[];
  card: LookCard | null;
  measurements: Measurements;
};

/** App-defined UI view state (`ui.view`). */
export type BeautyView = {
  /** Before-and-after slider position, 0 to 100, or null for the default. */
  compare: number | null;
};

/** The kinds the app adds to transcript entries made by its tools. */
export type BeautyMessageKind =
  "analysis" | "try_on" | "looks" | "picks" | "card" | "notice";

export function emptyBeautyState(): BeautyState {
  return {
    skin: null,
    face: null,
    tone: null,
    tryOns: [],
    looks: [],
    picks: [],
    card: null,
    measurements: { skinColor: null, faceShape: null },
  };
}

export const EMPTY_VIEW: BeautyView = { compare: null };
