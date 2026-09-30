/**
 * Document (underlag) operations: list and read the archive's metadata,
 * delete a document no verifikat holds, and pin a document to a bank
 * transaction or take it off again. Rules live in
 * lib/documents/document-actions.ts and lib/transactions/document-attach.ts.
 *
 * Upload, download and linking to a verifikat stay the hand-written v1
 * routes (POST /documents, GET /documents/{id}/download,
 * POST /documents/{id}/link).
 *
 * MCP: the reads and the attach have hand-written tools already
 * (gnubok_list_records, gnubok_get_record, gnubok_list_unmatched_documents,
 * gnubok_get_document_content, gnubok_attach_document_to_transaction, whose
 * approval runs the same attach service), so those operations are v1 only.
 * Delete and detach get generated staged tools.
 */
import { z } from 'zod'
import { AttachDocumentSchema } from '@/lib/api/schemas'
import { getDocumentMetadata, listDocumentsPage, removeDocument } from '@/lib/documents/document-actions'
import {
  attachDocumentToTransaction,
  detachDocumentFromTransaction,
} from '@/lib/transactions/document-attach'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const DocumentOut = z.object({
  document_id: z.string().uuid(),
  file_name: z.string(),
  mime_type: z.string().nullable(),
  file_size_bytes: z.number().nullable(),
  sha256_hash: z.string().describe('SHA-256 of the stored bytes (the WORM integrity anchor).'),
  version: z.number().int(),
  is_current_version: z.boolean(),
  upload_source: z.string().nullable().describe('file_upload, camera, email, e_invoice, scan, api or system.'),
  linked: z.boolean().describe('True when the document is the underlag of a verifikat (journal_entry_id set).'),
  journal_entry_id: z.string().uuid().nullable(),
  journal_entry_line_id: z.string().uuid().nullable(),
  created_at: z.string().describe('Upload time.'),
})

const EXAMPLE_DOCUMENT = {
  document_id: '4f1c…',
  file_name: 'kvitto-clas-ohlson.pdf',
  mime_type: 'application/pdf',
  file_size_bytes: 48213,
  sha256_hash: '9b2e…',
  version: 1,
  is_current_version: true,
  upload_source: 'email',
  linked: false,
  journal_entry_id: null,
  journal_entry_line_id: null,
  created_at: '2026-09-02T07:41:10Z',
}

const DOCUMENT_ID = z.string().uuid().describe('The document id (document_id from the list or an upload).')
const TRANSACTION_ID = z.string().uuid().describe('The bank transaction id (transaction_id).')

export const documentsList = defineOperation({
  id: 'documents.list',
  kind: 'read',
  scope: 'documents:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List documents in the archive, linked or not, newest upload first.',
    description:
      'Returns document metadata (file name, type, size, SHA-256, version, upload source and time) and whether each is the underlag of a verifikat (linked, journal_entry_id). Filter by linked, journal_entry_id or upload date range (uploaded_from/uploaded_to, YYYY-MM-DD, UTC). Current versions only unless current_only=false. Cursor pagination: pass next_cursor back as cursor; null on the last page. Never returns file bytes or extracted text.',
    useWhen:
      'You need the documents not yet attached to anything (linked=false) before matching receipts, the documents of one verifikat, or an inventory for a period.',
    doNotUseFor:
      'Downloading a file (GET /documents/{id}/download), reading its text (the Arkiv tools), or the inbox work queue with its extracted totals (GET /inbox-items).',
    pitfalls: [
      'linked=false still includes documents pinned to a bank transaction or held by an inbox item: GET /documents/{id} shows what holds one.',
      'Dates filter the upload time in UTC, not the invoice date on the document.',
      'The page is in data.documents with data.next_cursor; a cursor that no longer decodes starts from the first page.',
    ],
    example: { response: { data: { documents: [EXAMPLE_DOCUMENT], next_cursor: null }, meta: META } },
  },
  input: z.object({
    linked: z
      .enum(['true', 'false'])
      .optional()
      .describe('true = only documents linked to a verifikat, false = only unlinked ones. Default: both.'),
    journal_entry_id: z.string().uuid().optional().describe('Only the documents of this verifikat.'),
    uploaded_from: DATE.optional().describe('Uploaded on or after this date (UTC).'),
    uploaded_to: DATE.optional().describe('Uploaded on or before this date (UTC).'),
    current_only: z
      .enum(['true', 'false'])
      .optional()
      .describe('false includes superseded versions. Default true.'),
    cursor: z.string().optional().describe('next_cursor from the previous page. Omit for the first page.'),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('Page size, 1-100 (default 50).'),
  }),
  output: z.object({ documents: z.array(DocumentOut), next_cursor: z.string().nullable() }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/documents' },
  run: (ctx, input) => listDocumentsPage(ctx, input),
})

