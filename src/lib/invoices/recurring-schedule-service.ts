/**
 * Recurring invoice schedule service.
 *
 * Two public functions:
 *  - executeRecurringSchedule: spawn one invoice from a schedule, optionally
 *    sending it. Used by the daily cron and by a manual "run now" admin
 *    action.
 *  - computeNextRunDate: pure date helper. Given a reference date,
 *    day_of_month and interval_months, return the next date the schedule
 *    should run. Day-of-month values >28 are clamped to the last day of
 *    shorter months; the schedule keeps its original day_of_month so it
 *    jumps back in months that have it.
 *  - rollNextRunDateForward: pure date helper for stale schedules. Advances
 *    a missed next_run_date in whole intervals so a quarterly or yearly
 *    schedule keeps its month phase across an outage or a pause.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import {
  getArticleVatRateAdoptionSet,
  getPermittedVatRates,
  getVatRules,
} from '@/lib/invoices/vat-rules'
import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { ensureInvoiceNumber, InvoiceNumberSeriesBehindError } from '@/lib/invoices/ensure-invoice-number'
import {
  applyRecurringPlaceholders,
  buildRecurringPlaceholderValues,
} from '@/lib/invoices/recurring-placeholders'
import { isTextLine } from '@/lib/invoices/recurring-schedule-items'
import { isBalanceSheetAccount } from '@/lib/invoices/posting-account'
import { computeLineNet, computeLineVat } from '@/lib/bookkeeping/invoice-line-amounts'
import { roundOre } from '@/lib/money'
import { yourReferenceForNewInvoice } from '@/lib/customers/invoice-reference'
import { customerInvoiceMarking } from '@/lib/customers/invoice-marking'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  archiveIssuedInvoicePdf,
  issuable,
  markInvoiceSentAndBook,
  restoreUnbookedDraft,
} from '@/lib/invoices/issue-and-book-invoice'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { applyPaymentLinkToInvoice } from '@/lib/extensions/payment-links'
import { getEmailService } from '@/lib/email/service'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import {
  reserveInvoiceDelivery,
  sendTrackedInvoiceEmail,
} from '@/lib/invoices/invoice-deliveries'
import {
  exceedsInvoiceEmailRecipientLimit,
  invoiceEmailRecipientCount,
  resolveInvoiceEmailRecipients,
  resolveInvoiceReplyTo,
} from '@/lib/invoices/email-recipients'
import { snapshotInvoicePayee } from '@/lib/invoices/invoice-payee'
import { createLogger, type Logger } from '@/lib/logger'
import { todayIsoStockholm, invoiceDueDate } from '@/lib/dates/iso'
import { consumerCreditApplies, consumerInvoiceTerms, isInvoiceFeeLine } from '@/lib/invoices/consumer-credit'
import {
  firstRunDateOnOrAfter,
  getStockholmDateHour,
  isoFromParts,
  lastDayOfMonth,
} from '@/lib/invoices/recurring-run-date'

// Lives in the client-safe module now (the dialog needs Stockholm's calendar
// day too); re-exported so the cron, routes and executors keep importing it
// from here.
export { getStockholmDateHour } from '@/lib/invoices/recurring-run-date'
import type {
  Invoice,
  InvoiceItem,
  Customer,
  CompanySettings,
  RecurringInvoiceSchedule,
  RecurringInvoiceScheduleItem,
} from '@/types'
import { linkBasisColumns } from '@/lib/links/stamp'

const log = createLogger('invoices/recurring-schedule-service')

export interface ExecuteResult {
  invoiceId: string
  invoiceNumber: string | null
  autoSent: boolean
  warning: string | null
}

/** The schedule warning when auto-send stopped before anything was issued. */
const MANUAL_SEND_WARNING =
  'Auto-utskick misslyckades: fakturan finns som utkast och kan skickas manuellt.'

/**
 * How one auto-send ended. `sent` means the email reached the provider;
 * `warning` is what the schedule shows (last_run_warning), also on a send
 * that went out with a follow-up step missing.
 */
interface AutoSendOutcome {
  sent: boolean
  warning?: string
}

function assertValidCadence(dayOfMonth: number, intervalMonths: number): void {
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    throw new Error(`invalid day_of_month: ${dayOfMonth}`)
  }
  if (!Number.isInteger(intervalMonths) || intervalMonths < 1 || intervalMonths > 12) {
    throw new Error(`invalid interval_months: ${intervalMonths}`)
  }
}

/**
 * Compute the next run date for a schedule given a reference date, the
 * stored day_of_month and interval_months. The reference is always
 * interpreted in UTC to avoid timezone surprises around the day boundary in
 * Vercel cron.
 *
 * Rules:
 *  - If reference is the same as a valid day_of_month occurrence, returns
 *    the occurrence one interval later (callers compute the FIRST run via
 *    computeInitialRunDate).
 *  - Day 29-31 in shorter months clamps to that month's last day.
 *  - The schedule's stored day_of_month is unchanged: caller passes it in.
 *  - interval_months (default 1 = monthly) is how many months to advance;
 *    the cron passes the reference on the schedule's own due date, so the
 *    month phase of a quarterly/yearly schedule is preserved.
 */
