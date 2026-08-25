# Connectors

This plugin bundles exactly one connector: the Accounted MCP server, the same server that backs the Accounted connector in Claude.ai and the `accounted-mcp` stdio bridge.

| Connector | Server | Auth | What it reaches |
|-----------|--------|------|-----------------|
| Accounted | `https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted` | OAuth 2.1 (PKCE). Read-only scopes by default; write scopes are ticked explicitly on the consent screen. | The user's own companies in Accounted: ledger, transactions, invoices, VAT, payroll, reconciliation, year-end. |

## How the connection works

- **Lazy authentication.** The server answers `initialize`, `tools/list` and the documentation tools (`accounted_search_tools`, `accounted_list_skills`, `accounted_load_skill`) without any credentials. The first company-scoped call returns an authentication challenge, which Claude Code surfaces as `/mcp` → authenticate.
- **Account creation inside the sign-in.** A user who has no Accounted account creates one on the sign-in screen the challenge opens (BankID or e-mail + 2FA). No visit to the website first. `/accounted:setup` walks the whole flow, including creating the company from the conversation.
- **Every write is staged.** Write tools create a pending operation with a preview; nothing is booked until the user approves, either in chat via `accounted_approve_pending_operation` or in the web app.
- **Data stays in the user's tenant.** The connector only ever sees companies the signed-in user is a member of, enforced server-side per call.

## Self-hosted Accounted

Point the plugin at your own instance: remove the bundled server and add yours with `claude mcp add --transport http accounted "https://your-host/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted"`. The same OAuth flow, skills and commands apply.
