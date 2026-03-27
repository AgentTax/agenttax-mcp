#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.AGENTTAX_BASE_URL || "https://agenttax.io";
const API_KEY = process.env.AGENTTAX_API_KEY || "";

async function apiCall(method, path, body = null) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${BASE_URL}${path}`, opts);
  return resp.json();
}

const server = new McpServer({
  name: "agenttax",
  version: "1.0.0",
});

// ── calculate_tax ──────────────────────────────────────────────────────────
server.tool(
  "calculate_tax",
  "Calculate US sales tax or use tax for an AI agent transaction. Returns tax amount, rate, jurisdiction, audit trail, and advisories.",
  {
    role: z.enum(["buyer", "seller"]).describe("Your role in the transaction"),
    amount: z.number().positive().describe("Transaction amount in USD"),
    buyer_state: z.string().length(2).describe("2-letter US state code (e.g. TX, NY, CA)"),
    transaction_type: z.enum([
      "compute", "api_access", "data_purchase", "saas", "ai_labor", "storage",
      "digital_good", "consulting", "data_processing", "cloud_infrastructure",
      "ai_model_access", "marketplace_fee", "subscription", "license", "service",
    ]).describe("Type of transaction"),
    counterparty_id: z.string().describe("Identifier for the other party in the transaction"),
    buyer_zip: z.string().length(5).optional().describe("5-digit US zip code for local rate lookup"),
    work_type: z.enum(["compute", "research", "content", "consulting", "trading"]).optional()
      .describe("What the AI agent does — drives per-state tax classification"),
    is_b2b: z.boolean().optional().describe("Business-to-business transaction (affects rates in MD, IA)"),
    seller_remitting: z.boolean().optional().describe("Whether the seller is already collecting tax"),
  },
  async (params) => {
    const result = await apiCall("POST", "/api/v1/calculate", params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── log_trade ──────────────────────────────────────────────────────────────
server.tool(
  "log_trade",
  "Log a buy or sell trade for capital gains tracking. Sell trades return realized gain/loss with cost basis.",
  {
    asset_symbol: z.string().describe("Asset identifier (e.g. COMPUTE, GPU_HOUR, ETH)"),
    trade_type: z.enum(["buy", "sell"]).describe("Buy or sell"),
    quantity: z.number().positive().describe("Number of units"),
    price_per_unit: z.number().positive().describe("Price per unit in USD"),
    accounting_method: z.enum(["fifo", "lifo", "specific_id"]).optional()
      .describe("Cost basis method (default: fifo)"),
    resident_state: z.string().length(2).optional()
      .describe("2-letter state code for state capital gains tax estimate"),
    specific_lot_id: z.string().optional().describe("Lot ID for specific identification method"),
    notes: z.string().optional().describe("Free-text notes about the trade"),
  },
  async (params) => {
    const result = await apiCall("POST", "/api/v1/trades", params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── get_rates ──────────────────────────────────────────────────────────────
server.tool(
  "get_rates",
  "Get US sales tax rates. Returns rate, digital taxability, SaaS notes, and verification metadata for all 51 jurisdictions or a single state.",
  {
    state: z.string().length(2).optional().describe("2-letter state code for single state lookup. Omit for all states."),
    format: z.enum(["default", "compact", "verified"]).optional()
      .describe("Response format (default: full, compact: machine-optimized, verified: with verification details)"),
    explain: z.boolean().optional().describe("Include human-readable explanations for the rate and taxability"),
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.state) query.set("state", params.state);
    if (params.format) query.set("format", params.format);
    if (params.explain) query.set("explain", "true");
    const qs = query.toString();
    const result = await apiCall("GET", `/api/v1/rates${qs ? "?" + qs : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── configure_nexus ────────────────────────────────────────────────────────
server.tool(
  "configure_nexus",
  "Configure which US states you have economic nexus in. Sellers must configure nexus to get non-zero tax results. Requires API key.",
  {
    nexus: z.record(
      z.string(),
      z.object({
        hasNexus: z.boolean().describe("Whether you have nexus in this state"),
        reason: z.string().optional().describe("Reason for nexus (e.g. 'Economic nexus — over $500K revenue')"),
      })
    ).describe("Object with state codes as keys, e.g. { TX: { hasNexus: true, reason: '...' } }"),
  },
  async (params) => {
    const result = await apiCall("POST", "/api/v1/nexus", params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── check_health ───────────────────────────────────────────────────────────
server.tool(
  "check_health",
  "Check AgentTax API health, available endpoints, pricing tiers, and registry validation status.",
  {},
  async () => {
    const result = await apiCall("GET", "/api/v1/health");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Start server ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
