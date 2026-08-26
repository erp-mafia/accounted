# gnubok-mcp

Legacy compatibility package for existing MCP configurations. New installations
should use [`accounted-mcp`](https://www.npmjs.com/package/accounted-mcp).
This package, its environment variables, and all existing API keys remain
supported.

Connect [Claude Desktop](https://claude.ai/download) (or any stdio MCP client) to your [Accounted](https://app.gnubok.se) bookkeeping account. This is a thin stdio → HTTPS bridge: it forwards JSON-RPC over stdio to the hosted Accounted MCP server, which exposes 90+ bookkeeping tools (invoices, transactions, VAT/momsdeklaration, payroll, reports, year-end).

Write tools stage a pending operation that you confirm before anything is booked: the bridge never books on its own.

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
| `GNUBOK_API_KEY` | yes | - | Your `gnubok_sk_*` API key. |
| `GNUBOK_URL` | no | `https://app.gnubok.se/api/extensions/ext/mcp-server/mcp` | Override the MCP endpoint (e.g. for self-hosted Accounted). |
| `GNUBOK_CLIENT` | no | - | Distribution-channel marker (e.g. `openclaw`), sent as `X-Gnubok-Client`. Telemetry only: never affects auth or behavior. |

## Alternative: claude.ai connector (no API key)

If you use **claude.ai** or Claude Desktop's custom-connector flow, you can skip this bridge entirely and add Accounted as an OAuth 2.1 custom connector instead: paste the connector URL `https://app.gnubok.se/api/extensions/ext/mcp-server/mcp?client=claude-connector` and authorise on the Accounted consent screen (read-only scopes by default; write scopes are ticked explicitly).

## Docs

Full setup, sample prompts, and a 10-minute reviewer test: **[Connect with Claude](https://app.gnubok.se/docs/api/connect-claude)**.

## Releasing

The package is published to npm by the `Publish MCP bridges to npm` workflow
(`.github/workflows/npm-publish.yml`), never by hand:

1. Bump `version` in `packages/gnubok-mcp/package.json`.
   This is the legacy package: bump it only for compatibility fixes; new
   functionality goes to `accounted-mcp`.
2. Merge the change to `main`.
3. The workflow compares the new version with the registry and, if it is not
   there yet, runs `npm publish --provenance --access public`. A version that
   already exists on npm is skipped, so other `package.json` edits are harmless.

The workflow needs the repository secret `NPM_TOKEN`: an npm granular access
token with read and write access to `accounted-mcp` and `gnubok-mcp`, with
two-factor bypass enabled so CI can publish. npm caps the lifetime of such
tokens (90 days at the time of writing), so rotate the secret before it lapses.
Without the secret the run fails at its first step. The workflow can also be
started from the Actions tab, for one package or both, with a dry-run option
that packs and validates without publishing.

## License

MIT
