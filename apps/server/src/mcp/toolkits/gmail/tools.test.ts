import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { McpSchema, Tool } from "effect/ai";
import { GmailToolkit } from "./tools.ts";

describe("Gmail tools at the MCP protocol boundary", () => {
  it("registers every input and output schema with the server protocol", () => {
    const decode = Schema.decodeUnknownSync(McpSchema.Tool);
    for (const tool of Object.values(GmailToolkit.tools)) {
      // Empty Struct emits a non-object JSON Schema and prevents the entire server from starting.
      expect(
        () => decode({ name: tool.name, inputSchema: Tool.getJsonSchema(tool) }),
        tool.name,
      ).not.toThrow();
      expect(
        () =>
          decode({
            name: tool.name,
            inputSchema: Tool.getJsonSchemaFromSchema(tool.successSchema),
          }),
        tool.name,
      ).not.toThrow();
    }
  });
});
