# AgentTax MCP Server

Tax compliance tools for AI agents, powered by [AgentTax](https://agenttax.io).

This MCP server gives any AI agent (Claude, Cursor, Windsurf, etc.) native access to sales tax calculation, capital gains tracking, and tax rate data — no HTTP code required.

## Install

### Claude Code

```bash
claude mcp add agenttax -- npx @agenttax/mcp-server
```

Then set your API key:

```bash
export AGENTTAX_API_KEY=atx_live_your_key
```

Or use demo mode (no key, 50 calls/day).

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

## Tools

### calculate_tax

Calculate US sales/use tax for an AI agent transaction.

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

Returns tax amount, rate, jurisdiction breakdown, audit trail, and advisories.

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

```
check_health()
```

## Get an API Key

```bash
curl -X POST https://agenttax.io/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "securepass", "agent_name": "my-agent"}'
```

Save the `api_key.key` from the response — it's only shown once.

## Pricing

| Tier | Price | Calculations |
|------|-------|-------------|
| Free | $0 | 100/month |
| Starter | $25/mo | 10,000/month |
| Growth | $99/mo | 100,000/month |
| Pro | $199/mo | 1,000,000/month |
| x402 | ~$0.001/call | Unlimited |

## Links

- [AgentTax](https://agenttax.io)
- [API Docs](https://agenttax.io/?view=api-docs)
- [Agent Integration Guide](https://agenttax.io/api/v1/agents)
- [GitHub](https://github.com/AgentTax/agenttax-mcp)

## License

MIT
