import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getSignals, getSignalStats } from "@cryonix/database";
import { db, users } from "@cryonix/database";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * API Key Validation
 */
async function validateApiKey(key: string | undefined): Promise<boolean> {
  if (!key) return false;
  
  // Find user with this API key
  const allUsers = await db.select().from(users);
  return allUsers.some(user => {
    const keys = Array.isArray(user.apiKeys) ? user.apiKeys : [];
    return keys.some((k: any) => k.key === key);
  });
}

/**
 * Cryonix MCP Server
 * Exposes trading signals and market data to AI agents.
 */

const server = new Server(
  {
    name: "cryonix",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Tool definitions
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_latest_signals",
        description: "Fetch the most recent AI-validated trading signals from Cryonix.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of signals to return (default: 5, max: 20)",
              default: 5,
            },
            symbol: {
              type: "string",
              description: "Optional symbol to filter by (e.g., BTC/USDT)",
            },
          },
        },
      },
      {
        name: "get_signal_stats",
        description: "Get performance and distribution statistics for recent signals.",
        inputSchema: {
          type: "object",
          properties: {
            days: {
              type: "number",
              description: "Number of days back to analyze (default: 7)",
              default: 7,
            },
          },
        },
      },
    ],
  };
});

/**
 * Tool execution handlers
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Validate API Key
  const isValid = await validateApiKey(process.env.CRYONIX_API_KEY);
  if (!isValid) {
    return {
      content: [{ type: "text", text: "Error: Invalid or missing CRYONIX_API_KEY" }],
      isError: true,
    };
  }

  try {
    if (name === "get_latest_signals") {
      const { limit = 5, symbol } = z
        .object({
          limit: z.number().optional(),
          symbol: z.string().optional(),
        })
        .parse(args);

      const signals = await getSignals({
        limit: Math.min(limit, 20),
        symbol,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(signals, null, 2),
          },
        ],
      };
    }

    if (name === "get_signal_stats") {
      const { days = 7 } = z
        .object({
          days: z.number().optional(),
        })
        .parse(args);

      const since = new Date();
      since.setDate(since.getDate() - days);

      const stats = await getSignalStats({ since });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }

    throw new Error(`Tool not found: ${name}`);
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Start the server using stdio transport
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Cryonix MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
