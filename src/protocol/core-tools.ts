// Tools every ppro-app has, whatever the app does. UI tools change what the
// client sees through the same pipeline as app tools. Session tools (`say`,
// `set_presence`, `get_session_state`, `wait_for_events`, `end_session`) are
// implemented by the runtime itself; only their schemas live here, so the
// manifest, the OpenAPI document and the SDK describe them the same way.

import { z } from "zod";
import {
  defineTool,
  type RegisteredTool,
  type ToolGroup,
  type ToolRun,
} from "./app-definition.ts";
import { LIMITS } from "./constants.ts";
import { EVENT_TYPES, PRESENCE_STATES } from "./types.ts";
import { cleanDisplayLine } from "./text.ts";

function failure(
  code: string,
  message: string,
  result = {},
): ToolRun<never, never> {
  return { ok: false, result, error: { code, message } };
}

export function uiTools<State, View>(): RegisteredTool<State, View>[] {
  const uiShow = defineTool<
    State,
    View,
    {
      screen?: string;
      target?: string;
      take_control?: boolean;
    }
  >({
    name: "ui_show",
    title: "Show a screen or point at something",
    description:
      "Take the client to a screen, or point at one item on it (a target from a tool result, such as skin:pore, step:1 or shade:0). By default the app follows you until the client takes over by tapping; pass take_control=false to only leave a gentle pointer without moving the screen. Use it like a presenter: show the part you are talking about. Free.",
    group: "ui",
    cost: "free",
    input: z
      .object({
        screen: z
          .string()
          .max(24)
          .optional()
          .describe("A screen id from the manifest."),
        target: z
          .string()
          .max(60)
          .optional()
          .describe("A target, such as skin:acne or shade:1."),
        take_control: z.boolean().optional(),
      })
      .strict()
      .refine((args) => args.screen || args.target, {
        message: "Give a screen, a target, or both.",
      }),
    run(ctx, args) {
      let screen: string;
      let target: string | null = null;
      if (args.target) {
        const resolved = ctx.resolveTarget(args.target);
        if (!resolved.ok)
          return failure("unknown_target", resolved.message, {
            valid_targets: resolved.valid.slice(0, 60),
          }) as ToolRun<State, View>;
        screen = resolved.screen;
        target = args.target;
        if (args.screen && args.screen !== screen)
          return failure(
            "unknown_target",
            `"${args.target}" is on the ${screen} screen, not ${args.screen}.`,
          ) as ToolRun<State, View>;
      } else {
        const available = ctx.availableScreens();
        screen = args.screen as string;
        if (!available.includes(screen))
          return failure(
            "nothing_to_show",
            `The ${screen} screen has no content yet or does not exist.`,
            { available_screens: available },
          ) as ToolRun<State, View>;
      }
      const focus = { screen, target };
      const result = { screen, target, following: true };
      if (args.take_control !== false || ctx.ui.following)
        return {
          ok: true,
          result,
          ui: { screen, target, focus, following: true },
        };
      return {
        ok: true,
        result: { ...result, following: false, pointed: true },
        ui: {
          focus,
          nudge: {
            target: target ?? screen,
            label: target ?? screen,
            at: Date.now(),
          },
        },
      };
    },
  });

  const uiRequestPhoto = defineTool<
    State,
    View,
    {
      mode?: "camera" | "upload" | "either";
      reason?: string;
    }
  >({
    name: "ui_request_photo",
    title: "Ask the client for a selfie",
    description:
      "Ask the client to share a photo of themselves. The app opens a card on the first screen that explains why and offers the live camera and an upload button; it asks for the client's consent first. You cannot take the photo yourself. A photo.added event arrives when they share one. Free.",
    group: "ui",
    cost: "free",
    input: z
      .object({
        mode: z.enum(["camera", "upload", "either"]).optional(),
        reason: z
          .string()
          .max(120)
          .optional()
          .describe("One short sentence shown to the client."),
      })
      .strict(),
    run(ctx, args) {
      const first = ctx.availableScreens()[0];
      return {
        ok: true,
        result: {
          requested: true,
          note: "The client sees the request. Wait for a photo.added event.",
        },
        ui: {
          screen: first,
          target: null,
          focus: { screen: first, target: null },
          following: true,
          mediaRequest: {
            kind: "photo",
            mode: args.mode ?? "either",
            reason:
              cleanDisplayLine(args.reason, 120) ||
              "A clear, front-facing selfie in even light works best.",
            at: Date.now(),
          },
        },
      };
    },
  });

  const uiNotice = defineTool<
    State,
    View,
    {
      text: string;
      tone?: "info" | "warn";
    }
  >({
    name: "ui_notice",
    title: "Show a short notice",
    description:
      "Show the client a short banner at the top of the app, for example 'Move a little closer to the window'. It stays until the client dismisses it or you replace it. Free.",
    group: "ui",
    cost: "free",
    input: z
      .object({
        text: z.string().min(1).max(160),
        tone: z.enum(["info", "warn"]).optional(),
      })
      .strict(),
    run(_ctx, args) {
      const text = cleanDisplayLine(args.text, 160);
      if (!text)
        return failure(
          "invalid_arguments",
          "The notice must be plain text without links.",
        ) as ToolRun<State, View>;
      return {
        ok: true,
        result: { shown: true },
        ui: { notice: { text, tone: args.tone ?? "info", at: Date.now() } },
      };
    },
  });

  return [uiShow, uiRequestPhoto, uiNotice];
}

