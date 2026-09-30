/**
 * The deferred "Bokför" step for customer invoices (#967), one implementation
 * behind every door: the dashboard routes (POST /api/invoices/[id]/book,
 * POST /api/invoices/bulk-book), the v1 operations invoices.book and
 * invoices.bulk-book, and their MCP tools (lib/operations/invoice-booking.ts).
 *
 * Companies with company_settings.defer_invoice_booking=true send invoices
 * without a verifikat; ekonomi books the revenue entry here once the kontering
 * is verified. The entry itself is written by bookInvoiceDeferred
 * (CAS-guarded claim) and, for drafts in the bulk path, issueAndBookInvoice.
 *
 * Rules, in order, for one invoice:
 *   - it exists in the company, is a real invoice (not a quote, proforma,
 *     delivery note or credit note) and is not booked yet;
 *   - status sent or overdue (paid invoices were booked by their payment);
 *   - faktureringsmetoden: under kontantmetoden the sale books at payment;
 *   - the invoice date is not in a locked or closed period, nor on or before
 *     the company lock date: PERIOD_LOCKED, checked before anything is
 *     generated so a lock never costs a voucher or an F-number;
 *   - an open fiscal year covers the invoice date.
 *
 * A dry run reads, checks and previews the lines the generator would post,
 * and writes nothing: no entry, no claim, no number, no PDF.
 */
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { toEntryPreview, type EntryPreview } from '@/lib/bookkeeping/entry-preview'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { buildInvoiceJournalEntryInput } from '@/lib/bookkeeping/invoice-entries'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { bookInvoiceDeferred, INVOICE_BOOKABLE_STATUSES } from '@/lib/invoices/book-invoice-deferred'
import { issueAndBookInvoice, type IssuableInvoice } from '@/lib/invoices/issue-and-book-invoice'
import { hasRequiredInvoicePaymentAccount } from '@/lib/invoices/payment-accounts'
import { hasRequiredSellerVatNumber } from '@/lib/invoices/seller-vat-number'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import type { CompanySettings, EntityType, Invoice } from '@/types'
import { roundOre } from '@/lib/money'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** The bulk endpoint's bound, the same as the dashboard's InvoicesBulkBookSchema. */
export const BULK_BOOK_MAX_INVOICES = 200

/** English twins of the Swedish warnings bookInvoiceDeferred answers. */
const WARNING_EN: Record<string, string> = {
  PDF_LINK_FAILED: 'The invoice was booked, but the archived PDF could not be linked to the voucher.',
  ACCRUAL_SCHEDULE_FAILED:
    'The invoice was booked, but one or more accrual schedules (periodiseringar) could not be created. Check Bokföring > Periodiseringar.',
}

export function toOperationWarnings(warnings: Array<{ code: string; message: string }>): OperationWarning[] {
  return warnings.map((w) => ({ code: w.code, message_sv: w.message, message_en: WARNING_EN[w.code] ?? w.message }))
}

/** A failure in the generator: a typed bookkeeping error passes through, anything else is fallbackCode. */
function generatorFailure(err: unknown, fallbackCode: string, ctx: OperationContext, invoiceId: string): Failure {
  if (isBookkeepingError(err)) return { ok: false, code: fallbackCode, error: err }
  ctx.log.error('deferred booking preview failed', err as Error, { invoiceId })
  return { ok: false, code: fallbackCode }
}

async function lockFailure(ctx: OperationContext, invoiceDate: string): Promise<Failure | null> {
  const verdict = await checkPeriodLock(ctx.supabase, ctx.companyId, invoiceDate)
  if (!verdict.locked) return null
  return {
    ok: false,
    code: 'PERIOD_LOCKED',
    details: {
      reason: verdict.reason,
      ...(verdict.fiscal_period_id ? { fiscal_period_id: verdict.fiscal_period_id } : {}),
      invoice_date: invoiceDate,
    },
  }
}

