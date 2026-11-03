// Tool declarations and the formats agent frameworks expect. The native form
// is what the manifest publishes; the others are mechanical conversions, so an
// agent built on any of them can use the app without writing glue.

import { z } from "zod";
import type { RegisteredTool, ToolGroup } from "./app-definition.ts";
import type { RuntimeToolSchema } from "./core-tools.ts";

export type JsonSchema = Record<string, unknown>;

export type ToolDeclaration = {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  /** Human-readable price in provider units, for example "9-16 units". */
  cost: string;
  readOnly: boolean;
  /** The call needs a shared photo and the client's consent. */
  needsPhoto: boolean;
  inputSchema: JsonSchema;
};

/** JSON Schema (2020-12) for a Zod schema, without the `$schema` marker. */
export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
  }) as JsonSchema;
  delete json.$schema;
  return json;
}

export function declarationOf(
  tool: RegisteredTool<never, never> | RuntimeToolSchema,
): ToolDeclaration {
  const registered = tool as Partial<RegisteredTool<never, never>>;
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    group: tool.group,
    cost: tool.cost,
    readOnly: Boolean(tool.readOnly),
    needsPhoto: Boolean(registered.needsPhoto),
    inputSchema: jsonSchemaOf(
      "input" in tool ? (tool.input as z.ZodType) : z.object({}),
    ),
  };
}

export const TOOL_FORMATS = [
  "native",
  "openai",
  "gemini",
  "anthropic",
] as const;
export type ToolFormat = (typeof TOOL_FORMATS)[number];

export function formatTools(
  declarations: readonly ToolDeclaration[],
  format: ToolFormat,
) {
  switch (format) {
    case "native":
      return declarations;
    case "openai":
      return declarations.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    case "gemini":
      return [
        {
          functionDeclarations: declarations.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.inputSchema,
          })),
        },
      ];
    case "anthropic":
      return declarations.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
  }
}
