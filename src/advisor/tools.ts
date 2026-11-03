import { z } from "zod";
import {
  defineTool,
  type RegisteredTool,
  type StoredPhoto,
  type ToolContext,
  type ToolDefinition,
  type ToolRun,
} from "../protocol/app-definition.ts";
import {
  DISCLAIMER,
  LIMITS,
  UNITS,
  faceAttributeUnits,
  skinAnalysisUnits,
} from "../protocol/constants.ts";
import { ApiError } from "../protocol/errors.ts";
import { newId } from "../protocol/ids.ts";
import { cleanDisplayLine, normalizeHex } from "../protocol/text.ts";
import type { ImageRef } from "../protocol/types.ts";
import {
  DEFAULT_FACE_FEATURES,
  DEFAULT_SKIN_CONCERNS,
  FACE_FEATURES,
  LOOK_CATEGORIES,
  SIMULATED_LOOKS,
  SKIN_CONCERNS,
  colorAttributes,
  faceAttributes,
  flattenAttributes,
  httpsUrls,
  humanize,
  isSensitiveKey,
  readFaceResults,
  readToneResults,
  simulatedColors,
  simulatedFace,
  simulatedScore,
  skinRating,
  type MeasuredColors,
  type MeasuredFace,
  type RawAttribute,
  type SkinConcern,
} from "./analysis.ts";
import { youcamSourceJpeg, simulatedResultImage } from "./images.ts";
import { releaseYouCamTask, reserveYouCamTask } from "./limits.ts";
import {
  EYELINER_PATTERNS,
  EYESHADOW_PATTERNS,
  LASH_PATTERNS,
  makeupMenuText,
  parseRecipe,
  recipeEffects,
} from "./makeup.ts";
import { acceptedProducts, pickSchema, productLink } from "./products.ts";
import {
  SHADE_AREAS,
  type Attribute,
  type AttributeReport,
  type BeautyState,
  type BeautyView,
  type LookCard,
  type ProductPick,
  type SkinReport,
  type SkinScore,
  type Swatch,
  type TryOn,
} from "./types.ts";
import {
  YouCamError,
  youcamDownloadImage,
  youcamLookTemplates,
  youcamPhotoProblem,
  youcamTask,
  youcamUploadJpeg,
  type YouCamLook,
} from "./youcam.ts";

// The YouCam Beauty Advisor's tools. An agent calls them by name; each one
// validates its arguments (a Zod schema that is also published as JSON
// Schema), spends from the session's YouCam budget, calls YouCam (or a
// deterministic simulation when no API key is set), and returns two views of
// the outcome: a compact result for the agent and a transcript entry the
// client sees. Tools reach the session only through `ToolContext`.

type Ctx = ToolContext<BeautyState, BeautyView>;
type Run = ToolRun<BeautyState, BeautyView>;
type Tool = RegisteredTool<BeautyState, BeautyView>;

function tool<Args>(
  definition: ToolDefinition<BeautyState, BeautyView, Args>,
): Tool {
  return defineTool(definition);
}

// --- Outcomes -----------------------------------------------------------------

class ToolFail extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: string;
  readonly visible: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; detail?: string; visible?: boolean } = {},
  ) {
    super(message);
    this.name = "ToolFail";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
    this.visible = options.visible ?? false;
  }
}

/** A failed run. `visible` also shows the message to the client as a notice. */
function failed(error: ToolFail): Run {
  return {
    ok: false,
    result: {},
    error: {
      code: error.code,
      message: error.message,
      ...(error.retryable ? { retryable: true } : {}),
      ...(error.detail ? { detail: error.detail } : {}),
    },
    ...(error.visible
      ? { entry: { kind: "notice", body: error.message } }
      : {}),
  };
}

async function guard(name: string, work: () => Promise<Run> | Run) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ToolFail) return failed(error);
    if (error instanceof YouCamError) {
      if (youcamPhotoProblem(error.code))
        return failed(
          new ToolFail("photo_problem", error.message, {
            detail: error.code.slice(0, 60),
            visible: true,
          }),
        );
      return failed(
        new ToolFail(error.code.slice(0, 60) || "tool_error", error.message, {
          retryable: error.retryable,
          visible: true,
        }),
      );
    }
    if (error instanceof ApiError && error.status === 429)
      return failed(
        new ToolFail(
          "daily_limit",
          "YouCam analysis has reached today's limit. Continue with general advice.",
          { visible: true },
        ),
      );
    console.error(
      JSON.stringify({
        event: "tool_failed",
        tool: name,
        error: error instanceof Error ? error.name : "Error",
      }),
    );
    return failed(
      new ToolFail("tool_error", "That analysis could not finish. Try again.", {
        retryable: true,
        visible: true,
      }),
    );
  }
}

// --- Shared steps --------------------------------------------------------------

