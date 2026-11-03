// Builds the OpenAPI 3.1 description of PPRO App API v1 from the code: the
// request and response schemas in schemas.ts, the tool declarations of the app
// and the route table below. Nothing here is written by hand twice. The
// document is generated into spec/openapi.yaml and checked for drift in CI.

import { z } from "zod";
import type { AppDefinition } from "./app-definition.ts";
import { API_PREFIX, MANIFEST_PATH, MCP_PATH, PROTOCOL } from "./constants.ts";
import { ERROR_CODES } from "./errors.ts";
import { allToolDeclarations } from "./manifest.ts";
import * as schemas from "./schemas.ts";
import { EVENT_TYPES } from "./types.ts";

type Json = Record<string, unknown>;
type Role = "host" | "agent" | "client";

const json = (schema: z.ZodType): Json => {
  const out = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "any",
  }) as Json;
  delete out.$schema;
  return out;
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const idParam = {
  name: "id",
  in: "path",
  required: true,
  description:
    "A session id, or `current` for the session the token belongs to.",
  schema: { type: "string" },
};

type Route = {
  method: "get" | "post" | "put" | "delete";
  path: string;
  id: string;
  summary: string;
  description?: string;
  roles: readonly Role[] | "public";
  params?: Json[];
  query?: Json[];
  request?:
    | { schema: string; description?: string }
    | { raw: string; contentType: string; description: string };
  responses: Record<
    string,
    {
      description: string;
      schema?: string;
      contentType?: string;
      headers?: Json;
    }
  >;
};

const bodyless = (description: string) => ({ description });