/** The verifikat the invoice would get, or why it would not get one. Reads only. */
async function previewInvoiceEntry(
  ctx: OperationContext,
  invoice: IssuableInvoice,
  entityType: EntityType,
): Promise<{ ok: true; entry: EntryPreview } | Failure> {
  try {
    const input = await buildInvoiceJournalEntryInput(
      ctx.supabase,
      ctx.companyId,
      invoice as Invoice,
      entityType,
      invoice.customer?.name,
    )
    if (!input) {
      return { ok: false, code: 'INVOICE_BOOK_NO_FISCAL_PERIOD', details: { invoiceDate: invoice.invoice_date } }
    }
    return { ok: true, entry: toEntryPreview(input) }
  } catch (err) {
    return generatorFailure(err, 'INVOICE_BOOK_FAILED', ctx, invoice.id)
  }
}

function isRealInvoice(invoice: Pick<Invoice, 'document_type'>): boolean {
  return !invoice.document_type || invoice.document_type === 'invoice'
}

// ---------------------------------------------------------------------------
// One invoice
// ---------------------------------------------------------------------------

export interface BookInvoiceResult {
  /** The invoice row as the CAS-guarded link returned it. */
  invoice: Invoice
  journal_entry_id: string
}

export async function bookInvoice(
  ctx: OperationContext,
  invoiceId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BookInvoiceResult>> {
  const { supabase, companyId, userId, log } = ctx

  const { data: invoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(name), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()

  if (!invoice) return { ok: false, code: 'INVOICE_NOT_FOUND' }
  if (invoice.journal_entry_id) return { ok: false, code: 'INVOICE_BOOK_ALREADY_BOOKED' }
  if (!isRealInvoice(invoice) || invoice.credited_invoice_id) {
    return { ok: false, code: 'INVOICE_BOOK_NOT_BOOKABLE' }
  }
  if (!INVOICE_BOOKABLE_STATUSES.includes(invoice.status)) {
    return { ok: false, code: 'INVOICE_BOOK_INVALID_STATUS', details: { currentStatus: invoice.status } }
  }

  // The revenue-at-issue entry is a faktureringsmetoden concept; under
  // kontantmetoden the sale is booked in full when it is paid.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .single()
  // Fail closed: booking with guessed settings could apply the wrong
  // method's or entity type's rules, so a failed/missing settings read aborts.
  if (settingsError || !settings) {
    log.error('failed to load company settings for deferred booking', settingsError ?? undefined, { invoiceId })
    return { ok: false, code: 'INVOICE_BOOK_FAILED' }
  }
  if ((settings.accounting_method || 'accrual') !== 'accrual') {
    return { ok: false, code: 'INVOICE_BOOK_CASH_METHOD' }
  }
  const entityType = await resolveCompanyEntityType(
    supabase,
    companyId,
    (settings as Partial<CompanySettings>).entity_type,
  )

  const locked = await lockFailure(ctx, invoice.invoice_date)
  if (locked) return locked

  if (options.dryRun) {
    const preview = await previewInvoiceEntry(ctx, invoice as IssuableInvoice, entityType)
    if (!preview.ok) return preview
    return {
      ok: true,
      dryRun: true,
      preview: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number ?? null,
        status: invoice.status,
        journal_entry: preview.entry,
      },
    }
  }

  const result = await bookInvoiceDeferred({ supabase, companyId, userId, invoice, entityType, log })
  if (!result.ok) {
    if (result.kind === 'domain') return { ok: false, code: 'INVOICE_BOOK_FAILED', error: result.error }
    return { ok: false, code: result.errorCode, ...(result.details ? { details: result.details } : {}) }
  }
  return {
    ok: true,
    data: { invoice: result.invoice, journal_entry_id: result.journalEntryId },
    warnings: toOperationWarnings(result.warnings),
  }
}

// ---------------------------------------------------------------------------
// Many invoices
// ---------------------------------------------------------------------------

export interface BulkBookItemResult {
  id: string
  status: 'booked' | 'failed'
  journal_entry_id?: string | null
  error_code?: string
  /** Swedish user-facing message; raw errors stay in logs. */
  error?: string
}

export interface BulkBookSummary {
  total: number
  booked: number
  failed: number
}

export interface BulkBookResult {
  results: BulkBookItemResult[]
  summary: BulkBookSummary
}

/** One item of a bulk dry run: what the commit would do with it. */
export interface BulkBookPreviewItem {
  id: string
  status: 'would_book' | 'failed'
  /** book: the deferred Bokför step; issue_and_book: a draft is issued (F-number, marked sent, no email) and booked. */
  action?: 'book' | 'issue_and_book'
  error_code?: string
  error?: string
  journal_entry?: EntryPreview
}

function failItem(id: string, errorCode: string): BulkBookItemResult & { status: 'failed' } {
  return {
    id,
    status: 'failed',
    error_code: errorCode,
    error: getErrorEntry(errorCode)?.message_sv ?? 'Något gick fel. Försök igen.',
  }
}

/** A per-item failure from a Failure outcome: a wrapped domain error keeps its own code and message. */
function failItemFrom(id: string, failure: Failure): BulkBookItemResult & { status: 'failed' } {
  if (failure.error) {
    const code = (failure.error as { code?: string } | null)?.code
    return { id, status: 'failed', ...(code ? { error_code: code } : {}), error: getErrorMessage(failure.error) }
  }
  return failItem(id, failure.code)
}

/**
 * One "Bokför" for many customer invoices. Per invoice:
 *   - draft            -> issueAndBookInvoice(): F-number + mark sent (NO
 *                         email) + revenue verifikat, exactly the mark-sent
 *                         semantics; only when the company books at issue.
 *                         Deferred-booking companies get a per-item
 *                         INVOICE_BOOK_DEFERRED_DRAFT instead of a silent
 *                         issuance;
 *   - sent/overdue,
 *     unbooked         -> the single-invoice rules above (bookInvoiceDeferred);
 *   - anything else    -> a per-item error.
 *
 * Partial success: a failed item never aborts the batch and never rolls back
 * the items booked before it. The answer carries one result per unique id
 * and a summary; only a whole-batch precondition (settings unreadable,
 * kontantmetoden, the invoice read failing) fails the request itself.
 *
 * Sequential on purpose: commit_journal_entry assigns voucher numbers
 * atomically per call, so a serial loop keeps them gap-free and in order.
 */
export async function bulkBookInvoices(
  ctx: OperationContext,
  ids: readonly string[],
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BulkBookResult>> {
  const { supabase, companyId, userId, log } = ctx

  // One settings read for the whole batch: issuance needs the full row
  // (payment accounts + PDF branding), booking needs method + entity type.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()
  if (settingsError || !settings) return { ok: false, code: 'INVOICE_SEND_COMPANY_SETTINGS_MISSING' }
  // Under kontantmetoden nothing books before payment, so the whole request
  // is a no-op: reject it instead of issuing drafts nobody asked to send.
  if ((settings.accounting_method || 'accrual') !== 'accrual') {
    return { ok: false, code: 'INVOICE_BOOK_CASH_METHOD' }
  }
  const entityType = await resolveCompanyEntityType(
    supabase,
    companyId,
    (settings as Partial<CompanySettings>).entity_type,
  )

  const { data: invoices, error: fetchError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .in('id', ids as string[])
    .eq('company_id', companyId)
  if (fetchError) {
    log.error('failed to fetch invoices for bulk book', fetchError)
    return { ok: false, code: 'INTERNAL_ERROR' }
  }

  const invoicesById = new Map(((invoices ?? []) as IssuableInvoice[]).map((invoice) => [invoice.id, invoice]))
  const lockByDate = new Map<string, Failure | null>()
  const lockFor = async (date: string): Promise<Failure | null> => {
    if (!lockByDate.has(date)) lockByDate.set(date, await lockFailure(ctx, date))
    return lockByDate.get(date) ?? null
  }

  const results: BulkBookItemResult[] = []
  const previews: BulkBookPreviewItem[] = []

  // Dedupe: the loop's already-booked checks read the pre-loop snapshot, so
  // a repeated id would pass them twice and commit a second voucher that the
  // CAS claim then cancels (a cancelled verifikat + gap explanation per
  // duplicate). Each unique id is processed exactly once.
  for (const id of [...new Set(ids)]) {
    const invoice = invoicesById.get(id)
    const push = (item: BulkBookItemResult & { status: 'failed' }) =>
      options.dryRun ? previews.push(item) : results.push(item)

    if (!invoice) {
      push(failItem(id, 'INVOICE_NOT_FOUND'))
      continue
    }
    if (!isRealInvoice(invoice) || invoice.credited_invoice_id) {
      push(failItem(id, 'INVOICE_BOOK_NOT_BOOKABLE'))
      continue
    }

    let action: 'book' | 'issue_and_book'
    if (invoice.status === 'draft') {
      // Deferred-booking companies (#967) issue via mark-sent and book via
      // the explicit /book step. issueAndBookInvoice would consume an
      // F-number and flip the draft to sent WITHOUT booking anything, an
      // irreversible side effect nobody asked for, so the item fails
      // before the invoice is touched.
      if (!booksInvoicesOnIssue(settings)) {
        push(failItem(id, 'INVOICE_BOOK_DEFERRED_DRAFT'))
        continue
      }
      action = 'issue_and_book'
    } else if (INVOICE_BOOKABLE_STATUSES.includes(invoice.status)) {
      // Worklist-canonical unbooked predicate: journal_entry_id IS NULL.
      if (invoice.journal_entry_id) {
        push(failItem(id, 'INVOICE_BOOK_ALREADY_BOOKED'))
        continue
      }
      action = 'book'
    } else {
      push(failItem(id, 'INVOICE_BOOK_INVALID_STATUS'))
      continue
    }

    // Before any side effect: a lock would otherwise cost the draft its
    // F-number (issuance numbers first, books second) or a cancelled voucher.
    const locked = await lockFor(invoice.invoice_date)
    if (locked) {
      push(failItemFrom(id, locked))
      continue
    }

    if (options.dryRun) {
      // The issuance guards that need no write; the payee snapshot (which
      // writes the frozen payee onto the draft) runs at commit only.
      if (action === 'issue_and_book' && !hasRequiredInvoicePaymentAccount(settings, invoice as Invoice)) {
        push(failItem(id, 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING'))
        continue
      }
      if (action === 'issue_and_book' && !hasRequiredSellerVatNumber(settings, invoice as Invoice)) {
        push(failItem(id, 'INVOICE_SEND_VAT_NUMBER_MISSING'))
        continue
      }
      const preview = await previewInvoiceEntry(ctx, invoice, entityType)
      if (!preview.ok) {
        push(failItemFrom(id, preview))
        continue
      }
      previews.push({ id, status: 'would_book', action, journal_entry: preview.entry })
      continue
    }

    if (action === 'issue_and_book') {
      const result = await issueAndBookInvoice({
        supabase,
        companyId,
        userId,
        invoice,
        settings: settings as CompanySettings,
        log,
      })
      results.push(
        result.ok ? { id, status: 'booked', journal_entry_id: result.journalEntryId } : failItem(id, result.errorCode),
      )
      continue
    }

    const result = await bookInvoiceDeferred({ supabase, companyId, userId, invoice, entityType, log })
    if (result.ok) {
      results.push({ id, status: 'booked', journal_entry_id: result.journalEntryId })
    } else if (result.kind === 'domain') {
      results.push(failItemFrom(id, { ok: false, code: 'INVOICE_BOOK_FAILED', error: result.error }))
    } else {
      results.push(failItem(id, result.errorCode))
    }
  }

  if (options.dryRun) {
    const wouldBook = previews.filter((p) => p.status === 'would_book').length
    return {
      ok: true,
      dryRun: true,
      preview: {
        results: previews,
        summary: { total: previews.length, would_book: wouldBook, failed: previews.length - wouldBook },
        // What the batch posts in total: the unattended-commit ceiling of an
        // API key prices the staged operation by this figure.
        total_debit: roundOre(previews.reduce((sum, p) => sum + (p.journal_entry?.total_debit ?? 0), 0)),
        note:
          'Drafts (action issue_and_book) get their F-number at commit, so their preview lines carry a draft tag in place of the number. Items are booked one by one: a failed item does not stop the others.',
      },
    }
  }

  return {
    ok: true,
    data: {
      results,
      summary: {
        total: results.length,
        booked: results.filter((r) => r.status === 'booked').length,
        failed: results.filter((r) => r.status === 'failed').length,
      },
    },
  }
}