export const documentsGet = defineOperation({
  id: 'documents.get',
  kind: 'read',
  scope: 'documents:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one document\'s metadata and what holds it.',
    description:
      'Returns the document\'s metadata, its version chain (original_id, superseded_by_id), the verifikat it is underlag for, the bank transactions it is pinned to (transaction_ids) and the inbox item it arrived through (inbox_item_id). Metadata only: the file is GET /documents/{id}/download.',
    useWhen: 'You hold a document_id and need to know whether it can be deleted, detached or linked before acting.',
    doNotUseFor: 'Fetching the file (GET /documents/{id}/download) or listing documents (GET /documents).',
    pitfalls: [
      'An id from another company answers 404 DOC_NOT_FOUND.',
      'linked=true means räkenskapsinformation: it can never be deleted, only superseded by a new version.',
    ],
    example: {
      response: {
        data: {
          ...EXAMPLE_DOCUMENT,
          original_id: null,
          superseded_by_id: null,
          digitization_date: null,
          transaction_ids: [],
          inbox_item_id: '1b2c…',
        },
        meta: META,
      },
    },
  },
  input: z.object({ document_id: DOCUMENT_ID }),
  output: DocumentOut.extend({
    original_id: z.string().uuid().nullable(),
    superseded_by_id: z.string().uuid().nullable(),
    digitization_date: z.string().nullable(),
    transaction_ids: z.array(z.string().uuid()).describe('Bank transactions this document is pinned to.'),
    inbox_item_id: z.string().uuid().nullable().describe('The inbox item the document arrived through, if any.'),
  }),
  errorCodes: ['DOC_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/documents/:id',
    pathParams: { id: 'document_id' },
  },
  run: (ctx, { document_id }) => getDocumentMetadata(ctx, document_id),
})

export const documentsDelete = defineOperation({
  id: 'documents.delete',
  kind: 'write',
  scope: 'documents:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Delete a document that is not linked to any verifikat.',
    description:
      'Removes the document row and its stored file. Refused once the document is linked to a journal entry: it is then räkenskapsinformation under BFL 7 kap 2 § and must be kept for 7 years (correct it with a new version instead). The database trigger enforces the same rule. Idempotent. Dry-runnable.',
    useWhen: 'A duplicate, blank or wrong upload that no verifikat references should go.',
    doNotUseFor:
      'Taking a document off a bank transaction (POST /transactions/{id}/detach-document), discarding an inbox item (DELETE /inbox-items/{id}) or anything linked to a verifikat.',
    pitfalls: [
      'A linked document returns 409 DOC_DELETE_LINKED, whatever the verifikat\'s status.',
      'The file is removed from storage too: this cannot be undone.',
      'A document pinned to an unbooked bank transaction is not protected by this rule: detach it first if the transaction still needs it.',
    ],
    example: { response: { data: { document_id: '4f1c…', deleted: true }, meta: META } },
  },
  input: z.object({ document_id: DOCUMENT_ID }),
  output: z.object({ document_id: z.string().uuid(), deleted: z.literal(true) }),
  errorCodes: ['DOC_NOT_FOUND', 'DOC_DELETE_LINKED'],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/documents/:id',
    pathParams: { id: 'document_id' },
  },
  mcp: {
    name: 'gnubok_delete_document',
    title: 'Delete Document',
    description:
      'Stage deleting an uploaded document and its file. Refused for a document linked to a verifikat (räkenskapsinformation, BFL 7 kap 2 §). Use for duplicates or wrong uploads only; cannot be undone.',
    keywords: ['ta bort underlag', 'radera dokument', 'ta bort kvitto', 'dubblett underlag', 'fel uppladdning'],
    stage: { pendingType: 'delete_document', title: () => 'Ta bort underlag' },
  },
  run: async (ctx, { document_id }, { dryRun }) => {
    const outcome = await removeDocument(ctx, document_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { document_id: outcome.data.id, deleted: true as const } }
  },
})

const AttachOut = z.object({
  transaction_id: z.string().uuid(),
  document_id: z.string().uuid(),
  previous_document_id: z.string().uuid().nullable().describe('The document the pin replaced, if any.'),
  journal_entry_id: z
    .string()
    .uuid()
    .nullable()
    .describe('The verifikat the document now belongs to when the transaction is already booked.'),
})

