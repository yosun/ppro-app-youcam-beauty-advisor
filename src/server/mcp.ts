import {
  McpServer,
  createMcpHandler,
  type AuthInfo,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { MCP_PATH } from "../protocol/constants.ts";
import { ApiError } from "../protocol/errors.ts";
import { allToolDeclarations } from "../protocol/manifest.ts";
import type { ToolDeclaration } from "../protocol/formats.ts";
import type { Config } from "./config.ts";
import { authenticate } from "./http.ts";
import type { Runtime } from "./runtime.ts";

// The MCP binding. The same tools the HTTP API serves, for any agent that
// speaks the Model Context Protocol. A connection is authenticated with the
// advisor's session token as a bearer token, and that token also selects the
// session, so tools take no session argument.
//
// The handler is stateless and serves both the 2026-07-28 revision and the
// 2025-era protocol from one endpoint. The runtime validates tool arguments
// (the same code path as HTTP), so the schemas published here only describe.

/** Publishes a JSON Schema and leaves validation to the runtime. */
function describeOnly(
  schema: ToolDeclaration["inputSchema"],
): StandardSchemaWithJSON {
  const json = {
    ...schema,
    $schema: "https://json-schema.org/draft/2020-12/schema",
  };
  return {
    "~standard": {
      version: 1,
      vendor: "ppro-app",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  } as StandardSchemaWithJSON;
}

function textResult(payload: unknown, isError: boolean) {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: payload as Record<string, unknown>,
    isError,
  };
}

export function mountMcp<
  State extends Record<string, unknown>,
  View extends Record<string, unknown>,
>(app: Hono, runtime: Runtime<State, View>, config: Config) {
  const declarations = allToolDeclarations(runtime.app);

  const handler = createMcpHandler((ctx) => {
    const sessionId = ctx.authInfo?.clientId;
    const server = new McpServer(
      { name: runtime.app.id, version: runtime.app.version },
      {
        capabilities: { tools: {}, prompts: {} },
        instructions: `${runtime.app.name}: an AI beauty advisor app. Read the advisor_instructions prompt first, then loop: wait_for_events, act with the tools, reply with say.`,
      },
    );
    for (const tool of declarations) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: describeOnly(tool.inputSchema),
          annotations: { readOnlyHint: tool.readOnly },
        },
        async (args: unknown) => {
          if (!sessionId)
            return textResult(
              { error: { code: "unauthorized", message: "No session." } },
              true,
            );
          try {
            const { response } = await runtime.invoke(
              sessionId,
              tool.name,
              args,
            );
            return textResult(response, !response.ok);
          } catch (error) {
            if (error instanceof ApiError)
              return textResult(
                { error: { code: error.code, message: error.message } },
                true,
              );
            throw error;
          }
        },
      );
    }
    server.registerPrompt(
      "advisor_instructions",
      {
        title: "Advisor instructions",
        description:
          "How to advise in this session: the rules, the tools and the current status. Refetch it when the status changes.",
      },
      () => {
        const rec = sessionId ? runtime.get(sessionId) : null;
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: rec
                  ? runtime.instructions(rec, "chat")
                  : "No session is attached to this connection.",
              },
            },
          ],
        };
      },
    );
    return server;
  });

  app.all(MCP_PATH, async (c) => {
    const auth = authenticate(c, config, runtime.now);
    if (!auth || auth.role !== "agent")
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: "Send the advisor's session token as a bearer token.",
          },
        },
        401,
        { "WWW-Authenticate": 'Bearer realm="ppro-app"' },
      );
    // Sessions end and expire; a token for one that is gone selects nothing.
    try {
      runtime.get(auth.sessionId);
    } catch {
      return c.json(
        { error: { code: "not_found", message: "No such session." } },
        404,
      );
    }
    const authInfo: AuthInfo = {
      token: "redacted",
      clientId: auth.sessionId,
      scopes: ["agent"],
    };
    return handler.fetch(c.req.raw, { authInfo });
  });
}
