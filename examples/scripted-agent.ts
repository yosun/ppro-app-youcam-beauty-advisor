// A beauty advisor with no LLM: fixed rules reading real tool results. It
// shows the whole shape of an agent against PPRO App API v1 using only the SDK:
//
//   1. read the session, greet, ask for a selfie
//   2. listen for events (the client's messages and photo)
//   3. call tools, point the client at what you are talking about
//   4. reply with say
//
//   npm run dev                      # terminal 1 (the app on :5173)
//   npm run agent:demo               # terminal 2 (this advisor)
//   -> open the URL it prints, share a selfie, chat.
//
// Against a deployment with a host key, set PPRO_URL and PPRO_HOST_KEY and it
// creates the session itself. To attach to an existing session, set PPRO_URL
// and PPRO_AGENT_TOKEN.

import { pathToFileURL } from "node:url";
import {
  AdvisorClient,
  HostClient,
  type BeautyAdvisorClient,
  type CreatedSession,
} from "../src/client/index.ts";
import type { ToolResponse } from "../src/protocol/types.ts";

type Log = (line: string) => void;

const list = (items: unknown) =>
  Array.isArray(items) && items.length
    ? items.length === 1
      ? String(items[0])
      : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
    : "";

/** Light, medium or deep, from a #RRGGBB skin color (relative luminance). */
export function depthOf(
  hex: string | null | undefined,
): "light" | "medium" | "deep" {
  const value = Number.parseInt((hex ?? "#C99B7A").replace("#", ""), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * lin((value >> 16) & 255) +
    0.7152 * lin((value >> 8) & 255) +
    0.0722 * lin(value & 255);
  return luminance > 0.5 ? "light" : luminance > 0.2 ? "medium" : "deep";
}

const PALETTES = {
  light: {
    lip: ["Soft rose", "#D9788C"],
    blush: ["Peach petal", "#F0A090"],
    shadow: ["Champagne", "#D9BFA0"],
  },
  medium: {
    lip: ["Dusty rose", "#C9677B"],
    blush: ["Warm coral", "#E8879C"],
    shadow: ["Toasted tan", "#B98F6A"],
  },
  deep: {
    lip: ["Berry", "#8E2C48"],
    blush: ["Deep rose", "#B5566B"],
    shadow: ["Bronze", "#8C6239"],
  },
} as const;

const COLOR_WORDS: Record<string, [string, string]> = {
  pink: ["Pink", "#E8879C"],
  rose: ["Rose", "#C9677B"],
  red: ["Classic red", "#B3202F"],
  coral: ["Coral", "#F07C6C"],
  nude: ["Nude", "#C8907E"],
  berry: ["Berry", "#8E2C48"],
  plum: ["Plum", "#6E2A4D"],
  mauve: ["Mauve", "#B57B8C"],
};

export async function runScriptedAdvisor(
  advisor: BeautyAdvisorClient,
  options: { log?: Log; signal?: AbortSignal } = {},
) {
  const log = options.log ?? (() => undefined);
  const session = await advisor.state({ messages: 0 });
  const name = session.advisor.name;
  let analyzed = false;

  async function say(text: string) {
    log(`${name}: ${text}`);
    await advisor.say(text);
  }

  async function ask(reason: string) {
    await advisor.tool("ui_request_photo", { reason });
  }

  async function retake(result: ToolResponse) {
    // A photo problem comes with plain guidance the client can act on.
    await say(result.error?.message ?? "I couldn't use that photo.");
    await ask("Try again facing a window, with your face filling the frame.");
  }

  async function consult(photoId: string) {
    await advisor.presence("thinking");
    const skin = await advisor.tool("analyze_skin");
    if (!skin.ok) {
      if (skin.error?.code === "photo_problem") return retake(skin);
      return say(
        "I couldn't run the skin analysis just now. " +
          (skin.error?.message ?? ""),
      );
    }
    analyzed = true;
    await advisor.tool("ui_show", { target: "skin" });
    const note = skin.result.simulated
      ? " (This is a demo preview, not a real reading.)"
      : "";
    await say(
      `I measured your skin across eight areas. What could use the most care right now: ${list(skin.result.needs_most_care)}. ` +
        `Your strongest areas are ${list(skin.result.healthiest)}. Tap any row to see where I measured it.${note}`,
    );

    const face = await advisor.tool("analyze_face");
    const tone = await advisor.tool("analyze_skin_tone");
    const attributes = (face.result.attributes ?? []) as {
      name: string;
      value: string;
    }[];
    const faceShape = attributes.find(
      (item) => item.name === "Face shape",
    )?.value;
    const skinTone = (
      (tone.result.attributes ?? []) as { name: string; color?: string }[]
    ).find((item) => item.name === "Skin tone")?.color;
    if (face.ok) await advisor.tool("ui_show", { target: "face" });
    await say(
      faceShape
        ? `Your face shape reads as ${faceShape.toLowerCase()}, and I matched your skin tone so the shades below sit close to your own coloring.`
        : "I matched your skin tone so the shades below sit close to your own coloring.",
    );

    const depth = depthOf(skinTone);
    const palette = PALETTES[depth];
    const tryOn = await advisor.tool("try_on_full_look", {
      look: {
        name: "Soft everyday",
        intensity: "soft",
        lip: { color: palette.lip[1], finish: "satin" },
        blush: { color: palette.blush[1], placement: "lifted" },
        eyeshadow: {
          pattern: "1color1",
          colors: [palette.shadow[1]],
          finish: "matte",
        },
        contour: true,
        highlight: true,
      },
    });
    if (!tryOn.ok)
      return say(
        "I couldn't render the try-on: " + (tryOn.error?.message ?? ""),
      );
    await advisor.tool("present_look", {
      title: "Soft everyday glow",
      question: "An easy look that suits my coloring.",
      steps: [
        "Start with moisturizer and a light sunscreen.",
        `Blend ${palette.shadow[0].toLowerCase()} across the lid with a fingertip.`,
        `Sweep ${palette.blush[0].toLowerCase()} blush up toward the temples.`,
        `Finish with ${palette.lip[0].toLowerCase()} on the lips.`,
      ],
      shades: [
        { label: palette.lip[0], hex: palette.lip[1], area: "lips" },
        { label: palette.blush[0], hex: palette.blush[1], area: "cheeks" },
        { label: palette.shadow[0], hex: palette.shadow[1], area: "eyes" },
      ],
      image_id: tryOn.result.image_id,
      before_photo_id: photoId,
    });
    await advisor.tool("ui_show", { target: "look" });
    await advisor.tool("ui_compare", { reveal: 100 });
    await say(
      `Here is a soft everyday look in shades chosen for your ${depth} skin tone. Drag the line to compare before and after, then open Steps and Shades for the exact colors.`,
    );
    await advisor.presence("idle");
  }

  async function reply(text: string) {
    const lower = text.toLowerCase();
    if (/\b(bye|goodbye|thanks|thank you|done|that's all)\b/.test(lower)) {
      await say(
        "It was lovely working with you. Everything here is cosmetic guidance for reference only. Take care!",
      );
      await advisor.tool("end_session");
      return "ended";
    }
    if (!analyzed) {
      await say(
        "I'd love to start with a selfie so I can measure instead of guess. Use the camera button or upload one.",
      );
      return ask("A clear, front-facing selfie in even light works best.").then(
        () => "asked",
      );
    }
    const word = Object.keys(COLOR_WORDS).find((key) => lower.includes(key));
    if (word) {
      const [label, hex] = COLOR_WORDS[word];
      const out = await advisor.tool("try_on_makeup", { lip_color: hex });
      if (!out.ok)
        return say(out.error?.message ?? "I couldn't try that on.").then(
          () => "failed",
        );
      await say(
        `Here is ${label.toLowerCase()} on your lips (${hex}). Want it a little softer or bolder?`,
      );
      return "tried";
    }
    if (/\b(skin|acne|pores?|wrinkles?|oil|dry|hydrat)/.test(lower)) {
      await advisor.tool("ui_show", { target: "skin" });
      await say(
        "That is the Skin screen. Rows are ordered by what needs the most care, and tapping one shows where I measured it.",
      );
      return "skin";
    }
    if (/\b(face|shape|eyes?|brows?)\b/.test(lower)) {
      await advisor.tool("ui_show", { target: "face" });
      await say(
        "Here are your face shape and features, and your skin tone and colors below them.",
      );
      return "face";
    }
    await say(
      "I can show your skin report, your face shape, or try a color on you, like pink, berry or coral. What would you like?",
    );
    return "default";
  }

  await advisor.presence("idle");
  await say(
    `Hi, I'm ${name}, an AI beauty advisor. I can analyze your skin, read your face shape and colors, and try makeup on you. Share a selfie and we'll begin.`,
  );
  await ask("A clear, front-facing selfie in even light works best.");

  for await (const event of advisor.events({ signal: options.signal })) {
    if (event.type === "photo.added" && !analyzed) {
      log("(photo shared)");
      await consult(event.data.photo.id);
    } else if (
      event.type === "message.created" &&
      event.data.message.role === "client" &&
      event.data.message.kind === "text"
    ) {
      log(`client: ${event.data.message.body}`);
      if ((await reply(event.data.message.body)) === "ended") return;
    }
  }
}

async function main() {
  const baseUrl = (process.env.PPRO_URL ?? "http://localhost:8787").replace(
    /\/+$/,
    "",
  );
  let advisor: BeautyAdvisorClient;
  let launch: string | null = null;
  if (process.env.PPRO_AGENT_TOKEN) {
    advisor = new AdvisorClient({
      baseUrl,
      token: process.env.PPRO_AGENT_TOKEN,
    }) as BeautyAdvisorClient;
  } else {
    const host = process.env.PPRO_HOST_KEY
      ? new HostClient({ baseUrl, hostKey: process.env.PPRO_HOST_KEY })
      : null;
    const created: CreatedSession = host
      ? await host.createSession({ advisor: { name: "Aria" } })
      : ((await (
          await fetch(`${baseUrl}/ppro/v1/demo/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ advisor_name: "Aria" }),
          })
        ).json()) as CreatedSession);
    if (!created.session) {
      console.error(
        "Could not create a session. Is the server running, and is PPRO_STANDALONE on?",
      );
      process.exit(1);
    }
    advisor = new AdvisorClient({
      baseUrl,
      token: created.tokens.agent,
      sessionId: created.session.id,
    }) as BeautyAdvisorClient;
    launch = created.urls.client;
  }
  if (launch) console.log(`Open this to be the client:\n  ${launch}\n`);
  console.log("Advisor running. Ctrl-C to stop.\n");
  await runScriptedAdvisor(advisor, { log: (line) => console.log(line) });
  console.log("\nSession ended.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
