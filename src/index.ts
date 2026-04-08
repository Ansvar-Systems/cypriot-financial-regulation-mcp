#!/usr/bin/env node

/**
 * Cypriot Financial Regulation MCP — stdio entry point.
 *
 * Provides MCP tools for querying CySEC directives and circulars,
 * and CBC (Central Bank of Cyprus) prudential directives.
 *
 * Tool prefix: cy_fin_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
  getDataFreshness,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

let dataAge: string | null = null;
try {
  const ingestState = JSON.parse(
    readFileSync(join(__dirname, "..", "data", "ingest-state.json"), "utf8"),
  ) as { lastRun?: string };
  dataAge = ingestState.lastRun ?? null;
} catch {
  // fallback
}

const SERVER_NAME = "cypriot-financial-regulation-mcp";

// Tool definitions

const TOOLS = [
  {
    name: "cy_fin_search_regulations",
    description:
      "Full-text search across CySEC and CBC regulatory provisions. Returns matching directives, circulars, and prudential directives for Cyprus-regulated entities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'AIF managers', 'client money', 'capital adequacy', 'prudential requirements')",
        },
        sourcebook: {
          type: "string",
          description: "Filter by sourcebook ID (e.g., CYSEC_DIRECTIVES, CYSEC_CIRCULARS, CBC_DIRECTIVES). Optional.",
        },
        status: {
          type: "string",
          enum: ["in_force", "deleted", "not_yet_in_force"],
          description: "Filter by provision status. Defaults to all statuses.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "cy_fin_get_regulation",
    description:
      "Get a specific CySEC or CBC provision by sourcebook and reference (e.g., sourcebook 'CYSEC_DIRECTIVES', reference 'DI87-01').",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: {
          type: "string",
          description: "Sourcebook identifier (e.g., CYSEC_DIRECTIVES, CYSEC_CIRCULARS, CBC_DIRECTIVES)",
        },
        reference: {
          type: "string",
          description: "Provision reference (e.g., 'DI87-01', 'C116', 'CBC/2014/1')",
        },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "cy_fin_list_sourcebooks",
    description:
      "List all CySEC and CBC sourcebook collections with their names and descriptions.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "cy_fin_search_enforcement",
    description:
      "Search CySEC enforcement actions — fines, suspensions, licence revocations, and public reprimands against regulated entities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., firm name, breach type, 'market abuse', 'client money')",
        },
        action_type: {
          type: "string",
          enum: ["fine", "ban", "restriction", "warning"],
          description: "Filter by action type. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "cy_fin_check_currency",
    description:
      "Check whether a specific CySEC or CBC provision reference is currently in force. Returns status and effective date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "Provision reference to check (e.g., 'DI87-01', 'C116')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "cy_fin_about",
    description: "Return metadata about this MCP server: version, data source, tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "cy_fin_list_sources",
    description:
      "List the authoritative data sources used by this MCP server — CySEC and CBC — with URLs, descriptions, and license information.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "cy_fin_check_data_freshness",
    description:
      "Check data freshness for this MCP server. Returns the last ingest timestamp and current row counts for all collections.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// Zod schemas

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["in_force", "deleted", "not_yet_in_force"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z.enum(["fine", "ban", "restriction", "warning"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

// Helper

const META = {
  disclaimer:
    "This data is for informational purposes only. Verify all references against official CySEC and CBC publications before making compliance decisions.",
  data_age: dataAge,
  copyright:
    "© Cyprus Securities and Exchange Commission (CySEC) / Central Bank of Cyprus (CBC). Official regulatory publications.",
  source_url: "https://www.cysec.gov.cy/ and https://www.centralbank.cy/",
};

function textContent(data: unknown) {
  const payload = typeof data === "object" && data !== null
    ? { ...(data as Record<string, unknown>), _meta: META }
    : { data, _meta: META };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// Server setup

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "cy_fin_search_regulations": {
        const parsed = SearchRegulationsArgs.parse(args);
        const results = searchProvisions({
          query: parsed.query,
          sourcebook: parsed.sourcebook,
          status: parsed.status,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "cy_fin_get_regulation": {
        const parsed = GetRegulationArgs.parse(args);
        const provision = getProvision(parsed.sourcebook, parsed.reference);
        if (!provision) {
          return errorContent(
            `Provision not found: ${parsed.sourcebook} ${parsed.reference}`,
          );
        }
        return textContent(provision);
      }

      case "cy_fin_list_sourcebooks": {
        const sourcebooks = listSourcebooks();
        return textContent({ sourcebooks, count: sourcebooks.length });
      }

      case "cy_fin_search_enforcement": {
        const parsed = SearchEnforcementArgs.parse(args);
        const results = searchEnforcement({
          query: parsed.query,
          action_type: parsed.action_type,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "cy_fin_check_currency": {
        const parsed = CheckCurrencyArgs.parse(args);
        const currency = checkProvisionCurrency(parsed.reference);
        return textContent(currency);
      }

      case "cy_fin_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "Cyprus Securities and Exchange Commission (CySEC) and Central Bank of Cyprus (CBC) MCP server. Provides access to CySEC directives, circulars, CBC prudential directives, and enforcement actions.",
          data_source: "CySEC (https://www.cysec.gov.cy/) and CBC (https://www.centralbank.cy/)",
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      case "cy_fin_list_sources": {
        return textContent({
          sources: [
            {
              id: "CYSEC",
              name: "Cyprus Securities and Exchange Commission (CySEC)",
              url: "https://www.cysec.gov.cy/",
              description: "Official Cypriot financial markets regulator. Publishes directives, circulars, and enforcement decisions.",
              license: "Official government publications — public domain for informational use.",
              sourcebooks: ["CYSEC_DIRECTIVES", "CYSEC_CIRCULARS"],
            },
            {
              id: "CBC",
              name: "Central Bank of Cyprus (CBC)",
              url: "https://www.centralbank.cy/",
              description: "Central Bank of Cyprus. Publishes prudential directives for credit institutions and payment service providers.",
              license: "Official government publications — public domain for informational use.",
              sourcebooks: ["CBC_DIRECTIVES"],
            },
          ],
        });
      }

      case "cy_fin_check_data_freshness": {
        const freshness = getDataFreshness();
        return textContent(freshness);
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// Main

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
