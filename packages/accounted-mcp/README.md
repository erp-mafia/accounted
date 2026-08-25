# accounted-mcp

Connect Claude Desktop, Claude Code, or another stdio MCP client to your
[Accounted](https://app.accounted.se) bookkeeping account.

This zero-dependency bridge forwards JSON-RPC over stdio to the hosted Accounted
MCP server. New connections receive the `accounted_*` tool namespace. Existing
`gnubok-mcp` configurations remain supported separately.

## Setup

1. Create an API key in Accounted under **Settings > API**.
2. Add the bridge to your MCP client:

```json
{
  "mcpServers": {
    "accounted": {
      "command": "npx",
      "args": ["-y", "accounted-mcp"],
      "env": {
        "ACCOUNTED_API_KEY": "gnubok_sk_test_...",
        "ACCOUNTED_CLIENT": "claude-desktop"
      }
    }
  }
}
```

The credential value retains the legacy `gnubok_sk_*` wire prefix for backward
compatibility. Only the MCP integration is being renamed in this release.

## Environment variables

| Variable | Required | Default | Description |
|---|---:|---|---|
| `ACCOUNTED_API_KEY` | yes | none | Your existing Accounted API key. |
| `ACCOUNTED_URL` | no | Accounted hosted MCP endpoint | Override for self-hosted Accounted. The bridge adds `tool_namespace=accounted` when omitted. |
| `ACCOUNTED_CLIENT` | no | none | Telemetry-only distribution marker such as `claude-desktop`. |

The API key scopes determine which tools are visible and callable. Write tools
stage pending operations for explicit approval before anything is booked.

## OAuth connector (no API key, no account needed up front)

Clients with OAuth support connect directly without this bridge and without an
existing API key. The sign-in screen lets a new user create the Accounted
account (BankID or e-mail), and company setup then continues in the
conversation through the `onboarding` skill and `accounted_create_company`:

```text
https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted
```

```bash
# Claude Code
claude mcp add --transport http accounted \
  "https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted"

# OpenAI Codex
codex mcp add accounted --url \
  "https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted"
```

Claude.ai and Claude Desktop: Settings > Connectors > Add custom connector,
paste the URL. The connector works before you connect (documentation tools);
the first company-scoped call opens the Connect prompt.

## Compatibility

The legacy `gnubok-mcp` package, environment variables, endpoint behavior, and
`gnubok_*` tool aliases remain supported. Existing installations do not need to
change.
