/**
 * Settling a customer invoice the books do not have yet books its sale first.
 *
 * Under faktureringsmetoden a kundfaktura is two affärshändelser: the sale,
 * booked at fakturadatum (Debit 1510 Kundfordringar, and 1513 for a ROT/RUT
 * share / Credit 30xx revenue + 26xx utgående moms), and its payment (Debit
 * the bank / Credit 1510). A company with company_settings.
 * defer_invoice_booking (#967, "Registrera men bokför inte") sends invoices
 * without a verifikat and books the sale later through the explicit Bokför
 * step (bookInvoice, ./book-service.ts). Every settlement door used to pick
 * its entry on "kontantmetoden and never booked", so an unbooked invoice of a
 * deferring company that was paid before Bokför got the clearing alone: the
 * revenue and the utgående moms never reached the ledger (the VAT return came
 * out short) and 1510 kept a credit no sale ever debited.
 *
 * Every door that settles a customer invoice asks this module before it posts
 * anything:
 *   - mark paid: settleInvoicePayment (./settle-invoice-payment.ts) behind the
 *     dashboard and v1 mark-paid and the MCP approval of
 *     gnubok_mark_invoice_as_paid; the v1 dry run and the MCP staging preview
 *     plan it too;
 *   - the bank match of one income row: bookCustomerBankMatch
 *     (./book-customer-bank-match.ts: the dashboard and v1 match-invoice
 *     routes and the MCP approval of gnubok_match_transaction_to_invoice,
 *     which gnubok_auto_match_period stages), the dashboard match preview,
 *     and the stagings;
 *   - the samlingsbetalning (lib/transactions/match-batch.ts: dashboard, v1,
 *     MCP, and the Bankgirot/Open Payments splits that hand a row to it);
 *   - a link to an existing verifikat: linkInvoiceToVoucher
 *     (./voucher-matching.ts: dashboard, MCP staging and approval) and a bank
 *     row linked to a verifikat with invoice_id
 *     (lib/transactions/link-journal-entry.ts: dashboard, v1, MCP).
 * Two steps:
 *
 *   planSaleBeforeSettlement   whether the invoice must be booked first and,
 *     when it must, the Bokför step's own dry run: every check it runs
 *     (status, faktureringsmetoden, the lock on the invoice date, a fiscal
 *     year) and the verifikat it would post. Also the lock on the settlement
 *     date, so the common refusal of the payment comes before the sale is
 *     written. Writes nothing.
 *   bookSaleBeforeSettlement   the Bokför step itself, dated as Bokför dates
 *     it (the invoice date), once the door has run its own checks.
 *
 * A refusal carries the Bokför step's own code (or its typed bookkeeping
 * error) with details.sale_first, and the door refuses the payment with it:
 * nothing is written, never a clearing without its sale. The Bokför step
 * books a sent or overdue invoice only, so a payment reaching a partially
 * paid invoice without a sale (paid before this rule) is refused with
 * INVOICE_BOOK_INVALID_STATUS: that one needs a rättelse, not a payment.
 * Kontantmetoden is untouched (the cash entry books the whole sale at
 * payment), and so is every company that books at issue: there a missing link
 * can be a sale that arrived through SIE or a provider migration, and booking
 * it again would double the revenue.
 *
 * The rule is the one the credit of a deferred original applies
 * (creditBooksOriginalFirst, accounted#45): a missing link means unbooked only
 * where the company books in a separate step.
 */
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { invoiceBookingMoment } from '@/lib/bookkeeping/booking-mode'
import type { EntryPreview } from '@/lib/bookkeeping/entry-preview'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationWarning } from '@/lib/operations/types'
import { chunk } from '@/lib/utils'
import { bookInvoice } from './book-service'

/** The booked-ness signals the rule reads off a customer invoice. */
export interface SaleFirstInvoice {
  id: string
  journal_entry_id?: string | null
  document_type?: string | null
  credited_invoice_id?: string | null
  total?: number | null
}

type BookingSettings = Parameters<typeof invoiceBookingMoment>[0]

/**
 * A faktura with no verifikat of its own. Only a faktura carries a sale: a
 * credit note, proforma, quote or delivery note is left to its own flow.
 */
