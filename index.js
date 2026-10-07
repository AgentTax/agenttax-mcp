#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { z } from "zod";

const { version: PKG_VERSION } = createRequire(import.meta.url)("./package.json");

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
  const text = await resp.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`AgentTax ${resp.status}: non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const msg = parsed?.error || parsed?.message || `HTTP ${resp.status}`;
    const err = new Error(`AgentTax ${resp.status}: ${msg}`);
    err.status = resp.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

function toolError(e) {
  const body = e.body ? `\n${JSON.stringify(e.body, null, 2)}` : "";
  return {
    content: [{ type: "text", text: `AgentTax error: ${e.message}${body}` }],
    isError: true,
  };
}

const STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];
const stateCode = z.preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), z.enum(STATES));
const zip5 = z.string().regex(/^\d{5}$/);

const WORK_TYPES = ["compute", "research", "information_service", "content", "consulting", "trading"];
const TRANSACTION_TYPES = [
  "compute", "api_access", "data_purchase", "saas", "ai_labor", "storage",
  "digital_good", "consulting", "data_processing", "cloud_infrastructure",
  "ai_model_access", "marketplace_fee", "subscription", "license", "service",
];
const DIGITAL_CONTENT_TYPES = [
  "ebook", "audio", "video", "art_image", "photograph", "printable_document", "software", "data", "other",
];

const jsonResult = (result) => ({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });

function withQuery(path, params) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") query.set(k, String(v));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const server = new McpServer({
  name: "agenttax",
  version: PKG_VERSION,
});

// ── calculate_tax ──────────────────────────────────────────────────────────
server.registerTool(
  "calculate_tax",
  {
    title: "Calculate sales or use tax",
    description:
      "Calculate US sales tax (seller) or use tax (buyer) for an AI agent transaction. Returns tax amount, rate, jurisdiction, " +
      "audit trail, confidence score, and advisories. Sellers get $0 sales tax in states without configured nexus " +
      "(see configure_nexus); a $0 total means no collection obligation, not necessarily no tax, so read nexus_warning and advisories.",
    inputSchema: {
      role: z.enum(["buyer", "seller"]).describe("Your role in the transaction"),
      amount: z.number().positive().max(100_000_000).describe("Transaction amount in USD"),
      buyer_state: stateCode.describe("2-letter US state code of the buyer (or DC)"),
      transaction_type: z.enum(TRANSACTION_TYPES).describe("Type of transaction"),
      counterparty_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_\-.:@]+$/)
        .describe("Identifier for the other party (letters, digits and _-.:@ only)"),
      buyer_zip: zip5.optional().describe("Buyer's 5-digit zip code for local rate lookup"),
      seller_state: stateCode.optional().describe("Seller's 2-letter state code (needed for origin-sourced intrastate sales)"),
      seller_zip: zip5.optional()
        .describe("Seller's 5-digit zip. Required for TX/UT/AZ/TN origin-sourced intrastate sales and intrastate OH license/digital_good sales"),
      work_type: z.enum(WORK_TYPES).optional()
        .describe("What the agent's work is economically; drives per-state taxability (compute, research, information_service, content, consulting, trading)"),
      is_b2b: z.boolean().optional().describe("Business-to-business transaction (triggers state B2B rules, e.g. IA, MD)"),
      use_context: z.enum(["enterprise_system", "individual", "mixed"]).optional()
        .describe("Maryland only, with is_b2b=true: whether the purchase is solely for use in an enterprise computer system"),
      digital_content_type: z.enum(DIGITAL_CONTENT_TYPES).optional()
        .describe("With transaction_type digital_good: what the download is. Several states tax e-books, music and video but not digital art or printables"),
      seller_remitting: z.boolean().optional().describe("Buyer side: whether the seller is already collecting the tax"),
    },
    annotations: WRITES, // with an API key the calculation is logged to your history
  },
  async (params) => {
    try {
      return jsonResult(await apiCall("POST", "/api/v1/calculate", params));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── track_payment ─────────────────────────────────────────────────────────
// The primary tool for MCP tool developers. Call this after receiving any
// payment — Stripe, x402, direct, whatever. AgentTax classifies the
// transaction, calculates your sales tax liability, and logs it.
server.registerTool(
  "track_payment",
  {
    title: "Track a payment you received",
    description:
      "Track a payment you received and calculate your sales tax liability. Call this after receiving any payment — Stripe, x402, or direct. " +
      "Classifies the sale from its description, calculates tax owed, and logs it to your AgentTax account (requires API key for history).",
    inputSchema: {
      amount: z.number().positive().max(100_000_000).describe("Payment amount in USD"),
      buyer_state: stateCode.describe("2-letter US state where the buyer is located (e.g. TX, NY, CA)"),
      buyer_zip: zip5.optional().describe("Buyer's 5-digit zip code for local tax rates (more precise)"),
      description: z.string().optional().describe("What you sold — used to classify the transaction (e.g. 'API access', 'MCP tool subscription', 'compute credits', 'AI consulting')"),
      payment_id: z.string().regex(/^[A-Za-z0-9_\-.:@]{1,200}$/).optional()
        .describe("Your payment reference ID (Stripe payment_intent ID, x402 receipt, invoice number); letters, digits and _-.:@ only"),
      source: z.enum(["stripe", "x402", "direct", "other"]).optional().describe("Payment processor used"),
      is_b2b: z.boolean().optional().describe("Buyer is a business (affects rates in MD, IA, NJ)"),
    },
    annotations: WRITES,
  },
  async (params) => {
    try {
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
        return {
          content: [{ type: "text", text: `AgentTax returned success=false:\n${JSON.stringify(result, null, 2)}` }],
          isError: true,
        };
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
        nexus_warning: result.nexus_warning,
        compliance_note: taxOwed > 0
          ? `$${taxOwed.toFixed(2)} sales tax owed to ${params.buyer_state}. Remit to the state DOR.`
          : result.nexus_warning
            ? `No sales tax collected: ${params.buyer_state} is not in your configured nexus states. Use configure_nexus if you have nexus there.`
            : `No sales tax owed in ${params.buyer_state} for this transaction type.`,
      };

      return jsonResult(summary);
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── ingest_transactions ────────────────────────────────────────────────────
const ingestRecord = z.object({
  role: z.enum(["buyer", "seller"]).optional().describe("Default seller"),
  amount: z.number().positive().max(100_000_000),
  buyer_state: stateCode,
  buyer_zip: zip5.optional(),
  seller_state: stateCode.optional(),
  seller_zip: zip5.optional(),
  transaction_type: z.enum(TRANSACTION_TYPES).optional(),
  work_type: z.enum(WORK_TYPES).optional(),
  counterparty_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_\-.:@]+$/).optional(),
  is_b2b: z.boolean().optional(),
  external_tx_id: z.string().max(200).optional().describe("Your ID for the payment (e.g. x402 receipt); makes ingest idempotent"),
}).passthrough();

server.registerTool(
  "ingest_transactions",
  {
    title: "Bulk-log x402 purchases",
    description:
      "Bulk-log up to 100 transactions (e.g. purchases from third-party x402 sellers) into your AgentTax history in one call. " +
      "Idempotent on external_tx_id. Requires API key.",
    inputSchema: {
      records: z.array(ingestRecord).min(1).max(100).describe("Transactions to log (max 100)"),
    },
    annotations: WRITES,
  },
  async ({ records }) => {
    try {
      return jsonResult(await apiCall("POST", "/api/v1/transactions/ingest", records));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── list_transactions ──────────────────────────────────────────────────────
server.registerTool(
  "list_transactions",
  {
    title: "List your transactions",
    description: "List your logged transactions with a running summary (seller/buyer counts, total taxable, total tax). Requires API key.",
    inputSchema: {
      role: z.enum(["seller", "buyer"]).optional(),
      state: stateCode.optional().describe("Filter to one state"),
      since: z.string().optional().describe("ISO 8601 date or date-time lower bound, e.g. 2026-08-01"),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: READ_ONLY,
  },
  async (params) => {
    try {
      return jsonResult(await apiCall("GET", withQuery("/api/v1/transactions", params)));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── log_trade ──────────────────────────────────────────────────────────────
server.registerTool(
  "log_trade",
  {
    title: "Log a trade for capital gains",
    description:
      "Log a buy or sell trade for capital gains tracking. Sell trades return realized gain/loss with cost basis, holding period, " +
      "and federal/state estimates. Feeds the 1099-DA export. Requires API key.",
    inputSchema: {
      asset_symbol: z.string().regex(/^[A-Za-z0-9._\-]{1,50}$/).describe("Asset ticker: equity (AAPL), crypto (BTC), or token (COMPUTE-TOKEN)"),
      trade_type: z.enum(["buy", "sell"]).describe("Buy or sell"),
      quantity: z.number().positive().describe("Number of units"),
      price_per_unit: z.number().min(0).describe("Price per unit in USD"),
      fee_amount: z.number().min(0).optional().describe("Fees in USD (default 0)"),
      trade_date: z.string().optional().describe("ISO 8601 trade timestamp; defaults to now"),
      accounting_method: z.enum(["fifo", "lifo", "specific_id"]).optional().describe("Cost basis method (default: fifo)"),
      specific_lot_id: z.string().optional().describe("Lot ID, required when accounting_method is specific_id"),
      asset_class: z.enum(["stock", "security", "securities", "equity", "digital_asset", "crypto"]).optional()
        .describe("stock/security/equity enables wash-sale tracking; digital_asset/crypto do not"),
      resident_state: stateCode.optional().describe("Resident state for the state capital gains estimate"),
      tax_entity_type: z.enum(["individual", "c_corp", "pass_through"]).optional(),
      filing_status: z.enum(["single", "mfj", "mfs", "hoh"]).optional(),
      estimated_annual_income: z.number().min(0).optional().describe("Enables bracket-aware federal estimate and NIIT detection"),
      notes: z.string().max(1000).optional().describe("Free-text notes about the trade"),
    },
    annotations: WRITES,
  },
  async (params) => {
    try {
      return jsonResult(await apiCall("POST", "/api/v1/trades", params));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── list_trades ────────────────────────────────────────────────────────────
server.registerTool(
  "list_trades",
  {
    title: "List logged trades",
    description: "List trades you have logged, with realized gains on sells. Requires API key.",
    inputSchema: {
      asset_symbol: z.string().optional(),
      trade_type: z.enum(["buy", "sell"]).optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Default 50"),
      offset: z.number().int().min(0).optional(),
    },
    annotations: READ_ONLY,
  },
  async (params) => {
    try {
      return jsonResult(await apiCall("GET", withQuery("/api/v1/trades", params)));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── export_1099_da ─────────────────────────────────────────────────────────
server.registerTool(
  "export_1099_da",
  {
    title: "Export draft Form 1099-DA",
    description:
      "Export a DRAFT IRS Form 1099-DA payload for realized digital-asset gains from your logged trades: payer and recipient blocks, " +
      "per-trade lines (boxes 1a–5), and a short/long-term summary. Draft only; not a filed return. Requires API key.",
    inputSchema: {
      year: z.number().int().min(2020).max(2030).optional().describe("Tax year; defaults to the current year"),
    },
    annotations: READ_ONLY,
  },
  async (params) => {
    try {
      return jsonResult(await apiCall("GET", withQuery("/api/v1/export/1099-da", params)));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── get_rates ──────────────────────────────────────────────────────────────
server.registerTool(
  "get_rates",
  {
    title: "Get state sales tax rates",
    description: "Get US state sales tax rates with digital-goods taxability, SaaS notes, and verification metadata, for all 51 jurisdictions or one state. No API key needed.",
    inputSchema: {
      state: stateCode.optional().describe("2-letter state code for a single state. Omit for all states."),
      format: z.enum(["default", "compact", "verified"]).optional()
        .describe("default: full; compact: machine-optimized; verified: with verification details"),
      explain: z.boolean().optional().describe("Include human-readable explanations for the rate and taxability"),
    },
    annotations: READ_ONLY,
  },
  async ({ state, format, explain }) => {
    try {
      return jsonResult(await apiCall("GET", withQuery("/api/v1/rates", { state, format, explain: explain ? "true" : undefined })));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── get_local_rate ─────────────────────────────────────────────────────────
server.registerTool(
  "get_local_rate",
  {
    title: "Get combined rate for a zip code",
    description: "Get the combined state + local sales tax rate for a US zip code, with the breakdown and self-administered locality flags (e.g. Colorado home-rule cities). No API key needed.",
    inputSchema: {
      zip: zip5.describe("5-digit US zip code"),
    },
    annotations: READ_ONLY,
  },
  async ({ zip }) => {
    try {
      return jsonResult(await apiCall("GET", withQuery("/api/v1/rates/local", { zip })));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── get_capital_gains_rates ────────────────────────────────────────────────
server.registerTool(
  "get_capital_gains_rates",
  {
    title: "Get state capital gains rates",
    description: "Get state capital gains rates (short and long term) with federal context and per-state caveats, for all states or one. No API key needed.",
    inputSchema: {
      state: stateCode.optional().describe("2-letter state code. Omit for all states."),
      explain: z.boolean().optional().describe("With state: add an explanation block"),
    },
    annotations: READ_ONLY,
  },
  async ({ state, explain }) => {
    try {
      return jsonResult(await apiCall("GET", withQuery("/api/v1/rates/capital-gains", { state, explain: explain ? "true" : undefined })));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── get_nexus_thresholds ───────────────────────────────────────────────────
server.registerTool(
  "get_nexus_thresholds",
  {
    title: "Get economic nexus thresholds",
    description:
      "Get each state's economic nexus threshold (revenue and transaction count), whether it has sales tax, marketplace-facilitator and " +
      "origin-sourcing rules, notes, and the state DOR source link. Use it to see where your sales could require registration. No API key needed.",
    inputSchema: {
      state: stateCode.optional().describe("2-letter state code. Omit for all 51 jurisdictions."),
    },
    annotations: READ_ONLY,
  },
  async ({ state }) => {
    try {
      return jsonResult(await apiCall("GET", withQuery("/api/jurisdictions/supported", { code: state })));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── get_nexus ──────────────────────────────────────────────────────────────
server.registerTool(
  "get_nexus",
  {
    title: "Get your configured nexus states",
    description: "List the states where you have told AgentTax you have nexus, with each state's rate and how nexus monitoring measures thresholds. Requires API key.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return jsonResult(await apiCall("GET", "/api/v1/nexus"));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── configure_nexus ────────────────────────────────────────────────────────
server.registerTool(
  "configure_nexus",
  {
    title: "Configure your nexus states",
    description:
      "Set which US states you have economic nexus in. Sellers must configure nexus to get non-zero sales tax results. " +
      "Merge semantics: only the states you send change; send hasNexus:false to remove one. Requires API key.",
    inputSchema: {
      nexus: z.record(
        stateCode,
        z.object({
          hasNexus: z.boolean().describe("Whether you have nexus in this state"),
          reason: z.string().optional().describe("Reason for nexus (e.g. 'Economic nexus — over $100K revenue')"),
        })
      ).describe("State codes as keys, e.g. { TX: { hasNexus: true, reason: '...' } }"),
    },
    annotations: { ...WRITES, idempotentHint: true },
  },
  async (params) => {
    try {
      return jsonResult(await apiCall("POST", "/api/v1/nexus", params));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── get_pricing ────────────────────────────────────────────────────────────
server.registerTool(
  "get_pricing",
  {
    title: "Get AgentTax pricing",
    description: "Get AgentTax's machine-readable pricing contract: tiers, call limits, and the x402 per-call price. No API key needed.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return jsonResult(await apiCall("GET", "/api/v1/pricing"));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── check_health ───────────────────────────────────────────────────────────
server.registerTool(
  "check_health",
  {
    title: "Check API health",
    description: "Check AgentTax API health, available endpoints, pricing tiers, and registry validation status.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      return jsonResult(await apiCall("GET", "/api/v1/health"));
    } catch (e) {
      return toolError(e);
    }
  }
);

// ── Start server ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