export const ROUTES: readonly Route[] = [
  {
    method: "get",
    path: MANIFEST_PATH,
    id: "getManifest",
    summary: "Discover the app",
    description:
      "The app's manifest: what it is, its screens and targets, its tools with JSON Schemas, its events and the rules its advisor follows. Also served at `/ppro/v1/manifest`.",
    roles: "public",
    responses: { "200": { description: "The manifest.", schema: "Manifest" } },
  },
  {
    method: "get",
    path: `${API_PREFIX}/manifest`,
    id: "getManifestAlias",
    summary: "Discover the app (alias)",
    description:
      "The same manifest as `/.well-known/ppro-app.json`, under the API prefix for clients that only know the API base.",
    roles: "public",
    responses: { "200": { description: "The manifest.", schema: "Manifest" } },
  },
  {
    method: "get",
    path: `${API_PREFIX}/health`,
    id: "getHealth",
    summary: "Liveness and engine mode",
    roles: "public",
    responses: {
      "200": { description: "The server is up.", schema: "Health" },
    },
  },
  {
    method: "post",
    path: `${API_PREFIX}/sessions`,
    id: "createSession",
    summary: "Create a session",
    description:
      "Called by the host. Returns a token for the advisor, a token for the client's browser and a launch URL whose fragment carries the client token.",
    roles: ["host"],
    request: { schema: "CreateSessionRequest" },
    responses: {
      "201": { description: "The session.", schema: "CreatedSession" },
      "401": { description: "Missing or wrong host key.", schema: "Error" },
      "422": { description: "Invalid body.", schema: "Error" },
    },
  },
  {
    method: "post",
    path: `${API_PREFIX}/demo/session`,
    id: "createDemoSession",
    summary: "Start a standalone demo session",
    description:
      "Only when the server runs standalone (`capabilities.standalone`). No authentication; rate limited. Returns both tokens so a developer can connect an agent. Disabled in production unless PPRO_STANDALONE is set.",
    roles: "public",
    request: { schema: "DemoSessionRequest" },
    responses: {
      "201": { description: "The session.", schema: "CreatedSession" },
      "404": { description: "Standalone sessions are off.", schema: "Error" },
      "429": { description: "Too many demo sessions.", schema: "Error" },
    },
  },
  {
    method: "get",
    path: `${API_PREFIX}/sessions/{id}`,
    id: "getSession",
    summary: "Read the session",
    description:
      "A snapshot: state, transcript tail, budget, UI and presence. The advisor persona is omitted for the client. `?messages=N` sets how many recent messages (default 100, at most 300).",
    roles: ["host", "agent", "client"],
    params: [idParam],
    query: [
      {
        name: "messages",
        in: "query",
        schema: { type: "integer", minimum: 0, maximum: 300 },
      },
    ],
    responses: {
      "200": { description: "The snapshot.", schema: "Session" },
      "401": { description: "Unauthenticated.", schema: "Error" },
      "404": {
        description: "No such session for this token.",
        schema: "Error",
      },
    },
  },
  {
    method: "delete",
    path: `${API_PREFIX}/sessions/{id}`,
    id: "endSession",
    summary: "End the consultation",
    description:
      "Deletes the client's photos and every image made from them. The transcript stays readable for a few minutes.",
    roles: ["host", "agent", "client"],
    params: [idParam],
    responses: {
      "200": { description: "The ended session.", schema: "Session" },
    },
  },
  {
    method: "post",
    path: `${API_PREFIX}/sessions/{id}/tokens`,
    id: "mintToken",
    summary: "Mint a replacement token",
    description:
      "Host only. For example, a fresh launch link after the client lost theirs.",
    roles: ["host"],
    params: [idParam],
    request: { schema: "MintTokenRequest" },
    responses: { "200": { description: "The token.", schema: "MintedToken" } },
  },
  {
    method: "get",
    path: `${API_PREFIX}/sessions/{id}/events`,
    id: "getEvents",
    summary: "Listen for changes",
    description:
      "Every change to a session is an event with a rising `rev`. Send `Accept: text/event-stream` for server-sent events (resume with `Last-Event-ID`), or use `?after=<rev>&wait=<seconds>` to long-poll for JSON. The `rev` in a JSON response is a safe place to resume from. A cursor older than the kept buffer returns `410 events_expired`: read the session and continue from its `rev`.",
    roles: ["host", "agent", "client"],
    params: [idParam],
    query: [
      {
        name: "after",
        in: "query",
        schema: { type: "integer", minimum: 0 },
        description: "Return events newer than this rev.",
      },
      {
        name: "wait",
        in: "query",
        schema: { type: "integer", minimum: 0, maximum: 25 },
        description: "Seconds to wait for something new.",
      },
      {
        name: "types",
        in: "query",
        schema: { type: "string" },
        description: "Comma-separated event types to include.",
      },
    ],
    responses: {
      "200": {
        description:
          "A batch of events (JSON), or a stream (`text/event-stream`).",
        schema: "EventBatch",
      },
      "410": {
        description: "The cursor is older than the kept events.",
        schema: "Error",
      },
    },
  },
  {
    method: "post",
    path: `${API_PREFIX}/sessions/{id}/messages`,
    id: "postMessage",
    summary: "Send a chat message",
    description:
      "An agent token posts the advisor's message (links and markdown are removed; text that breaks the content rules is refused with `content_blocked`). A client token posts the client's. A host may relay the client's words with `role: \"client\"`.",
    roles: ["host", "agent", "client"],
    params: [idParam],
    request: { schema: "MessageRequest" },
    responses: {
      "201": { description: "The message.", schema: "PostedMessage" },
      "422": { description: "Blocked or invalid.", schema: "Error" },
      "429": { description: "Too many messages.", schema: "Error" },
    },
  },
  {
    method: "put",
    path: `${API_PREFIX}/sessions/{id}/presence`,
    id: "setPresence",
    summary: "Show what the advisor is doing",
    roles: ["agent"],
    params: [idParam],
    request: { schema: "PresenceRequest" },
    responses: {
      "200": {
        description: "The presence now shown.",
        schema: "PresenceReply",
      },
    },
  },
  {
    method: "get",
    path: `${API_PREFIX}/sessions/{id}/instructions`,
    id: "getInstructions",
    summary: "The advisor's briefing",
    description:
      "The rules, tools and current status for this session, as text for the advisor's system prompt. `?style=call` for spoken replies. Fetch it again as the status changes.",
    roles: ["host", "agent"],
    params: [idParam],
    query: [
      {
        name: "style",
        in: "query",
        schema: { type: "string", enum: ["chat", "call"] },
      },
    ],
    responses: {
      "200": { description: "The briefing.", schema: "Instructions" },
    },
  },
  {
    method: "get",
    path: `${API_PREFIX}/sessions/{id}/tools`,
    id: "listTools",
    summary: "The tools in your framework's format",
    roles: ["host", "agent"],
    params: [idParam],
    query: [
      {
        name: "format",
        in: "query",
        schema: {
          type: "string",
          enum: ["native", "openai", "gemini", "anthropic"],
        },
      },
    ],
    responses: {
      "200": { description: "The tool declarations in the requested format." },
    },
  },
  {
    method: "post",
    path: `${API_PREFIX}/sessions/{id}/tools/{name}`,
    id: "callTool",
    summary: "Call a tool",
    description:
      "The body is the tool's arguments object (empty means `{}`). A tool that cannot do what was asked (no photo yet, budget spent, the provider refused the photo) answers `200` with `ok: false` and an `error.code`; only contract problems are HTTP errors. Send `Idempotency-Key` to make a retry safe: the same key and arguments replay the first result.",
    roles: ["agent"],
    params: [
      idParam,
      { name: "name", in: "path", required: true, schema: { type: "string" } },
    ],
    request: {
      raw: "ToolArguments",
      contentType: "application/json",
      description:
        "The tool's arguments, per its `inputSchema` in the manifest.",
    },
    responses: {
      "200": {
        description: "The outcome, successful or not.",
        schema: "ToolResponse",
      },
      "404": { description: "No such tool.", schema: "Error" },
      "409": {
        description:
          "Idempotency key reused with different arguments, or the session ended.",
        schema: "Error",
      },
      "422": {
        description: "Arguments do not match the schema.",
        schema: "Error",
      },
      "429": { description: "Too many tool calls.", schema: "Error" },
    },
  },
  {
    method: "post",
    path: `${API_PREFIX}/sessions/{id}/consent`,
    id: "setConsent",
    summary: "Record the client's consent",
    roles: ["client"],
    params: [idParam],
    request: { schema: "ConsentRequest" },
    responses: {
      "200": { description: "The consent now held.", schema: "ConsentReply" },
    },
  },
  {
    method: "post",
    path: `${API_PREFIX}/sessions/{id}/photos`,
    id: "uploadPhoto",
    summary: "Share a photo",
    description:
      "The request body is the image (JPEG, PNG or WebP, up to 10 MB). It is validated from its bytes, re-encoded without metadata and held in memory only. Requires consent.",
    roles: ["client"],
    params: [idParam],
    request: {
      raw: "binary",
      contentType: "image/jpeg",
      description: "The image bytes.",
    },
    responses: {
      "201": { description: "The stored photo.", schema: "PhotoReply" },
      "409": {
        description: "Consent missing, or the photo limit reached.",
        schema: "Error",
      },
      "413": { description: "Too large.", schema: "Error" },
      "415": { description: "Not a JPEG, PNG or WebP.", schema: "Error" },
      "422": {
        description: "Unusable (too small, unreadable).",
        schema: "Error",
      },
    },
  },
  {
    method: "delete",
    path: `${API_PREFIX}/sessions/{id}/photos/{photoId}`,
    id: "deletePhoto",
    summary: "Delete a photo and everything made from it",
    roles: ["host", "client"],
    params: [
      idParam,
      {
        name: "photoId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: { "204": bodyless("Deleted.") },
  },
  {
    method: "post",
    path: `${API_PREFIX}/sessions/{id}/ui-events`,
    id: "postUiEvent",
    summary: "Report what the client did in the app",
    roles: ["client"],
    params: [idParam],
    request: { schema: "UiEventRequest" },
    responses: {
      "200": { description: "The UI state now.", schema: "UiReply" },
    },
  },
  {
    method: "get",
    path: `${API_PREFIX}/sessions/{id}/images/{imageId}`,
    id: "getImage",
    summary: "Image bytes",
    description:
      "A photo or a result image. The client may always read them. The advisor may only if the session was created with `agent_vision`; otherwise `403 vision_disabled`. Hosts never can.",
    roles: ["agent", "client"],
    params: [
      idParam,
      {
        name: "imageId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": { description: "A JPEG.", contentType: "image/jpeg" },
      "403": {
        description: "Not allowed for this role or session.",
        schema: "Error",
      },
      "404": { description: "Gone or never existed.", schema: "Error" },
    },
  },
  {
    method: "get",
    path: `${API_PREFIX}/sessions/{id}/transcript.txt`,
    id: "getTranscript",
    summary: "The conversation as text",
    roles: ["host", "client"],
    params: [idParam],
    responses: {
      "200": { description: "Plain text.", contentType: "text/plain" },
    },
  },
  {
    method: "post",
    path: MCP_PATH,
    id: "mcp",
    summary: "Model Context Protocol endpoint",
    description:
      "The same tools over MCP (Streamable HTTP, protocol 2026-07-28 and the 2025 revisions). Authenticate with the advisor's token; it also selects the session, so tools take no session argument. Includes the `advisor_instructions` prompt.",
    roles: ["agent"],
    responses: {
      "200": { description: "A JSON-RPC response." },
      "401": { description: "Not the advisor's token.", schema: "Error" },
    },
  },
];

const roleText = (roles: Route["roles"]) =>
  roles === "public" ? "No authentication." : `Roles: ${roles.join(", ")}.`;

export function buildOpenApi<State, View>(
  app: AppDefinition<State, View>,
): Json {
  const tools = allToolDeclarations(app);
  const components: Record<string, Json> = {
    Error: json(schemas.errorBody),
    Session: json(schemas.session),
    ToolResponse: json(schemas.toolResponse),
    EventBatch: json(schemas.eventBatch),
    CreateSessionRequest: json(schemas.createSessionBody),
    DemoSessionRequest: json(schemas.demoSessionBody),
    MessageRequest: json(schemas.messageBody),
    ConsentRequest: json(schemas.consentBody),
    PresenceRequest: json(schemas.presenceBody),
    MintTokenRequest: json(schemas.mintTokenBody),
    UiEventRequest: json(schemas.uiEventBody),
    Message: json(schemas.message),
    UiState: json(schemas.uiState),
    PhotoMeta: json(schemas.photoMeta),
    Manifest: {
      type: "object",
      description:
        "See spec/schemas/manifest.schema.json and docs/PPRO-APP-API.md.",
      additionalProperties: true,
    },
    Health: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        protocol: { type: "string", const: PROTOCOL },
        app: { type: "string" },
        version: { type: "string" },
        engine: { type: "string", enum: ["live", "simulated", "unavailable"] },
      },
    },
    CreatedSession: {
      type: "object",
      required: ["session", "tokens", "urls"],
      properties: {
        session: ref("Session"),
        tokens: {
          type: "object",
          required: ["agent", "client"],
          properties: {
            agent: {
              type: "string",
              description:
                "Give to the advisor. Keep it off the client's device.",
            },
            client: { type: "string" },
          },
        },
        urls: {
          type: "object",
          properties: {
            client: {
              type: "string",
              description:
                "Open this in the client's browser or iframe. The client token is in the fragment.",
            },
            api: { type: "string" },
            events: { type: "string" },
            mcp: { type: ["string", "null"] },
          },
        },
      },
    },
    MintedToken: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["agent", "client"] },
        token: { type: "string" },
        expiresAt: { type: "number" },
        url: { type: "string" },
      },
    },
    PostedMessage: { type: "object", properties: { message: ref("Message") } },
    PresenceReply: {
      type: "object",
      properties: { presence: { type: "string" } },
    },
    ConsentReply: {
      type: "object",
      properties: { consent: json(schemas.consent) },
    },
    PhotoReply: { type: "object", properties: { photo: ref("PhotoMeta") } },
    UiReply: { type: "object", properties: { ui: ref("UiState") } },
    Instructions: {
      type: "object",
      properties: {
        style: { type: "string", enum: ["chat", "call"] },
        rev: { type: "integer" },
        text: { type: "string" },
      },
    },
    ToolArguments: {
      type: "object",
      description: "Per the tool's inputSchema.",
      additionalProperties: true,
    },
    ...Object.fromEntries(
      EVENT_TYPES.map((type) => [
        `Event_${type.replace(/\./g, "_")}`,
        json(schemas.eventSchemas[type]),
      ]),
    ),
  };

  const paths: Record<string, Record<string, Json>> = {};
  for (const route of ROUTES) {
    const security = route.roles === "public" ? [] : [{ bearer: [] }];
    const audience =
      route.roles === "public"
        ? "discovery"
        : route.roles.length === 1
          ? route.roles[0]
          : route.roles.includes("agent") && route.roles.includes("client")
            ? "client"
            : route.roles[0];
    const operation: Json = {
      operationId: route.id,
      tags: [audience],
      summary: route.summary,
      description: [route.description, roleText(route.roles)]
        .filter(Boolean)
        .join("\n\n"),
      // An empty list says "no authentication"; omitting it would be ambiguous.
      security,
      ...(route.params || route.query
        ? { parameters: [...(route.params ?? []), ...(route.query ?? [])] }
        : {}),
      responses: Object.fromEntries(
        Object.entries<Route["responses"][string]>({
          ...(route.roles !== "public" && !route.responses["401"]
            ? {
                "401": {
                  description: "Missing, invalid or expired token.",
                  schema: "Error",
                },
              }
            : {}),
          ...route.responses,
        }).map(([status, response]) => [
          status,
          {
            description: response.description,
            ...(response.schema
              ? {
                  content: {
                    "application/json": { schema: ref(response.schema) },
                  },
                }
              : response.contentType
                ? {
                    content: {
                      [response.contentType]: { schema: { type: "string" } },
                    },
                  }
                : {}),
          },
        ]),
      ),
    };
    if (route.request) {
      operation.requestBody =
        "schema" in route.request
          ? {
              required: true,
              content: {
                "application/json": { schema: ref(route.request.schema) },
              },
            }
          : {
              required: true,
              description: route.request.description,
              content: {
                [route.request.contentType]:
                  route.request.raw === "binary"
                    ? { schema: { type: "string", format: "binary" } }
                    : { schema: ref(route.request.raw) },
              },
            };
    }
    (paths[route.path] ??= {})[route.method] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "PPRO App API",
      version: "1.0.0",
      summary: "How an external agent controls a Populi Professional app.",
      description: `Protocol \`${PROTOCOL}\`. This document describes the beauty advisor app (${app.name}); the envelope (sessions, events, messages, photos, UI state) is the same for every ppro-app, and the tool catalog is per app: ${tools.length} tools here, listed with their JSON Schemas in the manifest.`,
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [
      {
        url: "{origin}",
        description: "Your deployment of the app.",
        variables: { origin: { default: "https://beauty-advisor.invalid" } },
      },
    ],
    tags: [
      { name: "discovery", description: "What the app is and what it can do." },
      {
        name: "host",
        description: "Creating sessions and minting tokens. Server side only.",
      },
      {
        name: "agent",
        description: "What the advisor does: tools, messages, listening.",
      },
      {
        name: "client",
        description:
          "What the client's browser does: consent, photos, UI events.",
      },
    ],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description:
            "The host key (creates sessions), the advisor's session token, or the client's session token. Never send a token in a query string.",
        },
      },
      schemas: components,
    },
    "x-error-codes": [...ERROR_CODES],
    "x-tools": tools.map((tool) => ({
      name: tool.name,
      group: tool.group,
      cost: tool.cost,
    })),
  };
}