function lacksOwnVerifikat(invoice: SaleFirstInvoice | null | undefined): invoice is SaleFirstInvoice {
  if (!invoice || invoice.journal_entry_id || isCreditNoteDocument(invoice)) return false
  return !invoice.document_type || invoice.document_type === 'invoice'
}

/**
 * Whether settling this invoice must first book its sale: the company books
 * customer invoices in a separate step (faktureringsmetoden with
 * defer_invoice_booking) and the faktura has no verifikat of its own.
 */
export function settlementBooksSaleFirst(
  settings: BookingSettings,
  invoice: SaleFirstInvoice | null | undefined,
): boolean {
  return lacksOwnVerifikat(invoice) && invoiceBookingMoment(settings) === 'manual'
}

/**
 * The SEK a sale verifikat leaves on kundfordringar: its debits less its
 * credits on the accounts-receivable account. 1513, Skatteverket's share, is
 * another account and never the customer's to pay.
 */
export function saleReceivableSek(entry: Pick<EntryPreview, 'lines'>): number {
  const receivableAccount = resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable')
  let carried = 0
  for (const line of entry.lines) {
    if (line.account_number !== receivableAccount) continue
    carried += (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
  }
  return roundOre(carried)
}

export interface SaleFirstRefusal {
  ok: false
  /** The Bokför step's code, or the settlement date's. */
  code: string
  details?: Record<string, unknown>
  /** A typed bookkeeping error from the sale's entry builder, answered verbatim. */
  error?: unknown
}

export type SaleFirstPlan =
  | {
      ok: true
      required: false
      /**
       * A concurrent Bokför booked the sale since the caller read the
       * invoice: the row's journal_entry_id is stale, the ledger has the sale.
       */
      bookedSince?: true
    }
  | {
      ok: true
      required: true
      invoiceId: string
      /** The sale verifikat Bokför will post, as its dry run builds it. */
      entry: EntryPreview
      /** SEK the sale leaves on kundfordringar: what the settlement clears. */
      receivableSek: number
    }

export type RequiredSaleFirstPlan = Extract<SaleFirstPlan, { required: true }>

/** The plan of a settlement that books no sale first. */
export const SALE_FIRST_NOT_REQUIRED: SaleFirstPlan = { ok: true, required: false }
const NOT_REQUIRED = SALE_FIRST_NOT_REQUIRED

// Ids per `.in()` read, as lib/reconciliation/limits.ts sizes them.
const ID_READ_CHUNK = 100

function refusal(
  invoiceId: string,
  code: string,
  details?: Record<string, unknown>,
  error?: unknown,
): SaleFirstRefusal {
  return {
    ok: false,
    code,
    details: { ...(details ?? {}), sale_first: true, invoice_id: invoiceId },
    ...(error !== undefined ? { error } : {}),
  }
}

async function readBookingSettings(
  ctx: OperationContext,
): Promise<{ ok: true; settings: BookingSettings } | { ok: false; error: unknown }> {
  const { data, error } = await ctx.supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) return { ok: false, error }
  return { ok: true, settings: (data ?? null) as BookingSettings }
}

/**
 * The settlement date must take a verifikat before anything is booked: a
 * locked or closed period, the company lock date, or no fiscal year refuses
 * here, so the sale is never written for a payment that then cannot post.
 */
const PAYMENT_DATE_CODES = { locked: 'PERIOD_LOCKED', noPeriod: 'INVOICE_PAID_NO_FISCAL_PERIOD' }
// The codes match_batch_allocate answers for its own date.
const BATCH_DATE_CODES = { locked: 'BATCH_PERIOD_LOCKED', noPeriod: 'BATCH_NO_FISCAL_PERIOD' }

async function settlementDateRefusal(
  ctx: OperationContext,
  invoiceId: string,
  settlementDate: string,
  codes: { locked: string; noPeriod: string } = PAYMENT_DATE_CODES,
): Promise<SaleFirstRefusal | null> {
  const verdict = await checkPeriodLock(ctx.supabase, ctx.companyId, settlementDate)
  if (verdict.locked) {
    return refusal(invoiceId, codes.locked, {
      reason: verdict.reason,
      ...(verdict.fiscal_period_id ? { fiscal_period_id: verdict.fiscal_period_id } : {}),
      payment_date: settlementDate,
    })
  }
  if (verdict.reason === 'no_fiscal_period') {
    return refusal(invoiceId, codes.noPeriod, { payment_date: settlementDate })
  }
  return null
}

