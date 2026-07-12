import { API_V1_VERSION } from '@/lib/api/v1/version'

export const VERSIONING_MD = `# Versioning + idempotency + dry-run

> Three guarantees that hold across the entire v1 surface: stable response shapes pinned per request, safe retries on every write, and previewable side effects on every mutation. Once you've internalised them you can predict the shape of any new endpoint without reading its reference.

## Versioning

The major version is encoded in the URL: \`/api/v1/\`. Within v1, the response shape is dated and pinned. The current version is **\`${API_V1_VERSION}\`**.

Every response carries the active version in headers and the \`meta\` envelope:

\`\`\`
Gnubok-Version: ${API_V1_VERSION}
\`\`\`
\`\`\`json
{ "data": {...}, "meta": { "request_id": "...", "api_version": "${API_V1_VERSION}" } }
\`\`\`

### Pinning

Webhooks are pinned to the API version active at creation time (the \`api_version_pinned\` column on the \`webhooks\` row). Payload shapes for *your* webhook will not change until you explicitly upgrade: even if we ship a new dated version that breaks the shape for newly-created webhooks.

API requests pin per-request via the \`Gnubok-Version\` request header (planned for v1.x; today every request gets the current version):

\`\`\`bash
curl https://app.gnubok.se/api/v1/companies \\
  -H "Authorization: Bearer ..." \\
  -H "Gnubok-Version: ${API_V1_VERSION}"
\`\`\`

### Deprecation policy

When we ship a new dated version that breaks an existing shape:

1. The new version is dated forward (e.g. \`2026-08-01\`) and made the default for newly-created keys + webhooks.
2. The previous version stays available for at least **6 months** after the new version ships.
3. Deprecation appears in the [changelog](/docs/api/changelog) with the retirement date and a migration guide.
4. Three months before retirement, every response from a deprecated version stamps \`Gnubok-Deprecation: <ISO date>\` in headers.
5. Calls to a retired version receive HTTP 410 with code \`API_VERSION_RETIRED\`.

We will not break a shape inside an active dated version. Additive changes (new optional response fields, new request fields with defaults, new endpoints) ship as patch updates and are always backwards-compatible.

### What counts as a breaking change

- Removing a response field
- Renaming a response field
- Changing the type of a response field
- Removing an endpoint
- Removing or narrowing a stable error code
- Tightening request validation in a way that rejects previously-accepted input
- Changing the URL of an existing endpoint

What does NOT count as a breaking change:

- Adding a new optional response field
- Adding a new optional request field with a default
- Adding a new endpoint
- Adding a new error code (we expand the catalogue freely; existing codes stay stable)
- Loosening request validation
- Performance improvements that don't change observable behaviour

---

## Idempotency

Every state-changing endpoint (POST, PATCH, DELETE) accepts an \`Idempotency-Key\` header. The key is treated as an opaque string (a UUID is recommended, but any unique value works); the server caches the response keyed by \`(user_id, company_id, idempotency_key)\` for 24 hours. The canonical hash of the request body is stored alongside and compared on replay: same key + same body returns the cached response, same key + different body returns \`409 IDEMPOTENCY_KEY_REUSE\`.

### How it works

- **First call with a fresh key** → executes normally; response is cached.
- **Replay with the same key + same body** → returns the cached response with \`Idempotent-Replayed: true\` header. The original side effects are NOT re-executed.
- **Replay with the same key + different body** → returns \`409 IDEMPOTENCY_KEY_REUSE\`. This indicates the key was reused incorrectly.
- **Two concurrent requests with the same key** → the cache lookup takes no lock, so both may execute; the response write is best-effort (the first writer wins, the loser hits the unique-index conflict and skips). Idempotency de-duplicates *sequential* retries reliably; serialise concurrent retries of the same action on your side.

### Required vs supported

Most write endpoints **require** an Idempotency-Key — not only the obvious creates (invoices, customers, supplier-invoices, webhooks) but also journal-entry and salary-run creation, invoice \`send\`, period \`lock\`/\`close\`/\`year-end\`, bank reconciliation runs, dimension-value creation, PATCH/DELETE on customers, and more. Each endpoint's reference page states whether the key is required. Calls that omit a required key return \`400 VALIDATION_ERROR\` with field \`Idempotency-Key\`.

Other endpoints **support** but don't require it. Sending one is always safe.

### Pattern

\`\`\`bash
curl https://app.gnubok.se/api/v1/companies/{cid}/invoices \\
  -H "Authorization: Bearer ..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "customer_id": "...", "items": [...] }'
\`\`\`

In an agent loop, generate the key once at the *start* of an attempt and reuse it across every retry of that single logical action: never on a fresh attempt with new inputs.

---

## Dry-run

Every state-changing endpoint that supports dry-run (\`x-dry-run-supported: true\` in the OpenAPI spec) accepts \`?dry_run=true\` query param **or** \`X-Dry-Run: true\` header. The endpoint executes its full validation pipeline (Zod, business rules, period-lock checks, VAT-rate compatibility, cross-tenant guards, ...) but does NOT commit. A dry-run always returns **HTTP 200** with the \`X-Dry-Run: true\` response header — never the resource's normal success status (201, 204). The body wraps a preview, not the resource itself:

- All **local** \`validation_error\` shapes that a real commit would produce surface here (Zod, business rules, period locks, cross-tenant guards). Failures that depend on external providers do **not** surface — dry-run skips them (see below), so a VIES/BankID/Skatteverket rejection only appears on the real commit.
- \`data.preview\` holds the would-be record (same shape as the success response).
- For **financial** writes (invoices, journal entries, period ops, salary) the preview also carries \`staged_operation_id\`, the \`journal_lines\` that would be posted, \`account_deltas\`, and \`voucher_number_assigned_on_commit\` (a projection — the committed number can differ by one or two if another writer takes the next number first).

\`\`\`json
{
  "data": {
    "dry_run": true,
    "preview": { ... },
    "staged_operation_id": "po_...",
    "journal_lines": [{ "account": "1510", "debit": 12500, "credit": 0 }],
    "voucher_number_assigned_on_commit": "A-2026-043"
  },
  "meta": { "request_id": "req_...", "api_version": "${API_V1_VERSION}" }
}
\`\`\`

Use dry-run to:

- **Validate input shape** before paying the side-effect cost (especially in agent test loops).
- **Preview voucher lines** the engine would generate for a given invoice + VAT mix before committing.
- **Probe period-lock** on a date before scheduling work.

Dry-run **does not** call external providers (VIES VAT validation, BankID, Skatteverket submission). Those run only on commit.

---

## Strict-mode write semantics

A v1 mutation either commits fully or returns a structured error code with no side effects. The dashboard soft-fails on partial writes (a human is there to retry); the v1 surface aborts. This means you never see "the invoice was sent but the email failed" or "the journal entry posted but the payment row didn't": either both happened or neither did.

When a multi-step write fails:

- **Pre-engine failure** (validation, missing FK, period locked) → no rows written, structured error returned.
- **Post-engine failure** (engine call succeeded, follow-up step failed) → the engine's writes are reversed via \`reverseEntry()\` (storno), the failure surfaces with code matching the failed step (e.g. \`MATCH_INVOICE_LINK_TX_FAILED\`).

Storno reversals are themselves immutable journal entries: the original audit trail remains visible per BFL 5 kap 5 §. \`reversed_by_id\` on the original row points at the storno; the storno carries \`reverses_id\` back to the original.

---

## Inline audit on every write

Every successful write response carries an \`audit\` block in \`meta\`:

\`\`\`json
{
  "data": {...},
  "meta": {
    "request_id": "req_...",
    "api_version": "${API_V1_VERSION}",
    "audit": {
      "voucher_number": "A-2026-042",
      "voucher_url": "https://app.gnubok.se/bookkeeping/...",
      "audit_trail_url": "https://app.gnubok.se/audit/req_...",
      "immutable_at": "2026-05-15T12:00:00Z"
    }
  }
}
\`\`\`

No second round-trip needed to confirm what happened: agents can chain follow-up work directly on the returned voucher number.
`
