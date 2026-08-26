# Connectors

This plugin bundles exactly one connector: the Accounted MCP server, the same server that backs the Accounted connector in Claude.ai and the `accounted-mcp` stdio bridge.

| Connector | Server | Auth | What it reaches |
|-----------|--------|------|-----------------|
| Accounted | `https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted` | OAuth 2.1 (PKCE). One-click consent: all scopes pre-selected (adjustable in a fold); every write still stages for explicit approval before it touches the ledger. | The user's own companies in Accounted: ledger, transactions, invoices, VAT, payroll, reconciliation, year-end. |

## Share link and starter prompt

One-click add on claude.ai (opens the Add custom connector dialog prefilled; the params are `connectorName`/`connectorUrl`):

```
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Accounted&connectorUrl=https%3A%2F%2Fapp.accounted.se%2Fapi%2Fextensions%2Fext%2Fmcp-server%2Fmcp%3Ftool_namespace%3Daccounted
```

Pair the link with a starter prompt the user pastes as their first message. It stays copy-paste ready for everyone because it points the agent at what it already knows (Claude memory, earlier chats) instead of containing the user's own data; the server-side onboarding skill carries the rest of the flow:

> Sätt upp mitt företag i Accounted. Utgå från det du redan vet om mig och mitt bolag (organisationsnummer, bank, tidigare bokföringssystem) och fråga bara efter det som saknas. Håll det kort.

## How the connection works

- **Lazy authentication.** The server answers `initialize`, `tools/list` and the documentation tools (`accounted_search_tools`, `accounted_list_skills`, `accounted_load_skill`) without any credentials. The first company-scoped call returns an authentication challenge, which Claude Code surfaces as `/mcp` → authenticate and Claude.ai as an inline Connect prompt.
- **Adding it by hand in Claude.ai** (Settings → Connectors → Add custom connector): choose Authentication **"Required when the server asks"** (not the auto-detected "None") and OAuth client **"register one automatically" (DCR)**; the server does not advertise CIMD yet. No extra headers, Streamable HTTP.
- **Account creation inside the sign-in.** A user who has no Accounted account creates one on the sign-in screen the challenge opens (BankID or e-mail + 2FA). No visit to the website first. `/accounted:setup` walks the whole flow, including creating the company from the conversation.
- **Every write is staged.** Write tools create a pending operation with a preview; nothing is booked until the user approves, either in chat via `accounted_approve_pending_operation` or in the web app.
- **Data stays in the user's tenant.** The connector only ever sees companies the signed-in user is a member of, enforced server-side per call.

## Self-hosted Accounted

Point the plugin at your own instance: remove the bundled server and add yours with `claude mcp add --transport http accounted "https://your-host/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted"`. The same OAuth flow, skills and commands apply.