export function computeNextRunDate(
  reference: Date,
  dayOfMonth: number,
  intervalMonths = 1,
): string {
  assertValidCadence(dayOfMonth, intervalMonths)
  const refY = reference.getUTCFullYear()
  const refM = reference.getUTCMonth()
  // Advance one interval.
  const nextM = refM + intervalMonths
  const nextYear = refY + Math.floor(nextM / 12)
  const nextMonth = ((nextM % 12) + 12) % 12
  const clamped = Math.min(dayOfMonth, lastDayOfMonth(nextYear, nextMonth))
  return isoFromParts(nextYear, nextMonth, clamped)
}

/**
 * Roll a missed (or being-edited) next_run_date forward on the schedule's
 * own month grid: start from the anchor's year-month, apply day_of_month
 * (clamped per month), and advance in whole interval_months steps until the
 * result is on-or-after today (allowToday, cron's stale roll-forward) or
 * strictly after today (edits/reactivation, so nothing can trigger a
 * same-hour surprise send).
 *
 * Anchoring on the stale date rather than on today is what keeps a
 * quarterly schedule on its Jan/Apr/Jul/Oct phase: a Jan 15 run missed
 * during an outage rolls to Apr 15, not to Feb 15. For interval 1 every
 * month is on the grid, so this degenerates to the pre-interval behavior.
 */
export function rollNextRunDateForward(
  anchorDate: string,
  today: Date,
  dayOfMonth: number,
  intervalMonths = 1,
  { allowToday = false }: { allowToday?: boolean } = {},
): string {
  assertValidCadence(dayOfMonth, intervalMonths)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchorDate)
  if (!match) {
    throw new Error(`invalid anchor date: ${anchorDate}`)
  }
  let year = Number(match[1])
  let month0 = Number(match[2]) - 1
  // The regex only shapes the string; reject calendar-invalid anchors like
  // 2026-13-05 or 2026-02-31 instead of silently normalizing them.
  const anchorDay = Number(match[3])
  if (month0 < 0 || month0 > 11 || anchorDay < 1 || anchorDay > lastDayOfMonth(year, month0)) {
    throw new Error(`invalid anchor date: ${anchorDate}`)
  }
  const todayIso = todayIsoStockholm(today)
  let candidate = isoFromParts(year, month0, Math.min(dayOfMonth, lastDayOfMonth(year, month0)))
  while (allowToday ? candidate < todayIso : candidate <= todayIso) {
    const m = month0 + intervalMonths
    year += Math.floor(m / 12)
    month0 = m % 12
    candidate = isoFromParts(year, month0, Math.min(dayOfMonth, lastDayOfMonth(year, month0)))
  }
  return candidate
}

/**
 * Compute the initial next_run_date when a schedule is created: start_date
 * when given, otherwise the first occurrence of day_of_month on or after
 * today (firstRunDateOnOrAfter, the rule the dialog prefills with). "Today"
 * is Stockholm's calendar day for the instant `now`, the same day the
 * start_date validation uses; reading the UTC day instead would pick
 * yesterday's occurrence between midnight and 02:00 Swedish time.
 */
export function computeInitialRunDate(
  now: Date,
  dayOfMonth: number,
  startDate?: string,
): string {
  if (startDate) return startDate
  return firstRunDateOnOrAfter(getStockholmDateHour(now).date, dayOfMonth)
}

export interface ExecuteScheduleOptions {
  /**
   * Defence-in-depth sandbox suppression (ASVS V2.3): callers that resolved
   * `isSandboxCompany` at the route level pass true to skip the auto-send
   * path outright, so the sandbox invariant does not hinge solely on the
   * chokepoint inside sendInvoiceFromSchedule. Freeze-and-retain semantics
   * are unchanged: the invoice is still created as an (unnumbered) draft.
   */
  suppressAutoSend?: boolean
  /**
   * Called once the invoice exists (header and lines), before the auto-send:
   * the caller records the invoice on the schedule here (last_invoice_id and
   * whatever else its run advances). The send is the slow part of a run
   * (number, PDF, verifikat, email), so a run that is killed during it would
   * otherwise leave a schedule that knows nothing of its invoice: the next
   * day's roll reported "no invoice was created" and the next run billed the
   * same period again.
   *
   * An error does not prove the write failed: a timeout or a dropped
   * connection can hide one that landed, or one still on its way. So the
   * draft is removed only when the hook throws RecurringRecordNotLandedError,
   * the caller's word that its record did not land and now never will (it
   * holds the schedule); the hook's error is rethrown only once the removal
   * is confirmed, and the caller may then give the run back. Any other error,
   * or a removal that is not confirmed, keeps the draft and is thrown as
   * RecurringInvoiceKeptError: removing it could leave a schedule moved on to
   * its next period with no invoice for this one, and giving the run back
   * beside a draft would bill the period twice. After the record, a failure
   * is thrown as RecurringInvoiceKeptError as well: the invoice is in place
   * and the caller must not retry the run.
   */
  onInvoiceCreated?: (invoiceId: string) => Promise<void>
}

/**
 * Thrown by an onInvoiceCreated hook whose record certainly did not land and
 * can no longer land: the run's draft is removed, and nothing points at it.
 * `heldAt` is the hold the hook left on the schedule (holdRecurringScheduleRun),
 * which the caller gives back once the removal is confirmed.
 */
export class RecurringRecordNotLandedError extends Error {
  constructor(
    public readonly invoiceId: string,
    reason: string,
    public readonly heldAt: string | null = null,
  ) {
    super(reason)
    this.name = 'RecurringRecordNotLandedError'
  }
}