export const transactionsAttachDocument = defineOperation({
  id: 'transactions.attach-document',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Pin a document (receipt, invoice) to a bank transaction as its underlag.',
    description:
      'Pins the document to the transaction. On an unbooked transaction the pin rides along when it is categorized; on a booked one the document becomes the verifikat\'s underlag at once (BFL 5 kap 6 §). The inbox item the document came from is marked matched. Attaching another document replaces the pin and is logged as a rättelse. Idempotent. Dry-runnable.',
    useWhen: 'A receipt or invoice in the archive belongs to a bank transaction (same date, amount, counterparty).',
    doNotUseFor:
      'Linking a document to a verifikat with no bank transaction (POST /documents/{id}/link) or uploading a file (POST /documents).',
    pitfalls: [
      'A document already underlag of ANOTHER verifikat returns 409 DOC_ATTACH_OTHER_VERIFIKAT.',
      'Replacing a pinned document that is already linked to a verifikat returns 409 DOC_ATTACH_REPLACES_POSTED: reverse the entry first.',
      'On a booked transaction in a locked period the pin is saved but the verifikat link is refused: 409 DOC_ATTACH_PERIOD_LOCKED.',
      'Check date, amount and counterparty on both sides first: once the transaction is booked the link is immutable.',
    ],
    example: {
      request: { document_id: '4f1c…' },
      response: {
        data: { transaction_id: '1f2e…', document_id: '4f1c…', previous_document_id: null, journal_entry_id: null },
        meta: META,
      },
    },
  },
  input: AttachDocumentSchema.extend({
    transaction_id: TRANSACTION_ID,
    document_id: DOCUMENT_ID,
  }),
  output: AttachOut,
  errorCodes: [
    'TX_CATEGORIZE_TX_NOT_FOUND',
    'DOC_NOT_FOUND',
    'DOC_ATTACH_OTHER_VERIFIKAT',
    'DOC_ATTACH_REPLACES_POSTED',
    'DOC_ATTACH_PERIOD_LOCKED',
    'DOC_ATTACH_PROPAGATION_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/transactions/:id/attach-document',
    pathParams: { id: 'transaction_id' },
  },
  run: (ctx, { transaction_id, document_id }, { dryRun }) =>
    attachDocumentToTransaction(ctx, transaction_id, document_id, { dryRun }),
})

export const transactionsDetachDocument = defineOperation({
  id: 'transactions.detach-document',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Take the pinned document off a bank transaction that is not booked against it.',
    description:
      'Clears the transaction\'s document pin and releases the inbox item matched to it, so the next booking does not anchor the detached document. Refused once the document is linked to a verifikat (BFL 5 kap 6 §): only a storno undoes that. A transaction with no document answers success. Answers detached_document_id. Idempotent. Dry-runnable.',
    useWhen: 'The wrong receipt was attached to a transaction that is not yet booked.',
    doNotUseFor:
      'A booked transaction (reverse or uncategorize it first), deleting the document (DELETE /documents/{id}) or releasing an inbox item\'s match (POST /inbox-items/{id}/unmatch-transaction).',
    pitfalls: [
      'A document linked to a verifikat returns 409 DOC_DETACH_POSTED.',
      'A concurrent attach wins: the detach then answers 409 DOC_DETACH_CONCURRENT and changes nothing.',
      'The document itself stays in the archive.',
    ],
    example: {
      response: {
        data: { transaction_id: '1f2e…', document_id: null, detached_document_id: '4f1c…' },
        meta: META,
      },
    },
  },
  input: z.object({ transaction_id: TRANSACTION_ID }),
  output: z.object({
    transaction_id: z.string().uuid(),
    document_id: z.null(),
    detached_document_id: z.string().uuid().nullable().describe('The document that was pinned, or null when none was.'),
  }),
  errorCodes: ['TX_CATEGORIZE_TX_NOT_FOUND', 'DOC_DETACH_POSTED', 'DOC_DETACH_CONCURRENT', 'DOC_DETACH_INBOX_UNLINK_FAILED'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/transactions/:id/detach-document',
    pathParams: { id: 'transaction_id' },
  },
  mcp: {
    name: 'gnubok_detach_document_from_transaction',
    title: 'Detach Document from Transaction',
    description:
      'Stage taking the pinned document off an unbooked bank transaction (a wrong receipt). Releases the matched inbox item too. Refused once the document is linked to a verifikat; the document stays in the archive.',
    keywords: ['ta bort underlag från transaktion', 'koppla bort kvitto', 'fel kvitto', 'lossa underlag'],
    stage: { pendingType: 'detach_document_from_transaction', title: () => 'Koppla bort underlag från transaktion' },
  },
  run: (ctx, { transaction_id }, { dryRun }) => detachDocumentFromTransaction(ctx, transaction_id, { dryRun }),
})
