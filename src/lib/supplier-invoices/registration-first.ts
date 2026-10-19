/**
 * Settling a supplier invoice the books do not have yet books its
 * registration first.
 *
 * Under faktureringsmetoden a leverantörsfaktura is two affärshändelser: the
 * invoice, booked at fakturadatum (Debit cost + ingående moms / Credit 2440
 * Leverantörsskulder), and its payment (Debit 2440 / Credit the bank). A
 * company with company_settings.defer_invoice_booking (#967, "Registrera men
 * bokför inte") registers the invoice without its verifikat and books it
 * later through the explicit Bokför step (bookSupplierInvoice,
 * ./book-service.ts). Every settlement door used to pick its entry on
 * "kontantmetoden and never booked", so an unbooked invoice of a deferring
 * company that was paid before Bokför got the clearing alone: the cost and
 * the ingående moms never reached the ledger, 2440 kept a debit no
 * registration ever credited, and Bokför then refused the paid invoice.
 *
 * Every door that settles a supplier invoice asks this module before it posts
 * anything: dashboard and v1 mark-paid and the mark-paid preview; the bank
 * match (bookSupplierBankMatch behind the dashboard route and a bank payment
 * order's own debit, the v1 match route, the match preview); the
 * samlingsbetalning (lib/transactions/match-batch.ts: dashboard, v1, MCP); the
 * link to an existing verifikat (linkSupplierInvoiceToVoucher: dashboard, MCP
 * approval, and its MCP staging). Payment files (betalfil) book nothing and
 * settle through these doors. Two steps:
 *
 *   planRegistrationBeforeSettlement   whether the invoice must be booked
 *     first and, when it must, the Bokför step's own dry run: every check it
 *     runs (status, faktureringsmetoden, the lock on the invoice date, a
 *     fiscal year, the accrual months) and the verifikat it would post. Also
 *     the lock on the settlement date, so the common refusal of the payment
 *     comes before the registration is written. Writes nothing.
 *   bookRegistrationBeforeSettlement   the Bokför step itself, dated as Bokför
 *     dates it (the invoice date), once the door has run its own checks.
 *
 * A refusal carries the Bokför step's own code (or its typed bookkeeping
 * error) with details.registration_first, and the door refuses the payment
 * with it: nothing is written, never a clearing without its registration.
 * Kontantmetoden is untouched (the cash entry books the whole invoice at
 * payment), and so is every company that books at registration: there a
 * missing link can be a registration that arrived through SIE or a provider
 * migration, and booking it again would double the cost.
 *
 * The rule is the one the customer side's credit applies to a deferred
 * original (creditBooksOriginalFirst, accounted#45): a missing link means
 * unbooked only where the company books in a separate step.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { invoiceBookingMoment } from '@/lib/bookkeeping/booking-mode'
import type { EntryPreview } from '@/lib/bookkeeping/entry-preview'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationWarning } from '@/lib/operations/types'
import { chunk } from '@/lib/utils'
import { bookSupplierInvoice } from './book-service'

/** The booked-ness signals the rule reads off a supplier invoice. */
export interface RegistrationFirstInvoice {
  id: string
  registration_journal_entry_id?: string | null
  is_credit_note?: boolean | null
}

type BookingSettings = Parameters<typeof invoiceBookingMoment>[0]

/**
 * Whether settling this invoice must first book its registration: the company
 * books supplier invoices in a separate step (faktureringsmetoden with
 * defer_invoice_booking) and the invoice has no registration verifikat. A
 * credit note is never booked through Bokför, so it is left to its own flow.
 */
export function settlementBooksRegistrationFirst(
  settings: BookingSettings,
  invoice: RegistrationFirstInvoice | null | undefined,
): boolean {
  if (!invoice || invoice.is_credit_note || invoice.registration_journal_entry_id) return false
  return invoiceBookingMoment(settings) === 'manual'
}

/**
 * The SEK a registration verifikat leaves on leverantörsskulder: its credits
 * less its debits on the accounts-payable account, the one account the
 * registration builder books the skuld on.
 */
export function registrationPayableSek(entry: Pick<EntryPreview, 'lines'>): number {
  const payableAccount = resolveAccountRole(PINNED_JURISDICTION, 'accounts_payable')
  let carried = 0
  for (const line of entry.lines) {
    if (line.account_number !== payableAccount) continue
    carried += (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0)
  }
  return roundOre(carried)
}

export interface RegistrationFirstRefusal {
  ok: false
  /** The Bokför step's code, or the settlement date's. */
  code: string
  details?: Record<string, unknown>
  /** A typed bookkeeping error from the registration builder, answered verbatim. */
  error?: unknown
}

