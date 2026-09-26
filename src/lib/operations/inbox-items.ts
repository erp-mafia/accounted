/**
 * Invoice-inbox (Underlag) operations: list and read inbox items, correct a
 * reading's fields, release a transaction match, discard an item, and turn
 * one into a registered supplier invoice. Rules live in
 * lib/documents/inbox-item-actions.ts and lib/documents/inbox-convert.ts,
 * shared with the invoice-inbox extension's dashboard routes.
 *
 * Stamping an item against a verifikat stays the hand-written v1 route
 * (POST /inbox-items/{id}/stamp).
 *
 * MCP: list, get, the reading and the conversion have hand-written tools
 * (gnubok_list_inbox_items, gnubok_get_inbox_item,
 * gnubok_set_inbox_extracted_data, gnubok_create_supplier_invoice_from_inbox),
 * so those operations are v1 only. Delete and unmatch get generated staged
 * tools.
 */
import { z } from 'zod'
import { CreateSupplierInvoiceItemSchema, CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import {
  deleteInboxItem,
  getInboxItem,
  listInboxItemsPage,
  unmatchInboxItemTransaction,
  updateInboxItemFields,
  UpdateInboxItemFieldsSchema,
} from '@/lib/documents/inbox-item-actions'
import { convertInboxItemToSupplierInvoice } from '@/lib/documents/inbox-convert'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const INBOX_ITEM_ID = z.string().uuid().describe('The inbox item id (inbox_item_id from the list).')

const UNDERLAG_STATUS = z
  .enum(['anchored', 'unlinked', 'unlinked_locked', 'anchored_elsewhere', 'unknown'])
  .nullable()
  .describe(
    'For a matched item whose transaction is booked: whether THIS item\'s document reached that verifikat (anchored) or not. Null otherwise.',
  )

const InboxItemSummaryOut = z.object({
  inbox_item_id: z.string().uuid(),
  status: z.string().describe('received or error (extraction failed).'),
  source: z.string().describe('How it arrived: email, upload, api, whatsapp, ...'),
  created_at: z.string(),
  document_id: z.string().uuid().nullable(),
  kind_hint: z.string().nullable().describe('Sender-declared kind from a +lev / +ver address tag.'),
  vendor_name: z.string().nullable().describe('Supplier name as read from the document.'),
  amount: z.number().nullable().describe('Total as read from the document, in its currency.'),
  currency: z.string().nullable(),
  invoice_date: z.string().nullable(),
  processed: z
    .boolean()
    .describe('True once the item has a terminal link: a transaction match, a supplier invoice or a verifikat.'),
  matched_supplier_id: z.string().uuid().nullable(),
  matched_transaction_id: z.string().uuid().nullable(),
  matched_transaction_journal_entry_id: z
    .string()
    .uuid()
    .nullable()
    .describe('The verifikat that booked the matched transaction, when it is booked.'),
  created_supplier_invoice_id: z.string().uuid().nullable(),
  created_journal_entry_id: z.string().uuid().nullable(),
  underlag_status: UNDERLAG_STATUS,
  email_from: z.string().nullable(),
  email_subject: z.string().nullable(),
  email_received_at: z.string().nullable(),
  error_message: z.string().nullable(),
})

const EXAMPLE_ITEM = {
  inbox_item_id: '1b2c…',
  status: 'received',
  source: 'email',
  created_at: '2026-09-02T07:41:10Z',
  document_id: '4f1c…',
  kind_hint: null,
  vendor_name: 'Clas Ohlson AB',
  amount: 499,
  currency: 'SEK',
  invoice_date: '2026-09-01',
  processed: false,
  matched_supplier_id: null,
  matched_transaction_id: null,
  matched_transaction_journal_entry_id: null,
  created_supplier_invoice_id: null,
  created_journal_entry_id: null,
  underlag_status: null,
  email_from: 'kvitto@clasohlson.se',
  email_subject: 'Ditt kvitto',
  email_received_at: '2026-09-02T07:41:02Z',
  error_message: null,
}

export const inboxItemsList = defineOperation({
  id: 'inbox-items.list',
  kind: 'read',
  scope: 'documents:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List invoice-inbox items (Underlag) with a summary of what was read from each.',
    description:
      'Returns inbox items newest first: how each arrived, the document, the vendor, total, currency and date read from it, and its links (transaction match, supplier invoice, verifikat). processed is true once any link exists; unprocessed_only=true returns only the items still needing handling. Cursor pagination: pass next_cursor back as cursor; null on the last page. The full reading and the e-mail text are on GET /inbox-items/{id}.',
    useWhen: 'You work the inbox: receipts and invoices waiting to be matched, converted or booked.',
    doNotUseFor:
      'The document archive as a whole (GET /documents) or supplier invoices already registered (GET /supplier-invoices).',
    pitfalls: [
      'amount is in the document\'s currency: compare with a transaction\'s amount only after converting.',
      'A matched item whose transaction is booked can still have underlag_status unlinked: the document did not reach the verifikat.',
      'The page is in data.inbox_items with data.next_cursor; a cursor that no longer decodes starts from the first page.',
    ],
    example: { response: { data: { inbox_items: [EXAMPLE_ITEM], next_cursor: null }, meta: META } },
  },
  input: z.object({
    status: z.enum(['received', 'error']).optional().describe('error = extraction failed.'),
    unprocessed_only: z
      .enum(['true', 'false'])
      .optional()
      .describe('true = only items with no transaction match, supplier invoice or verifikat yet.'),
    cursor: z.string().optional().describe('next_cursor from the previous page. Omit for the first page.'),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('Page size, 1-100 (default 50).'),
  }),
  output: z.object({ inbox_items: z.array(InboxItemSummaryOut), next_cursor: z.string().nullable() }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/inbox-items' },
  run: (ctx, input) => listInboxItemsPage(ctx, input),
})

export const inboxItemsGet = defineOperation({
  id: 'inbox-items.get',
  kind: 'read',
  scope: 'documents:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one inbox item with its full reading and e-mail text.',
    description:
      'Returns the item\'s summary plus the complete extracted_data (supplier, invoice, totals, line items, VAT breakdown), the e-mail body text and the document\'s file name. When the item has no reading of its own, the document\'s reading stands in.',
    useWhen: 'You are about to correct the reading, convert the item to a supplier invoice or match it, and need every field.',
    doNotUseFor: 'Scanning the queue (GET /inbox-items) or downloading the file (GET /documents/{id}/download).',
    pitfalls: [
      'extracted_data is what was read, not what was booked: check it against the document before converting.',
      'email_body_text can carry personal data: do not copy it into notes or descriptions.',
      'An id from another company answers 404 INBOX_ITEM_NOT_FOUND.',
    ],
    example: {
      response: {
        data: {
          ...EXAMPLE_ITEM,
          extracted_data: { supplier: { name: 'Clas Ohlson AB' }, invoice: { invoiceDate: '2026-09-01', currency: 'SEK' }, totals: { total: 499 } },
          extraction_skipped: false,
          email_body_text: null,
          file_name: 'kvitto.pdf',
          updated_at: '2026-09-02T07:41:30Z',
        },
        meta: META,
      },
    },
  },
  input: z.object({ inbox_item_id: INBOX_ITEM_ID }),
  output: InboxItemSummaryOut.extend({
    extracted_data: z.record(z.string(), z.unknown()).nullable(),
    extraction_skipped: z.boolean(),
    email_body_text: z.string().nullable(),
    file_name: z.string().nullable(),
    updated_at: z.string(),
  }),
  errorCodes: ['INBOX_ITEM_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/inbox-items/:id',
    pathParams: { id: 'inbox_item_id' },
  },
  run: (ctx, { inbox_item_id }) => getInboxItem(ctx, inbox_item_id),
})