/**
 * The run failed with its invoice still in place, or possibly in place (a
 * header INSERT that answered an error may have landed); only thrown for a
 * caller that records through onInvoiceCreated. The caller keeps its claim,
 * so no second invoice is created for the run, and tells the user to look at
 * the invoice.
 */
export class RecurringInvoiceKeptError extends Error {
  constructor(
    public readonly invoiceId: string,
    public readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason))
    this.name = 'RecurringInvoiceKeptError'
  }
}

/**
 * A failure that may leave a draft behind (one the run could not remove, or
 * a header INSERT whose answer was an error): for a caller that records
 * through onInvoiceCreated (the cron, which holds the schedule on
 * RecurringInvoiceKeptError instead of retrying beside the draft), kept; for
 * any other caller, the failure as it is.
 */
function keptOrPlain(options: ExecuteScheduleOptions, invoiceId: string, failure: Error): Error {
  return options.onInvoiceCreated ? new RecurringInvoiceKeptError(invoiceId, failure) : failure
}

/**
 * Remove a draft this run created and cannot use. Only ever an unnumbered
 * draft: the filter is the guard, so an invoice that has a number or has left
 * draft is never deleted from here. Its lines go with it (invoice_items
 * cascades) and no F-series number was taken. Answers whether the draft is
 * confirmed gone; one that could not be removed (or whose removal answered an
 * error) is logged as an error.
 */
async function removeUnnumberedDraft(
  supabase: SupabaseClient,
  opLog: Logger,
  invoiceId: string,
  why: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('invoices')
    .delete()
    .eq('id', invoiceId)
    .is('invoice_number', null)
    .eq('status', 'draft')
    .select('id')
  const removed = !error && Array.isArray(data) && data.length > 0
  if (!removed) {
    opLog.error(
      'recurring draft could not be removed; a retry of the run creates a second draft beside it',
      new Error(error?.message ?? 'no unnumbered draft matched the delete'),
      { invoiceId, why },
    )
  }
  return removed
}

/**
 * Spawn one invoice from a schedule. Always creates the invoice as an
 * unnumbered draft, exactly like "Spara som utkast": the F-series number is
 * taken when the draft is issued (finalize, send, mark-sent, Peppol), so a
 * draft removed before that is hard-deleted and leaves no gap (ML 17 kap.
 * 24 § p. 2, crm#1285). auto_send additionally numbers, renders, issues
 * (status sent + verifikat, fail closed), then emails and archives the PDF.
 * A verifikat the engine refuses stops the send and comes back as the
 * warning the schedule shows.
 *
 * Idempotency: caller must check schedule.last_run_at >= today before calling
 * to prevent double-spawn on cron retries within the same Stockholm day.
 */