export type RegistrationFirstPlan =
  | { ok: true; required: false }
  | {
      ok: true
      required: true
      supplierInvoiceId: string
      /** The registration verifikat Bokför will post, as its dry run builds it. */
      entry: EntryPreview
      /** SEK the registration leaves on leverantörsskulder: the skuld the settlement clears. */
      payableSek: number
      /** Whether the registration creates periodiseringar (accrual schedules). */
      createsAccrualSchedules: boolean
    }

const NOT_REQUIRED: RegistrationFirstPlan = { ok: true, required: false }

// Ids per `.in()` read, as lib/reconciliation/limits.ts sizes them.
const ID_READ_CHUNK = 100

function refusal(
  invoiceId: string,
  code: string,
  details?: Record<string, unknown>,
  error?: unknown,
): RegistrationFirstRefusal {
  return {
    ok: false,
    code,
    details: { ...(details ?? {}), registration_first: true, supplier_invoice_id: invoiceId },
    ...(error !== undefined ? { error } : {}),
  }
}

async function readBookingSettings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ ok: true; settings: BookingSettings } | { ok: false; error: unknown }> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return { ok: false, error }
  return { ok: true, settings: (data ?? null) as BookingSettings }
}

/**
 * The settlement date must take a verifikat before anything is booked: a
 * locked or closed period, the company lock date, or no fiscal year refuses
 * here with the code the payment doors use, so the registration is never
 * written for a payment that then cannot post.
 */
const PAYMENT_DATE_CODES = { locked: 'SI_PAID_PERIOD_LOCKED', noPeriod: 'INVOICE_PAID_NO_FISCAL_PERIOD' }
// The codes match_batch_allocate answers for its own date.
const BATCH_DATE_CODES = { locked: 'BATCH_PERIOD_LOCKED', noPeriod: 'BATCH_NO_FISCAL_PERIOD' }

