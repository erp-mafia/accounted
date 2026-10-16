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

**Typed handles.** Responses add `handle` next to the id of the resources
they return (the endpoint schemas show where):
`<prefix>_<the UUID as 32 lowercase hex, no dashes>`, so journal entry
`0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b` is `je_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b`.
It is the same id spelled with its type: store the handle and you always know
what an id names. Every path id and every body or query field named for a
resource (`journal_entry_id`, `credited_invoice_id`, `invoice_ids`,
`period_id`, ...) accepts the handle or the plain UUID; the plain UUID keeps
working everywhere. A handle of the wrong type (an `inv_` invoice handle where
a journal entry id belongs) is refused with `400 HANDLE_TYPE_MISMATCH` before
anything is read: `error.details.issues[]` names the `field`, the
`expected_prefix` it takes (null: plain UUID only) and the `received_prefix`.
Id fields keep their names and values (`journal_entry_id` still holds the
UUID); only `handle` is added. Prefixes are permanent: `cmp` company, `je`
journal entry, `inv` customer invoice (quotes and credit notes too), `sinv`
supplier invoice, `cus` customer, `sup` supplier, `txn` bank transaction,
`doc` document, `pop` pending operation, `fp` fiscal period, `emp` employee,
`srun` salary run, `art` article, `ast` fixed asset, `dim` dimension, `dimv`
dimension value, `inbx` inbox item, `exp` expense claim, `cash` cash account,
`pmt` payment order, `spb` supplier payment batch, `wh` webhook, `whd`
webhook delivery, `op` async operation, `svc` service account, `key` API key.
Sub-resources without a prefix
(salary lines, benefits, reconciliation signoffs) take the plain UUID only.
MCP tools accept handles in their id arguments too and still answer plain
UUIDs.

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

**Pin the preview you showed** (`x-preview-token-supported` in the spec).
The dry run of these writes also answers `data.preview_token`. The flow for
an agent: dry run, show the person `data.preview`, and once they confirm,
commit the same request with the header `Preview-Token: <preview_token>`
(and the same `Idempotency-Key`). The commit then books exactly what was
shown, or answers `409 PREVIEW_STALE` and writes nothing when something moved
in between (a period locked, an account deactivated, a rate changed, another
write landed): `error.details.preview` is what the write would do now and
`error.details.preview_token` its token, so show that, ask again and resend
with the new token. A token binds the operation, the company and the exact
input, so it never passes anywhere else. It works with `?stage=true` too.
The header on an endpoint without the flag, or a malformed value, is `400`;
without the header nothing changes. Over MCP the generated write tools take
the same token as a `preview_token` argument when staging.

**Stage for approval** (`stage` query parameter in the endpoint entry,
`x-stage-supported` in the spec). A write that agents stage over MCP can be
staged over REST too: send it with `?stage=true` and nothing is committed;
the answer is `202` with a pending operation (`pending_operation_id`,
`status: "pending"`, `task_state: "working"`, the `preview` an approver sees).
It commits only when approved: `POST /pending-operations/{id}/approve` (scope
`pending_operations:approve`, `{"confirmed": true}` for `risk_level` high),
or a person in the app; `POST /pending-operations/{id}/reject` discards it.
Poll `GET /pending-operations/{id}` until `task_state` is terminal:
`completed` (committed, `result` holds the outcome), `failed` (the approved
commit did not go through) or `cancelled` (rejected, expired or superseded).
`stage=true` on any other endpoint is `400 STAGE_NOT_SUPPORTED`; values other
than `true`/`false` are `400`. With `dry_run=true` (or a test key) the staging
is previewed and nothing is stored. Approving twice never commits twice: the
second approval answers `409 PENDING_OPERATION_NOT_PENDING` with the
operation as it stands.

**Idempotency-Key.** Send a fresh UUID header on every POST/PATCH/DELETE;
several endpoints reject writes without one (`400`). Replaying the same
key+body returns the original response with the `Idempotent-Replayed: true`
header; the same key with a different body returns `409 IDEMPOTENCY_KEY_REUSE`
(24h window). A repeat sent while the first request with that key is still
running returns `409 IDEMPOTENCY_KEY_IN_PROGRESS` with `Retry-After` and runs
nothing: wait, then resend the identical request to get the first answer.
Safe retry loop: keep the key, keep the body.

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

**Report query parameters.** A report read never answers an unfiltered report
to a dimension filter it cannot apply: `dim_no`, `dim_code`, `dimensions`,
`project` or `cost_center` on a report that does not document them is
`400 VALIDATION_ERROR`. Any other query parameter a report does not document
is not applied, and the response names it in the `X-Ignored-Query-Params`
header: check that header when a filter seems to have had no effect.

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