/**
 * Whether settling `invoice` must book its sale first and, when it must, the
 * Bokför step's dry run. `settlementDate` is the date the payment verifikat
 * will carry; omit it when the settlement posts none (a link to an existing
 * verifikat). Writes nothing; never throws.
 */
export async function planSaleBeforeSettlement(
  ctx: OperationContext,
  invoice: SaleFirstInvoice,
  options: { settlementDate?: string | null } = {},
): Promise<SaleFirstPlan | SaleFirstRefusal> {
  // Booked already, or not a faktura: no read needed.
  if (!lacksOwnVerifikat(invoice)) return NOT_REQUIRED
  try {
    const read = await readBookingSettings(ctx)
    // Fail closed: settling with guessed settings could skip the sale.
    if (!read.ok) {
      ctx.log.error('sale-first: company settings unreadable', read.error, { invoiceId: invoice.id })
      return refusal(invoice.id, 'INVOICE_BOOK_FAILED')
    }
    if (!settlementBooksSaleFirst(read.settings, invoice)) return NOT_REQUIRED
    return await planDeferred(ctx, invoice.id, options.settlementDate ?? null)
  } catch (err) {
    ctx.log.error('sale-first: planning failed', err, { invoiceId: invoice.id })
    return refusal(invoice.id, 'INVOICE_BOOK_FAILED')
  }
}

/**
 * planSaleBeforeSettlement for a door that holds only the invoice's id (a
 * link to an existing verifikat): the company setting is read first, and the
 * invoice only when the company books in a separate step. A missing invoice
 * needs nothing booked: the door refuses it on its own terms. Writes nothing;
 * never throws.
 */
export async function planSaleBeforeSettlementById(
  ctx: OperationContext,
  invoiceId: string,
  options: { settlementDate?: string | null } = {},
): Promise<SaleFirstPlan | SaleFirstRefusal> {
  try {
    const read = await readBookingSettings(ctx)
    if (!read.ok) {
      ctx.log.error('sale-first: company settings unreadable', read.error, { invoiceId })
      return refusal(invoiceId, 'INVOICE_BOOK_FAILED')
    }
    if (invoiceBookingMoment(read.settings) !== 'manual') return NOT_REQUIRED
    const { data, error } = await ctx.supabase
      .from('invoices')
      .select('id, journal_entry_id, document_type, credited_invoice_id, total')
      .eq('id', invoiceId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) {
      ctx.log.error('sale-first: invoice unreadable', error, { invoiceId })
      return refusal(invoiceId, 'INVOICE_BOOK_FAILED')
    }
    const invoice = data as SaleFirstInvoice | null
    if (!settlementBooksSaleFirst(read.settings, invoice)) return NOT_REQUIRED
    return await planDeferred(ctx, invoiceId, options.settlementDate ?? null)
  } catch (err) {
    ctx.log.error('sale-first: planning failed', err, { invoiceId })
    return refusal(invoiceId, 'INVOICE_BOOK_FAILED')
  }
}

async function planDeferred(
  ctx: OperationContext,
  invoiceId: string,
  settlementDate: string | null,
): Promise<SaleFirstPlan | SaleFirstRefusal> {
  if (settlementDate) {
    const dateRefusal = await settlementDateRefusal(ctx, invoiceId, settlementDate)
    if (dateRefusal) return dateRefusal
  }
  const dryRun = await bookInvoice(ctx, invoiceId, { dryRun: true })
  if (!dryRun.ok) {
    // Booked since the caller read it: the settlement clears that verifikat.
    if (dryRun.code === 'INVOICE_BOOK_ALREADY_BOOKED') return { ok: true, required: false, bookedSince: true }
    return refusal(invoiceId, dryRun.code, dryRun.details, dryRun.error)
  }
  if (!dryRun.dryRun) return refusal(invoiceId, 'INVOICE_BOOK_FAILED')
  const entry = dryRun.preview.journal_entry as EntryPreview
  return { ok: true, required: true, invoiceId, entry, receivableSek: saleReceivableSek(entry) }
}