async function settlementDateRefusal(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  settlementDate: string,
  codes: { locked: string; noPeriod: string } = PAYMENT_DATE_CODES,
): Promise<RegistrationFirstRefusal | null> {
  const verdict = await checkPeriodLock(supabase, companyId, settlementDate)
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
 * Whether settling `invoice` must book its registration first and, when it
 * must, the Bokför step's dry run. `settlementDate` is the date the payment
 * verifikat will carry; omit it when the settlement posts none (a link to an
 * existing verifikat). Writes nothing; never throws.
 */
export async function planRegistrationBeforeSettlement(
  ctx: OperationContext,
  invoice: RegistrationFirstInvoice,
  options: { settlementDate?: string | null } = {},
): Promise<RegistrationFirstPlan | RegistrationFirstRefusal> {
  // Booked already, or a credit note: no read needed.
  if (invoice.is_credit_note || invoice.registration_journal_entry_id) return NOT_REQUIRED
  try {
    const read = await readBookingSettings(ctx.supabase, ctx.companyId)
    // Fail closed: settling with guessed settings could skip the registration.
    if (!read.ok) {
      ctx.log.error('registration-first: company settings unreadable', read.error, {
        supplierInvoiceId: invoice.id,
      })
      return refusal(invoice.id, 'SI_BOOK_FAILED')
    }
    if (!settlementBooksRegistrationFirst(read.settings, invoice)) return NOT_REQUIRED
    return await planDeferred(ctx, invoice.id, options.settlementDate ?? null)
  } catch (err) {
    ctx.log.error('registration-first: planning failed', err, { supplierInvoiceId: invoice.id })
    return refusal(invoice.id, 'SI_BOOK_FAILED')
  }
}

/**
 * planRegistrationBeforeSettlement for a door that holds only the invoice's
 * id (a link to an existing verifikat): the company setting is read first,
 * and the invoice only when the company books in a separate step. A missing
 * invoice needs nothing booked: the door refuses it on its own terms. Writes
 * nothing; never throws.
 */
export async function planRegistrationBeforeSettlementById(
  ctx: OperationContext,
  invoiceId: string,
  options: { settlementDate?: string | null } = {},
): Promise<RegistrationFirstPlan | RegistrationFirstRefusal> {
  try {
    const read = await readBookingSettings(ctx.supabase, ctx.companyId)
    if (!read.ok) {
      ctx.log.error('registration-first: company settings unreadable', read.error, { supplierInvoiceId: invoiceId })
      return refusal(invoiceId, 'SI_BOOK_FAILED')
    }
    if (invoiceBookingMoment(read.settings) !== 'manual') return NOT_REQUIRED
    const { data, error } = await ctx.supabase
      .from('supplier_invoices')
      .select('id, registration_journal_entry_id, is_credit_note')
      .eq('id', invoiceId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) {
      ctx.log.error('registration-first: supplier invoice unreadable', error, { supplierInvoiceId: invoiceId })
      return refusal(invoiceId, 'SI_BOOK_FAILED')
    }
    const invoice = data as RegistrationFirstInvoice | null
    if (!settlementBooksRegistrationFirst(read.settings, invoice)) return NOT_REQUIRED
    return await planDeferred(ctx, invoiceId, options.settlementDate ?? null)
  } catch (err) {
    ctx.log.error('registration-first: planning failed', err, { supplierInvoiceId: invoiceId })
    return refusal(invoiceId, 'SI_BOOK_FAILED')
  }
}

async function planDeferred(
  ctx: OperationContext,
  invoiceId: string,
  settlementDate: string | null,
): Promise<RegistrationFirstPlan | RegistrationFirstRefusal> {
  if (settlementDate) {
    const dateRefusal = await settlementDateRefusal(ctx.supabase, ctx.companyId, invoiceId, settlementDate)
    if (dateRefusal) return dateRefusal
  }
  const dryRun = await bookSupplierInvoice(ctx, invoiceId, { dryRun: true })
  if (!dryRun.ok) {
    // Booked since the caller read it: the settlement clears that verifikat.
    if (dryRun.code === 'SI_BOOK_ALREADY_BOOKED') return NOT_REQUIRED
    return refusal(invoiceId, dryRun.code, dryRun.details, dryRun.error)
  }
  if (!dryRun.dryRun) return refusal(invoiceId, 'SI_BOOK_FAILED')
  const entry = dryRun.preview.journal_entry as EntryPreview
  return {
    ok: true,
    required: true,
    supplierInvoiceId: invoiceId,
    entry,
    payableSek: registrationPayableSek(entry),
    createsAccrualSchedules: dryRun.preview.creates_accrual_schedules === true,
  }
}

export type RegistrationFirstBooking =
  | {
      ok: true
      /** The registration verifikat: posted here, by a concurrent Bokför, or null when none was required. */
      journalEntryId: string | null
      /** True when this call posted it. */
      bookedHere: boolean
      /** The Bokför step's non-blocking warnings (an accrual schedule that failed). */
      warnings: OperationWarning[]
    }
  | RegistrationFirstRefusal

/**
 * Book the registration a plan requires, through the Bokför step. A door
 * calls it after its own checks and right before it posts the settlement. A
 * refusal (a concurrent change since the plan) writes nothing, except what
 * Bokför itself cancels when another request claimed the invoice first.
 * Never throws.
 */
export async function bookRegistrationBeforeSettlement(
  ctx: OperationContext,
  plan: RegistrationFirstPlan,
): Promise<RegistrationFirstBooking> {
  if (!plan.required) return { ok: true, journalEntryId: null, bookedHere: false, warnings: [] }
  const invoiceId = plan.supplierInvoiceId
  try {
    const outcome = await bookSupplierInvoice(ctx, invoiceId)
    if (outcome.ok) {
      if (outcome.dryRun) return refusal(invoiceId, 'SI_BOOK_FAILED')
      return {
        ok: true,
        journalEntryId: outcome.data.journal_entry_id,
        bookedHere: true,
        warnings: outcome.warnings ?? [],
      }
    }
    if (outcome.code === 'SI_BOOK_ALREADY_BOOKED') {
      // A concurrent Bokför (or another settlement) booked it: settle against that verifikat.
      const { data } = await ctx.supabase
        .from('supplier_invoices')
        .select('registration_journal_entry_id')
        .eq('id', invoiceId)
        .eq('company_id', ctx.companyId)
        .maybeSingle()
      const existing = (data as { registration_journal_entry_id?: string | null } | null)?.registration_journal_entry_id
      if (existing) return { ok: true, journalEntryId: existing, bookedHere: false, warnings: [] }
    }
    ctx.log.warn('registration-first: the Bokför step refused the registration', {
      supplierInvoiceId: invoiceId,
      code: outcome.code,
    })
    return refusal(invoiceId, outcome.code, outcome.details, outcome.error)
  } catch (err) {
    ctx.log.error('registration-first: booking the registration failed', err, {
      supplierInvoiceId: invoiceId,
    })
    return refusal(invoiceId, 'SI_BOOK_FAILED')
  }
}

/** One plan per supplier invoice a samlingsbetalning settles. */
export type RegistrationFirstBatchPlan =
  | { ok: true; plans: Extract<RegistrationFirstPlan, { required: true }>[] }
  | RegistrationFirstRefusal

/**
 * The batch form of planRegistrationBeforeSettlement, for one bank row that
 * settles several supplier invoices (match_batch_allocate): one settings read,
 * one read of the invoices, then the Bokför dry run of each that must be
 * booked first. The first refusal refuses the batch; `settlementDate` is
 * asked for only when a registration is required. Never throws.
 */
export async function planRegistrationsBeforeBatchSettlement(
  ctx: OperationContext,
  supplierInvoiceIds: readonly string[],
  options: { settlementDate: () => Promise<string | null> },
): Promise<RegistrationFirstBatchPlan> {
  const ids = Array.from(new Set(supplierInvoiceIds))
  if (ids.length === 0) return { ok: true, plans: [] }
  try {
    const read = await readBookingSettings(ctx.supabase, ctx.companyId)
    if (!read.ok) {
      ctx.log.error('registration-first: company settings unreadable', read.error)
      return { ok: false, code: 'SI_BOOK_FAILED', details: { registration_first: true } }
    }
    // Only a deferring company has anything to book: no invoice read otherwise.
    if (invoiceBookingMoment(read.settings) !== 'manual') return { ok: true, plans: [] }

    // Read in slices: a full batch of ids in one `.in()` overruns the
    // gateway's URL limit.
    const unbookedIdSet = new Set<string>()
    for (const part of chunk(ids, ID_READ_CHUNK)) {
      const { data, error } = await ctx.supabase
        .from('supplier_invoices')
        .select('id, registration_journal_entry_id, is_credit_note')
        .in('id', part)
        .eq('company_id', ctx.companyId)
      if (error) {
        ctx.log.error('registration-first: supplier invoices unreadable', error)
        return { ok: false, code: 'SI_BOOK_FAILED', details: { registration_first: true } }
      }
      for (const invoice of (data ?? []) as RegistrationFirstInvoice[]) {
        if (settlementBooksRegistrationFirst(read.settings, invoice)) unbookedIdSet.add(invoice.id)
      }
    }
    if (unbookedIdSet.size === 0) return { ok: true, plans: [] }

    // In the caller's order, so the first refusal is the first invoice that has one.
    const unbookedIds = ids.filter((id) => unbookedIdSet.has(id))
    const settlementDate = await options.settlementDate()
    if (settlementDate) {
      const dateRefusal = await settlementDateRefusal(
        ctx.supabase,
        ctx.companyId,
        unbookedIds[0]!,
        settlementDate,
        BATCH_DATE_CODES,
      )
      if (dateRefusal) return dateRefusal
    }
    const plans: Extract<RegistrationFirstPlan, { required: true }>[] = []
    for (const id of unbookedIds) {
      const plan = await planDeferred(ctx, id, null)
      if (!plan.ok) return plan
      if (plan.required) plans.push(plan)
    }
    return { ok: true, plans }
  } catch (err) {
    ctx.log.error('registration-first: batch planning failed', err)
    return { ok: false, code: 'SI_BOOK_FAILED', details: { registration_first: true } }
  }
}

export type RegistrationFirstBatchBooking =
  | {
      ok: true
      /** Registration verifikat per supplier invoice id, posted here or by a concurrent Bokför. */
      journalEntryIds: Record<string, string>
      /** The ones this call posted. */
      postedJournalEntryIds: Record<string, string>
      warnings: OperationWarning[]
    }
  | (RegistrationFirstRefusal & {
      /** Registrations posted before the refusal: committed and immutable, each a correct booking of its invoice. */
      postedJournalEntryIds: Record<string, string>
    })

/**
 * Book every registration a batch plan requires, in order, right before the
 * samlingsbetalning posts. Stops at the first refusal and names what it had
 * posted by then. Never throws.
 */
export async function bookRegistrationsBeforeBatchSettlement(
  ctx: OperationContext,
  plans: Extract<RegistrationFirstPlan, { required: true }>[],
): Promise<RegistrationFirstBatchBooking> {
  const journalEntryIds: Record<string, string> = {}
  const postedJournalEntryIds: Record<string, string> = {}
  const warnings: OperationWarning[] = []
  for (const plan of plans) {
    const booked = await bookRegistrationBeforeSettlement(ctx, plan)
    if (!booked.ok) return { ...booked, postedJournalEntryIds }
    if (booked.journalEntryId) {
      journalEntryIds[plan.supplierInvoiceId] = booked.journalEntryId
      if (booked.bookedHere) postedJournalEntryIds[plan.supplierInvoiceId] = booked.journalEntryId
    }
    warnings.push(...booked.warnings)
  }
  return { ok: true, journalEntryIds, postedJournalEntryIds, warnings }
}