export const inboxItemsDelete = defineOperation({
  id: 'inbox-items.delete',
  kind: 'write',
  scope: 'documents:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Discard an inbox item that was never converted or booked.',
    description:
      'Removes the inbox item (its e-mail metadata and reading). The document it carried stays in the archive with its own deletion rule (DELETE /documents/{id}). Refused once the item became a supplier invoice or was booked. Idempotent. Dry-runnable.',
    useWhen: 'Spam, a duplicate delivery or a non-accounting e-mail landed in the inbox.',
    doNotUseFor: 'Deleting the document itself (DELETE /documents/{id}) or undoing a supplier invoice or verifikat.',
    pitfalls: [
      'A converted item returns 409 INBOX_ITEM_DELETE_CONVERTED; a booked one 409 INBOX_ITEM_DELETE_BOOKED.',
      'Cannot be undone: the e-mail metadata and the reading are gone.',
    ],
    example: { response: { data: { inbox_item_id: '1b2c…', deleted: true }, meta: META } },
  },
  input: z.object({ inbox_item_id: INBOX_ITEM_ID }),
  output: z.object({ inbox_item_id: z.string().uuid(), deleted: z.literal(true) }),
  errorCodes: ['INBOX_ITEM_NOT_FOUND', 'INBOX_ITEM_DELETE_CONVERTED', 'INBOX_ITEM_DELETE_BOOKED'],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/inbox-items/:id',
    pathParams: { id: 'inbox_item_id' },
  },
  mcp: {
    name: 'gnubok_delete_inbox_item',
    title: 'Delete Inbox Item',
    description:
      'Stage discarding an inbox item (spam, duplicate delivery). The document stays in the archive. Refused once the item became a supplier invoice or was booked; cannot be undone.',
    keywords: ['ta bort inkorgspost', 'radera från inkorgen', 'skräppost inkorg', 'dubblett inkorg'],
    stage: { pendingType: 'delete_inbox_item', title: () => 'Ta bort post ur inkorgen' },
  },
  run: async (ctx, { inbox_item_id }, { dryRun }) => {
    const outcome = await deleteInboxItem(ctx, inbox_item_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { inbox_item_id: outcome.data.id, deleted: true as const } }
  },
})

