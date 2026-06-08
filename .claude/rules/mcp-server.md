---
paths:
  - "extensions/general/mcp-server/**"
  - "packages/gnubok-mcp/**"
---

# MCP Server

Accounted exposes its bookkeeping engine as an MCP server for Claude Desktop/Code.

**MCP extension** (`extensions/general/mcp-server/`): 90+ tools covering transactions, categorization, customers/suppliers, invoices, accounts, fiscal periods, reports (trial balance, GL, BS, IS, AR/supplier ledger, VAT, KPI), reconciliation, salary runs, AGI, year-end, document upload, and loadable skills. JSON-RPC 2.0. Endpoint: `/api/extensions/ext/mcp-server/mcp`.

**OAuth 2.1** for Claude connectors: `.well-known/oauth-protected-resource` + `.well-known/oauth-authorization-server` discovery; `/api/mcp-oauth/authorize`, `/token` (PKCE), `/register`. Stateless AES-256-GCM auth codes (`lib/auth/oauth-codes.ts`). Single-use via `oauth_used_codes`. Allowlist: `claude.ai/api/*`, `claude.com/api/*`, `localhost`.

**npm package** (`packages/gnubok-mcp`): Stdio-to-HTTP bridge; users run `npx gnubok-mcp` with API key.

## Tool authoring conventions (enforced by tests)

- Every `inputSchema` must declare `additionalProperties: false` at the top level. Guarded by `extensions/general/mcp-server/__tests__/strict-schemas.test.ts`.
- Tool descriptions must be ≤ 280 chars (guarded by `output-schema.test.ts`). No `Args:` / `Returns:` / `Examples:` blocks — those belong in JSON Schema, not description prose. Use agent-native hints like "Use to…" / "Call X first" instead.
- Completion-signal pattern: tools that stage operations return `STAGED_OPERATION_SCHEMA` — `{ staged, risk_level, actor, message, preview, period_status?, next? }`. The `staged: true` boolean is the explicit completion signal; agents must not infer completion from prose. Do NOT introduce a parallel `{ success, shouldContinue, output }` envelope.
- Tools that touch a fiscal-period-bound date (categorize, mark paid, create voucher, correct/reverse entry, approve supplier invoice) pass `dateForPeriodCheck` to `stagePendingOperation` so the response includes `period_status: { period_id, status: open|locked|closed, lock_date }`. Widgets and agents use this to disable writes without round-trips.