export async function executeRecurringSchedule(
  supabase: SupabaseClient,
  schedule: RecurringInvoiceSchedule & { items: RecurringInvoiceScheduleItem[] },
  today: Date = new Date(),
  options: ExecuteScheduleOptions = {},
): Promise<ExecuteResult> {
  const opLog = log.child({ scheduleId: schedule.id, companyId: schedule.company_id })

  // 1. Load customer to resolve VAT rules.
  const { data: customer, error: customerErr } = await supabase
    .from('customers')
    .select('*')
    .eq('id', schedule.customer_id)
    .eq('company_id', schedule.company_id)
    .single<Customer>()

  if (customerErr || !customer) {
    throw new Error(`customer not found for schedule ${schedule.id}`)
  }

  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated, customer.country)
  // A stored rate that is not a Swedish rate this customer may lawfully carry
  // (getPermittedVatRates, the set buildInvoiceWriteData gates on) refuses the
  // run, as before.
  const permittedRates = getPermittedVatRates(customer.customer_type, customer.vat_number_validated, customer.country)
  const allowedRates = new Set(permittedRates.map((r) => r.rate))
  // The line's rate follows the customer's VAT treatment, by the invoice
  // editor's rule (components/invoices/line-vat-rates.ts): a stored rate is
  // adopted only when it is in the customer's DEFAULT set
  // (getArticleVatRateAdoptionSet), otherwise the customer's default applies.
  // The schedule dialog never asked for a rate (it stored 25 on every line),
  // so a stored rate is a prefill, not a choice: under huvudregeln (ML 6 kap.
  // 33 §) a service to a foreign business is taxed where the buyer is
  // established, and a stored 25 must not put Swedish VAT under an export
  // (ruta 40) or reverse-charge header (crm#1285). A domestic customer's
  // default set holds 25/12/6/0, so its stored rates are kept as they are.
  const adoptableRates = getArticleVatRateAdoptionSet(customer.customer_type, customer.vat_number_validated, customer.country)
  // A line picked from the artikelregister (accounted#52) becomes an invoice
  // line with that article, as the invoice editor writes one: the article's
  // number and revenue account are copied when this invoice is created, and a
  // line without a rate of its own takes the article's rate under the same
  // adoption rule. The read is company-scoped, so a link to another
  // company's article, or one deleted since, leaves the line unlinked.
  const articles = await loadScheduleArticles(supabase, schedule.company_id, schedule.items || [])
  // The article accounts buildInvoiceWriteData would accept on a hand-written
  // line: active class 1-3 accounts of this company (a balance-sheet account
  // only on a 0 % line, checked per line below). Read before anything is
  // written, so a failed read leaves no half-made invoice.
  const validRevenueAccounts = await loadActivePostingAccounts(
    supabase,
    schedule.company_id,
    Array.from(articles.values()).map((a) => a.revenue_account).filter((a): a is string => !!a),
  )
  const articleOf = (item: RecurringInvoiceScheduleItem): ScheduleArticle | undefined =>
    item.article_id ? articles.get(item.article_id) : undefined
  const lineRate = (item: RecurringInvoiceScheduleItem): number => {
    const stored = item.vat_rate ?? articleOf(item)?.vat_rate ?? null
    return stored != null && adoptableRates.has(stored) ? stored : vatRules.rate
  }

  // 2. Compute amounts (mirrors POST /api/invoices). Text rows carry no
  //    amounts and never book: they are copied onto the invoice as text rows
  //    but stay out of totals, VAT and the rate gate below.
  const allItems = (schedule.items || []).slice().sort((a, b) => a.sort_order - b.sort_order)
  const items = allItems.filter((item) => !isTextLine(item))
  if (items.length === 0) {
    throw new Error(`schedule ${schedule.id} has no billable items`)
  }

  // VAT registration gate, mirroring buildInvoiceWriteData (issue #1719): a
  // non-momsregistrerad company books no output VAT, so the spawned invoice
  // must be momsfri regardless of what the schedule template says. Both a
  // stored template rate (older lines carry the dialog's former 25% default,
  // and schedules may predate a deregistration) and the null-rate fallback to the
  // customer default below (25% for Swedish customers) would otherwise put
  // VAT on the cron-generated invoice even though momskrysset is off. Zero
  // every line at spawn time; 0% is a permitted rate for every customer type,
  // so the allowedRates gate below still passes.
  const { data: vatSettings, error: vatSettingsError } = await supabase
    .from('company_settings')
    .select('vat_registered')
    .eq('company_id', schedule.company_id)
    .maybeSingle()
  // A failed read must not read as "registered": the invoice would carry VAT
  // the company may not charge, and with auto_send it is issued and mailed.
  if (vatSettingsError) throw new Error(`VAT registration read failed: ${vatSettingsError.message}`)
  const notVatRegistered = vatSettings?.vat_registered === false
  if (notVatRegistered) {
    for (const item of items) item.vat_rate = 0
  }

  // Öre-exact amounts, the rule buildInvoiceWriteData applies: each line net
  // is computeLineNet (whole öre) and the header sums are rounded.
  const subtotal = roundOre(items.reduce((sum, it) => sum + computeLineNet(it.quantity, it.unit_price), 0))
  let vatAmount = 0
  for (const item of items) {
    if (item.vat_rate != null && !allowedRates.has(item.vat_rate)) {
      throw new Error(
        `VAT rate ${item.vat_rate}% not allowed for customer type ${customer.customer_type}`,
      )
    }
    const itemRate = lineRate(item)
    const lineTotal = computeLineNet(item.quantity, item.unit_price)
    vatAmount = roundOre(vatAmount + computeLineVat(lineTotal, itemRate))
  }
  const total = roundOre(subtotal + vatAmount)

  const uniqueRates = new Set(items.map(lineRate))
  const isMixedRate = uniqueRates.size > 1

  // 3. Dates: invoice_date = Stockholm's calendar day of `today` (the real
  //    instant of the run), due_date = +payment_terms_days. The UTC day lags
  //    it until 01:00/02:00, so a run at 00:30 on the 1st would date the
  //    invoice, its verifikat and {månad} in the previous month (#58).
  const invoiceDate = todayIsoStockholm(today)
  //    A consumer's invoice is due within 50 days and carries no invoice fee
  //    (konsumentkreditlagen 2026:1011, lib/invoices/consumer-credit).
  const dueDate = invoiceDueDate(
    invoiceDate,
    consumerInvoiceTerms(schedule.payment_terms_days, customer.customer_type, invoiceDate),
  )
  if (consumerCreditApplies(customer.customer_type, invoiceDate) && items.some(isInvoiceFeeLine)) {
    throw new Error('invoice fee line not allowed on an invoice to a private person (konsumentkreditlagen)')
  }

  // Placeholders ({månad}, {år}, {periodstart} ...) resolve against the
  // invoice date and the schedule's current period; month names follow the
  // customer's invoice language. The schedule text itself is never rewritten.
  const placeholderValues = buildRecurringPlaceholderValues({
    runDate: invoiceDate,
    periodStart: schedule.period_start ?? null,
    intervalMonths: schedule.interval_months ?? 1,
    lang: customer.language === 'en' ? 'en' : 'sv',
  })

  // 4. Foreign currency: fetch exchange rate.
  let exchangeRate: number | null = null
  let exchangeRateDate: string | null = null
  let subtotalSek: number | null = null
  let vatAmountSek: number | null = null
  let totalSek: number | null = null
  if (schedule.currency !== 'SEK') {
    // Same call shape as buildInvoiceWriteData: the date anchors the rate on
    // the invoice date (the taxable event for a schedule-spawned invoice), and
    // the supabase client routes the lookup through the shared exchange_rates
    // cache on BOTH legs (read-through before Riksbanken, last-cached-
    // observation fallback when Riksbanken 429s). Without them a transient
    // rate limit left every cron-generated foreign invoice with a permanently
    // NULL exchange_rate. A null rate still only skips the SEK columns: the
    // cron deliberately does not fail closed here.
    const rateData = await fetchExchangeRate(schedule.currency, new Date(invoiceDate), supabase)
    if (rateData) {
      exchangeRate = rateData.rate
      exchangeRateDate = rateData.date
      subtotalSek = sekOfForeign(subtotal, exchangeRate)
      vatAmountSek = sekOfForeign(vatAmount, exchangeRate)
      totalSek = sekOfForeign(total, exchangeRate)
    }
  }

  // 5. Insert invoice header, under an id this run generates. An error answer
  //    to the INSERT does not prove the row is absent: postgrest-js answers a
  //    502/504 or a reset connection as an error and does not retry a POST,
  //    so the row may have landed (accounted#211). The id names the draft the
  //    run may have left, and a caller that records (the cron) keeps the run
  //    held for a person instead of giving it back beside that draft.
  const invoiceId = crypto.randomUUID()
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      id: invoiceId,
      user_id: schedule.user_id,
      company_id: schedule.company_id,
      customer_id: schedule.customer_id,
      invoice_number: null,
      invoice_date: invoiceDate,
      due_date: dueDate,
      delivery_date: null,
      currency: schedule.currency,
      exchange_rate: exchangeRate,
      exchange_rate_date: exchangeRateDate,
      subtotal,
      subtotal_sek: subtotalSek,
      vat_amount: vatAmount,
      vat_amount_sek: vatAmountSek,
      total,
      total_sek: totalSek,
      remaining_amount: total,
      // Header VAT fields mirror buildInvoiceWriteData: a not-VAT-registered
      // company stamps the sale as momsfri (treatment 'exempt', no ruta, no
      // reverse-charge notation); every line rate is already zeroed above.
      vat_treatment: notVatRegistered ? 'exempt' : vatRules.treatment,
      vat_rate: isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate),
      moms_ruta: notVatRegistered ? null : vatRules.momsRuta,
      reverse_charge_text: notVatRegistered ? null : (vatRules.reverseChargeText || null),
      // The schedule's Er referens, else the card's Fakturareferens as it is
      // today (crm#1200), so a change to the card reaches the next invoice.
      your_reference: yourReferenceForNewInvoice(schedule.your_reference, customer),
      our_reference: schedule.our_reference,
      // A schedule has no Märkning of its own: the card's as it is today
      // (crm#1477).
      invoice_marking: customerInvoiceMarking(customer),
      notes: applyRecurringPlaceholders(schedule.notes, placeholderValues),
      // Carried verbatim so cron-spawned invoices book with the same
      // dimension tags a manually created invoice would (PR7 propagation
      // in lib/bookkeeping/invoice-entries.ts reads these columns).
      default_dimensions: schedule.default_dimensions ?? {},
      document_type: 'invoice',
    })
    .select()
    .single()

  if (invoiceError || !invoice) {
    // Kept for a caller that records: given back, the next run would create a
    // second draft for the period beside this one, if it landed. Any other
    // caller (a person who clicked "Skapa faktura nu" and reads the answer)
    // gets the failure as it is.
    throw keptOrPlain(options, invoiceId, new Error(`failed to insert invoice from schedule: ${invoiceError?.message ?? 'unknown'}`))
  }

  // 6. Insert items. An article's revenue account is used only where
  //    buildInvoiceWriteData would accept it on a hand-written line (see
  //    validRevenueAccounts above); otherwise the line books by VAT treatment,
  //    as every recurring line did before article links.
  const itemRows = allItems.map((item, index) => {
    const description = applyRecurringPlaceholders(item.description, placeholderValues)
    if (isTextLine(item)) {
      // Same shape as a manually added text row (build-invoice-write.ts):
      // description only, every amount zero, never booked.
      return {
        invoice_id: invoice.id,
        sort_order: index,
        line_type: 'text' as const,
        description,
        quantity: 0,
        unit: '',
        unit_price: 0,
        line_total: 0,
        vat_rate: 0,
        vat_amount: 0,
        dimensions: {},
        article_id: null,
        article_number: null,
        revenue_account: null,
      }
    }
    const itemRate = lineRate(item)
    const lineTotal = computeLineNet(item.quantity, item.unit_price)
    const itemVat = computeLineVat(lineTotal, itemRate)
    const article = articleOf(item)
    const articleAccount = article?.revenue_account ?? null
    const revenueAccount =
      articleAccount
      && validRevenueAccounts.has(articleAccount)
      && !(isBalanceSheetAccount(articleAccount) && itemRate > 0)
        ? articleAccount
        : null
    return {
      invoice_id: invoice.id,
      sort_order: index,
      line_type: 'product' as const,
      description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: lineTotal,
      vat_rate: itemRate,
      vat_amount: itemVat,
      dimensions: item.dimensions ?? {},
      article_id: article?.id ?? null,
      article_number: article?.article_number?.trim() || null,
      revenue_account: revenueAccount,
    }
  })
  const { error: itemsError } = await supabase.from('invoice_items').insert(itemRows)
  if (itemsError) {
    // Hard-delete is safe: the draft is unnumbered (step 5 inserted
    // invoice_number: null), so no F-series slot has been consumed.
    const failure = new Error(`failed to insert invoice items: ${itemsError.message}`)
    if (await removeUnnumberedDraft(supabase, opLog, invoice.id, 'its lines could not be inserted')) throw failure
    throw keptOrPlain(options, invoice.id, failure)
  }

  // 7. No number here. The draft stays unnumbered until it is issued, the
  //    lifecycle of a "Spara som utkast" draft: finalize, send, mark-sent and
  //    Peppol each take the number (ensureInvoiceNumber), and the auto-send
  //    path below takes it after its guards. A draft removed before then is
  //    hard-deleted with no gap in the series (crm#1285). invoice.created,
  //    which drives webhooks and the audit log, follows the number too: it
  //    fires at finalize, or in the auto-send path once the number is taken.

  // 8. Re-fetch with relations so downstream PDF/email/event have full data.
  const { data: completeInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .single()

  if (!completeInvoice) {
    // The run stops here and its caller releases the claim, so the next run
    // creates the invoice again: this draft must not stay beside that one.
    const failure = new Error('failed to reload created invoice')
    if (await removeUnnumberedDraft(supabase, opLog, invoice.id, 'it could not be reloaded')) throw failure
    throw keptOrPlain(options, invoice.id, failure)
  }

  // The invoice exists from here on: let the caller record it before the
  // send (see ExecuteScheduleOptions.onInvoiceCreated for what a hook that
  // throws leads to).
  let recordedByCaller = false
  if (options.onInvoiceCreated) {
    try {
      await options.onInvoiceCreated(invoice.id)
    } catch (err) {
      if (err instanceof RecurringRecordNotLandedError) {
        if (await removeUnnumberedDraft(supabase, opLog, invoice.id, 'the schedule did not record it')) throw err
        // Not confirmed gone: kept, so the caller keeps the schedule held.
        throw new RecurringInvoiceKeptError(invoice.id, err)
      }
      // The caller reports it (the cron as an error, with the schedule).
      opLog.warn('recurring invoice kept: its record on the schedule is not confirmed', {
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : String(err),
      })
      throw new RecurringInvoiceKeptError(invoice.id, err)
    }
    recordedByCaller = true
  }

  let autoSent = false
  let warning: string | null = null

  try {
    // 9. Auto-send path. If anything below fails, we keep the invoice (an
    //    unnumbered draft when it stopped before numbering, a numbered draft
    //    after, or issued and booked when only the email failed) and surface a
    //    Swedish warning on the schedule (last_run_warning): the user can act
    //    on it from /invoices/[id].
    if (schedule.auto_send && options.suppressAutoSend) {
      // Route-level sandbox suppression: same outcome as the internal sandbox
      // chokepoint below (no email, invoice retained as draft, manual-send
      // warning), reached without entering the send path at all.
      opLog.warn('auto-send suppressed by route-level sandbox guard', {
        invoiceId: invoice.id,
      })
      warning = MANUAL_SEND_WARNING
    } else if (schedule.auto_send) {
      try {
        const outcome = await sendInvoiceFromSchedule(
          supabase,
          schedule.company_id,
          schedule.user_id,
          completeInvoice as Invoice & { customer: Customer; items: InvoiceItem[] },
        )
        autoSent = outcome.sent
        warning = outcome.warning ?? (outcome.sent ? null : MANUAL_SEND_WARNING)
      } catch (err) {
        opLog.error('auto-send failed for recurring schedule', err as Error, {
          invoiceId: invoice.id,
        })
        warning = `Auto-utskick misslyckades: ${err instanceof Error ? err.message : 'okänt fel'}`
      }
    }

    await eventBus.emit({
      type: 'recurring_invoice.executed',
      payload: {
        scheduleId: schedule.id,
        invoice: completeInvoice as Invoice,
        autoSent,
        warning,
        companyId: schedule.company_id,
        userId: schedule.user_id,
      },
    })
  } catch (err) {
    // The invoice is in place and, for a caller that recorded it, the
    // schedule has moved on: not a run to retry.
    if (recordedByCaller) throw new RecurringInvoiceKeptError(invoice.id, err)
    throw err
  }

  return {
    invoiceId: invoice.id,
    invoiceNumber: (completeInvoice as Invoice).invoice_number,
    autoSent,
    warning,
  }
}