export const inboxItemsUnmatchTransaction = defineOperation({
  id: 'inbox-items.unmatch-transaction',
  kind: 'write',
  scope: 'documents:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Release an inbox item\'s bank transaction match.',
    description:
      'Clears the item\'s matched transaction, and the transaction\'s document pin when it is still this item\'s document (a document from another source stays). Answers the released transaction. The item returns to the work queue. Idempotent. Dry-runnable.',
    useWhen: 'The item was paired with the wrong bank transaction, or should be paired again.',
    doNotUseFor:
      'Taking a document off a transaction directly (POST /transactions/{id}/detach-document) or undoing a booked verifikat (storno).',
    pitfalls: [
      'Once the transaction is booked with this document as underlag, the transaction pin cannot be cleared (the document is räkenskapsinformation); the item\'s own match is released regardless.',
      'An item with no match answers success with released_transaction_id null.',
    ],
    example: {
      response: { data: { inbox_item_id: '1b2c…', matched_transaction_id: null, released_transaction_id: '1f2e…' }, meta: META },
    },
  },
  input: z.object({ inbox_item_id: INBOX_ITEM_ID }),
  output: z.object({
    inbox_item_id: z.string().uuid(),
    matched_transaction_id: z.null(),
    released_transaction_id: z.string().uuid().nullable(),
  }),
  errorCodes: ['INBOX_ITEM_NOT_FOUND'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/inbox-items/:id/unmatch-transaction',
    pathParams: { id: 'inbox_item_id' },
  },
  mcp: {
    name: 'gnubok_unmatch_inbox_item_transaction',
    title: 'Unmatch Inbox Item Transaction',
    description:
      'Stage releasing an inbox item\'s bank transaction match (a wrong pairing). Also clears the transaction\'s document pin while it is still this item\'s document. The item returns to the work queue.',
    keywords: ['avbryt matchning', 'fel transaktion', 'koppla bort transaktion', 'inkorg matchning'],
    stage: { pendingType: 'unmatch_inbox_item_transaction', title: () => 'Avbryt matchning av inkorgspost' },
  },
  run: async (ctx, { inbox_item_id }, { dryRun }) => {
    const outcome = await unmatchInboxItemTransaction(ctx, inbox_item_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: {
        inbox_item_id: outcome.data.id,
        matched_transaction_id: null,
        released_transaction_id: outcome.data.released_transaction_id,
      },
    }
  },
})