function requirePhoto(ctx: Ctx, photoId: string | undefined): StoredPhoto {
  if (photoId && !ctx.hasPhoto(photoId))
    throw new ToolFail(
      "unknown_photo",
      "That photo id is not in this session. Omit photo_id to use the latest photo.",
    );
  const photo = ctx.photo(photoId);
  if (!photo)
    throw new ToolFail(
      "no_photo",
      "No photo yet. Ask the client to share a clear, front-facing selfie (call ui_request_photo).",
    );
  return photo;
}

async function youcamFileFor(ctx: Ctx, photo: StoredPhoto): Promise<string> {
  if (
    photo.providerFileId &&
    photo.providerFileAt &&
    Date.now() - photo.providerFileAt < 20 * 60_000
  )
    return photo.providerFileId;
  const fileId = await youcamUploadJpeg(
    await youcamSourceJpeg(Buffer.from(photo.jpeg)),
    `${photo.id}.jpg`,
  );
  ctx.rememberProviderFile(photo.id, fileId);
  return fileId;
}

/**
 * Runs one YouCam task, counting it against the daily cap and giving the count
 * back when the task never reached YouCam.
 */
async function runYouCamTask(
  ctx: Ctx,
  photo: StoredPhoto,
  feature: Parameters<typeof youcamTask>[0],
  body: (fileId: string) => Record<string, unknown>,
) {
  reserveYouCamTask();
  try {
    const fileId = await youcamFileFor(ctx, photo);
    return await youcamTask(feature, body(fileId));
  } catch (error) {
    if (!(error instanceof YouCamError) || error.code === "not_configured")
      releaseYouCamTask();
    throw error;
  }
}

async function saveRemoteImages(
  ctx: Ctx,
  items: { url: string; label: string }[],
  photoId: string,
): Promise<ImageRef[]> {
  const saved: ImageRef[] = [];
  for (let index = 0; index < items.length; index += 3) {
    const batch = await Promise.all(
      items.slice(index, index + 3).map(async ({ url, label }) => {
        try {
          const bytes = await youcamDownloadImage(url);
          const id = await ctx.saveImage(bytes, label, photoId);
          return id ? { id, label } : null;
        } catch {
          return null;
        }
      }),
    );
    for (const item of batch) if (item) saved.push(item);
  }
  return saved;
}

async function lookCatalog(ctx: Ctx): Promise<YouCamLook[]> {
  return ctx.engine === "live" ? youcamLookTemplates() : SIMULATED_LOOKS;
}

const simulated = (ctx: Ctx) => ctx.engine !== "live";

// --- Schemas -------------------------------------------------------------------

const photoId = z
  .string()
  .max(64)
  .optional()
  .describe("A specific shared photo. Omit to use the latest photo.");

