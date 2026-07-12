# Accounted MCP server

JSON-RPC 2.0 server exposing the Accounted bookkeeping engine to MCP clients (Claude Desktop, Claude Code, etc.). Endpoint: `/api/extensions/ext/mcp-server/mcp`. OAuth and stdio bridge live alongside the API surface: see `app/api/mcp-oauth/` and `packages/gnubok-mcp/`.

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

For internal Anthropic API usage (today only `extensions/general/invoice-inbox/lib/extract-invoice-fields.ts`): annotate stable prefixes with `cache_control: { type: 'ephemeral' }` and log `usage.cache_read_input_tokens` for hit-ratio observability. The 1h TTL from the agent-native API plan (item 10) requires the direct Anthropic API; Accounted's Bedrock path defaults to a shorter TTL.

## Payload-size watchdog

`payload-size.bench.test.ts` enforces a `tools/list` JSON payload ceiling (currently 36,000 tokens, bumped from 32,000 when top-level `Tool.title` landed on all tools for Claude Connectors Directory readiness). If the test fires, the right answer is rarely "raise the ceiling". Instead, trim descriptions or leverage `gnubok_search_tools` (already deployed; tool definitions can defer to it for discovery rather than enumerating in `tools/list`).

## Where things live

- `server.ts`: the tools array + JSON-RPC dispatcher
- `tool-result.ts`: `withNext()`, `toToolError()` response helpers
- `resources/`: read-only `Accounted://` URIs (active company, period, recent activity, capabilities, attention items, voucher gaps, chart of accounts, VAT treatments)
- `widgets/`: inline HTML widgets (receipt-matcher, vat-review)
- `prompts/`: slash-command-style prompts
- `skills/`: domain-knowledge skill bodies served via `gnubok_load_skill`
- `__tests__/`: strictness guards + per-tool coverage
