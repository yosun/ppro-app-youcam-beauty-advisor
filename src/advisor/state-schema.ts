import { z } from "zod";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_TIERS,
  SHADE_AREAS,
  type BeautyState,
  type BeautyView,
} from "./types.ts";

// Zod schemas for the advisor's session state. They are the source of the
// `state` JSON Schema in the manifest and let tests check that a real session
// matches what the manifest promises. The assertions at the bottom make the
// build fail if a schema and its TypeScript type ever drift apart.

const imageRef = z.object({ id: z.string(), label: z.string() });

const skinScore = z.object({
  concern: z.string().describe("YouCam's key, for example acne."),
  label: z.string(),
  score: z.number().min(0).max(100).describe("0 to 100, higher is healthier."),
  rating: z.string(),
  imageId: z.string().nullable(),
  target: z.string().describe("skin:<concern>"),
});

const skinReport = z.object({
  photoId: z.string(),
  at: z.number(),
  scores: z
    .array(skinScore)
    .describe("Sorted so what needs the most care comes first."),
  skinType: z.string().nullable(),
  images: z.array(imageRef),
  units: z.number(),
  simulated: z.boolean(),
});

const attribute = z.object({
  name: z.string(),
  value: z.string(),
  color: z.string().optional().describe("#RRGGBB when the value is a color."),
  target: z.string().describe("face:<n> or tone:<n>"),
});

const attributeReport = z.object({
  photoId: z.string(),
  at: z.number(),
  attributes: z.array(attribute),
  units: z.number(),
  simulated: z.boolean(),
});

const swatch = z.object({
  part: z.string(),
  color: z.string(),
  finish: z.string(),
});

const tryOn = z.object({
  id: z.string(),
  kind: z.enum(["look", "makeup", "full_face"]),
  title: z.string(),
  category: z.string().nullable(),
  imageId: z.string(),
  photoId: z.string(),
  swatches: z.array(swatch),
  units: z.number(),
  simulated: z.boolean(),
  at: z.number(),
});

const lookSummary = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
});

const pick = z.object({
  category: z.enum(PRODUCT_CATEGORIES),
  brand: z.string(),
  name: z.string(),
  shade: z.string(),
  why: z.string(),
  tier: z.enum(PRODUCT_TIERS),
  url: z.string().optional(),
  target: z.string().describe("pick:<n>"),
});

const cardImage = z.object({
  id: z.string(),
  alt: z.string(),
  caption: z.string(),
});

const lookCard = z.object({
  title: z.string(),
  question: z.string().nullable(),
  steps: z.array(z.string()),
  shades: z.array(
    z.object({
      label: z.string(),
      hex: z.string(),
      area: z.enum(SHADE_AREAS).nullable(),
    }),
  ),
  image: cardImage.nullable().describe("The try-on, shown as the after."),
  before: cardImage
    .nullable()
    .describe("The client's own photo, shown as the before."),
  disclaimer: z.string(),
  at: z.number(),
});

export const beautyStateSchema = z.object({
  skin: skinReport.nullable(),
  face: attributeReport.nullable(),
  tone: attributeReport.nullable(),
  tryOns: z.array(tryOn),
  looks: z.array(lookSummary),
  picks: z.array(pick),
  card: lookCard.nullable(),
  measurements: z.object({
    skinColor: z.string().nullable(),
    faceShape: z.string().nullable(),
  }),
});

export const beautyViewSchema = z.object({
  compare: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .describe(
      "Before-and-after divider position from the left, 0 to 100, or null for the default.",
    ),
});

// Compile-time drift checks: each schema's type and the TypeScript type must
// be assignable to each other.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const _stateMatchesType: Mutual<
  z.infer<typeof beautyStateSchema>,
  BeautyState
> = true;
export const _viewMatchesType: Mutual<
  z.infer<typeof beautyViewSchema>,
  BeautyView
> = true;
