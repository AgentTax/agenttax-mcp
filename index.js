#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.AGENTTAX_BASE_URL || "https://agenttax.io";
const API_KEY = process.env.AGENTTAX_API_KEY || "";

// Classify work type from a plain-English description.
// Developers can describe what they sold and we auto-classify for tax purposes.
function classifyWorkType(description) {
  if (!description) return "content";
  const d = description.toLowerCase();
  if (/\b(compute|inference|gpu|process|api[\s-]?call|token)\b/.test(d)) return "compute";
  if (/\b(research|analysis|analytics|data[\s-]?(process|feed))\b/.test(d)) return "research";
  if (/\b(consult|advisory|advice|audit)\b/.test(d)) return "consulting";
  if (/\b(trade|trading|swap|asset)\b/.test(d)) return "trading";
  return "content"; // Default: SaaS / digital service
}

const WORK_TYPE_TO_TX_TYPE = {
  compute: "compute",
  research: "api_access",
  content: "saas",
  consulting: "consulting",
  trading: "digital_good",
};

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

// ── track_payment ─────────────────────────────────────────────────────────
// The primary tool for MCP tool developers. Call this after receiving any
// payment — Stripe, x402, direct, whatever. AgentTax classifies the
// transaction, calculates your sales tax liability, and logs it.
server.tool(
  "track_payment",
  "Track a payment you received and calculate your sales tax liability. Call this after receiving any payment — Stripe, x402, or direct. Automatically classifies the transaction, calculates tax owed, and logs it to your AgentTax account.",
  {
    amount: z.number().positive().describe("Payment amount in USD"),
    buyer_state: z.string().length(2).describe("2-letter US state where the buyer is located (e.g. TX, NY, CA)"),
    buyer_zip: z.string().length(5).optional().describe("Buyer's 5-digit zip code for local tax rates (more precise)"),
    description: z.string().optional().describe("What you sold — used to classify the transaction (e.g. 'API access', 'MCP tool subscription', 'compute credits', 'AI consulting')"),
    payment_id: z.string().optional().describe("Your payment reference ID for deduplication (Stripe payment_intent ID, x402 receipt, invoice number, etc.)"),
    source: z.enum(["stripe", "x402", "direct", "other"]).optional().describe("Payment processor used"),
    is_b2b: z.boolean().optional().describe("Buyer is a business (affects rates in MD, IA, NJ)"),
  },
  async (params) => {
    const workType = classifyWorkType(params.description);
    const transactionType = WORK_TYPE_TO_TX_TYPE[workType] || "saas";
    const counterpartyId = params.payment_id || `payment_${Date.now()}`;

    const result = await apiCall("POST", "/api/v1/calculate", {
      role: "seller",
      amount: params.amount,
      buyer_state: params.buyer_state,
      buyer_zip: params.buyer_zip,
      transaction_type: transactionType,
      work_type: workType,
      counterparty_id: counterpartyId,
      is_b2b: params.is_b2b || false,
    });

    if (!result.success) {
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    const taxOwed = result.total_tax || 0;
    const summary = {
      payment_tracked: true,
      source: params.source || "unspecified",
      amount: params.amount,
      buyer_state: params.buyer_state,
      tax_owed: taxOwed,
      tax_rate: result.sales_tax?.rate || result.combined_rate || 0,
      taxable: taxOwed > 0,
      work_type: result.work_type,
      transaction_id: result.transaction_id,
      compliance_note: taxOwed > 0
        ? `$${taxOwed.toFixed(2)} sales tax owed to ${params.buyer_state}. Remit to the state DOR.`
        : `No sales tax owed in ${params.buyer_state} for this transaction type.`,
    };

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
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
