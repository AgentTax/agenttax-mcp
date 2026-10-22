# AgentTax MCP Server

Tax compliance for MCP tool developers and AI agents, powered by [AgentTax](https://agenttax.io).

## For MCP tool developers

If you build MCP tools that charge for usage, you have sales tax obligations in states where your buyers are located. Most payment processors don't handle this correctly for digital services.

Add AgentTax to your MCP setup and call `track_payment` after every payment. That's it.

```json
{
  "mcpServers": {
    "agenttax": {
      "command": "npx",
      "args": ["@agenttax/mcp-server"],
      "env": {
        "AGENTTAX_API_KEY": "atx_live_your_key"
      }
    }
  }
}
```

After a payment:

```
track_payment({
  amount: 49.00,
  buyer_state: "TX",
  buyer_zip: "78701",
  description: "MCP API access — monthly subscription",
  payment_id: "pi_stripe_abc123",
  source: "stripe"
})
```

Returns your tax liability, compliance status, and logs it to your account. All transactions are viewable in your [AgentTax dashboard](https://agenttax.io/?view=dashboard).

## Stripe webhook (fully automated)

For fully automatic tax tracking without calling any tool manually, point your Stripe webhook to AgentTax:

1. In [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks), add an endpoint:
   ```
   https://agenttax.io/api/v1/webhooks/stripe?key=atx_live_YOUR_KEY
   ```
2. Select events: `payment_intent.succeeded`, `checkout.session.completed`, `invoice.paid`, `charge.succeeded`
3. Optional: set `metadata.work_type` on your Stripe products (`compute` | `research` | `content` | `consulting` | `trading`) for precise tax classification

Every payment is automatically classified, taxed, and logged. No code changes required.

> Requires a billing address on the Stripe payment. Enable full address collection in your Stripe Checkout settings.

---

## Install

### Claude Code

```bash
claude mcp add agenttax -- npx @agenttax/mcp-server
export AGENTTAX_API_KEY=atx_live_your_key
```

### Claude Desktop / Cursor / Windsurf

Add to your MCP config file:

```json
{
  "mcpServers": {
    "agenttax": {
      "command": "npx",
      "args": ["@agenttax/mcp-server"],
      "env": {
        "AGENTTAX_API_KEY": "atx_live_your_key"
      }
    }
  }
}
```

Demo mode works without a key (50 calls/day, no account required). Tools marked "Yes" below need `AGENTTAX_API_KEY`.

---

## Tools

| Tool | What it does | Key needed |
|---|---|---|
| `track_payment` | Log a payment you received and get your sales tax liability. The main tool for paid MCP servers and APIs. | Demo works; key for history |
| `calculate_tax` | Full sales/use tax calculation with jurisdiction breakdown, audit trail, confidence score and advisories | Demo works; key for full response |
| `ingest_transactions` | Bulk-log up to 100 transactions (e.g. x402 purchases), idempotent on `external_tx_id` | Yes |
| `list_transactions` | Your transaction history with running totals | Yes |
| `get_nexus_thresholds` | Each state's economic nexus thresholds (revenue / transaction count), notes and DOR source | No |
| `get_nexus` | The states you have configured nexus in | Yes |
| `configure_nexus` | Set the states you have nexus in (merge semantics) | Yes |
| `log_trade` | Log a buy/sell; sells return realized gain/loss with cost basis | Yes |
| `list_trades` | Trades you have logged | Yes |
| `export_1099_da` | Draft Form 1099-DA payload for realized digital-asset gains | Yes (Pro) |
| `get_rates` | State sales tax rates and digital-goods taxability, all 51 jurisdictions or one | No |
| `get_local_rate` | Combined state + local rate for a zip code | No |
| `get_capital_gains_rates` | State short/long-term capital gains rates | No |
| `get_pricing` | Machine-readable pricing contract | No |
| `check_health` | API health and endpoint list | No |

Read-only tools carry the MCP `readOnlyHint` annotation so clients can auto-approve them.

### track_payment

```
track_payment({
  amount: 49.00,
  buyer_state: "TX",
  buyer_zip: "78701",
  description: "MCP tool subscription",
  work_type: "content",
  payment_id: "pi_stripe_abc123",
  source: "stripe"
})
```

Returns `tax_owed`, `tax_rate`, `taxable`, `transaction_id`, a `classification` (where the work type came from) and a `compliance_note`. Sellers get $0 in states where no nexus is configured; the response says so in `nexus_warning`.

**Pass `work_type` explicitly** (`compute` | `research` | `information_service` | `content` | `consulting` | `trading`) when you know what you sold. It is a declaration and gives the exact answer, and it is the only way the consulting or trading exemption applies: for example, AI consulting sold to an Arizona buyer is an exempt professional service (A.R.S. §42-5061(A)(1), TPR 93-48), so `work_type: "consulting"` returns $0 in AZ. Without `work_type` the server guesses from `description`, but a guess never takes the consulting or trading exemption: a description that looks like consulting (e.g. "SOC 2 audit platform subscription") or trading is taxed as SaaS, and `classification.note` tells you to resend with `work_type` if the guess was right. A description that looks like compute or research keeps the 1.1.1 classification, which can tax less than SaaS in some states (e.g. CT, MD, SC, TN, WV); pass `work_type` for an exact answer. Leave `is_b2b` out when you don't know the buyer; `false` declares a consumer. Upgrading from 1.1.1? Some `track_payment` results change; see [CHANGELOG.md](CHANGELOG.md).

### calculate_tax

```
calculate_tax({
  role: "buyer",
  amount: 500,
  buyer_state: "TX",
  buyer_zip: "78701",
  transaction_type: "compute",
  work_type: "compute",
  counterparty_id: "seller-agent-123",
  is_b2b: true
})
```

Optional fields: `seller_state` / `seller_zip` (origin-sourced intrastate sales in TX, UT, AZ, TN and some OH sales), `use_context` (Maryland B2B), `digital_content_type` (with `transaction_type: "digital_good"`), `seller_remitting`. `transaction_type` and `work_type` are sent exactly as given and treated as declared facts; don't guess them (`consulting` is exempt in Arizona).

**`intent`** (optional, `"estimate"` | `"record"`). Pass `"estimate"` to quote a price before a wallet signs. An estimate is computed and counts toward your monthly quota, but it is never saved to your transaction history, never counts toward nexus revenue, and ignores any idempotency key. With an API key and no `intent`, the call is a `"record"` and is logged. Keyless demo calls are always estimates. The server sends `intent` only when you pass it. It needs the AgentTax API release that accepts `intent` (live on agenttax.io since 2026-10-21).

**`resolution`** in the response says how sure each part of the answer is. `resolution.location`, `resolution.nexus` and `resolution.taxability` each carry a `status` (`resolved`, `partial` or `unknown`), a `basis` (for example `zip_local_rate`, `state_only`, `no_nexus_profile`, `fact_not_declared`) and a `detail` sentence. `total_tax` is always returned, never withheld. If your rule is "unknown means do not charge", branch on the status yourself:

```js
// Pseudo-code. quote = the parsed JSON result of the calculate_tax tool call
const price = 20;
const quote = await calculate_tax({
  role: "seller", amount: price, buyer_state: "NY", buyer_zip: "10001",
  transaction_type: "saas", counterparty_id: "buyer-agent-7", intent: "estimate"
});

if (quote.resolution.nexus.status === "unknown") {
  // No nexus profile configured: total_tax may be $0 only because nexus was never set up.
  // Run configure_nexus, or hold the sale for review, instead of charging $0.
} else {
  charge(price + quote.total_tax);
}
```

### Nexus

```
get_nexus_thresholds({ state: "NY" })          // what triggers registration
configure_nexus({ nexus: { TX: { hasNexus: true, reason: "Economic nexus" } } })
get_nexus()                                     // what you have configured
```

### Capital gains and 1099-DA

```
log_trade({ asset_symbol: "ETH", trade_type: "buy", quantity: 2, price_per_unit: 2500, asset_class: "crypto" })
log_trade({ asset_symbol: "ETH", trade_type: "sell", quantity: 1, price_per_unit: 3100, asset_class: "crypto" })
export_1099_da({ year: 2026 })                  // draft, not a filed return
```

---

## Get an API Key

```bash
curl -X POST https://agenttax.io/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "securepass", "agent_name": "my-mcp-server", "agent_work_type": "compute"}'
```

All four fields are required; `agent_work_type` is one of `compute`, `research`, `information_service`, `content`, `consulting`, `trading`. Save the `api_key.key` from the response — it's only shown once.

## Pricing

| Tier | Price | Calls/month |
|------|-------|-------------|
| Free | $0 | 1,500 |
| Starter | $25/mo | 10,000 |
| Growth | $99/mo | 100,000 |
| Pro | $199/mo | 1,000,000 |
| x402 | $0.005/call in USDC on Base | Pay per call, no signup |

Current machine-readable pricing: `get_pricing` or `GET https://agenttax.io/api/v1/pricing`.

## Links

- [AgentTax](https://agenttax.io)
- [API Docs](https://agenttax.io/?view=api-docs)
- [Dashboard](https://agenttax.io/?view=dashboard)
- [GitHub](https://github.com/AgentTax/agenttax-mcp)

## License

MIT