interface ScheduleArticle {
  id: string
  article_number: string | null
  revenue_account: string | null
  vat_rate: number | null
}

/** This company's articles linked from the schedule's product lines, by id. */
async function loadScheduleArticles(
  supabase: SupabaseClient,
  companyId: string,
  items: RecurringInvoiceScheduleItem[],
): Promise<Map<string, ScheduleArticle>> {
  const ids = Array.from(
    new Set(
      items
        .filter((item) => !isTextLine(item))
        .map((item) => item.article_id)
        .filter((id): id is string => !!id),
    ),
  )
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase
    .from('articles')
    .select('id, article_number, revenue_account, vat_rate')
    .eq('company_id', companyId)
    .in('id', ids)
  // A failed read must not quietly book linked lines by VAT treatment.
  if (error) throw new Error(`article read failed: ${error.message}`)
  return new Map(((data ?? []) as ScheduleArticle[]).map((row) => [row.id, row]))
}

/** The given accounts that are active class 1-3 accounts in the company's chart. */
async function loadActivePostingAccounts(
  supabase: SupabaseClient,
  companyId: string,
  accounts: string[],
): Promise<Set<string>> {
  const unique = Array.from(new Set(accounts))
  if (unique.length === 0) return new Set()
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .gte('account_class', 1)
    .lte('account_class', 3)
    .eq('is_active', true)
    .in('account_number', unique)
  if (error) throw new Error(`chart of accounts read failed: ${error.message}`)
  return new Set(((data ?? []) as Array<{ account_number: string }>).map((row) => row.account_number))
}

