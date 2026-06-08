# gnubok-mcp

Connect [Claude Desktop](https://claude.ai/download) (or any stdio MCP client) to your [Accounted](https://app.gnubok.se) bookkeeping account. This is a thin stdio → HTTPS bridge: it forwards JSON-RPC over stdio to the hosted Accounted MCP server, which exposes 90+ bookkeeping tools (invoices, transactions, VAT/momsdeklaration, payroll, reports, year-end).

Write tools stage a pending operation that you confirm before anything is booked — the bridge never books on its own.

## Quickstart

1. Mint an API key in the Accounted dashboard at **[/settings/api](https://app.gnubok.se/settings?tab=api)**. Use a `gnubok_sk_test_*` key against the sandbox while you evaluate; switch to `gnubok_sk_live_*` for real data. The key's scopes gate which tools are callable.

2. Run the bridge with the key in the environment:

   ```bash
   GNUBOK_API_KEY=gnubok_sk_test_... npx gnubok-mcp
   ```

   It reads JSON-RPC from stdin and writes responses to stdout, so you normally point an MCP client at it rather than running it by hand.

## Claude Desktop config

Add the bridge to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gnubok": {
      "command": "npx",
      "args": ["gnubok-mcp"],
      "env": {
        "GNUBOK_API_KEY": "gnubok_sk_test_..."
      }
    }
  }
}
```

Restart Claude Desktop. The Accounted tools appear in the client and you can start asking questions like *"Show my uncategorized bank transactions and suggest categories."*

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GNUBOK_API_KEY` | yes | — | Your `gnubok_sk_*` API key. |
| `GNUBOK_URL` | no | `https://app.gnubok.se/api/extensions/ext/mcp-server/mcp` | Override the MCP endpoint (e.g. for self-hosted Accounted). |

## Alternative: claude.ai connector (no API key)

If you use **claude.ai** or Claude Desktop's custom-connector flow, you can skip this bridge entirely and add Accounted as an OAuth 2.1 custom connector instead — paste the connector URL `https://app.gnubok.se/api/extensions/ext/mcp-server/mcp` and authorise on the Accounted consent screen (read-only scopes by default; write scopes are ticked explicitly).

## Docs

Full setup, sample prompts, and a 10-minute reviewer test: **[Connect with Claude](https://app.gnubok.se/docs/api/connect-claude)**.

## License

MIT
