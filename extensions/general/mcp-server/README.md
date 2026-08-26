# Accounted MCP server

JSON-RPC 2.0 server exposing the Accounted bookkeeping engine to MCP clients (Claude Desktop, Claude Code, etc.). Endpoint: `/api/extensions/ext/mcp-server/mcp`. Add `?tool_namespace=accounted` for the Accounted tool names. Requests without it retain the legacy Gnubok namespace. OAuth and stdio bridges live alongside the API surface: see `app/api/mcp-oauth/`, `packages/accounted-mcp/`, and the compatibility package in `packages/gnubok-mcp/`.

## Tool authoring contract

Enforced by tests in `__tests__/`: these are not style preferences, they're guard rails.

1. **`additionalProperties: false`** on every `inputSchema`. Guarded by `strict-schemas.test.ts`. Forces clear rejections on hallucinated fields instead of silent ignores.
2. **Descriptions ≤ 280 chars.** Guarded by `output-schema.test.ts`. No `Args:` / `Returns:` / `Examples:` prose: those belong in JSON Schema. Use agent-native hints ("Use to…", "Call X first", "HIGH risk").
3. **Staged-operation envelope** for write tools: `outputSchema: STAGED_OPERATION_SCHEMA` (`server.ts`). Fields: `staged, risk_level, actor, message, preview, period_status?, next?`. The `staged: true` boolean is the explicit completion signal; agents must not infer completion from prose. Do NOT introduce a parallel `{ success, shouldContinue, output }` envelope.
4. **`period_status` threading**: any tool that ties to a fiscal-period-bound date (categorize, mark paid, create voucher, correct/reverse entry, approve supplier invoice) passes `dateForPeriodCheck` to `stagePendingOperation`. Response then includes `period_status: { period_id, status: open|locked|closed, lock_date }` so widgets and agents disable writes without round-trips.
5. **Scope mapping**: every new tool needs an entry in `lib/auth/api-keys.ts` `TOOL_SCOPE_MAP`. Missing entries default to deny.
6. **Tests for new write tools**: add staging-gate coverage to `__tests__/voucher-tools.test.ts` (or a sibling) plus executor coverage to `lib/pending-operations/__tests__/voucher-executors.test.ts` if the tool stages a new `operation_type`.

## Determinism / cache stability

Tool definitions (name, description, inputSchema, outputSchema, annotations) are declared as static object literals at module load: no timestamps, no UUIDs, no Date/Math.random in the definition layer. This makes the `tools/list` JSON payload byte-stable across requests, which lets agent-side prompt caches stay warm. **Do not introduce per-request non-determinism into the definitions block.** Anything time-bound or random belongs inside `execute()`.

For internal Anthropic API usage (the SDK is called from `lib/ai/provider.ts` and `lib/ai/services/anthropic-family.ts`; features such as `extensions/general/invoice-inbox/lib/extract-invoice-fields.ts` go through `getAiService()` in `lib/ai` rather than the SDK directly): annotate stable prefixes with `cache_control: { type: 'ephemeral' }` and log `usage.cache_read_input_tokens` for hit-ratio observability. The 1h TTL from the agent-native API plan (item 10) requires the direct Anthropic API; Accounted's Bedrock path defaults to a shorter TTL.

## Payload-size watchdog

`payload-size.bench.test.ts` enforces a `tools/list` JSON payload ceiling. If the test fires, the right answer is rarely "raise the ceiling". Instead, trim descriptions or set specialized wide tools to `catalogVisibility: 'search'`. Those tools remain discoverable with full schemas through `gnubok_search_tools` and callable through `tools/call` without bloating the default catalog.

## Where things live

- `server.ts`: the tools array + JSON-RPC dispatcher
- `tool-result.ts`: `withNext()`, `toToolError()` response helpers
- `resources/`: read-only `Accounted://` URIs, registered in `resources/index.ts`: `company/current`, `period/active`, `recent-activity`, `capabilities`, `attention`, `chart-of-accounts`, `settings/vat-treatments`, `booking-templates`, `ledger/context`, `reconciliation/summary`
- `widgets/`: inline HTML widgets (receipt-matcher, vat-review, pending-operations)
- `prompts/`: slash-command-style prompts
- `skills/`: domain-knowledge skill bodies served via `gnubok_load_skill`
- `public-tools.ts`: lazy authentication (issue #1814). `ANONYMOUS_METHODS` (initialize, ping, tools/prompts/resources listing) and the three `PUBLIC_TOOLS` (`gnubok_search_tools`, `gnubok_list_skills`, `gnubok_load_skill`) answer without credentials, rate-limited per truncated IP; every other `tools/call` gets a transport-level 401 + `WWW-Authenticate` from `handleMcpRequest` in `server.ts`, which is the challenge clients turn into their Connect prompt
- `tasks.ts`: MCP Tasks extension (`io.modelcontextprotocol/tasks`): durable handles for long-running tool calls, rows in `mcp_tasks` (service-role writes only)
- `origin-guard.ts`: Origin-header validation on the Streamable HTTP endpoint (DNS-rebinding defence required by the MCP spec)
- `staging-pii-guard.ts`: refuses a plaintext personnummer in staged `pending_operations` params/preview, so every staging tool inherits the encrypt-at-staging rule
- `tool-namespace.ts`: `?tool_namespace=accounted` handling (`accounted_*` aliases for the canonical `gnubok_*` ids)
- `__tests__/`: strictness guards + per-tool coverage
