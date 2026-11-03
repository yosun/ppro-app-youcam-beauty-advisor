// The schema of the manifest an app publishes at /.well-known/ppro-app.json.
// This is what makes the standard checkable: a host or an agent can validate
// any app's manifest against spec/schemas/manifest.schema.json before it
// trusts it. The drift check keeps it in step with the Manifest type.

import { z } from "zod";
import { PROTOCOL } from "./constants.ts";
import type { Manifest } from "./manifest.ts";

const toolDeclaration = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  title: z.string(),
  description: z.string(),
  group: z.enum(["analysis", "presentation", "ui", "session"]),
  cost: z
    .string()
    .describe('Price in provider units, for example "9-16 units" or "free".'),
  readOnly: z.boolean(),
  needsPhoto: z.boolean(),
  inputSchema: z
    .record(z.string(), z.unknown())
    .describe("JSON Schema (2020-12) for the tool's arguments."),
});

export const manifestSchema = z.object({
  protocol: z.literal(PROTOCOL),
  app: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/),
    name: z.string(),
    version: z.string(),
    description: z.string(),
  }),
  skill: z.object({ id: z.string(), name: z.string() }),
  provider: z.object({ name: z.string(), url: z.string() }),
  endpoints: z.object({
    api: z.string(),
    manifest: z.string(),
    events: z.string(),
    mcp: z.string().nullable(),
    ui: z.string(),
  }),
  auth: z.object({
    scheme: z.literal("bearer"),
    roles: z.object({
      host: z.string(),
      agent: z.string(),
      client: z.string(),
    }),
    tokenLocation: z.string(),
  }),
  capabilities: z.object({
    engine: z.object({
      mode: z.enum(["live", "simulated", "unavailable"]),
      provider: z.string(),
    }),
    events: z.array(z.string()),
    mcp: z.boolean(),
    toolFormats: z.array(z.string()),
    agentVision: z.boolean(),
    speech: z.object({ spokenText: z.boolean() }),
    embedding: z.boolean(),
    standalone: z.boolean(),
  }),
  limits: z.record(z.string(), z.number()),
  screens: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        filledBy: z.string().nullable(),
      }),
    )
    .min(1)
    .describe("The first screen is always available."),
  targets: z.array(
    z.object({
      section: z.string(),
      screen: z.string(),
      item: z.string(),
      description: z.string(),
    }),
  ),
  state: z
    .record(z.string(), z.unknown())
    .describe("JSON Schema of the session's `app` object."),
  tools: z.array(toolDeclaration).min(1),
  events: z.array(z.object({ type: z.string(), description: z.string() })),
  messageKinds: z.array(z.string()),
  advisor: z.object({
    guardrails: z.array(z.string()).min(1),
    disclaimer: z.string(),
    starters: z.array(z.string()),
    instructions: z.string(),
  }),
  privacy: z.object({
    photosStoredOnDisk: z.boolean(),
    retention: z.string(),
    sensitiveAttributes: z.string(),
    consent: z.string(),
  }),
});

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
// The type uses readonly arrays where the schema yields plain ones. Same data:
// compare the shapes with readonly removed at every depth.
type Plain<T> = T extends readonly (infer U)[]
  ? Plain<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Plain<T[K]> }
    : T;
export const _manifestMatchesType: Mutual<
  Plain<z.infer<typeof manifestSchema>>,
  Plain<Manifest>
> = true;
