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
paste the URL, then in step 2 choose:

- **Authentication: "Required when the server asks."** Claude auto-detects
  "None" because the server answers the handshake without credentials; with
  "None" the first company-scoped call shows an error instead of the sign-in.
- **OAuth client: "No client ID, register one automatically" (DCR).** The
  server does not advertise Anthropic's hosted client metadata (CIMD) yet.
- No additional headers; transport stays Streamable HTTP.

The connector works before you connect (documentation tools); the first
company-scoped call opens the sign-in prompt, where a new user creates the
account.

## Compatibility

The legacy `gnubok-mcp` package, environment variables, endpoint behavior, and
`gnubok_*` tool aliases remain supported. Existing installations do not need to
change.

## Releasing

The package is published to npm by the `Publish MCP bridges to npm` workflow
(`.github/workflows/npm-publish.yml`), never by hand:

1. Bump `version` in `packages/accounted-mcp/package.json`.
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
