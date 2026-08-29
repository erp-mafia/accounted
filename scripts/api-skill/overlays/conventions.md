## Conventions

These rules hold across the whole surface; endpoint entries below do not
repeat them.

**Response envelope.** Success: `{ "data": ..., "meta": { "request_id",
"api_version", "next_cursor"?, "audit"?, "partial_expansions"? } }`. Errors
replace `data` with `error` (no `meta`; `request_id` moves inside `error`).

**Errors.** Stable machine codes with agent-oriented remediation:

```json
{ "error": { "code": "PERIOD_LOCKED", "message": "Svenska", "message_en": "English",
  "details": {}, "recovery_hint": "next step", "docs_url": "...",
  "valid_alternatives": {}, "request_id": "req_..." } }
```

React to `code`, read `message_en` and `recovery_hint`, follow
`valid_alternatives` when present (e.g. `next_open_period`). Standard codes on
every endpoint: `400` validation, `401` bad key, `403` missing scope, `404`,
`429` rate limited (honor `Retry-After`), `500`. Full catalogue:
https://app.gnubok.se/docs/api/errors. Only endpoint-specific codes are
mentioned per endpoint below.

**Cursor pagination.** List endpoints take `?cursor=` and return
`meta.next_cursor`; loop until it is absent/null. A stale or tampered cursor
is NOT an error: the first page is returned again, so terminate on
`next_cursor`, never on "page looks familiar".

**Dry-run on every write that supports it** (`dry-run` badge in the index).
Send `?dry_run=true` (or `X-Dry-Run: true`): the response is always `200` with
`data.dry_run: true` plus a preview (would-be record, journal lines, voucher
number) and the `X-Dry-Run: true` response header; nothing is committed.
Commit by re-issuing without the flag and with the SAME `Idempotency-Key`
(the dry run is not cached against the key). Preview first on any financial
write; it is free.

**Idempotency-Key.** Send a fresh UUID header on every POST/PATCH/DELETE;
several endpoints reject writes without one (`400`). Replaying the same
key+body returns the original response with the `Idempotent-Replayed: true`
header; the same key with a different body returns `409 IDEMPOTENCY_KEY_REUSE`
(24h window). Safe retry loop: keep the key, keep the body.

**Test keys are simulation-only.** With a `gnubok_sk_test_*` key, reads
return real company data (responses carry `X-Gnubok-Mode: test`) and every
write is forced into dry-run; writes that cannot be simulated return
`403 TEST_KEY_WRITE_BLOCKED`. Nothing a test key does ever persists: it is
`?dry_run=true` baked into the credential. Full end-to-end write tests
therefore need a live key against a company you own.

**Atomic writes.** A mutation either commits fully or errors with no side
effects. There is no partial state to clean up after an error response
(`bulk-create` endpoints that do partial success say so explicitly).

**Audit inline.** Successful financial writes include `meta.audit` (voucher
number, audit-trail URL, immutability timestamp). No follow-up read needed to
confirm what was booked.

**Expansion.** Some list/detail endpoints take `?expand=a,b` (documented per
endpoint). If an expansion fails the response still succeeds and names the
failed parts in `meta.partial_expansions`; check it before trusting expanded
fields.

**Async operations.** Long-running actions (fiscal-period lock/close/year-end,
imports) return `202` with an operation id; poll `GET /api/v1/operations/{id}`
until `status` is `succeeded`/`failed`. The response shape is identical
whether the work ran inline or queued.

**Versioning.** Dated versions (current: see `meta.api_version`). Responses
carry the `Gnubok-Version` header; request pinning via a `Gnubok-Version`
request header is reserved for a future breaking change and is not read
today. Additive changes ship without a version bump; see
https://app.gnubok.se/docs/api/versioning.

**Index badges.** Every operation line below carries machine-readable
annotations from the spec: `scope:` (required key scope), `risk:` (low/medium/
high; confirm with a human before unprompted high-risk calls), `idempotent`
(safe to retry), `dry-run` (previewable), `reversible` (a single follow-up
call can undo it, e.g. invoice credit).
