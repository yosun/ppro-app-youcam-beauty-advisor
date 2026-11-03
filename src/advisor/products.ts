import { z } from "zod";
import { envString } from "../support/env.ts";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_TIERS,
  type ProductPick,
} from "./types.ts";

// Product picks: the specific products and shades a beauty professional would
// put in this client's kit. The agent names them; this module cleans them.
//
// Stored picks never contain a link. A link is added only when the operator
// configures PPRO_PRODUCT_LINK_TEMPLATE (an https URL containing {query}, for
// example a retailer search page), so the agent can never point a client at an
// address of its own choosing.

export type PickInput = Omit<ProductPick, "target" | "url">;

/** One pick as an agent writes it. The tool publishes this as JSON Schema. */
export const pickSchema = z
  .object({
    category: z.enum(PRODUCT_CATEGORIES),
    brand: z.string().max(200),
    name: z.string().max(300).describe("Product name without the brand."),
    shade: z
      .string()
      .max(200)
      .default("")
      .describe("Exact shade name or number. Empty if the product has none."),
    why: z.string().max(800),
    tier: z.enum(PRODUCT_TIERS),
  })
  .strict();

// Prescription drugs, procedures and anything sexual never appear as a pick.
// Shade and product names like "Nude" or "Naked" are ordinary makeup words.
const UNSAFE_PICK =
  /\b(?:prescription|rx-only|tretinoin|accutane|isotretinoin|hydroquinone|steroid|botox|filler|injectable|surgery|weight loss|diet pills?|porn\w*|fetish|genitals?)\b/i;
const INSTRUCTION_LIKE =
  /\b(ignore (all|any|previous)|system prompt|jailbreak|developer mode)\b/i;

// Prices are never shown: a model's guess would be stale. The tier stands in
// for price. A price or link goes together with the little words that lead
// into it.
const LEAD = String.raw`(?:\b(?:for|at|around|about|under|only|just|roughly|on|from|via)\s+)*`;
const PRICE = new RegExp(
  String.raw`${LEAD}(?:us\$|usd\s?|\$)\s?\d[\d.,]*(?:\s?(?:-|–|to)\s?\$?\d[\d.,]*)?|${LEAD}\b\d[\d.,]*\s?(?:dollars|bucks)\b`,
  "gi",
);
const LINK = new RegExp(
  String.raw`${LEAD}(?:https?:\/\/\S+|www\.\S+|\S+\.(?:com|net|org|co)\b\S*)`,
  "gi",
);

function clean(value: string, max: number) {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(LINK, "")
      .replace(PRICE, "")
      .replace(/[<>{}[\]\\`*_|~^$]/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,;:!?])/g, "$1")
      .replace(/,\s*([.!?]|$)/g, "$1")
      .trim()
      .slice(0, max)
      .trim()
  );
}

/** "Maybelline" + "Maybelline Fit Me" -> "Fit Me". */
function withoutBrand(name: string, brand: string) {
  return name.toLowerCase().startsWith(`${brand.toLowerCase()} `)
    ? name.slice(brand.length).trim()
    : name;
}

/**
 * Cleans agent-written picks and drops incomplete, unsafe and duplicate ones.
 * Brand, name and shade keep their casing.
 */
export function acceptedProducts(raw: unknown, max: number): PickInput[] {
  if (!Array.isArray(raw)) return [];
  const picks: PickInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = pickSchema.safeParse(item);
    if (!parsed.success) continue;
    const brand = clean(parsed.data.brand, 40);
    const name = withoutBrand(clean(parsed.data.name, 120), brand).slice(0, 80);
    const shade = clean(parsed.data.shade, 48).replace(/^(?:n\/a|none)$/i, "");
    const why = clean(parsed.data.why, 220);
    if (!brand || !name || !why) continue;
    if (
      [brand, name, shade, why].some(
        (text) => UNSAFE_PICK.test(text) || INSTRUCTION_LIKE.test(text),
      )
    )
      continue;
    const key = `${brand}|${name}|${shade}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({
      category: parsed.data.category,
      brand,
      name,
      shade,
      why,
      tier: parsed.data.tier,
    });
    if (picks.length >= max) break;
  }
  return picks;
}

/** The operator's link template, or null when none is configured. */
export function productLinkTemplate(): string | null {
  const template = envString("PPRO_PRODUCT_LINK_TEMPLATE");
  if (!template || !template.startsWith("https://")) return null;
  return template.includes("{query}") ? template : null;
}

/** A search link for one pick, or null without a configured template. */
export function productLink(
  pick: PickInput,
  template = productLinkTemplate(),
): string | null {
  if (!template) return null;
  const query = [pick.brand, pick.name, pick.shade]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}&'’+.!#\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  if (!query) return null;
  return template.replace("{query}", encodeURIComponent(query));
}

/** A pick as one plain-text line, for transcripts (never with a link). */
export function productLine(pick: PickInput) {
  return `${pick.brand} ${pick.name}${pick.shade ? ` (${pick.shade})` : ""} · ${pick.category} · ${pick.tier}: ${pick.why}`;
}
