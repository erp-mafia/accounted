<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Documents endpoints

The WORM document archive (7-year legal retention: uploads are permanent) and inbox-item stamping. Link every uploaded receipt/invoice document to its journal entry.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `POST /api/v1/companies/{companyId}/documents`

**Upload a document to the WORM archive.**
`scope:documents:write · risk:medium · idempotent`

Multipart upload of a document (PDF / image) under the BFL 7 kap retention regime. The bytes are hashed (SHA-256), written to Supabase Storage, and recorded in document_attachments at version=1. Allowed MIME types: application/pdf, image/jpeg, image/png, image/webp. Max size: 10 MB.

**Use when:** You have a receipt, invoice scan, or supporting document for a posted verifikation and want it archived for the 7-year BFL retention period. Optionally link to a journal entry at upload time via journal_entry_id.
**Do not use for:** Updating an existing document (no v1 update endpoint; new versions go through the dashboard). Bulk uploads: call once per file.

**Pitfalls:**
- Idempotency-Key is mandatory; multipart retries with the same key replay the cached response.
- Max size 10 MB enforced server-side: DOC_UPLOAD_TOO_LARGE on overrun.
- Only application/pdf / image/jpeg / image/png / image/webp accepted: DOC_UPLOAD_UNSUPPORTED_TYPE otherwise.
- WORM: once linked to a posted journal entry, the document row cannot be modified or deleted (DB trigger). Upload-then-link is reversible (the document exists with journal_entry_id=null until linked); once linked, treat as immutable.
- Dry-run is not supported on this endpoint: the engine hashes + stores + inserts in one atomic flow.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body (`multipart/form-data`):
```ts
{
  file?: string,
  upload_source?: "file_upload" | "camera" | "email" | "api",
  journal_entry_id?: string,
  journal_entry_line_id?: string
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    file_name: string,
    mime_type: string,
    file_size_bytes: number,
    sha256_hash: string,
    version: number,
    is_current_version: boolean,
    upload_source: string,
    journal_entry_id: string,
    journal_entry_line_id: string,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "file_name": "kvitto-2026-05-12.pdf",
    "mime_type": "application/pdf",
    "file_size_bytes": 184320,
    "sha256_hash": "8a7f…",
    "version": 1,
    "is_current_version": true,
    "journal_entry_id": "a8f1…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/documents/{id}/download`

**Get a time-limited signed download URL for a document.**
`scope:documents:read · risk:low · idempotent`

Returns a Supabase Storage signed URL valid for 15 minutes. The URL itself is the canonical download: fetch it with any HTTP client; no API key needed on the storage host. Verify file integrity client-side against the returned sha256_hash if your workflow requires it.

**Use when:** You need the bytes of an archived document (e.g. for OCR, attachment to an email, regulatory export). Always re-fetch the URL before each download: old URLs expire.
**Do not use for:** Persisting the URL anywhere: it expires. Storing the URL in a webhook payload or audit log makes the audit trail dependent on URL state.

**Pitfalls:**
- The signed URL expires after 15 minutes. Don't cache it beyond the immediate transaction.
- The URL leaks the Supabase Storage origin; this is benign (the signature alone authorizes the read) but rate-limit any forwarding so you don't reveal the storage layout to untrusted callers.
- Each call emits a document.accessed event. Polling this endpoint produces audit noise; cache the URL for its full TTL.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    file_name: string,
    mime_type: string,
    sha256_hash: string,
    is_current_version: boolean,
    download_url: string,
    expires_in_seconds: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "file_name": "kvitto-2026-05-12.pdf",
    "mime_type": "application/pdf",
    "sha256_hash": "8a7f…",
    "download_url": "https://…supabase.co/storage/v1/object/sign/…",
    "expires_in_seconds": 900
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/documents/{id}/link`

**Link a document to a journal entry.**
`scope:documents:write · risk:medium · idempotent · dry-run`

Sets journal_entry_id (and optionally journal_entry_line_id) on an existing document. Optionally stamps the originating invoice_inbox_items row as consumed via inbox_item_id. Use this after /documents upload when the link target was unknown at upload time, or to re-link a stray document. Once the target JE is posted, the document row is effectively immutable per BFL 7 kap retention.

**Use when:** A document was uploaded without a journal_entry_id (e.g. bulk import) and you now want to attach it to a posted verifikation. Pass inbox_item_id when the document came from the invoice inbox so the item is marked resolved in one call.
**Do not use for:** Unlinking: no v1 unlink endpoint. The dashboard exposes a manual override; v1 keeps the WORM contract by refusing to revert posted-JE links.

**Pitfalls:**
- Idempotency-Key is mandatory.
- Both the document and the journal_entry_id must belong to the caller's company. NOT_FOUND on mismatch (enumeration hardening).
- Re-linking an already-linked document overwrites the previous journal_entry_id: confirm the old target is what you intend to break.
- inbox_item_id stamping is best-effort: if the stamp fails the document link still succeeds. Use POST /api/v1/companies/:companyId/inbox-items/:id/stamp to stamp independently.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ journal_entry_id: string, journal_entry_line_id?: string, inbox_item_id?: string }
```

Example request:
```json
{
  "journal_entry_id": "a8f1…"
}
```

Response `200`:
```ts
{
  data: { id: string, journal_entry_id: string, journal_entry_line_id: string, file_name: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "journal_entry_id": "a8f1…",
    "journal_entry_line_id": null,
    "file_name": "kvitto-2026-05-12.pdf"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/inbox-items/{id}/stamp`

**Mark an inbox item as consumed by a journal entry.**
`scope:documents:write · risk:low · idempotent`

Sets created_journal_entry_id on an invoice_inbox_items row so the item drops out of the active inbox todo list. Use when the document was linked to a JE via a separate call and you need to close the inbox item independently.

**Use when:** An inbox document has already been attached to a verifikation (via documents link) but the inbox item itself was not stamped at link time: e.g. when using the v1 link endpoint without inbox_item_id.
**Do not use for:** Creating a new journal entry from an inbox item: use the invoice-inbox extension book-direct route for that.

**Pitfalls:**
- Idempotency-Key is mandatory.
- The inbox item and journal_entry_id must both belong to the caller's company.
- Stamping with a different journal_entry_id than the one already set returns CONFLICT: the item is already resolved.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ journal_entry_id: string }
```

Example request:
```json
{
  "journal_entry_id": "dcccb3c5-b44a-4536-82fa-f0b9bb77f900"
}
```

Response `200`:
```ts
{
  data: { id: string, created_journal_entry_id: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "4d2fcdbb-13b3-4ff3-911f-a4cc82f1f6db",
    "created_journal_entry_id": "dcccb3c5-b44a-4536-82fa-f0b9bb77f900"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
