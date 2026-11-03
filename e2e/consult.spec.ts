import { expect, test, type Page } from "@playwright/test";
import {
  AdvisorClient,
  type BeautyAdvisorClient,
} from "../src/client/index.ts";
import { makePhoto } from "../tests/helpers.ts";

// A person uses the app in a real browser while an external agent, using only
// the SDK, runs the same session. Each assertion is something the person sees.

/** A screenshot taken after CSS animations finish, so it shows the settled screen. */
async function shot(
  page: Page,
  info: { outputPath: (name: string) => string },
  name: string,
) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    animations: "disabled",
  });
}

async function startDemo(page: Page, advisorName = "Aria") {
  await page.goto("/");
  await page.getByLabel("Advisor’s name").fill(advisorName);
  await page.getByRole("button", { name: "Start a demo consultation" }).click();
  await expect(page.getByRole("tab", { name: /Chat/ })).toBeVisible();
  // The advisor's token is available to the standalone demo; read it as a
  // developer would from the panel, here straight from the page's storage.
  const dev = await page.evaluate(() => {
    const stored = JSON.parse(
      sessionStorage.getItem("ppro:credentials") ?? "{}",
    );
    return { id: stored.id, agentToken: stored.dev?.agentToken };
  });
  const agent = new AdvisorClient({
    baseUrl: new URL(page.url()).origin,
    token: dev.agentToken,
    sessionId: dev.id,
  }) as BeautyAdvisorClient;
  return { agent };
}

async function sharePhoto(page: Page) {
  await page.getByLabel(/I am 18 or older/).check();
  await page.getByLabel(/I agree to YouCam AI/).check();
  await expect(
    page.getByRole("button", { name: "Upload a photo" }),
  ).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "selfie.jpg",
    mimeType: "image/jpeg",
    buffer: await makePhoto(900, 1200),
  });
  await expect(page.getByRole("img", { name: "Your photo" })).toBeVisible();
}