// --- Runtime tools (schemas only) ----------------------------------------------

export type RuntimeToolSchema = {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  cost: string;
  readOnly?: boolean;
  input: z.ZodType;
};

export const RUNTIME_TOOLS: readonly RuntimeToolSchema[] = [
  {
    name: "say",
    title: "Say something to the client",
    description:
      "Send the client a message in the chat as the advisor. Plain text only: links and markdown are removed, and text that breaks the content rules is refused. The result includes `spoken`, the same words made safe to read aloud, for voice agents. Free.",
    group: "session",
    cost: "free",
    input: z
      .object({ text: z.string().min(1).max(LIMITS.agentMessageChars) })
      .strict(),
  },
  {
    name: "set_presence",
    title: "Show what the advisor is doing",
    description:
      "Tell the app what you are doing so it can show it: thinking (typing indicator), speaking (a voice is playing), listening, or idle. Free.",
    group: "session",
    cost: "free",
    input: z.object({ state: z.enum(PRESENCE_STATES) }).strict(),
  },
  {
    name: "get_session_state",
    title: "Read the session",
    description:
      "Read a compact snapshot of the session: the revision, time and budget left, consent, shared photos, what the client is looking at, what has been shown, and the latest messages. Free.",
    group: "session",
    cost: "free",
    readOnly: true,
    input: z
      .object({
        messages: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("How many recent messages to include. Default 12."),
      })
      .strict(),
  },
  {
    name: "wait_for_events",
    title: "Wait for the client",
    description: `Wait until something happens in the session (a client message, a photo, a screen change) and return the new events. Pass the highest rev you have seen as after_rev. Returns at once if events are already waiting, otherwise after up to ${LIMITS.waitMaxSeconds} seconds with an empty list. Use it as the core of your loop. Free.`,
    group: "session",
    cost: "free",
    readOnly: true,
    input: z
      .object({
        after_rev: z.number().int().min(0),
        timeout_seconds: z
          .number()
          .min(0)
          .max(LIMITS.waitMaxSeconds)
          .optional(),
        types: z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length).optional(),
      })
      .strict(),
  },
  {
    name: "end_session",
    title: "End the consultation",
    description:
      "End the consultation. The client's photos and result images are deleted; the transcript stays available for a short time. Say goodbye with say first. Free.",
    group: "session",
    cost: "free",
    input: z.object({}).strict(),
  },
];
