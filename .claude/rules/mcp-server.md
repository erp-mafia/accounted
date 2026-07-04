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
- Tool descriptions must be ≤ 280 chars (guarded by `output-schema.test.ts`). No `Args:` / `Returns:` / `Examples:` blocks: those belong in JSON Schema, not description prose. Use agent-native hints like "Use to…" / "Call X first" instead.
- Completion-signal pattern: tools that stage operations return `STAGED_OPERATION_SCHEMA`: `{ staged, risk_level, actor, message, preview, period_status?, next? }`. The `staged: true` boolean is the explicit completion signal; agents must not infer completion from prose. Do NOT introduce a parallel `{ success, shouldContinue, output }` envelope.
- Machine-readable staging contract: `tools/list` (and `gnubok_search_tools` detail=full) attach a derived `_meta` to staging writes so an agent knows the contract WITHOUT reading prose. `deriveToolMeta()` keys off `outputSchema === STAGED_OPERATION_SCHEMA` and emits `{ requires_approval: true, approve_tool: 'gnubok_approve_pending_operation', preflight? }`; it merges under any literal `_meta` (e.g. UI widget hints), which wins on collision. Add to `TOOL_PREFLIGHT_MAP` when a write has a genuine read-only pre-flight (e.g. `gnubok_run_year_end` → `gnubok_year_end_readiness`). A new staging tool inherits `_meta` for free: just keep its description declaring it stages (guarded by `__tests__/staging-meta.test.ts`). `confirmed=true` belongs on the APPROVE call for high-risk ops, never on the staging tool; only some tools accept `dry_run`/`idempotency_key`: never imply they are universal.
- Skill/atom summaries: `gnubok_list_skills` and `gnubok_get_agent_briefing` pass registry `description` fields through `toSummary()` (`skills/atoms.ts`): the raw SKILL.md frontmatter is a long keyword-stuffed trigger list authored for CLI matching, not display copy, and gets truncated mid-sentence otherwise. Full bodies are fetched via `gnubok_load_skill`. The local `.claude/skills/*` are the Claude-Code surface; the `agent_atom_registry` rows seeded from the same bodies are the canonical connector surface: when they overlap, the connector atom is authoritative for MCP users.
- Tools that touch a fiscal-period-bound date (categorize, mark paid, create voucher, correct/reverse entry, approve supplier invoice) pass `dateForPeriodCheck` to `stagePendingOperation` so the response includes `period_status: { period_id, status: open|locked|closed, lock_date }`. Widgets and agents use this to disable writes without round-trips.
- Qualified identifiers: no bare `id` in tool OUTPUT schemas: every identifier is fully qualified (`transaction_id`, `journal_entry_id`, `fact_id`, `dimension_value_id`, …) so agents never guess which entity an id belongs to. Guarded by `__tests__/qualified-ids.test.ts` (a shrinking grandfathered list carries the deprecated `id` aliases; new tools must use qualified names only).
- Error envelope: every tool failure flows through the single dispatch point (`toToolError` → `getStructuredError`) and returns `{ error: { code, message_sv, message_en, retryable, remediation? } }`. `retryable` is ALWAYS an explicit boolean: `true` means transient (back off and retry the identical call, pairing with `idempotency_key` where the tool accepts one); `false` means permanent for these inputs (fix arguments/state, never blind-retry). Unclassified transient failures (deadlock, statement timeout, connection drop, upstream 429/5xx) surface as code `TRANSIENT_ERROR`. Don't wrap errors in ad-hoc shapes inside tools: throw (typed errors or plain `Error`; SQLSTATE/message inference handles classification) and let the dispatch layer build the envelope. Client-side failures (e.g. the claude.ai approval elicitation's "No approval received") never reach this envelope: idempotency keys are what make those blind retries safe.
