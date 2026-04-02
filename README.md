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

Demo mode works without a key (50 calls/day, no account required).

---

## Tools

### track_payment

Track a payment you received and calculate your sales tax liability. The primary tool for MCP tool developers.

```
track_payment({
  amount: 49.00,
  buyer_state: "TX",
  buyer_zip: "78701",
  description: "MCP tool subscription",
  payment_id: "pi_stripe_abc123",
  source: "stripe"
})
```

Returns:
```json
{
  "payment_tracked": true,
  "amount": 49.00,
  "buyer_state": "TX",
  "tax_owed": 4.04,
  "tax_rate": 0.0825,
  "taxable": true,
  "work_type": "content",
  "transaction_id": "atx_...",
  "compliance_note": "$4.04 sales tax owed to TX. Remit to the state DOR."
}
```

Transaction classification is automatic. Set `description` to what you sold for best results, or pass an explicit `work_type` via the Stripe metadata field.

### calculate_tax

Full tax calculation with complete audit trail. Use this when you need jurisdiction details, confidence scoring, and advisories.

```
calculate_tax({
  role: "seller",
  amount: 500,
  buyer_state: "TX",
  buyer_zip: "78701",
  transaction_type: "saas",
  work_type: "content",
  counterparty_id: "customer-abc",
  is_b2b: false
})
```

### log_trade

Log a buy or sell for capital gains tracking.

```
log_trade({
  asset_symbol: "COMPUTE",
  trade_type: "buy",
  quantity: 100,
  price_per_unit: 12.50
})
```

Sell trades return realized gain/loss with cost basis (FIFO, LIFO, or Specific ID).

### get_rates

Get tax rates for all 51 US jurisdictions or a single state.

```
get_rates({ state: "TX", explain: true })
```

### configure_nexus

Set which states you have economic nexus in. Required for sellers to get non-zero tax results.

```
configure_nexus({
  nexus: {
    TX: { hasNexus: true, reason: "Economic nexus" },
    NY: { hasNexus: true, reason: "Physical presence" }
  }
})
```

### check_health

Check API health and available endpoints.

---

## Get an API Key

```bash
curl -X POST https://agenttax.io/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "securepass", "agent_name": "my-mcp-server"}'
```

Save the `api_key.key` from the response — it's only shown once.

## Pricing

| Tier | Price | Calls/month |
|------|-------|-------------|
| Free | $0 | 100 |
| Starter | $25/mo | 10,000 |
| Growth | $99/mo | 100,000 |
| Pro | $199/mo | 1,000,000 |
| x402 | ~$0.001/call | Pay-per-call, no signup |

## Links

- [AgentTax](https://agenttax.io)
- [API Docs](https://agenttax.io/?view=api-docs)
- [Dashboard](https://agenttax.io/?view=dashboard)
- [GitHub](https://github.com/AgentTax/agenttax-mcp)

## License

MIT
