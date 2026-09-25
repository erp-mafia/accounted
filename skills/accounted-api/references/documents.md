<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Documents endpoints

The WORM document archive (7-year legal retention: uploads are permanent) and inbox-item stamping. Link every uploaded receipt/invoice document to its journal entry.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/documents`

**List documents in the archive, linked or not, newest upload first.**
`scope:documents:read · risk:low · idempotent`

Returns document metadata (file name, type, size, SHA-256, version, upload source and time) and whether each is the underlag of a verifikat (linked, journal_entry_id). Filter by linked, journal_entry_id or upload date range (uploaded_from/uploaded_to, YYYY-MM-DD, UTC). Current versions only unless current_only=false. Cursor pagination: pass next_cursor back as cursor; null on the last page. Never returns file bytes or extracted text.

**Use when:** You need the documents not yet attached to anything (linked=false) before matching receipts, the documents of one verifikat, or an inventory for a period.
**Do not use for:** Downloading a file (GET /documents/{id}/download), reading its text (the Arkiv tools), or the inbox work queue with its extracted totals (GET /inbox-items).

**Pitfalls:**
- linked=false still includes documents pinned to a bank transaction or held by an inbox item: GET /documents/{id} shows what holds one.
- Dates filter the upload time in UTC, not the invoice date on the document.
- The page is in data.documents with data.next_cursor; a cursor that no longer decodes starts from the first page.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `linked` | query | `"true" \| "false"` | no | true = only documents linked to a verifikat, false = only unlinked ones. Default: both. |
| `journal_entry_id` | query | `string` | no | Only the documents of this verifikat. |
| `uploaded_from` | query | `string` | no | Uploaded on or after this date (UTC). |
| `uploaded_to` | query | `string` | no | Uploaded on or before this date (UTC). |
| `current_only` | query | `"true" \| "false"` | no | false includes superseded versions. Default true. |
| `cursor` | query | `string` | no | next_cursor from the previous page. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). |

Response `200`:
```ts
{
  data: {
    documents: { document_id: string, file_name: string, mime_type: string | null, file_size_bytes: number | null, sha256_hash: string, version: number, is_current_version: boolean, upload_source: string | null, linked: boolean, journal_entry_id: string | null, journal_entry_line_id: string | null, created_at: string }[],
    next_cursor: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "documents": [
      {
        "document_id": "4f1c…",
        "file_name": "kvitto-clas-ohlson.pdf",
        "mime_type": "application/pdf",
        "file_size_bytes": 48213,
        "sha256_hash": "9b2e…",
        "version": 1,
        "is_current_version": true,
        "upload_source": "email",
        "linked": false,
        "journal_entry_id": null,
        "journal_entry_line_id": null,
        "created_at": "2026-09-02T07:41:10Z"
      }
    ],
    "next_cursor": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/documents`

**Upload a document to the WORM archive.**
`scope:documents:write · risk:medium · idempotent`

Multipart upload of a document (PDF, image or Office file) under the BFL 7 kap retention regime. The bytes are hashed (SHA-256), written to Supabase Storage, and recorded in document_attachments at version=1. Allowed MIME types: application/pdf, image/jpeg, image/png, image/webp, image/heic, image/heif, application/vnd.openxmlformats-officedocument.wordprocessingml.document, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.openxmlformats-officedocument.presentationml.presentation, application/msword, application/vnd.ms-excel, application/vnd.ms-powerpoint, application/vnd.oasis.opendocument.text, application/vnd.oasis.opendocument.spreadsheet, application/vnd.oasis.opendocument.presentation, application/rtf, text/rtf, text/csv. Max size: 10 MB.

**Use when:** You have a receipt, invoice scan, or supporting document for a posted verifikation and want it archived for the 7-year BFL retention period. Optionally link to a journal entry at upload time via journal_entry_id.
**Do not use for:** Updating an existing document (no v1 update endpoint; new versions go through the dashboard). Bulk uploads: call once per file.

**Pitfalls:**
- Idempotency-Key is mandatory; multipart retries with the same key replay the cached response.
- Max size 10 MB enforced server-side: DOC_UPLOAD_TOO_LARGE on overrun.
- Only application/pdf / image/jpeg / image/png / image/webp / image/heic / image/heif / application/vnd.openxmlformats-officedocument.wordprocessingml.document / application/vnd.openxmlformats-officedocument.spreadsheetml.sheet / application/vnd.openxmlformats-officedocument.presentationml.presentation / application/msword / application/vnd.ms-excel / application/vnd.ms-powerpoint / application/vnd.oasis.opendocument.text / application/vnd.oasis.opendocument.spreadsheet / application/vnd.oasis.opendocument.presentation / application/rtf / text/rtf / text/csv accepted: DOC_UPLOAD_UNSUPPORTED_TYPE otherwise.
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
    mime_type: string | null,
    file_size_bytes: number,
    sha256_hash: string,
    version: number,
    is_current_version: boolean,
    upload_source: string | null,
    journal_entry_id: string | null,
    journal_entry_line_id: string | null,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
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

### `GET /api/v1/companies/{companyId}/documents/{id}`

**Read one document's metadata and what holds it.**
`scope:documents:read · risk:low · idempotent`

Returns the document's metadata, its version chain (original_id, superseded_by_id), the verifikat it is underlag for, the bank transactions it is pinned to (transaction_ids) and the inbox item it arrived through (inbox_item_id). Metadata only: the file is GET /documents/{id}/download.

**Use when:** You hold a document_id and need to know whether it can be deleted, detached or linked before acting.
**Do not use for:** Fetching the file (GET /documents/{id}/download) or listing documents (GET /documents).

**Pitfalls:**
- An id from another company answers 404 DOC_NOT_FOUND.
- linked=true means räkenskapsinformation: it can never be deleted, only superseded by a new version.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    document_id: string,
    file_name: string,
    mime_type: string | null,
    file_size_bytes: number | null,
    sha256_hash: string,
    version: number,
    is_current_version: boolean,
    upload_source: string | null,
    linked: boolean,
    journal_entry_id: string | null,
    journal_entry_line_id: string | null,
    created_at: string,
    original_id: string | null,
    superseded_by_id: string | null,
    digitization_date: string | null,
    transaction_ids: string[],
    inbox_item_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "document_id": "4f1c…",
    "file_name": "kvitto-clas-ohlson.pdf",
    "mime_type": "application/pdf",
    "file_size_bytes": 48213,
    "sha256_hash": "9b2e…",
    "version": 1,
    "is_current_version": true,
    "upload_source": "email",
    "linked": false,
    "journal_entry_id": null,
    "journal_entry_line_id": null,
    "created_at": "2026-09-02T07:41:10Z",
    "original_id": null,
    "superseded_by_id": null,
    "digitization_date": null,
    "transaction_ids": [],
    "inbox_item_id": "1b2c…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/documents/{id}`

**Delete a document that is not linked to any verifikat.**
`scope:documents:write · risk:medium · idempotent · dry-run`

Removes the document row and its stored file. Refused once the document is linked to a journal entry: it is then räkenskapsinformation under BFL 7 kap 2 § and must be kept for 7 years (correct it with a new version instead). The database trigger enforces the same rule. Idempotent. Dry-runnable.

**Use when:** A duplicate, blank or wrong upload that no verifikat references should go.
**Do not use for:** Taking a document off a bank transaction (POST /transactions/{id}/detach-document), discarding an inbox item (DELETE /inbox-items/{id}) or anything linked to a verifikat.

**Pitfalls:**
- A linked document returns 409 DOC_DELETE_LINKED, whatever the verifikat's status.
- The file is removed from storage too: this cannot be undone.
- A document pinned to an unbooked bank transaction is not protected by this rule: detach it first if the transaction still needs it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { document_id: string, deleted: true },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "document_id": "4f1c…",
    "deleted": true
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
    mime_type: string | null,
    sha256_hash: string,
    is_current_version: boolean,
    download_url: string,
    expires_in_seconds: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
  data: { id: string, journal_entry_id: string, journal_entry_line_id: string | null, file_name: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
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

### `GET /api/v1/companies/{companyId}/inbox-items`

**List invoice-inbox items (Underlag) with a summary of what was read from each.**
`scope:documents:read · risk:low · idempotent`

Returns inbox items newest first: how each arrived, the document, the vendor, total, currency and date read from it, and its links (transaction match, supplier invoice, verifikat). processed is true once any link exists; unprocessed_only=true returns only the items still needing handling. Cursor pagination: pass next_cursor back as cursor; null on the last page. The full reading and the e-mail text are on GET /inbox-items/{id}.

**Use when:** You work the inbox: receipts and invoices waiting to be matched, converted or booked.
**Do not use for:** The document archive as a whole (GET /documents) or supplier invoices already registered (GET /supplier-invoices).

**Pitfalls:**
- amount is in the document's currency: compare with a transaction's amount only after converting.
- A matched item whose transaction is booked can still have underlag_status unlinked: the document did not reach the verifikat.
- The page is in data.inbox_items with data.next_cursor; a cursor that no longer decodes starts from the first page.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"received" \| "error"` | no | error = extraction failed. |
| `unprocessed_only` | query | `"true" \| "false"` | no | true = only items with no transaction match, supplier invoice or verifikat yet. |
| `cursor` | query | `string` | no | next_cursor from the previous page. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). |

Response `200`:
```ts
{
  data: {
    inbox_items: { inbox_item_id: string, status: string, source: string, created_at: string, document_id: string | null, kind_hint: string | null, vendor_name: string | null, amount: number | null, currency: string | null, invoice_date: string | null, processed: boolean, matched_supplier_id: string | null, matched_transaction_id: string | null, matched_transaction_journal_entry_id: string | null, created_supplier_invoice_id: string | null, created_journal_entry_id: string | null, underlag_status: "anchored" | "unlinked" | "unlinked_locked" | "anchored_elsewhere" | "unknown" | null, email_from: string | null, email_subject: string | null, email_received_at: string | null, error_message: string | null }[],
    next_cursor: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "inbox_items": [
      {
        "inbox_item_id": "1b2c…",
        "status": "received",
        "source": "email",
        "created_at": "2026-09-02T07:41:10Z",
        "document_id": "4f1c…",
        "kind_hint": null,
        "vendor_name": "Clas Ohlson AB",
        "amount": 499,
        "currency": "SEK",
        "invoice_date": "2026-09-01",
        "processed": false,
        "matched_supplier_id": null,
        "matched_transaction_id": null,
        "matched_transaction_journal_entry_id": null,
        "created_supplier_invoice_id": null,
        "created_journal_entry_id": null,
        "underlag_status": null,
        "email_from": "kvitto@clasohlson.se",
        "email_subject": "Ditt kvitto",
        "email_received_at": "2026-09-02T07:41:02Z",
        "error_message": null
      }
    ],
    "next_cursor": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/inbox-items/{id}`

**Read one inbox item with its full reading and e-mail text.**
`scope:documents:read · risk:low · idempotent`

Returns the item's summary plus the complete extracted_data (supplier, invoice, totals, line items, VAT breakdown), the e-mail body text and the document's file name. When the item has no reading of its own, the document's reading stands in.

**Use when:** You are about to correct the reading, convert the item to a supplier invoice or match it, and need every field.
**Do not use for:** Scanning the queue (GET /inbox-items) or downloading the file (GET /documents/{id}/download).

**Pitfalls:**
- extracted_data is what was read, not what was booked: check it against the document before converting.
- email_body_text can carry personal data: do not copy it into notes or descriptions.
- An id from another company answers 404 INBOX_ITEM_NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    inbox_item_id: string,
    status: string,
    source: string,
    created_at: string,
    document_id: string | null,
    kind_hint: string | null,
    vendor_name: string | null,
    amount: number | null,
    currency: string | null,
    invoice_date: string | null,
    processed: boolean,
    matched_supplier_id: string | null,
    matched_transaction_id: string | null,
    matched_transaction_journal_entry_id: string | null,
    created_supplier_invoice_id: string | null,
    created_journal_entry_id: string | null,
    underlag_status: "anchored" | "unlinked" | "unlinked_locked" | "anchored_elsewhere" | "unknown" | null,
    email_from: string | null,
    email_subject: string | null,
    email_received_at: string | null,
    error_message: string | null,
    extracted_data: Record<string, unknown> | null,
    extraction_skipped: boolean,
    email_body_text: string | null,
    file_name: string | null,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "inbox_item_id": "1b2c…",
    "status": "received",
    "source": "email",
    "created_at": "2026-09-02T07:41:10Z",
    "document_id": "4f1c…",
    "kind_hint": null,
    "vendor_name": "Clas Ohlson AB",
    "amount": 499,
    "currency": "SEK",
    "invoice_date": "2026-09-01",
    "processed": false,
    "matched_supplier_id": null,
    "matched_transaction_id": null,
    "matched_transaction_journal_entry_id": null,
    "created_supplier_invoice_id": null,
    "created_journal_entry_id": null,
    "underlag_status": null,
    "email_from": "kvitto@clasohlson.se",
    "email_subject": "Ditt kvitto",
    "email_received_at": "2026-09-02T07:41:02Z",
    "error_message": null,
    "extracted_data": {
      "supplier": {
        "name": "Clas Ohlson AB"
      },
      "invoice": {
        "invoiceDate": "2026-09-01",
        "currency": "SEK"
      },
      "totals": {
        "total": 499
      }
    },
    "extraction_skipped": false,
    "email_body_text": null,
    "file_name": "kvitto.pdf",
    "updated_at": "2026-09-02T07:41:30Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/inbox-items/{id}`

**Correct fields of an inbox item's reading (supplier, invoice, totals).**
`scope:documents:write · risk:low · idempotent · dry-run · reversible`

Merges the given fields into the item's extracted_data: supplier (name, orgNumber, vatNumber, address, bankgiro, plusgiro), invoice (invoiceNumber, invoiceDate, dueDate, paymentReference, currency) and totals (subtotal, vatAmount, total). Fields not named are kept, line items and the VAT breakdown included; null clears a field. A hand-set total becomes a verified total. Answers the merged reading. Idempotent. Dry-runnable.

**Use when:** The reading got a field wrong (total, date, invoice number) before the item is converted or matched.
**Do not use for:** Replacing the whole reading from your own extraction pipeline (MCP gnubok_set_inbox_extracted_data), or changing a registered supplier invoice.

**Pitfalls:**
- An item already converted to a supplier invoice returns 409 INBOX_ITEM_EDIT_LOCKED.
- A concurrent edit returns 409 INBOX_ITEM_EDIT_CONFLICT: read the item again and retry.
- Dates are YYYY-MM-DD; currency is a 3-letter ISO 4217 code.
- An enskild firma's orgNumber is a personnummer: only send it when it is on the document.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  supplier?: {
    name?: string | null,
    orgNumber?: string | null,
    vatNumber?: string | null,
    address?: string | null,
    bankgiro?: string | null,
    plusgiro?: string | null
  },
  invoice?: {
    invoiceNumber?: string | null,
    invoiceDate?: string | null,
    dueDate?: string | null,
    paymentReference?: string | null,
    currency?: string
  },
  totals?: { subtotal?: number | null, vatAmount?: number | null, total?: number | null }
}
```

Example request:
```json
{
  "totals": {
    "total": 499
  },
  "invoice": {
    "invoiceDate": "2026-09-01"
  }
}
```

Response `200`:
```ts
{
  data: { inbox_item_id: string, extracted_data: Record<string, unknown> },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "inbox_item_id": "1b2c…",
    "extracted_data": {
      "totals": {
        "total": 499
      },
      "invoice": {
        "invoiceDate": "2026-09-01"
      }
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/inbox-items/{id}`

**Discard an inbox item that was never converted or booked.**
`scope:documents:write · risk:medium · idempotent · dry-run`

Removes the inbox item (its e-mail metadata and reading). The document it carried stays in the archive with its own deletion rule (DELETE /documents/{id}). Refused once the item became a supplier invoice or was booked. Idempotent. Dry-runnable.

**Use when:** Spam, a duplicate delivery or a non-accounting e-mail landed in the inbox.
**Do not use for:** Deleting the document itself (DELETE /documents/{id}) or undoing a supplier invoice or verifikat.

**Pitfalls:**
- A converted item returns 409 INBOX_ITEM_DELETE_CONVERTED; a booked one 409 INBOX_ITEM_DELETE_BOOKED.
- Cannot be undone: the e-mail metadata and the reading are gone.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { inbox_item_id: string, deleted: true },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "inbox_item_id": "1b2c…",
    "deleted": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/inbox-items/{id}/convert`

**Register a supplier invoice from an inbox item, with its document as underlag.**
`scope:suppliers:write · risk:medium · idempotent · dry-run`

Registers a supplier invoice (status registered, next ankomstnummer) from the given lines, attaches the item's document as underlag and marks the item converted. A company that books on registration gets the registration verifikat at once (cost and 2641 against 2440, with periodisering and särskild löneskatt where the lines ask); a company that defers booking gets none until the invoice is booked. A non-SEK invoice without exchange_rate gets Riksbanken's rate for invoice_date. Idempotent. Dry-runnable: the preview computes the invoice without an ankomstnummer.

**Use when:** An inbox item is a supplier invoice the company will pay later (leverantörsskuld).
**Do not use for:** A receipt the company already paid (book it against the bank transaction), a purchase paid privately (POST /expense-claims), or registering an invoice without an inbox item (POST /supplier-invoices).

**Pitfalls:**
- An item already converted returns 409 INBOX_ITEM_ALREADY_CONVERTED; a supplier invoice number the supplier already has returns 409 SI_CREATE_DUPLICATE_INVOICE_NUMBER with details.existing.
- amount is per line EXCLUDING VAT; VAT is computed from vat_rate. Per-line vat_amount, dimensions and private-payment fields are not accepted here.
- No fiscal year for invoice_date returns SI_CREATE_NO_FISCAL_PERIOD and registers nothing.
- account_number is a STRING ("6110"), never a number.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  supplier_id: string,
  supplier_invoice_number: string,
  invoice_date: string,
  due_date: string,
  delivery_date?: string | "",
  currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF",
  exchange_rate?: number,
  vat_treatment?: "standard_25" | "reduced_12" | "reduced_6" | "reverse_charge" | "export" | "exempt",
  reverse_charge?: boolean,
  payment_reference?: string,
  notes?: string,
  items: { description: string, amount?: number, quantity?: number, unit?: string, unit_price?: number, account_number: string, vat_rate?: 0 | 0.06 | 0.12 | 0.25, vat_code?: string, reverse_charge_rate?: number, apply_slp?: boolean, accrual_period_start?: string | null, accrual_period_end?: string | null, accrual_balance_account?: string | null }[]
}
```

Example request:
```json
{
  "supplier_id": "7c1d…",
  "supplier_invoice_number": "F-2026-118",
  "invoice_date": "2026-09-01",
  "due_date": "2026-09-30",
  "items": [
    {
      "description": "Kontorsmaterial",
      "amount": 399.2,
      "account_number": "6110",
      "vat_rate": 0.25
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    supplier_invoice_id: string,
    arrival_number: number | null,
    status: string,
    currency: string,
    total: number,
    total_sek: number | null,
    registration_journal_entry_id: string | null,
    inbox_item_id: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "supplier_invoice_id": "a9e0…",
    "arrival_number": 118,
    "status": "registered",
    "currency": "SEK",
    "total": 499,
    "total_sek": 499,
    "registration_journal_entry_id": "9c1e…",
    "inbox_item_id": "1b2c…"
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
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
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

---

### `POST /api/v1/companies/{companyId}/inbox-items/{id}/unmatch-transaction`

**Release an inbox item's bank transaction match.**
`scope:documents:write · risk:low · idempotent · dry-run · reversible`

Clears the item's matched transaction, and the transaction's document pin when it is still this item's document (a document from another source stays). Answers the released transaction. The item returns to the work queue. Idempotent. Dry-runnable.

**Use when:** The item was paired with the wrong bank transaction, or should be paired again.
**Do not use for:** Taking a document off a transaction directly (POST /transactions/{id}/detach-document) or undoing a booked verifikat (storno).

**Pitfalls:**
- Once the transaction is booked with this document as underlag, the transaction pin cannot be cleared (the document is räkenskapsinformation); the item's own match is released regardless.
- An item with no match answers success with released_transaction_id null.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { inbox_item_id: string, matched_transaction_id: unknown, released_transaction_id: string | null },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "inbox_item_id": "1b2c…",
    "matched_transaction_id": null,
    "released_transaction_id": "1f2e…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
