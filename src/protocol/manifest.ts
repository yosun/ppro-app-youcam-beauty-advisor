import type { AppDefinition } from "./app-definition.ts";
import {
  API_PREFIX,
  LIMITS,
  MANIFEST_PATH,
  MCP_PATH,
  PROTOCOL,
} from "./constants.ts";
import { RUNTIME_TOOLS, uiTools } from "./core-tools.ts";
import { EVENT_DOCS } from "./events-doc.ts";
import { declarationOf, type ToolDeclaration } from "./formats.ts";
import { EVENT_TYPES, type EngineMode } from "./types.ts";

// The manifest: what a ppro-app publishes at /.well-known/ppro-app.json. It
// is everything an agent or a host needs to decide whether and how to use the
// app, without reading any other documentation.

export type Manifest = {
  protocol: typeof PROTOCOL;
  app: {
    id: string;
    name: string;
    version: string;
    description: string;
  };
  skill: { id: string; name: string };
  provider: { name: string; url: string };
  endpoints: {
    api: string;
    manifest: string;
    events: string;
    mcp: string | null;
    ui: string;
  };
  auth: {
    scheme: "bearer";
    roles: {
      host: string;
      agent: string;
      client: string;
    };
    tokenLocation: string;
  };
  capabilities: {
    engine: { mode: EngineMode; provider: string };
    events: string[];
    mcp: boolean;
    toolFormats: string[];
    agentVision: boolean;
    speech: { spokenText: boolean };
    embedding: boolean;
    standalone: boolean;
  };
  limits: Record<string, number>;
  screens: {
    id: string;
    title: string;
    description: string;
    filledBy: string | null;
  }[];
  targets: {
    section: string;
    screen: string;
    item: string;
    description: string;
  }[];
  /** JSON Schema of the `app` object in a session snapshot. */
  state: Record<string, unknown>;
  tools: ToolDeclaration[];
  events: { type: string; description: string }[];
  messageKinds: string[];
  advisor: {
    guardrails: readonly string[];
    disclaimer: string;
    starters: readonly string[];
    instructions: string;
  };
  privacy: {
    photosStoredOnDisk: boolean;
    retention: string;
    sensitiveAttributes: string;
    consent: string;
  };
};

export type ManifestOptions = {
  engine: EngineMode;
  mcp: boolean;
  standalone: boolean;
  embedding: boolean;
};

/** Every tool of an app: its own, the UI tools and the runtime tools. */
export function allToolDeclarations<State, View>(
  app: AppDefinition<State, View>,
): ToolDeclaration[] {
  return [
    ...app.tools.map((tool) => declarationOf(tool as never)),
    ...uiTools<State, View>().map((tool) => declarationOf(tool as never)),
    ...RUNTIME_TOOLS.map((tool) => declarationOf(tool)),
  ];
}

export function buildManifest<State, View>(
  app: AppDefinition<State, View>,
  options: ManifestOptions,
): Manifest {
  return {
    protocol: PROTOCOL,
    app: {
      id: app.id,
      name: app.name,
      version: app.version,
      description: app.description,
    },
    skill: app.skill,
    provider: app.provider,
    endpoints: {
      api: API_PREFIX,
      manifest: MANIFEST_PATH,
      events: `${API_PREFIX}/sessions/{id}/events`,
      mcp: options.mcp ? MCP_PATH : null,
      ui: "/",
    },
    auth: {
      scheme: "bearer",
      roles: {
        host: "A static key from the operator. Creates sessions and mints tokens. Never given to a browser or an agent.",
        agent:
          "A session token for the advisor. Calls tools, posts messages, reads and listens. Can read image bytes only when the session allows agent vision.",
        client:
          "A session token for the client's browser. Shares photos, writes messages, uses the app. Delivered in the launch URL fragment.",
      },
      tokenLocation: "Authorization: Bearer <token>. Never in a query string.",
    },
    capabilities: {
      engine: { mode: options.engine, provider: app.provider.name },
      events: ["sse", "long-poll"],
      mcp: options.mcp,
      toolFormats: ["native", "openai", "gemini", "anthropic"],
      agentVision: true,
      speech: { spokenText: true },
      embedding: options.embedding,
      standalone: options.standalone,
    },
    limits: {
      clientMessageChars: LIMITS.clientMessageChars,
      agentMessageChars: LIMITS.agentMessageChars,
      maxPhotos: LIMITS.maxPhotos,
      photoUploadBytes: LIMITS.photoUploadBytes,
      photoMaxSide: LIMITS.photoMaxSide,
      photoMinShortSide: LIMITS.photoMinShortSide,
      toolCallsPerMinute: LIMITS.toolCallsPerMinute,
      messagesPerMinute: LIMITS.messagesPerMinute,
      eventBuffer: LIMITS.eventBuffer,
      waitMaxSeconds: LIMITS.waitMaxSeconds,
      sessionUnits: app.sessionUnits(),
    },
    screens: app.screens.map((screen) => ({ ...screen })),
    targets: app.targets.map((target) => ({ ...target })),
    state: app.stateSchema,
    tools: allToolDeclarations(app),
    events: EVENT_TYPES.map((type) => ({
      type,
      description: EVENT_DOCS[type],
    })),
    messageKinds: ["text", "photo", ...app.messageKinds],
    advisor: {
      guardrails: app.guardrails,
      disclaimer: app.disclaimer,
      starters: app.starters,
      instructions: `${API_PREFIX}/sessions/{id}/instructions`,
    },
    privacy: {
      photosStoredOnDisk: false,
      retention:
        "Photos and result images live in server memory only and are deleted when the session ends, expires, or the client deletes them. Transcript text is kept for a few minutes after the end so the client can download it.",
      sensitiveAttributes:
        "Estimated age, gender and attractiveness-style fields from the provider are dropped on the server and never reach the agent or the client.",
      consent:
        "Photo analysis requires the client to confirm they are 18 or older and agree to analysis of their own photo. Hosts may attest to this only if they collected it.",
    },
  };
}