export const inboxItemsUpdateExtractedData = defineOperation({
  id: 'inbox-items.update-extracted-data',
  kind: 'write',
  scope: 'documents:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Correct fields of an inbox item\'s reading (supplier, invoice, totals).',
    description:
      'Merges the given fields into the item\'s extracted_data: supplier (name, orgNumber, vatNumber, address, bankgiro, plusgiro), invoice (invoiceNumber, invoiceDate, dueDate, paymentReference, currency) and totals (subtotal, vatAmount, total). Fields not named are kept, line items and the VAT breakdown included; null clears a field. A hand-set total becomes a verified total. Answers the merged reading. Idempotent. Dry-runnable.',
    useWhen: 'The reading got a field wrong (total, date, invoice number) before the item is converted or matched.',
    doNotUseFor:
      'Replacing the whole reading from your own extraction pipeline (MCP gnubok_set_inbox_extracted_data), or changing a registered supplier invoice.',
    pitfalls: [
      'An item already converted to a supplier invoice returns 409 INBOX_ITEM_EDIT_LOCKED.',
      'A concurrent edit returns 409 INBOX_ITEM_EDIT_CONFLICT: read the item again and retry.',
      'Dates are YYYY-MM-DD; currency is a 3-letter ISO 4217 code.',
      'An enskild firma\'s orgNumber is a personnummer: only send it when it is on the document.',
    ],
    example: {
      request: { totals: { total: 499 }, invoice: { invoiceDate: '2026-09-01' } },
      response: {
        data: { inbox_item_id: '1b2c…', extracted_data: { totals: { total: 499 }, invoice: { invoiceDate: '2026-09-01' } } },
        meta: META,
      },
    },
  },
  input: UpdateInboxItemFieldsSchema.extend({ inbox_item_id: INBOX_ITEM_ID }).refine(
    (body) => body.supplier !== undefined || body.invoice !== undefined || body.totals !== undefined,
    { message: 'Send at least one of supplier, invoice or totals.' },
  ),
  output: z.object({
    inbox_item_id: z.string().uuid(),
    extracted_data: z.record(z.string(), z.unknown()),
  }),
  errorCodes: ['INBOX_ITEM_NOT_FOUND', 'INBOX_ITEM_EDIT_LOCKED', 'INBOX_ITEM_EDIT_CONFLICT'],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/inbox-items/:id',
    pathParams: { id: 'inbox_item_id' },
  },
  run: async (ctx, { inbox_item_id, ...fields }, { dryRun }) => {
    const outcome = await updateInboxItemFields(ctx, inbox_item_id, fields, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { inbox_item_id: outcome.data.id, extracted_data: outcome.data.extracted_data } }
  },
})

// The convert request carries exactly the fields the conversion honours. The
// dashboard form posts the full supplier-invoice schema, but this path has
// never read per-line vat_amount, dimensions, öresavrundning or the
// private-payment fields: a strict object refuses them with 400 instead of
// accepting and silently dropping them.
const invoiceShape = CreateSupplierInvoiceSchema.shape
const itemShape = CreateSupplierInvoiceItemSchema.shape

const ConvertItem = z.strictObject({
  description: itemShape.description,
  amount: itemShape.amount.describe('Line amount excluding VAT. Or quantity x unit_price.'),
  quantity: itemShape.quantity,
  unit: itemShape.unit,
  unit_price: itemShape.unit_price,
  account_number: itemShape.account_number.describe('BAS cost account as a STRING, e.g. "6110".'),
  vat_rate: itemShape.vat_rate.describe('0, 0.06, 0.12 or 0.25. Omitted follows vat_treatment.'),
  vat_code: itemShape.vat_code,
  reverse_charge_rate: itemShape.reverse_charge_rate,
  apply_slp: itemShape.apply_slp,
  accrual_period_start: itemShape.accrual_period_start,
  accrual_period_end: itemShape.accrual_period_end,
  accrual_balance_account: itemShape.accrual_balance_account,
})

const ConvertInput = z.strictObject({
  inbox_item_id: INBOX_ITEM_ID,
  supplier_id: invoiceShape.supplier_id.describe('The supplier (supplier_id from GET /suppliers).'),
  supplier_invoice_number: invoiceShape.supplier_invoice_number,
  invoice_date: invoiceShape.invoice_date,
  due_date: invoiceShape.due_date,
  delivery_date: invoiceShape.delivery_date,
  currency: invoiceShape.currency,
  exchange_rate: invoiceShape.exchange_rate,
  vat_treatment: invoiceShape.vat_treatment,
  reverse_charge: invoiceShape.reverse_charge,
  payment_reference: invoiceShape.payment_reference,
  notes: invoiceShape.notes,
  items: z.array(ConvertItem).min(1, 'At least one item is required'),
})