const hexColor = z
  .string()
  .regex(/^#?[0-9A-Fa-f]{6}$/, "Use a color like #C9677B.");

const concernKeys = Object.keys(SKIN_CONCERNS) as [
  SkinConcern,
  ...SkinConcern[],
];
const featureKeys = Object.keys(FACE_FEATURES) as [
  keyof typeof FACE_FEATURES,
  ...(keyof typeof FACE_FEATURES)[],
];

const unique = <T>(items: T[]) => [...new Set(items)];

// --- Analysis ------------------------------------------------------------------

const analyzeSkinInput = z
  .object({
    concerns: z
      .array(z.enum(concernKeys))
      .max(16)
      .optional()
      .describe(
        "Concerns to score. Omit for the standard set of 8 (acne, pore, texture, wrinkle, redness, oiliness, moisture, dark_circle_v2).",
      ),
    photo_id: photoId,
  })
  .strict()
  .transform((args) => ({
    photo_id: args.photo_id,
    concerns: unique(
      args.concerns?.length ? args.concerns : DEFAULT_SKIN_CONCERNS,
    ),
  }));

const analyzeSkin = tool({
  name: "analyze_skin",
  title: "Skin analysis",
  description:
    "Run YouCam AI Skin Analysis on the client's photo. Returns a 0-100 score per concern (higher is healthier) and overlay images the client can see on their Skin screen. Costs 9-16 units depending on how many concerns. The face must fill most of the photo (over 60% of its width) or YouCam refuses it; a photo_problem error says how the client should retake it.",
  group: "analysis",
  cost: "9-16 units",
  input: analyzeSkinInput,
  needsPhoto: true,
  usesEngine: true,
  units: (args) => skinAnalysisUnits(args.concerns.length),
  run: (ctx, args) =>
    guard("analyze_skin", async () => {
      const photo = requirePhoto(ctx, args.photo_id);
      const units = skinAnalysisUnits(args.concerns.length);
      type Item = {
        type: string;
        score: number | null;
        details: Record<string, string>;
        urls: string[];
      };
      let results: Item[];
      if (!simulated(ctx)) {
        const { data } = await runYouCamTask(
          ctx,
          photo,
          "skin-analysis",
          (fileId) => ({
            src_file_id: fileId,
            dst_actions: args.concerns,
            miniserver_args: { enable_mask_overlay: true },
            format: "json",
          }),
        );
        const output = recordOf(data.results).output;
        results = (Array.isArray(output) ? output : []).map((raw) => {
          const item = recordOf(raw);
          const score = Number(item.ui_score);
          const details: Record<string, string> = {};
          for (const [key, value] of Object.entries(item))
            if (
              ![
                "type",
                "ui_score",
                "raw_score",
                "mask_urls",
                "output_mask_name",
              ].includes(key) &&
              !isSensitiveKey(key) &&
              (typeof value === "string" || typeof value === "number") &&
              String(value).length <= 60 &&
              !/^https?:/i.test(String(value))
            )
              details[key] = String(value);
          return {
            type: String(item.type || ""),
            score: Number.isFinite(score) ? Math.round(score) : null,
            details,
            urls: Array.isArray(item.mask_urls)
              ? item.mask_urls
                  .filter((url): url is string => typeof url === "string")
                  .slice(0, 1)
              : [],
          };
        });
      } else {
        results = args.concerns.map((type): Item => ({
          type,
          score:
            type === "skin_type" ? null : simulatedScore(photo.sha256, type),
          details: type === "skin_type" ? { skin_type: "combination" } : {},
          urls: [],
        }));
      }
      const known = results.filter((item) => item.type in SKIN_CONCERNS);
      const images: ImageRef[] = await saveRemoteImages(
        ctx,
        known
          .filter((item) => item.urls.length)
          .slice(0, 8)
          .map((item) => ({
            url: item.urls[0],
            label: `${humanize(item.type)} overlay`,
          })),
        photo.id,
      );
      if (simulated(ctx)) {
        const id = await ctx.saveImage(
          await simulatedResultImage(photo.jpeg, "#C1121F", 0.14),
          "Simulated skin overlay (demo)",
          photo.id,
        );
        if (id) images.push({ id, label: "Simulated skin overlay (demo)" });
      }
      const scores: SkinScore[] = known
        // Skin type is a label ("oily"), not a score, whatever number comes with it.
        .filter((item) => item.score !== null && item.type !== "skin_type")
        .map((item) => ({
          concern: item.type,
          label: humanize(item.type),
          score: item.score as number,
          rating: skinRating(item.score as number),
          imageId:
            images.find(
              (image) => image.label === `${humanize(item.type)} overlay`,
            )?.id ?? null,
          target: `skin:${item.type}`,
        }))
        // What needs the most care first.
        .sort((a, b) => a.score - b.score);
      const skinType = known.find((item) => item.type === "skin_type");
      const skinTypeLabel =
        (skinType &&
          (Object.values(skinType.details)[0] ||
            (skinType.score !== null ? String(skinType.score) : ""))) ||
        null;
      if (!scores.length && !skinTypeLabel)
        throw new ToolFail(
          "no_results",
          "YouCam returned no skin scores for that photo. Ask for a closer, evenly lit, front-facing selfie.",
          { retryable: true },
        );
      const report: SkinReport = {
        photoId: photo.id,
        at: Date.now(),
        scores,
        skinType: skinTypeLabel,
        images,
        units,
        simulated: simulated(ctx),
      };
      return {
        ok: true,
        units,
        result: {
          photo_id: photo.id,
          scores: scores.map(({ label, score, rating, target }) => ({
            label,
            score,
            rating,
            target,
          })),
          ...(skinTypeLabel ? { skin_type: skinTypeLabel } : {}),
          needs_most_care: scores.slice(0, 3).map((item) => item.label),
          healthiest: scores
            .slice(-3)
            .reverse()
            .map((item) => item.label),
          shown_to_client: "Skin screen",
          simulated: report.simulated,
        },
        entry: {
          kind: "analysis",
          body: `YouCam skin analysis · ${scores.length} concern${scores.length === 1 ? "" : "s"} scored`,
          data: { tool: "analyze_skin", title: "Skin analysis", report },
        },
        patch: (state) => {
          state.skin = report;
        },
        ui: { nudge: { target: "skin", label: "Skin report", at: Date.now() } },
      };
    }),
});

function attributeReport(
  ctx: Ctx,
  photo: StoredPhoto,
  section: "face" | "tone",
  attributes: RawAttribute[],
  units: number,
): AttributeReport {
  return {
    photoId: photo.id,
    at: Date.now(),
    attributes: attributes.map((attribute, index): Attribute => ({
      ...attribute,
      target: `${section}:${index}`,
    })),
    units,
    simulated: simulated(ctx),
  };
}

const analyzeFaceInput = z
  .object({
    features: z
      .array(z.enum(featureKeys))
      .max(14)
      .optional()
      .describe(
        "Features to read. Omit for face, eye, lip and brow shape plus cheekbones. Colors come from analyze_skin_tone.",
      ),
    photo_id: photoId,
  })
  .strict()
  .transform((args) => ({
    photo_id: args.photo_id,
    features: unique(
      args.features?.length ? args.features : DEFAULT_FACE_FEATURES,
    ),
  }));

const analyzeFace = tool({
  name: "analyze_face",
  title: "Face shape and features",
  description:
    "Run YouCam AI Face Attribute analysis on the client's photo: face shape and eye, eyelid, brow, lip, nose and cheekbone shapes. Results appear on the client's Face screen. Costs 10 units for up to 5 features and 20 for 6-14.",
  group: "analysis",
  cost: "10-20 units",
  input: analyzeFaceInput,
  needsPhoto: true,
  usesEngine: true,
  units: (args) => faceAttributeUnits(args.features.length),
  run: (ctx, args) =>
    guard("analyze_face", async () => {
      const photo = requirePhoto(ctx, args.photo_id);
      const units = faceAttributeUnits(args.features.length);
      let measured: MeasuredFace;
      let attributes: RawAttribute[];
      if (!simulated(ctx)) {
        const { data } = await runYouCamTask(
          ctx,
          photo,
          "face-attr-analysis",
          (fileId) => ({
            src_file_id: fileId,
            face_angle_strictness_level: "medium",
            features: args.features,
          }),
        );
        const results = data.results ?? data;
        measured = readFaceResults(results);
        attributes = faceAttributes(measured);
        // An unfamiliar result layout still shows what YouCam returned.
        if (!attributes.length) attributes = flattenAttributes(results);
      } else {
        measured = simulatedFace(args.features);
        attributes = faceAttributes(measured);
      }
      if (!attributes.length)
        throw new ToolFail(
          "no_results",
          "YouCam could not read facial features in that photo. Ask for a straight-on selfie in even light.",
          { retryable: true },
        );
      const report = attributeReport(ctx, photo, "face", attributes, units);
      return {
        ok: true,
        units,
        result: {
          photo_id: photo.id,
          attributes: report.attributes.map(({ name, value, target }) => ({
            name,
            value,
            target,
          })),
          shown_to_client: "Face screen",
          simulated: report.simulated,
        },
        entry: {
          kind: "analysis",
          body: "YouCam face shape and features",
          data: {
            tool: "analyze_face",
            title: "Face shape & features",
            report,
          },
        },
        patch: (state) => {
          state.face = report;
          if (measured.faceShape)
            state.measurements.faceShape = measured.faceShape;
        },
        ui: { nudge: { target: "face", label: "Face shape", at: Date.now() } },
      };
    }),
});

const analyzeSkinTone = tool({
  name: "analyze_skin_tone",
  title: "Skin tone and colors",
  description:
    "Run YouCam AI Facial Color Tones analysis on the client's photo: skin tone and eye, lip, brow and hair colors as exact #RRGGBB values, useful for foundation and lipstick shade matching. Results appear on the client's Face screen. Costs 20 units. Hair color drifts under warm light, so prefer the other colors.",
  group: "analysis",
  cost: "20 units",
  input: z.object({ photo_id: photoId }).strict(),
  needsPhoto: true,
  usesEngine: true,
  units: () => UNITS.skinTone,
  run: (ctx, args) =>
    guard("analyze_skin_tone", async () => {
      const photo = requirePhoto(ctx, args.photo_id);
      let measured: MeasuredColors;
      let attributes: RawAttribute[];
      if (!simulated(ctx)) {
        const { data } = await runYouCamTask(
          ctx,
          photo,
          "skin-tone-analysis",
          (fileId) => ({
            src_file_id: fileId,
            face_angle_strictness_level: "medium",
          }),
        );
        const results = data.results ?? data;
        measured = readToneResults(results);
        attributes = colorAttributes(measured);
        if (!attributes.length) attributes = flattenAttributes(results);
      } else {
        measured = simulatedColors();
        attributes = colorAttributes(measured);
      }
      if (!attributes.length)
        throw new ToolFail(
          "no_results",
          "YouCam could not read facial colors in that photo. Ask for a straight-on selfie in even light.",
          { retryable: true },
        );
      const report = attributeReport(
        ctx,
        photo,
        "tone",
        attributes,
        UNITS.skinTone,
      );
      return {
        ok: true,
        units: UNITS.skinTone,
        result: {
          photo_id: photo.id,
          attributes: report.attributes.map(
            ({ name, value, color, target }) => ({
              name,
              value,
              ...(color ? { color } : {}),
              target,
            }),
          ),
          shown_to_client: "Face screen",
          simulated: report.simulated,
        },
        entry: {
          kind: "analysis",
          body: "YouCam skin tone and facial colors",
          data: {
            tool: "analyze_skin_tone",
            title: "Skin tone & colors",
            report,
          },
        },
        patch: (state) => {
          state.tone = report;
          if (measured.skinColor)
            state.measurements.skinColor = measured.skinColor;
        },
        ui: { nudge: { target: "tone", label: "Skin tone", at: Date.now() } },
      };
    }),
});

// --- Looks and try-ons -----------------------------------------------------------

const listMakeupLooks = tool({
  name: "list_makeup_looks",
  title: "Browse makeup looks",
  description:
    "Browse YouCam's curated full-face makeup looks. Free. Returns look ids and titles to suggest; apply one with try_on_look.",
  group: "analysis",
  cost: "free",
  readOnly: true,
  input: z
    .object({
      category: z.enum(LOOK_CATEGORIES).optional(),
      search: z
        .string()
        .max(60)
        .optional()
        .describe("Optional words to match in look titles."),
    })
    .strict(),
  run: (ctx, args) =>
    guard("list_makeup_looks", async () => {
      const catalog = await lookCatalog(ctx);
      const category = args.category?.toLowerCase();
      const words = (args.search ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      let looks = catalog.filter(
        (look) =>
          (!category || look.category.toLowerCase() === category) &&
          words.every((word) => look.title.toLowerCase().includes(word)),
      );
      if (!looks.length)
        looks = catalog.filter((look) => look.category === "Daily");
      looks = looks.slice(0, 12);
      return {
        ok: true,
        units: 0,
        result: { looks, hint: "Apply one with try_on_look(look_id)." },
        entry: {
          kind: "looks",
          body: `YouCam looks${category ? ` · ${looks[0]?.category || args.category}` : ""}`,
          data: { tool: "list_makeup_looks", looks },
        },
        patch: (state) => {
          state.looks = looks;
        },
      };
    }),
});

async function tryOnResult(
  ctx: Ctx,
  options: {
    photo: StoredPhoto;
    url: string | undefined;
    label: string;
    washHex: string;
  },
): Promise<string> {
  let imageId: string | null;
  if (!simulated(ctx)) {
    if (!options.url)
      throw new ToolFail("no_results", "YouCam returned no try-on image.", {
        retryable: true,
      });
    imageId =
      (
        await saveRemoteImages(
          ctx,
          [{ url: options.url, label: options.label }],
          options.photo.id,
        )
      )[0]?.id ?? null;
  } else {
    imageId = await ctx.saveImage(
      await simulatedResultImage(options.photo.jpeg, options.washHex),
      `${options.label} (demo)`,
      options.photo.id,
    );
  }
  if (!imageId)
    throw new ToolFail("save_failed", "The try-on image could not be saved.", {
      retryable: true,
    });
  return imageId;
}

function tryOnRun(tryOn: TryOn, extra: Record<string, unknown>): Run {
  return {
    ok: true,
    units: tryOn.units,
    result: {
      try_on_id: tryOn.id,
      image_id: tryOn.imageId,
      ...extra,
      shown_to_client: "Chat",
      simulated: tryOn.simulated,
      next: "Use present_look with this image_id to put the look on the Look, Steps and Shades screens.",
    },
    entry: {
      kind: "try_on",
      body: `YouCam try-on · ${tryOn.title}`,
      data: { tool: tryOn.kind, title: tryOn.title, tryOn },
    },
    patch: (state) => {
      state.tryOns = [...state.tryOns, tryOn].slice(-12);
    },
  };
}

const tryOnLook = tool({
  name: "try_on_look",
  title: "Try on a curated look",
  description:
    "Apply one curated YouCam makeup look (an id from list_makeup_looks) to the client's photo. The client sees the result image in the chat. Costs 2 units.",
  group: "analysis",
  cost: "2 units",
  input: z
    .object({
      look_id: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
      photo_id: photoId,
    })
    .strict(),
  needsPhoto: true,
  usesEngine: true,
  units: () => UNITS.lookTryOn,
  run: (ctx, args) =>
    guard("try_on_look", async () => {
      const look = (await lookCatalog(ctx)).find(
        (item) => item.id === args.look_id,
      );
      if (!look)
        throw new ToolFail(
          "unknown_look",
          "Unknown look id. Use an id returned by list_makeup_looks.",
        );
      const photo = requirePhoto(ctx, args.photo_id);
      let url: string | undefined;
      if (!simulated(ctx)) {
        const { data } = await runYouCamTask(
          ctx,
          photo,
          "look-vto",
          (fileId) => ({ src_file_id: fileId, template_id: look.id }),
        );
        [url] = httpsUrls(data.results ?? data, 1);
      }
      const imageId = await tryOnResult(ctx, {
        photo,
        url,
        label: `Look: ${look.title}`,
        washHex: "#C9677B",
      });
      const tryOn: TryOn = {
        id: newId("try"),
        kind: "look",
        title: look.title,
        category: look.category,
        imageId,
        photoId: photo.id,
        swatches: [],
        units: UNITS.lookTryOn,
        simulated: simulated(ctx),
        at: Date.now(),
      };
      return tryOnRun(tryOn, {
        applied: look.title,
        category: look.category,
      });
    }),
});

const tryOnMakeup = tool({
  name: "try_on_makeup",
  title: "Try on custom colors",
  description:
    "Virtually apply custom makeup colors to the client's photo with YouCam Makeup Virtual Try-On. Give at least one of lip_color, blush_color or eyeshadow_color as #RRGGBB. For a complete look (eyes, liner, lashes, contour) use try_on_full_look instead. Costs 1 unit.",
  group: "analysis",
  cost: "1 unit",
  input: z
    .object({
      lip_color: hexColor.optional(),
      lip_finish: z.enum(["matte", "satin", "gloss", "sheer"]).optional(),
      blush_color: hexColor.optional(),
      eyeshadow_color: hexColor.optional(),
      eyeshadow_finish: z.enum(["matte", "shimmer"]).optional(),
      intensity: z.enum(["soft", "medium", "bold"]).optional(),
      photo_id: photoId,
    })
    .strict(),
  needsPhoto: true,
  usesEngine: true,
  units: () => UNITS.makeupTryOn,
  run: (ctx, args) =>
    guard("try_on_makeup", async () => {
      const { effects, swatches } = makeupEffects(args);
      if (!effects.length)
        throw new ToolFail(
          "no_effects",
          "Give at least one of lip_color, blush_color or eyeshadow_color as #RRGGBB.",
        );
      const photo = requirePhoto(ctx, args.photo_id);
      const label = `Makeup: ${swatches.map((item) => `${item.part.toLowerCase()} ${item.color}`).join(", ")}`;
      let url: string | undefined;
      if (!simulated(ctx)) {
        const { data } = await runYouCamTask(
          ctx,
          photo,
          "makeup-vto",
          (fileId) => ({ src_file_id: fileId, version: "1.0", effects }),
        );
        [url] = httpsUrls(data.results ?? data, 1);
      }
      const imageId = await tryOnResult(ctx, {
        photo,
        url,
        label,
        washHex: swatches[0].color,
      });
      const tryOn: TryOn = {
        id: newId("try"),
        kind: "makeup",
        title: "Custom makeup",
        category: null,
        imageId,
        photoId: photo.id,
        swatches,
        units: UNITS.makeupTryOn,
        simulated: simulated(ctx),
        at: Date.now(),
      };
      return tryOnRun(tryOn, { applied: swatches });
    }),
});

/** Single-color lip, blush and eyeshadow effects for `try_on_makeup`. */
export function makeupEffects(args: {
  lip_color?: string;
  lip_finish?: string;
  blush_color?: string;
  eyeshadow_color?: string;
  eyeshadow_finish?: string;
  intensity?: string;
}) {
  const strength =
    { soft: 40, medium: 60, bold: 80 }[String(args.intensity)] ?? 60;
  const effects: Record<string, unknown>[] = [];
  const swatches: Swatch[] = [];
  const lip = normalizeHex(args.lip_color);
  if (lip) {
    const finish = ["matte", "satin", "gloss", "sheer"].includes(
      String(args.lip_finish),
    )
      ? String(args.lip_finish)
      : "satin";
    effects.push({
      category: "lip_color",
      shape: { name: "original" },
      style: { type: "full" },
      palettes: [
        {
          color: lip,
          texture: finish,
          colorIntensity: strength,
          ...(finish === "gloss" || finish === "sheer"
            ? { gloss: 60, transparencyIntensity: finish === "sheer" ? 55 : 30 }
            : {}),
        },
      ],
    });
    swatches.push({ part: "Lips", color: lip, finish });
  }
  const blush = normalizeHex(args.blush_color);
  if (blush) {
    effects.push({
      category: "blush",
      pattern: { name: "1color1" },
      palettes: [
        {
          color: blush,
          texture: "matte",
          colorIntensity: Math.max(30, strength - 15),
        },
      ],
    });
    swatches.push({ part: "Blush", color: blush, finish: "matte" });
  }
  const shadow = normalizeHex(args.eyeshadow_color);
  if (shadow) {
    const finish = args.eyeshadow_finish === "shimmer" ? "shimmer" : "matte";
    effects.push({
      category: "eye_shadow",
      pattern: { name: "1color1" },
      palettes: [
        {
          color: shadow,
          texture: finish,
          colorIntensity: strength,
          ...(finish === "shimmer"
            ? { shimmerColor: "#FFFFFF", shimmerIntensity: 45 }
            : {}),
        },
      ],
    });
    swatches.push({ part: "Eyeshadow", color: shadow, finish });
  }
  return { effects, swatches };
}

const recipeSchema = z
  .object({
    name: z.string().min(1).max(32),
    intensity: z.enum(["soft", "medium", "bold"]),
    eyeshadow: z
      .object({
        pattern: z.enum(
          EYESHADOW_PATTERNS.map((item) => item.label) as [string, ...string[]],
        ),
        colors: z.array(hexColor).min(1).max(3),
        finish: z.enum(["matte", "shimmer"]).optional(),
      })
      .strict()
      .optional(),
    eyeliner: z
      .object({
        pattern: z.enum(
          EYELINER_PATTERNS.map((item) => item.label) as [string, ...string[]],
        ),
        color: hexColor,
      })
      .strict()
      .optional(),
    lashes: z
      .object({
        pattern: z.enum(
          LASH_PATTERNS.map((item) => item.label) as [string, ...string[]],
        ),
      })
      .strict()
      .optional(),
    blush: z
      .object({
        color: hexColor,
        placement: z.enum(["apples", "lifted", "draped"]).optional(),
      })
      .strict()
      .optional(),
    lip: z
      .object({
        color: hexColor,
        finish: z.enum(["matte", "satin", "gloss", "sheer"]).optional(),
      })
      .strict()
      .optional(),
    foundation: z
      .object({
        color: hexColor,
        coverage: z.enum(["sheer", "medium"]).optional(),
      })
      .strict()
      .optional(),
    contour: z.boolean().optional(),
    highlight: z.boolean().optional(),
  })
  .strict();

const tryOnFullLook = tool({
  name: "try_on_full_look",
  title: "Try on a complete look",
  description: `Apply a complete custom makeup look to the client's photo in one YouCam Makeup Virtual Try-On: optional sheer skin tint, contour and highlight placed for their face shape, an eyeshadow placement, eyeliner and lash styles, blush placement and lip color. Costs 1 unit. Contour and highlight are placed using the client's measured skin color and face shape, which are taken from earlier analyze_skin_tone and analyze_face results in this session unless you pass skin_color and face_shape. Choose pattern labels only from these menus:\n${makeupMenuText()}`,
  group: "analysis",
  cost: "1 unit",
  input: z
    .object({
      look: recipeSchema,
      skin_color: hexColor.optional(),
      face_shape: z.string().max(40).optional(),
      photo_id: photoId,
    })
    .strict(),
  needsPhoto: true,
  usesEngine: true,
  units: () => UNITS.makeupTryOn,
  run: (ctx, args) =>
    guard("try_on_full_look", async () => {
      const recipe = parseRecipe(args.look, "Custom look");
      const { effects, swatches } = recipeEffects(recipe, {
        skinColor:
          normalizeHex(args.skin_color) ?? ctx.state.measurements.skinColor,
        faceShape: args.face_shape ?? ctx.state.measurements.faceShape,
      });
      // skin_smooth alone is not a look.
      if (
        effects.filter((effect) => effect.category !== "skin_smooth").length < 1
      )
        throw new ToolFail(
          "no_effects",
          "Describe at least one part of the look with a valid pattern label from the menus and #RRGGBB colors.",
        );
      const photo = requirePhoto(ctx, args.photo_id);
      const label = `Look: ${recipe.name}`;
      let url: string | undefined;
      if (!simulated(ctx)) {
        const { data } = await runYouCamTask(
          ctx,
          photo,
          "makeup-vto",
          (fileId) => ({ src_file_id: fileId, version: "1.0", effects }),
        );
        [url] = httpsUrls(data.results ?? data, 1);
      }
      const imageId = await tryOnResult(ctx, {
        photo,
        url,
        label,
        washHex: swatches[0]?.color ?? "#C9677B",
      });
      const tryOn: TryOn = {
        id: newId("try"),
        kind: "full_face",
        title: recipe.name,
        category: null,
        imageId,
        photoId: photo.id,
        swatches,
        units: UNITS.makeupTryOn,
        simulated: simulated(ctx),
        at: Date.now(),
      };
      return tryOnRun(tryOn, { applied: recipe.name, parts: swatches });
    }),
});

// --- Presentation ----------------------------------------------------------------

const recommendProducts = tool({
  name: "recommend_products",
  title: "Recommend products",
  description:
    "Show the client product cards on their Picks screen for specific products and shades you recommend. Free; no photo needed. Name real, currently sold products and shades you are confident exist, each tied to the client's measured colors, features or skin scores. Write names with their real capitalization. Do not include prices or links: the tier (drugstore, mid-range, prestige) stands in for price. Up to 6 per call, 12 in total; set replace to start the list over.",
  group: "presentation",
  cost: "free",
  input: z
    .object({
      products: z.array(pickSchema).min(1).max(6),
      replace: z.boolean().optional(),
    })
    .strict(),
  run: (ctx, args) =>
    guard("recommend_products", () => {
      const accepted = acceptedProducts(args.products, 6);
      if (!accepted.length)
        throw new ToolFail(
          "no_results",
          "Name at least one real product with its brand, name, category, tier and why it suits this client. Prescription items, prices and links are not accepted.",
        );
      const existing = args.replace ? [] : ctx.state.picks;
      const seen = new Set(
        existing.map((pick) =>
          `${pick.brand}|${pick.name}|${pick.shade}`.toLowerCase(),
        ),
      );
      const merged = [
        ...existing,
        ...accepted.filter(
          (pick) =>
            !seen.has(`${pick.brand}|${pick.name}|${pick.shade}`.toLowerCase()),
        ),
      ].slice(0, LIMITS.maxPicks);
      const picks: ProductPick[] = merged.map((pick, index) => {
        const url = productLink(pick);
        return {
          category: pick.category,
          brand: pick.brand,
          name: pick.name,
          shade: pick.shade,
          why: pick.why,
          tier: pick.tier,
          ...(url ? { url } : {}),
          target: `pick:${index}`,
        };
      });
      return {
        ok: true,
        units: 0,
        result: {
          shown_to_client: "Picks screen",
          picks: picks.map(({ brand, name, shade, target }) => ({
            product: `${brand} ${name}${shade ? ` ${shade}` : ""}`,
            target,
          })),
        },
        entry: {
          kind: "picks",
          body: `Product picks · ${picks.length}`,
          data: {
            tool: "recommend_products",
            title: "Product picks",
            // Picks in the transcript never carry links.
            picks: picks.map(({ url: _url, ...pick }) => pick),
          },
        },
        patch: (state) => {
          state.picks = picks;
        },
        ui: {
          nudge: { target: "picks", label: "Product picks", at: Date.now() },
        },
      };
    }),
});

const shadeInput = z
  .object({
    label: z.string().min(1).max(24),
    hex: hexColor,
    area: z.enum(SHADE_AREAS).optional(),
  })
  .strict();

const presentLook = tool({
  name: "present_look",
  title: "Present a look",
  description:
    "Put the look you recommend on the client's Look, Steps and Shades screens: a title, the steps to get it, the exact shades (with hex codes the client can copy) and, as the before-and-after, a try-on image you made with a try_on tool. Free. Call it after a try-on, then use ui_show to take the client there. Calling it again replaces the previous look.",
  group: "presentation",
  cost: "free",
  input: z
    .object({
      title: z.string().min(1).max(70),
      question: z
        .string()
        .max(140)
        .optional()
        .describe("A neutral restatement of the client's question."),
      steps: z.array(z.string().min(1).max(160)).min(1).max(LIMITS.maxSteps),
      shades: z.array(shadeInput).max(LIMITS.maxShades).optional(),
      image_id: z
        .string()
        .optional()
        .describe("A try-on result image id returned by a try_on tool."),
      before_photo_id: z
        .string()
        .optional()
        .describe("The client's photo to show as the before. Omit for none."),
    })
    .strict(),
  run: (ctx, args) =>
    guard("present_look", () => {
      if (args.image_id && !ctx.hasImage(args.image_id))
        throw new ToolFail(
          "unknown_image",
          "That image_id is not a result image of this session. Use the image_id returned by a try_on tool.",
        );
      if (args.before_photo_id && !ctx.hasPhoto(args.before_photo_id))
        throw new ToolFail(
          "unknown_photo",
          "That before_photo_id is not a photo in this session.",
        );
      const title = cleanDisplayLine(args.title, 70);
      const steps = args.steps
        .map((step) => cleanDisplayLine(step, 160))
        .filter(Boolean);
      if (!title || !steps.length)
        throw new ToolFail(
          "no_results",
          "The title and steps must be plain text without links.",
        );
      const card: LookCard = {
        title,
        question: cleanDisplayLine(args.question, 140) || null,
        steps,
        shades: (args.shades ?? []).flatMap((shade) => {
          const label = cleanDisplayLine(shade.label, 24);
          const hex = normalizeHex(shade.hex);
          return label && hex ? [{ label, hex, area: shade.area ?? null }] : [];
        }),
        image: args.image_id
          ? { id: args.image_id, alt: `Try-on: ${title}`, caption: "Try-on" }
          : null,
        before: args.before_photo_id
          ? {
              id: args.before_photo_id,
              alt: "Your photo before the try-on",
              caption: "Before",
            }
          : null,
        disclaimer: DISCLAIMER,
        at: Date.now(),
      };
      return {
        ok: true,
        units: 0,
        result: {
          shown_to_client: "Look, Steps and Shades screens",
          screens: [
            ...(card.image ? ["look"] : []),
            "steps",
            ...(card.shades.length ? ["shades"] : []),
          ],
          next: "Use ui_show to take the client to it, for example ui_show(target: 'look').",
        },
        entry: {
          kind: "card",
          body: `Look · ${card.title}`,
          data: { tool: "present_look", title: card.title, card },
        },
        patch: (state) => {
          state.card = card;
        },
        ui: {
          nudge: { target: "look", label: "Your look", at: Date.now() },
          view: { compare: null },
        },
      };
    }),
});

const uiCompare = tool({
  name: "ui_compare",
  title: "Move the before-and-after slider",
  description:
    "Move the before-and-after slider on the Look screen: reveal 0 shows only the before photo, 100 only the try-on. Use it to reveal the try-on while you describe it. Free. Needs a look presented with both a try-on image and a before photo.",
  group: "ui",
  cost: "free",
  input: z
    .object({
      reveal: z
        .number()
        .min(0)
        .max(100)
        .describe("How much of the try-on is visible, 0 to 100 percent."),
    })
    .strict(),
  run: (ctx, args) => {
    const card = ctx.state.card;
    if (!card?.image || !card.before)
      return failed(
        new ToolFail(
          "nothing_to_show",
          "There is no before-and-after yet. Present a look with image_id and before_photo_id first.",
        ),
      );
    // The view stores the divider position from the left, with the before
    // photo on its left side, so revealing 100% of the try-on is position 0.
    const reveal = Math.round(args.reveal);
    return {
      ok: true,
      units: 0,
      result: { reveal },
      ui: { screen: "look", following: true, view: { compare: 100 - reveal } },
    };
  },
});

export const BEAUTY_TOOLS: readonly Tool[] = [
  analyzeSkin,
  analyzeFace,
  analyzeSkinTone,
  listMakeupLooks,
  tryOnLook,
  tryOnMakeup,
  tryOnFullLook,
  recommendProducts,
  presentLook,
  uiCompare,
];

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