/**
 * Render the PDF, issue the invoice (status sent + verifikat, fail closed),
 * then email it. Mirrors /api/invoices/[id]/send/route.ts but inline so we
 * don't depend on the route's auth chain.
 *
 * The invoice is issued and booked BEFORE the email leaves, through the same
 * markInvoiceSentAndBook the send route and mark-sent use: a verifikat the
 * engine refuses (a required dimension on the revenue account, a schedule tag
 * whose value has since been archived) stops the send with the invoice back
 * as a draft, and the refusal reaches the schedule's warning so the user can
 * fix the tag. The customer never holds an invoice the ledger does not have.
 * An email that fails after a verifikat was posted leaves the invoice issued
 * and booked (a posted verifikat is never undone), exactly as after
 * mark-sent: the warning says to deliver it by hand. With nothing booked
 * (kontantmetoden, deferred booking) the draft is put back instead.
 */
async function sendInvoiceFromSchedule(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice & { customer: Customer; items: InvoiceItem[] },
): Promise<AutoSendOutcome> {
  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('email service not configured; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
    })
    return { sent: false }
  }
  // The sandbox must never deliver a real email to a real address. The
  // interactive send routes enforce this with guardSandbox, but cron and
  // run-now reach this function without any route-level guard, so the
  // invariant is enforced here at the email chokepoint. Freeze-and-retain
  // like the paywall path below: the invoice is still generated as a draft.
  if (await isSandboxCompany(supabase, companyId)) {
    log.warn('sandbox company; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      companyId,
    })
    return { sent: false }
  }
  // Paywall: email sending is a paid capability. The invoice itself is still
  // created (bookkeeping stays free); it just isn't emailed, and the schedule
  // surfaces the standard manual-send warning (freeze-and-retain).
  if (!(await hasCapability(supabase, companyId, CAPABILITY.email_send))) {
    log.warn('company lacks email_send capability; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      companyId,
    })
    return { sent: false }
  }
  if (!invoice.customer.email?.trim()) {
    log.warn('customer has no email; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      customerId: invoice.customer.id,
    })
    return { sent: false }
  }

  const { data: company } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single<CompanySettings>()

  if (!company) {
    throw new Error('company settings missing: cannot send invoice')
  }
  const payeeSnapshot = await snapshotInvoicePayee(supabase, companyId, invoice)
  if (!payeeSnapshot.ok) {
    log.warn('chosen payee account is no longer usable; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      ...payeeSnapshot.details,
    })
    return { sent: false }
  }
  invoice.payment_details = payeeSnapshot.payee
  const refused = issuable(invoice, company)
  if (refused) {
    log.warn('recurring schedule cannot auto-send', { invoiceId: invoice.id, code: refused.code, ...refused.details })
    return { sent: false }
  }
  const recipients = resolveInvoiceEmailRecipients({
    to: invoice.customer.email,
    configuredCc: company.invoice_email_cc_addresses,
    configuredBcc: company.invoice_email_bcc_addresses,
    customerCc: invoice.customer.invoice_email_cc_addresses,
    customerBcc: invoice.customer.invoice_email_bcc_addresses,
  })
  if (exceedsInvoiceEmailRecipientLimit(recipients)) {
    log.warn('invoice has too many email recipients; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      recipientCount: invoiceEmailRecipientCount(recipients),
    })
    return { sent: false }
  }
  let deliveryId: string
  try {
    deliveryId = await reserveInvoiceDelivery({
      supabase,
      companyId,
      userId,
      invoiceId: invoice.id,
    })
  } catch (err) {
    log.error('failed to reserve recurring invoice delivery', err as Error, {
      invoiceId: invoice.id,
      companyId,
    })
    return { sent: false }
  }

  // The F-series number is taken here, at the point the send route takes it
  // (after the delivery reservation, before the payment link, PDF and email
  // that print it): every stop above leaves an unnumbered draft that can be
  // deleted with no gap (crm#1285). Mutates invoice.invoice_number.
  try {
    await ensureInvoiceNumber(supabase, companyId, invoice)
  } catch (err) {
    log.error('failed to assign invoice number for recurring auto-send', err as Error, {
      invoiceId: invoice.id,
    })
    // The series refusal used up nothing and is a sentence the company can
    // act on: it names where the series continues.
    return {
      sent: false,
      ...(err instanceof InvoiceNumberSeriesBehindError
        ? { warning: `${MANUAL_SEND_WARNING} ${err.message}` }
        : {}),
    }
  }
  // Numbered from here on: invoice.created, the event that drives webhooks
  // and the audit log, fires now, as it does at finalize.
  await eventBus.emit({
    type: 'invoice.created',
    payload: { invoice, companyId, userId },
  })

  const items = (invoice.items || []).slice().sort((a, b) => a.sort_order - b.sort_order)

  // Auto-create an online payment link (extension-provided, e.g. Stripe) so
  // the email button and PDF QR carry it: parity with the manual and v1 send
  // routes. Best-effort: the faktura is legally valid without a link, so a
  // failure only logs and the send proceeds. On success the helper mirrors
  // payment_link_url onto this invoice object, which the email template and
  // QR builder below read.
  const { failure: paymentLinkFailure } = await applyPaymentLinkToInvoice(
    supabase,
    companyId,
    userId,
    invoice,
    log,
  )
  if (paymentLinkFailure) {
    log.warn('payment link creation failed for recurring invoice; sending without it', {
      invoiceId: invoice.id,
      reason: paymentLinkFailure,
    })
  }

  // Render PDF with status overridden to 'sent' so the customer doesn't
  // receive a "UTKAST" stamp.
  const renderableInvoice = { ...invoice, status: 'sent' as const }
  const { buffer: pdfBuffer } = await renderInvoicePdfBuffer({
    invoice: renderableInvoice,
    customer: invoice.customer,
    items,
    company,
    // A recurring run only ever produces real invoices: always a payee.
    paymentAccountRequired: true,
  })

  // Issue before the email leaves: status sent + the verifikat, fail closed.
  // Everything that could stop the send without issuing (settings, payee,
  // recipients, the delivery reservation, the PDF render) has run above.
  const issueLog = log.child({ invoiceId: invoice.id })
  const issued = await markInvoiceSentAndBook({
    supabase,
    companyId,
    userId,
    invoice,
    settings: company,
    log: issueLog,
  })
  const label = invoice.invoice_number ?? ''
  if (!issued.ok) {
    if (issued.errorCode === 'INVOICE_MARK_SENT_BOOK_FAILED') {
      log.warn('recurring invoice not sent: its verifikat was refused', {
        invoiceId: invoice.id,
        reason: issued.reason,
      })
      const reason = issued.reason ? ` ${issued.reason}` : ''
      return {
        sent: false,
        warning: `Auto-utskick stoppades: faktura ${label} kunde inte bokföras och har inte skickats till kunden.${reason} Fakturan ligger kvar som utkast: åtgärda orsaken (i schemat om den kommer därifrån) och skicka fakturan manuellt.`,
      }
    }
    log.warn('recurring invoice not sent: the status could not be set to sent', {
      invoiceId: invoice.id,
      errorCode: issued.errorCode,
    })
    return { sent: false }
  }
  const { journalEntryId } = issued
  const followUpWarnings = issued.partialFailures.map((failure) => failure.reason)

  // Cron send: no user to fall back to for Reply-To.
  const replyTo = resolveInvoiceReplyTo(company)
  const emailData = { invoice: renderableInvoice, customer: invoice.customer, company, replyTo }
  const filename = invoicePdfFilename({
    companyName: company.company_name,
    customerName: invoice.customer.name,
    invoiceNumber: invoice.invoice_number,
    invoiceId: invoice.id,
    invoiceDate: invoice.invoice_date,
    documentType: invoice.document_type,
  })
  const subject = generateInvoiceEmailSubject(emailData)
  const html = generateInvoiceEmailHtml(emailData)
  const text = generateInvoiceEmailText(emailData)
  let result: Awaited<ReturnType<typeof sendTrackedInvoiceEmail>> | null = null
  try {
    result = await sendTrackedInvoiceEmail({
      supabase,
      emailService,
      companyId,
      userId,
      invoiceId: invoice.id,
      deliveryId,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject,
      html,
      text,
      replyTo,
      fromName: company.company_name ?? undefined,
      from: await resolveInvoiceSender(supabase, companyId, company.company_name),
      filename,
      pdfBuffer,
    })
  } catch (err) {
    log.error('failed to persist recurring invoice delivery before send', err as Error, {
      invoiceId: invoice.id,
    })
  }

  if (result?.trackingWarning) {
    log.error(
      'recurring invoice delivery snapshot requires reconciliation',
      new Error(result.trackingWarning),
      { invoiceId: invoice.id, deliveryId: result.deliveryId },
    )
  }

  if (!result?.success) {
    if (result) {
      log.error(
        'email provider failed in recurring schedule auto-send',
        new Error(result.error || 'unknown'),
        { invoiceId: invoice.id },
      )
    }
    // Nothing booked (kontantmetoden, deferred booking): nothing irreversible
    // happened, so the draft is put back and the invoice can be sent by hand
    // exactly as before.
    if (!journalEntryId && (await restoreUnbookedDraft(supabase, companyId, invoice.id, issueLog))) {
      return { sent: false }
    }
    // Issued and booked but not delivered: finish it the way mark-sent
    // does, underlag archived on the verifikat, so the invoice is complete
    // for whoever delivers it by hand.
    const archiveFailure = await archiveIssuedInvoicePdf({
      supabase,
      companyId,
      userId,
      invoice,
      settings: company,
      journalEntryId,
      log: issueLog,
    })
    if (archiveFailure) followUpWarnings.push(archiveFailure.reason)
    await eventBus.emit({
      type: 'invoice.sent',
      payload: { invoice: { ...invoice, status: 'sent' }, companyId, userId },
    })
    return {
      sent: false,
      warning: [
        `Faktura ${label} är utfärdad${journalEntryId ? ' och bokförd' : ''} men e-postmeddelandet kunde inte skickas. Ladda ned fakturan och skicka den till kunden.`,
        ...followUpWarnings,
      ].join(' '),
    }
  }

  if (journalEntryId) {
    try {
      // The generated PDF of this invoice on the invoice's own verifikat.
      await linkToJournalEntry(supabase, companyId, result.documentId, journalEntryId, linkBasisColumns('system_derived'))
    } catch (err) {
      log.error('failed to link recurring invoice PDF to journal entry', err as Error, {
        invoiceId: invoice.id,
        documentId: result.documentId,
      })
      followUpWarnings.push('Fakturans arkiverade PDF kunde inte kopplas till verifikationen.')
    }
  }

  await eventBus.emit({
    type: 'invoice.sent',
    payload: { invoice: { ...invoice, status: 'sent' }, companyId, userId },
  })

  return followUpWarnings.length > 0
    ? { sent: true, warning: `Fakturan skickades, men: ${followUpWarnings.join(' ')}` }
    : { sent: true }
}