export const inboxItemsConvertToSupplierInvoice = defineOperation({
  id: 'inbox-items.convert-to-supplier-invoice',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Register a supplier invoice from an inbox item, with its document as underlag.',
    description:
      'Registers a supplier invoice (status registered, next ankomstnummer) from the given lines, attaches the item\'s document as underlag and marks the item converted. A company that books on registration gets the registration verifikat at once (cost and 2641 against 2440, with periodisering and särskild löneskatt where the lines ask); a company that defers booking gets none until the invoice is booked. A non-SEK invoice without exchange_rate gets Riksbanken\'s rate for invoice_date. Idempotent. Dry-runnable: the preview computes the invoice without an ankomstnummer.',
    useWhen: 'An inbox item is a supplier invoice the company will pay later (leverantörsskuld).',
    doNotUseFor:
      'A receipt the company already paid (book it against the bank transaction), a purchase paid privately (POST /expense-claims), or registering an invoice without an inbox item (POST /supplier-invoices).',
    pitfalls: [
      'An item already converted returns 409 INBOX_ITEM_ALREADY_CONVERTED; a supplier invoice number the supplier already has returns 409 SI_CREATE_DUPLICATE_INVOICE_NUMBER with details.existing.',
      'amount is per line EXCLUDING VAT; VAT is computed from vat_rate. Per-line vat_amount, dimensions and private-payment fields are not accepted here.',
      'No fiscal year for invoice_date returns SI_CREATE_NO_FISCAL_PERIOD and registers nothing.',
      'account_number is a STRING ("6110"), never a number.',
    ],
    example: {
      request: {
        supplier_id: '7c1d…',
        supplier_invoice_number: 'F-2026-118',
        invoice_date: '2026-09-01',
        due_date: '2026-09-30',
        items: [{ description: 'Kontorsmaterial', amount: 399.2, account_number: '6110', vat_rate: 0.25 }],
      },
      response: {
        data: {
          supplier_invoice_id: 'a9e0…',
          arrival_number: 118,
          status: 'registered',
          currency: 'SEK',
          total: 499,
          total_sek: 499,
          registration_journal_entry_id: '9c1e…',
          inbox_item_id: '1b2c…',
        },
        meta: META,
      },
    },
  },
  input: ConvertInput,
  output: z.object({
    supplier_invoice_id: z.string().uuid(),
    arrival_number: z.number().int().nullable().describe('Ankomstnummer.'),
    status: z.string(),
    currency: z.string(),
    total: z.number(),
    total_sek: z.number().nullable(),
    registration_journal_entry_id: z
      .string()
      .uuid()
      .nullable()
      .describe('The registration verifikat, or null when the company defers booking.'),
    inbox_item_id: z.string().uuid(),
  }),
  errorCodes: [
    'INBOX_ITEM_NOT_FOUND',
    'INBOX_ITEM_ALREADY_CONVERTED',
    'SUPPLIER_NOT_FOUND',
    'SI_CREATE_SLP_INVALID_ACCOUNT',
    'SI_CREATE_SLP_ACCRUAL',
    'SI_CREATE_ACCRUAL_REVERSE_CHARGE',
    'SI_CREATE_INVALID_INPUT',
    'SI_FX_RATE_MISSING',
    'SI_CREATE_DUPLICATE_INVOICE_NUMBER',
    'SI_CREATE_NO_FISCAL_PERIOD',
    'SI_CREATE_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/inbox-items/:id/convert',
    pathParams: { id: 'inbox_item_id' },
  },
  run: async (ctx, { inbox_item_id, ...body }, { dryRun }) => {
    // The cross-field rules (treatment vs VAT rate, periodisering dates) are
    // the supplier-invoice schema's: run them exactly as the dashboard does.
    const full = CreateSupplierInvoiceSchema.safeParse(body)
    if (!full.success) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: {
          issues: full.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        },
      }
    }
    const outcome = await convertInboxItemToSupplierInvoice(ctx, inbox_item_id, full.data, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const invoice = outcome.data.invoice
    return {
      ok: true,
      created: true,
      data: {
        supplier_invoice_id: invoice.id,
        arrival_number: invoice.arrival_number ?? null,
        status: invoice.status,
        currency: invoice.currency,
        total: invoice.total,
        total_sek: invoice.total_sek ?? null,
        registration_journal_entry_id: outcome.data.registration_journal_entry_id,
        inbox_item_id: outcome.data.inbox_item_id,
      },
    }
  },
})
