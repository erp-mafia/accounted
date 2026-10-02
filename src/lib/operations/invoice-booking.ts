/**
 * Deferred "Bokför" operations (#967): companies with
 * company_settings.defer_invoice_booking=true send customer invoices and
 * register supplier invoices WITHOUT a verifikat, and book them later with
 * this explicit step. Before these operations the step was dashboard-only,
 * so an API customer on that setting could never book.
 *
 * Rules live in lib/invoices/book-service.ts and
 * lib/supplier-invoices/book-service.ts, shared with the dashboard routes
 * POST /api/invoices/[id]/book, POST /api/invoices/bulk-book and
 * POST /api/supplier-invoices/[id]/book.
 */
import { z } from 'zod'
import { BULK_BOOK_MAX_INVOICES, bookInvoice, bulkBookInvoices } from '@/lib/invoices/book-service'
import { bookSupplierInvoice } from '@/lib/supplier-invoices/book-service'
import type { Invoice, SupplierInvoice } from '@/types'
import { defineOperation } from './types'

const META_EXAMPLE = { request_id: 'req_…', api_version: '2026-05-12' }

const BookedInvoice = z.object({
  id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  status: z.string(),
  invoice_date: z.string(),
  due_date: z.string().nullable(),
  currency: z.string(),
  total: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
})

function toBookedInvoice(row: Invoice): z.infer<typeof BookedInvoice> {
  return {
    id: row.id,
    invoice_number: row.invoice_number ?? null,
    status: row.status,
    invoice_date: row.invoice_date,
    due_date: row.due_date ?? null,
    currency: row.currency,
    total: row.total,
    journal_entry_id: row.journal_entry_id ?? null,
  }
}

const BookedSupplierInvoice = z.object({
  id: z.string().uuid(),
  arrival_number: z.number().nullable(),
  supplier_invoice_number: z.string().nullable(),
  status: z.string(),
  invoice_date: z.string(),
  due_date: z.string().nullable(),
  currency: z.string(),
  total: z.number(),
  registration_journal_entry_id: z.string().uuid().nullable(),
})

function toBookedSupplierInvoice(row: SupplierInvoice): z.infer<typeof BookedSupplierInvoice> {
  return {
    id: row.id,
    arrival_number: row.arrival_number ?? null,
    supplier_invoice_number: row.supplier_invoice_number ?? null,
    status: row.status,
    invoice_date: row.invoice_date,
    due_date: row.due_date ?? null,
    currency: row.currency,
    total: row.total,
    registration_journal_entry_id: row.registration_journal_entry_id ?? null,
  }
}

const PERIOD_LOCKED_PITFALL =
  'A locked or closed period, or an invoice date on or before the company lock date (bookkeeping_locked_through), answers 400 PERIOD_LOCKED with details.reason, details.fiscal_period_id and details.invoice_date. Nothing is generated, so no voucher number is spent: unlock the period (only if the user asked for that correction) and retry.'

// ---------------------------------------------------------------------------
// invoices.book
// ---------------------------------------------------------------------------