test("a person and an external agent run a whole consultation", async ({
  page,
}, info) => {
  const { agent } = await startDemo(page);

  // The launcher offers how to connect an agent, with the token masked.
  await expect(
    page.getByRole("complementary", { name: "Connect an agent" }),
  ).toBeVisible();
  await expect(page.getByRole("complementary")).not.toContainText(
    await agentToken(page),
  );

  // The agent greets and asks for a selfie: the card appears in the app.
  await agent.say("Hi, I'm Aria. Let's start with a selfie.");
  await expect(
    page.getByText("Hi, I'm Aria. Let's start with a selfie."),
  ).toBeVisible();
  await agent.tool("ui_request_photo", { reason: "Please face the window." });
  await expect(
    page.getByRole("heading", { name: "Aria would like a selfie" }),
  ).toBeVisible();
  await expect(page.getByText("Please face the window.")).toBeVisible();
  // Nothing can be uploaded before both confirmations.
  await expect(
    page.getByRole("button", { name: "Upload a photo" }),
  ).toBeDisabled();

  await shot(page, info, "01-chat-ask");

  // The person consents and shares a photo; the agent is told.
  const seen = agent.events({
    types: ["photo.added"],
    after: (await agent.state()).rev,
  });
  await sharePhoto(page);
  expect((await seen.next()).value?.type).toBe("photo.added");
  // The request card is gone. (Scoped to the phone: the developer panel beside
  // it has a heading that mentions a selfie too.)
  await expect(
    page.locator(".frame").getByRole("heading", { name: /selfie/ }),
  ).toHaveCount(0);

  // The agent analyzes: a card lands in the chat and the Skin tab appears with a pointer.
  await agent.presence("thinking");
  await expect(page.getByLabel("Aria is typing")).toBeVisible();
  const skin = await agent.tool("analyze_skin");
  expect(skin.ok).toBe(true);
  await agent.presence("idle");
  await expect(
    page.getByRole("heading", { name: "Skin analysis" }),
  ).toBeVisible();
  await expect(page.getByText("Demo preview").first()).toBeVisible();
  await expect(page.getByRole("tab", { name: /Skin/ })).toBeVisible();
  await expect(page.locator(".pa-tab-dot")).toBeVisible();

  await shot(page, info, "02-chat-card");

  // The agent takes the person to one concern; the app follows.
  await agent.tool("ui_show", { target: "skin:pore" });
  await expect(page.getByRole("tab", { name: /Skin/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("With Aria")).toBeVisible();
  await expect(page.getByRole("button", { name: /Pores/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await shot(page, info, "skin");

  // The person takes over; the app lets go and offers to follow again.
  await page.getByRole("tab", { name: /Chat/ }).click();
  await expect(page.getByText("With Aria")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Follow Aria" })).toBeVisible();
  const state = await agent.state();
  expect(state.ui.screen).toBe("chat");
  expect(state.ui.following).toBe(false);
  await page.getByRole("button", { name: "Follow Aria" }).click();
  await expect(page.getByRole("tab", { name: /Skin/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // A try-on, a presented look, and the shades with copyable codes.
  const tryOn = await agent.tool("try_on_full_look", {
    look: {
      name: "Soft rose",
      intensity: "soft",
      lip: { color: "#C9677B" },
      blush: { color: "#E8879C" },
    },
  });
  const photoId = (await agent.state()).photos[0].id;
  await agent.tool("recommend_products", {
    products: [
      {
        category: "lipstick",
        brand: "Maybelline",
        name: "Super Stay",
        shade: "Pink Goes On",
        why: "A soft pink for warm skin.",
        tier: "drugstore",
      },
    ],
  });
  await agent.tool("present_look", {
    title: "Soft rose glow",
    question: "An easy everyday look.",
    steps: [
      "Prep with moisturizer.",
      "Blend blush up toward the temples.",
      "Finish with a satin lip.",
    ],
    shades: [
      { label: "Dusty rose", hex: "#C9677B", area: "lips" },
      { label: "Warm coral", hex: "#E8879C", area: "cheeks" },
    ],
    image_id: tryOn.result.image_id,
    before_photo_id: photoId,
  });
  await agent.tool("ui_show", { target: "look" });
  await expect(
    page.getByRole("heading", { name: "Soft rose glow" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Try-on: Soft rose glow/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Your photo before the try-on" }),
  ).toBeVisible();
  await agent.tool("ui_compare", { reveal: 40 });
  await expect(
    page.getByRole("slider", { name: /compare before and after/ }),
  ).toHaveValue("60");
  await shot(page, info, "look");

  // Steps: the agent walks through them and the highlight moves.
  await agent.tool("ui_show", { target: "step:1" });
  await expect(page.locator('.pa-steps li[data-state="active"]')).toContainText(
    "Blend blush",
  );
  await expect(page.locator('.pa-steps li[data-state="done"]')).toHaveCount(1);
  await agent.tool("ui_show", { target: "shade:1" });
  await expect(
    page.locator('.pa-shades li[data-state="active"]'),
  ).toContainText("Warm coral");
  await expect(page.locator('.pa-shades li[data-state="done"]')).toHaveCount(1);
  await shot(page, info, "shades");

  // The person copies a shade; the agent is told, and nothing else changes.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const actions = agent.events({
    types: ["client.action"],
    after: (await agent.state()).rev,
  });
  await page.getByRole("button", { name: "Copy Warm coral, #E8879C" }).click();
  expect((await actions.next()).value).toMatchObject({
    data: { action: "copy", target: "shade:1" },
  });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "#E8879C",
  );

  // Product picks.
  await shot(page, info, "05-shades-copied");
  await agent.tool("ui_show", { target: "pick:0" });
  await expect(page.getByText("Maybelline Super Stay")).toBeVisible();
  await expect(page.locator(".pick[data-active]")).toBeVisible();
  await shot(page, info, "06-picks");

  // The person writes; the agent hears it and answers.
  await page.getByRole("tab", { name: /Chat/ }).click();
  const heard = agent.events({
    types: ["message.created"],
    after: (await agent.state()).rev,
  });
  await page.getByLabel("Message Aria").fill("Can I wear this to a wedding?");
  await page.getByRole("button", { name: "Send" }).click();
  const event = (await heard.next()).value;
  expect(event).toMatchObject({
    data: {
      message: { role: "client", body: "Can I wear this to a wedding?" },
    },
  });
  await agent.say(
    "Absolutely. Swap the satin lip for a longer-wearing formula.",
  );
  await expect(page.getByText("Absolutely. Swap the satin lip")).toBeVisible();

  // The agent ends it: the person's photos are gone and they can keep the transcript.
  await agent.tool("end_session");
  await expect(
    page.getByRole("dialog", { name: "Consultation ended" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Transcript" })).toBeVisible();
  const after = await agent.state();
  expect(after.phase).toBe("ended");
  expect(after.photos).toEqual([]);
  await shot(page, info, "ended");
});

test("the live camera reports a load failure and offers an upload instead", async ({
  page,
}) => {
  await startDemo(page);
  await page.route("**/plugins-media.makeupar.com/**", (route) =>
    route.abort(),
  );
  await page.getByLabel(/I am 18 or older/).check();
  await page.getByLabel(/I agree to YouCam AI/).check();
  await page.getByRole("button", { name: "Live camera" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText("could not load");
  await expect(
    dialog.getByRole("button", { name: /Upload a photo instead/ }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close camera" }).click();
  await expect(dialog).toBeHidden();
});

test("a rejected photo explains itself and keeps the person in place", async ({
  page,
}) => {
  await startDemo(page);
  await page.getByLabel(/I am 18 or older/).check();
  await page.getByLabel(/I agree to YouCam AI/).check();
  await page.locator('input[type="file"]').setInputFiles({
    name: "tiny.jpg",
    mimeType: "image/jpeg",
    buffer: await makePhoto(300, 300),
  });
  await expect(page.getByRole("alert")).toContainText("too small");
  await expect(page.getByRole("img", { name: "Your photo" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Upload a photo" }),
  ).toBeEnabled();
});

test("works on a phone-sized screen and leaves the developer panel out of the way", async ({
  browser,
}, info) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 780 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await startDemo(page);
  await expect(page.getByRole("tab", { name: /Chat/ })).toBeVisible();
  const box = await page.locator(".frame").boundingBox();
  expect(box?.width).toBeLessThanOrEqual(375);
  await shot(page, info, "phone");
  await context.close();
});

test("a launch link opens the session and hides its token", async ({
  page,
  request,
}) => {
  const created = await (
    await request.post("/ppro/v1/demo/session", {
      data: { advisor_name: "Mara" },
    })
  ).json();
  await page.goto(created.urls.client);
  await expect(page.getByText("Mara’s consultation")).toBeVisible();
  expect(page.url()).not.toContain("#t=");
  expect(page.url()).not.toContain("p1.");
  await page.reload();
  await expect(page.getByText("Mara’s consultation")).toBeVisible();
});

async function agentToken(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("ppro:credentials") ?? "{}").dev
        ?.agentToken as string,
  );
}
