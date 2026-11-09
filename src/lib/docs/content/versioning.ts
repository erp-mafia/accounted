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
curl https://app.accounted.se/api/v1/companies \\
  -H "Authorization: Bearer ..." \\
  -H "Gnubok-Version: ${API_V1_VERSION}"
\`\`\`

### Deprecation policy

When we ship a new dated version that breaks an existing shape:

1. The new version is dated forward (e.g. \`2026-08-01\`) and made the default for newly-created keys + webhooks.
2. The previous version stays available for at least **6 months** after the new version ships.
3. Deprecation appears in the [changelog](/docs/api/changelog) with the retirement date and a migration guide.
4. Three months before retirement, responses from the deprecated version will carry a \`Gnubok-Deprecation: <ISO date>\` header. Planned alongside request pinning: no version has been deprecated yet and nothing emits the header today.
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

Every state-changing endpoint (POST, PATCH, DELETE) accepts an \`Idempotency-Key\` header. The key is treated as an opaque string (a UUID is recommended, but any unique value works); the server claims it before the write runs and caches the response keyed by \`(user_id, company_id, idempotency_key)\` for 24 hours. The canonical hash of the request body is stored alongside and compared on replay: same key + same body returns the cached response, same key + different body returns \`409 IDEMPOTENCY_KEY_REUSE\`, and same key + same body while the first request is still running returns \`409 IDEMPOTENCY_KEY_IN_PROGRESS\`.

### How it works

- **First call with a fresh key** → executes normally; response is cached.
- **Replay with the same key + same body** → returns the cached response with \`Idempotent-Replayed: true\` header. The original side effects are NOT re-executed.
- **Replay with the same key + different body** → returns \`409 IDEMPOTENCY_KEY_REUSE\`. This indicates the key was reused incorrectly.
- **A repeat with the same key + same body while the first request is still running** → returns \`409 IDEMPOTENCY_KEY_IN_PROGRESS\` with a \`Retry-After\` header (seconds) and runs nothing. The key is claimed atomically before the write starts, so two requests with one key never run at the same time. Wait \`Retry-After\` seconds and send the identical request again with the same key; once the first request has finished it returns that request's response with \`Idempotent-Replayed: true\`. Do not switch to a fresh key: that would run the write a second time.
- **A failed request** (a 5xx or 429 response) caches nothing and gives the key back, so a retry with the same key runs again. A request killed before it could answer (a platform timeout) frees its key after 15 minutes; until then a repeat answers \`409 IDEMPOTENCY_KEY_IN_PROGRESS\`.

### Required vs supported

Most write endpoints **require** an Idempotency-Key: not only the obvious creates (companies, invoices, customers, supplier-invoices, webhooks) but also journal-entry and salary-run creation, invoice \`send\`, period \`lock\`/\`close\`/\`year-end\`, bank reconciliation runs, dimension-value creation, PATCH/DELETE on customers, and more. Each endpoint's reference page states whether the key is required. Calls that omit a required key return \`400 VALIDATION_ERROR\` with field \`Idempotency-Key\`.

Other endpoints **support** but don't require it. Sending one is always safe.

### Pattern

\`\`\`bash
curl https://app.accounted.se/api/v1/companies/{cid}/invoices \\
  -H "Authorization: Bearer ..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "customer_id": "...", "items": [...] }'
\`\`\`

In an agent loop, generate the key once at the *start* of an attempt and reuse it across every retry of that single logical action: never on a fresh attempt with new inputs.

---

## Dry-run

Every state-changing endpoint that supports dry-run (\`x-dry-run-supported: true\` in the OpenAPI spec) accepts \`?dry_run=true\` query param **or** \`X-Dry-Run: true\` header. The endpoint executes its full validation pipeline (Zod, business rules, period-lock checks, VAT-rate compatibility, cross-tenant guards, ...) but does NOT commit. A dry-run always returns **HTTP 200** with the \`X-Dry-Run: true\` response header, never the resource's normal success status (201, 204). The body wraps a preview, not the resource itself:

- All **local** \`validation_error\` shapes that a real commit would produce surface here (Zod, business rules, period locks, cross-tenant guards). Failures that depend on external providers do **not** surface: dry-run skips them (see below), so a VIES/BankID/Skatteverket rejection only appears on the real commit.
- \`data.preview\` holds the would-be record (same shape as the success response).
- For writes that post a verifikat, the preview carries the lines that would be posted, each with \`account_number\` (a string), \`debit_amount\` and \`credit_amount\`, under the resource's own field (for example \`preview.lines\` on \`POST /journal-entries\`, \`preview.verifikat.lines\` on \`POST /expense-claims\` and \`POST /supplier-invoices\`). On those three the accounts are checked as the commit checks them: one that is deactivated or not in BAS 2026 answers \`400 ACCOUNTS_NOT_IN_CHART\`. No voucher number is drawn; the dry run of \`POST /journal-entries/{id}/commit\` answers \`preview.voucher_number_assigned_on_commit\`, a projection another writer can take first.

\`\`\`json
{
  "data": {
    "dry_run": true,
    "preview": {
      "verifikat": {
        "lines": [
          { "account_number": "5410", "debit_amount": 400, "credit_amount": 0 },
          ...
        ],
        "total_debit": 500,
        "total_credit": 500
      }
    }
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

## Stage for approval

The writes an agent stages over MCP (\`x-stage-supported: true\` in the OpenAPI spec) accept \`?stage=true\`. The endpoint runs its dry-run checks, stores the write as a **pending operation** and answers **HTTP 202** with it: nothing is committed. It commits when someone approves it, over \`POST /api/v1/companies/{companyId}/pending-operations/{id}/approve\` (scope \`pending_operations:approve\`), the MCP approve tool or the app; \`.../reject\` discards it. An attest flow built outside Accounted polls \`GET .../pending-operations/{id}\` until \`task_state\` is terminal:

| status | task_state |
|---|---|
| pending, committing | working |
| committed | completed |
| failed_partial, unknown (an interrupted approval whose outcome could not be verified; never replayed), or rejected by the commit | failed |
| rejected by a person, expired or superseded | cancelled |

\`stage=true\` on an endpoint without \`x-stage-supported\` answers \`400 STAGE_NOT_SUPPORTED\`, and a value other than \`true\` or \`false\` is \`400\`, so a misspelt flag never commits. A write only a person may approve in the app (handing an invoice to collection, an escalating collection case action) is never committed from a key: without \`stage=true\` it answers \`400 STAGE_REQUIRED\` and does nothing. With \`dry_run=true\` or a test key the staging is previewed and nothing is stored. A staged request and a commit of the same body are different requests to the idempotency layer: reusing one's \`Idempotency-Key\` for the other answers \`409 IDEMPOTENCY_KEY_REUSE\`.

---

## Pinned previews

An agent that shows a person a preview needs the commit to book exactly that. Every operation write (\`x-preview-token-supported: true\` in the OpenAPI spec) answers its dry run with \`data.preview_token\`, a fingerprint of the operation, the company, the validated input and the preview. Send it back on the commit in the \`Preview-Token\` header:

1. Dry run the write and show the person \`data.preview\`.
2. When they confirm, send the same request without \`dry_run\`, with \`Preview-Token: <data.preview_token>\` and the same \`Idempotency-Key\`.
3. The server recomputes the dry run first. If it still fingerprints the same, the write commits as usual. If anything moved in between (a period was locked, an account deactivated, a rate changed, another write landed), it answers **HTTP 409** \`PREVIEW_STALE\` and writes nothing; \`error.details.preview\` is what the write would do now and \`error.details.preview_token\` its token. Show that, ask again, and resend with the new token (the refusal is not cached against the key).

A token is a fingerprint, not a credential: it never passes for another operation, company or input, and it carries nothing beyond what the client sent and received. It works with \`?stage=true\` too: the write is staged only while the preview still holds (the approval itself commits against the state at approval time, as before). The header on an endpoint without \`x-preview-token-supported\`, or a malformed value, answers \`400 VALIDATION_ERROR\`, so a pin is never silently ignored. Without the header nothing changes. Over MCP, the generated write tools take the same token as a \`preview_token\` argument when staging and answer \`PREVIEW_STALE\` the same way.

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
      "voucher_url": "https://app.accounted.se/bookkeeping/...",
      "audit_trail_url": "https://app.accounted.se/audit/req_...",
      "immutable_at": "2026-05-15T12:00:00Z"
    }
  }
}
\`\`\`

No second round-trip needed to confirm what happened: agents can chain follow-up work directly on the returned voucher number.
`