export const invoicesBook = defineOperation({
  id: 'invoices.book',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book a sent customer invoice that was issued without a verifikat (the deferred Bokför step).',
    description:
      'For companies with defer_invoice_booking=true (Registrera men bokför inte): :send and :mark-sent issue the invoice without posting anything, and this step posts the revenue verifikat afterwards (Debit 1510 Kundfordringar / Credit revenue per VAT rate + utgående moms; ROT/RUT share on 1513; periodiserade lines on 29xx with their schedules). Dated on the invoice date. The invoice is claimed with a compare-and-set, so a concurrent book, payment or credit cancels this entry instead of double-posting. The delivered PDF, if archived at send, is linked to the verifikat. Idempotent. Dry-runnable: the dry run previews the exact lines and writes nothing.',
    useWhen:
      'A customer invoice is sent or overdue, has no journal_entry_id, and the company books invoices in a separate step (defer_invoice_booking), typically after someone has checked the kontering.',
    doNotUseFor:
      'Drafts (issue them with :send or :mark-sent first), paid invoices (their payment already booked the sale in full), credit notes, quotes, proformas or delivery notes, or any invoice under kontantmetoden (booked at payment).',
    pitfalls: [
      'An invoice that already has a journal_entry_id answers 400 INVOICE_BOOK_ALREADY_BOOKED.',
      'Status other than sent or overdue answers 400 INVOICE_BOOK_INVALID_STATUS with details.currentStatus.',
      'Under kontantmetoden answers 400 INVOICE_BOOK_CASH_METHOD: nothing books before payment.',
      PERIOD_LOCKED_PITFALL,
      'No open fiscal year covering the invoice date answers 400 INVOICE_BOOK_NO_FISCAL_PERIOD: create the räkenskapsår first.',
      'A posted verifikat is permanent: undo a wrong booking with storno (POST /journal-entries/{id}/reverse), never by editing.',
    ],
    example: {
      response: {
        data: {
          invoice: {
            id: '7d1e…',
            invoice_number: 'F-1042',
            status: 'sent',
            invoice_date: '2026-09-10',
            due_date: '2026-10-10',
            currency: 'SEK',
            total: 12500,
            journal_entry_id: '9a0b…',
          },
          journal_entry_id: '9a0b…',
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({
    invoice_id: z.string().uuid().describe('The customer invoice id, from GET /invoices.'),
  }),
  output: z.object({ invoice: BookedInvoice, journal_entry_id: z.string().uuid() }),
  errorCodes: [
    'INVOICE_NOT_FOUND',
    'INVOICE_BOOK_ALREADY_BOOKED',
    'INVOICE_BOOK_NOT_BOOKABLE',
    'INVOICE_BOOK_INVALID_STATUS',
    'INVOICE_BOOK_CASH_METHOD',
    'PERIOD_LOCKED',
    'INVOICE_BOOK_NO_FISCAL_PERIOD',
    'INVOICE_BOOK_CONFLICT',
    'INVOICE_BOOK_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/invoices/:id/book',
    pathParams: { id: 'invoice_id' },
  },
  mcp: {
    name: 'gnubok_book_invoice',
    title: 'Book Customer Invoice',
    description:
      'Stage the deferred Bokför step for a sent customer invoice that has no verifikat yet (defer_invoice_booking companies). The preview shows the exact revenue lines. Refused for drafts, paid invoices, kontantmetoden and locked periods.',
    keywords: ['bokför faktura', 'bokför kundfaktura', 'registrera men bokför inte', 'obokförd faktura', 'defer_invoice_booking'],
    stage: { pendingType: 'book_invoice', title: () => 'Bokför kundfaktura' },
  },
  run: async (ctx, { invoice_id }, { dryRun }) => {
    const outcome = await bookInvoice(ctx, invoice_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ...outcome,
      data: { invoice: toBookedInvoice(outcome.data.invoice), journal_entry_id: outcome.data.journal_entry_id },
    }
  },
})

// ---------------------------------------------------------------------------
// invoices.bulk-book
// ---------------------------------------------------------------------------

const BulkBookItem = z.object({
  id: z.string(),
  status: z.enum(['booked', 'failed']),
  journal_entry_id: z.string().nullable().optional(),
  error_code: z.string().optional(),
  error: z.string().optional(),
})

export const invoicesBulkBook = defineOperation({
  id: 'invoices.bulk-book',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book many customer invoices in one call, each with its own outcome.',
    description:
      `The bulk Bokför of the invoice list. Per invoice id (at most ${BULK_BOOK_MAX_INVOICES}, duplicates processed once): a sent or overdue invoice without a verifikat gets the same revenue verifikat as POST /invoices/{id}/book; a draft is issued and booked like :mark-sent (F-series number allocated, marked sent WITHOUT email, verifikat posted, PDF archived, invoice.sent emitted), but only when the company books at issue: under defer_invoice_booking a draft fails with INVOICE_BOOK_DEFERRED_DRAFT and is not touched. Partial success: items are booked one by one in order, a failed item never stops the others and never undoes the ones before it, and the answer is 200 with one result per unique id plus a summary. Only whole-batch preconditions fail the request (kontantmetoden, unreadable settings). Idempotent. Dry-runnable: the dry run answers per item what would happen, with the lines, and writes nothing.`,
    useWhen:
      'Several invoices are waiting to be booked (the unbooked list, or MCP-created drafts in a company that books at issue) and the user wants them booked together.',
    doNotUseFor:
      'Sending invoices to customers (no email is sent here: use :send), paid invoices, credit notes, or kontantmetoden companies.',
    pitfalls: [
      'Check data.summary.failed and each data.results[].error_code: a 200 does not mean every invoice was booked.',
      'Under kontantmetoden the whole request answers 400 INVOICE_BOOK_CASH_METHOD.',
      'Per-item codes mirror POST /invoices/{id}/book (INVOICE_NOT_FOUND, INVOICE_BOOK_ALREADY_BOOKED, INVOICE_BOOK_INVALID_STATUS, INVOICE_BOOK_NOT_BOOKABLE, INVOICE_BOOK_DEFERRED_DRAFT, PERIOD_LOCKED, INVOICE_BOOK_NO_FISCAL_PERIOD, INVOICE_BOOK_CONFLICT) plus the issuance codes for drafts (INVOICE_SEND_PAYMENT_ACCOUNT_MISSING, INVOICE_SEND_VAT_NUMBER_MISSING, INVOICE_MARK_SENT_*).',
      'A draft that is issued consumes its F-number even if a later step fails; a locked period is checked first, so a lock never costs a number.',
      'A retried call with a new Idempotency-Key is safe: booked invoices answer INVOICE_BOOK_ALREADY_BOOKED per item.',
    ],
    example: {
      request: { invoice_ids: ['7d1e…', '8e2f…'] },
      response: {
        data: {
          results: [
            { id: '7d1e…', status: 'booked', journal_entry_id: '9a0b…' },
            {
              id: '8e2f…',
              status: 'failed',
              error_code: 'INVOICE_BOOK_INVALID_STATUS',
              error: 'Endast skickade eller förfallna fakturor kan bokföras i efterhand.',
            },
          ],
          summary: { total: 2, booked: 1, failed: 1 },
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({
    invoice_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(BULK_BOOK_MAX_INVOICES)
      .describe(`Customer invoice ids, 1 to ${BULK_BOOK_MAX_INVOICES}. Duplicates are processed once.`),
  }),
  output: z.object({
    results: z.array(BulkBookItem),
    summary: z.object({ total: z.number().int(), booked: z.number().int(), failed: z.number().int() }),
  }),
  errorCodes: ['INVOICE_BOOK_CASH_METHOD', 'INVOICE_SEND_COMPANY_SETTINGS_MISSING', 'INTERNAL_ERROR'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/invoices/bulk-book' },
  mcp: {
    name: 'gnubok_bulk_book_invoices',
    title: 'Bulk Book Customer Invoices',
    description:
      'Stage one Bokför for up to 200 customer invoices: sent unbooked ones get their revenue verifikat, drafts are issued (no email) and booked when the company books at issue. Each invoice reports its own result; failures never stop the rest.',
    keywords: ['bokför fakturor', 'bokför alla', 'massbokför', 'obokförda fakturor', 'bokför valda'],
    stage: {
      pendingType: 'bulk_book_invoices',
      title: (input) => {
        const n = new Set(Array.isArray(input.invoice_ids) ? input.invoice_ids : []).size
        return n === 1 ? 'Bokför 1 kundfaktura' : `Bokför ${n} kundfakturor`
      },
    },
  },
  run: (ctx, { invoice_ids }, { dryRun }) => bulkBookInvoices(ctx, invoice_ids, { dryRun }),
})

// ---------------------------------------------------------------------------
// supplier-invoices.book
// ---------------------------------------------------------------------------

export const supplierInvoicesBook = defineOperation({
  id: 'supplier-invoices.book',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book a registered supplier invoice that was registered without a verifikat (the deferred Bokför step).',
    description:
      'For companies with defer_invoice_booking=true (Registrera men bokför inte): POST /supplier-invoices registers the invoice without posting anything, and this step posts the registration verifikat afterwards (Debit cost accounts per line + 2641 ingående moms, or fiktiv moms for reverse charge; Credit 2440 Leverantörsskulder; periodiserade lines on 17xx with their schedules). Dated on the invoice date. The invoice is claimed with a compare-and-set, so a concurrent book, payment or credit cancels this entry instead of double-posting. The retained source document is anchored to the verifikat. Idempotent. Dry-runnable: the dry run previews the exact lines and writes nothing.',
    useWhen:
      'A supplier invoice is registered, approved or overdue, has no registration_journal_entry_id, and the company books supplier invoices in a separate step (defer_invoice_booking).',
    doNotUseFor:
      'Paid or partially paid invoices (their payment booked them in full), credit notes, or any supplier invoice under kontantmetoden (booked at payment via :mark-paid).',
    pitfalls: [
      'An invoice that already has a registration_journal_entry_id answers 400 SI_BOOK_ALREADY_BOOKED.',
      'Status other than registered, approved or overdue answers 400 SI_BOOK_INVALID_STATUS with details.currentStatus.',
      'Under kontantmetoden answers 400 SI_BOOK_CASH_METHOD.',
      PERIOD_LOCKED_PITFALL,
      'No open fiscal year covering the invoice date answers 400 SI_BOOK_NO_FISCAL_PERIOD.',
      'Booking does not attest the invoice: :approve is a separate step and may come before or after.',
    ],
    example: {
      response: {
        data: {
          supplier_invoice: {
            id: '3b4c…',
            arrival_number: 118,
            supplier_invoice_number: '55012',
            status: 'approved',
            invoice_date: '2026-09-03',
            due_date: '2026-10-03',
            currency: 'SEK',
            total: 6250,
            registration_journal_entry_id: '6d7e…',
          },
          journal_entry_id: '6d7e…',
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({
    supplier_invoice_id: z.string().uuid().describe('The supplier invoice id, from GET /supplier-invoices.'),
  }),
  output: z.object({ supplier_invoice: BookedSupplierInvoice, journal_entry_id: z.string().uuid() }),
  errorCodes: [
    'SI_NOT_FOUND',
    'SI_BOOK_ALREADY_BOOKED',
    'SI_BOOK_NOT_BOOKABLE',
    'SI_BOOK_INVALID_STATUS',
    'SI_BOOK_CASH_METHOD',
    'PERIOD_LOCKED',
    'SI_BOOK_NO_FISCAL_PERIOD',
    'SI_BOOK_CONFLICT',
    'SI_BOOK_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/supplier-invoices/:id/book',
    pathParams: { id: 'supplier_invoice_id' },
  },
  mcp: {
    name: 'gnubok_book_supplier_invoice',
    title: 'Book Supplier Invoice',
    description:
      'Stage the deferred Bokför step for a registered supplier invoice that has no verifikat yet (defer_invoice_booking companies). The preview shows the exact registration lines. Refused for paid invoices, credit notes, kontantmetoden and locked periods.',
    keywords: ['bokför leverantörsfaktura', 'registrera men bokför inte', 'obokförd leverantörsfaktura', 'leverantörsskuld'],
    stage: { pendingType: 'book_supplier_invoice', title: () => 'Bokför leverantörsfaktura' },
  },
  run: async (ctx, { supplier_invoice_id }, { dryRun }) => {
    const outcome = await bookSupplierInvoice(ctx, supplier_invoice_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ...outcome,
      data: {
        supplier_invoice: toBookedSupplierInvoice(outcome.data.supplier_invoice),
        journal_entry_id: outcome.data.journal_entry_id,
      },
    }
  },
})