export type SaleFirstBooking =
  | {
      ok: true
      /** The sale verifikat: posted here, by a concurrent Bokför, or null when none was required. */
      journalEntryId: string | null
      /** True when this call posted it. */
      bookedHere: boolean
      /** The Bokför step's non-blocking warnings (an archived PDF or a periodisering that failed). */
      warnings: OperationWarning[]
    }
  | SaleFirstRefusal

/** The sale verifikat a concurrent request linked, or null. */
async function linkedSaleEntryId(ctx: OperationContext, invoiceId: string): Promise<string | null> {
  const { data } = await ctx.supabase
    .from('invoices')
    .select('journal_entry_id')
    .eq('id', invoiceId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  return (data as { journal_entry_id?: string | null } | null)?.journal_entry_id ?? null
}

/**
 * Book the sale a plan requires, through the Bokför step. A door calls it
 * after its own checks and right before it posts the settlement. A refusal (a
 * concurrent change since the plan) writes nothing, except what Bokför itself
 * cancels when another request claimed the invoice first. Never throws.
 */
export async function bookSaleBeforeSettlement(
  ctx: OperationContext,
  plan: SaleFirstPlan,
): Promise<SaleFirstBooking> {
  if (!plan.required) return { ok: true, journalEntryId: null, bookedHere: false, warnings: [] }
  const invoiceId = plan.invoiceId
  try {
    const outcome = await bookInvoice(ctx, invoiceId)
    if (outcome.ok) {
      if (outcome.dryRun) return refusal(invoiceId, 'INVOICE_BOOK_FAILED')
      return {
        ok: true,
        journalEntryId: outcome.data.journal_entry_id,
        bookedHere: true,
        warnings: outcome.warnings ?? [],
      }
    }
    if (outcome.code === 'INVOICE_BOOK_ALREADY_BOOKED' || outcome.code === 'INVOICE_BOOK_CONFLICT') {
      // A concurrent Bokför (or another settlement that booked it first)
      // linked the sale: settle against that verifikat.
      const existing = await linkedSaleEntryId(ctx, invoiceId)
      if (existing) return { ok: true, journalEntryId: existing, bookedHere: false, warnings: [] }
    }
    ctx.log.warn('sale-first: the Bokför step refused the sale', { invoiceId, code: outcome.code })
    return refusal(invoiceId, outcome.code, outcome.details, outcome.error)
  } catch (err) {
    ctx.log.error('sale-first: booking the sale failed', err, { invoiceId })
    return refusal(invoiceId, 'INVOICE_BOOK_FAILED')
  }
}

/** One plan per customer invoice a samlingsbetalning settles. */
export type SaleFirstBatchPlan = { ok: true; plans: RequiredSaleFirstPlan[] } | SaleFirstRefusal

/**
 * The batch form of planSaleBeforeSettlement, for one bank row that settles
 * several customer invoices (match_batch_allocate): one settings read, one
 * read of the invoices, then the Bokför dry run of each that must be booked
 * first. The first refusal refuses the batch; `settlementDate` is asked for
 * only when a sale is required. Never throws.
 */
export async function planSalesBeforeBatchSettlement(
  ctx: OperationContext,
  invoiceIds: readonly string[],
  options: { settlementDate: () => Promise<string | null> },
): Promise<SaleFirstBatchPlan> {
  const ids = Array.from(new Set(invoiceIds))
  if (ids.length === 0) return { ok: true, plans: [] }
  try {
    const read = await readBookingSettings(ctx)
    if (!read.ok) {
      ctx.log.error('sale-first: company settings unreadable', read.error)
      return { ok: false, code: 'INVOICE_BOOK_FAILED', details: { sale_first: true } }
    }
    // Only a deferring company has anything to book: no invoice read otherwise.
    if (invoiceBookingMoment(read.settings) !== 'manual') return { ok: true, plans: [] }

    // Read in slices: a full batch of ids in one `.in()` overruns the
    // gateway's URL limit.
    const unbookedIdSet = new Set<string>()
    for (const part of chunk(ids, ID_READ_CHUNK)) {
      const { data, error } = await ctx.supabase
        .from('invoices')
        .select('id, journal_entry_id, document_type, credited_invoice_id, total')
        .in('id', part)
        .eq('company_id', ctx.companyId)
      if (error) {
        ctx.log.error('sale-first: invoices unreadable', error)
        return { ok: false, code: 'INVOICE_BOOK_FAILED', details: { sale_first: true } }
      }
      for (const invoice of (data ?? []) as SaleFirstInvoice[]) {
        if (settlementBooksSaleFirst(read.settings, invoice)) unbookedIdSet.add(invoice.id)
      }
    }
    if (unbookedIdSet.size === 0) return { ok: true, plans: [] }

    // In the caller's order, so the first refusal is the first invoice that has one.
    const unbookedIds = ids.filter((id) => unbookedIdSet.has(id))
    const settlementDate = await options.settlementDate()
    if (settlementDate) {
      const dateRefusal = await settlementDateRefusal(ctx, unbookedIds[0]!, settlementDate, BATCH_DATE_CODES)
      if (dateRefusal) return dateRefusal
    }
    const plans: RequiredSaleFirstPlan[] = []
    for (const id of unbookedIds) {
      const plan = await planDeferred(ctx, id, null)
      if (!plan.ok) return plan
      if (plan.required) plans.push(plan)
    }
    return { ok: true, plans }
  } catch (err) {
    ctx.log.error('sale-first: batch planning failed', err)
    return { ok: false, code: 'INVOICE_BOOK_FAILED', details: { sale_first: true } }
  }
}

export type SaleFirstBatchBooking =
  | {
      ok: true
      /** Sale verifikat per invoice id, posted here or by a concurrent Bokför. */
      journalEntryIds: Record<string, string>
      /** The ones this call posted. */
      postedJournalEntryIds: Record<string, string>
      warnings: OperationWarning[]
    }
  | (SaleFirstRefusal & {
      /** Sales posted before the refusal: committed and immutable, each a correct booking of its invoice. */
      postedJournalEntryIds: Record<string, string>
    })

/**
 * Book every sale a batch plan requires, in order, right before the
 * samlingsbetalning posts. Stops at the first refusal and names what it had
 * posted by then. Never throws.
 */
export async function bookSalesBeforeBatchSettlement(
  ctx: OperationContext,
  plans: readonly RequiredSaleFirstPlan[],
): Promise<SaleFirstBatchBooking> {
  const journalEntryIds: Record<string, string> = {}
  const postedJournalEntryIds: Record<string, string> = {}
  const warnings: OperationWarning[] = []
  for (const plan of plans) {
    const booked = await bookSaleBeforeSettlement(ctx, plan)
    if (!booked.ok) return { ...booked, postedJournalEntryIds }
    if (booked.journalEntryId) {
      journalEntryIds[plan.invoiceId] = booked.journalEntryId
      if (booked.bookedHere) postedJournalEntryIds[plan.invoiceId] = booked.journalEntryId
    }
    warnings.push(...booked.warnings)
  }
  return { ok: true, journalEntryIds, postedJournalEntryIds, warnings }
}

/**
 * What a preview or a staged approval shows of a plan: the sale verifikat the
 * settlement books first, or nothing when none is required.
 */
export function saleFirstPreview(plan: SaleFirstPlan): { books_sale_first: true; sale_entry: EntryPreview } | Record<string, never> {
  return plan.required ? { books_sale_first: true, sale_entry: plan.entry } : {}
}

/** Kundfordringar: 1510 and its sub-accounts, as the voucher matchers read them. */
const RECEIVABLE_ACCOUNT_PREFIX = '151'

/**
 * Whether a payment's lines clear the receivable (credit a 151x account).
 * Only such a payment needs the sale booked first: lines that book the
 * revenue themselves (a hand-made Dr 1930 / Cr 30xx, the verifikat the
 * duplicate dialog links a bank row to) already carry the sale, and booking
 * it again would double the revenue and the utgående moms.
 */
export function clearsReceivable(
  lines: ReadonlyArray<{ account_number: string; credit_amount?: number | null }>,
): boolean {
  return lines.some(
    (line) => line.account_number.startsWith(RECEIVABLE_ACCOUNT_PREFIX) && (Number(line.credit_amount) || 0) > 0,
  )
}

/** A refusal's code as an agent or API reads it: a typed bookkeeping error answers with its own code. */
export function saleFirstRefusalCode(refusal: SaleFirstRefusal): string {
  const errorCode = (refusal.error as { code?: unknown } | null | undefined)?.code
  return typeof errorCode === 'string' ? errorCode : refusal.code
}
