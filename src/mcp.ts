/**
 * cacheport MCP server. Tools: set, get, delete, list.
 *
 * Why the low-level Server instead of McpServer: the high-level helper
 * converts zod schemas to JSON Schema and injects two keys that are not
 * in this tool's public spec ("$schema" and "additionalProperties"),
 * which breaks exact tool-list/schema parity with the spec. This file
 * therefore serves tools/list with the spec's exact input schemas,
 * while zod still validates every tools/call argument set.
 *
 * The target comes from the argument after `mcp` (`cacheport mcp
 * redis://...`) or from REDIS_URL / the CACHEPORT_ env spellings (see
 * resolveRedisTarget). No connection is opened at startup: the server
 * answers tools/list with nothing behind it, and only a tools/call
 * touches the socket — which is where an unreachable server surfaces
 * as an isError result instead of an invented value.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createCachePort, VERSION } from "./cache.js";

const SetArgs = z.object({
  key: z.string(),
  value: z.string(),
  expireSeconds: z.number().optional(),
});

const GetArgs = z.object({
  key: z.string(),
});

const DeleteArgs = z.object({
  key: z.union([z.string(), z.array(z.string())]),
});

const ListArgs = z.object({
  pattern: z.string().optional(),
});

const TOOLS = [
  {
    name: "set",
    description: "Set a Redis key-value pair with optional expiration",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "The Redis key to set" },
        value: { type: "string", description: "The string value to store under the key" },
        expireSeconds: {
          type: "number",
          description:
            "Optional expiration time in seconds after which the key expires; must be a positive number",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "get",
    description: "Get a value by key from Redis",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "The Redis key whose value to retrieve" },
      },
      required: ["key"],
    },
  },
  {
    name: "delete",
    description: "Delete one or more keys from Redis",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          description: "The Redis key to delete, or an array of Redis keys to delete",
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
      required: ["key"],
    },
  },
  {
    name: "list",
    description: "List Redis keys matching a pattern",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description:
            "Optional glob pattern to match key names against; defaults to '*' to list all keys",
        },
      },
      required: [] as string[],
    },
  },
];

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

// argv looks like: [node, cli.js, "mcp", maybe-redis-url].
const argv = process.argv.slice(2);
const mcpIndex = argv.indexOf("mcp");
const explicit = mcpIndex >= 0 ? argv[mcpIndex + 1] : undefined;
const port = createCachePort(explicit);

const server = new Server(
  { name: "cacheport", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "set") {
      const parsed = SetArgs.parse(args ?? {});
      return textResult(await port.set(parsed.key, parsed.value, parsed.expireSeconds));
    }
    if (name === "get") {
      const parsed = GetArgs.parse(args ?? {});
      return textResult(await port.get(parsed.key));
    }
    if (name === "delete") {
      const parsed = DeleteArgs.parse(args ?? {});
      return textResult(await port.delete(parsed.key));
    }
    if (name === "list") {
      const parsed = ListArgs.parse(args ?? {});
      return textResult(await port.list(parsed.pattern));
    }
  } catch (err) {
    return errorResult(err);
  }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
