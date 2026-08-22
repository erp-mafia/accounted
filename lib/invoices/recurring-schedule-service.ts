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
import { getVatRules, getPermittedVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import {
  prepareInvoicePdfRender,
  buildSwishQrDataUrl,
  buildPaymentLinkQrDataUrl,
} from '@/lib/invoices/pdf-render-helpers'
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
} from '@/lib/invoices/email-recipients'
import {
  hasRequiredInvoicePaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { createLogger } from '@/lib/logger'
import type {
  Invoice,
  InvoiceItem,
  Customer,
  CompanySettings,
  RecurringInvoiceSchedule,
  RecurringInvoiceScheduleItem,
} from '@/types'

const log = createLogger('invoices/recurring-schedule-service')

export interface ExecuteResult {
  invoiceId: string
  invoiceNumber: string | null
  autoSent: boolean
  warning: string | null
}

/**
 * Last day of the month for the given year/month (1-indexed month).
 * Used to clamp day_of_month values >28 in shorter months.
 */
function lastDayOfMonth(year: number, monthIndex0: number): number {
  // Day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate()
}

function isoFromParts(year: number, monthIndex0: number, day: number): string {
  const yyyy = year.toString().padStart(4, '0')
  const mm = (monthIndex0 + 1).toString().padStart(2, '0')
  const dd = day.toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
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
  const todayIso = isoFromParts(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
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
 * Compute the initial next_run_date when a schedule is created.
 * - If start_date is given, use it.
 * - Else, if today's day-of-month <= schedule day_of_month (clamped to this
 *   month's last day), pick this month's occurrence.
 * - Otherwise pick next month's occurrence.
 */
export function computeInitialRunDate(
  today: Date,
  dayOfMonth: number,
  startDate?: string,
): string {
  if (startDate) return startDate
  if (dayOfMonth < 1 || dayOfMonth > 31) {
    throw new Error(`invalid day_of_month: ${dayOfMonth}`)
  }
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth()
  const todayDay = today.getUTCDate()
  const thisMonthDay = Math.min(dayOfMonth, lastDayOfMonth(y, m))
  if (todayDay <= thisMonthDay) {
    const yyyy = y.toString().padStart(4, '0')
    const mm = (m + 1).toString().padStart(2, '0')
    const dd = thisMonthDay.toString().padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
  return computeNextRunDate(today, dayOfMonth)
}

/**
 * Resolve the calendar date (yyyy-mm-dd) and hour (0-23) in Europe/Stockholm
 * for a given instant. The recurring cron runs in UTC on Vercel, but users
 * pick a send time in Swedish local time, so we need "what day and hour is it
 * in Sweden right now". Uses Intl (DST-aware, no extra dependency); en-CA +
 * hourCycle 'h23' guarantees zero-padded ISO-shaped parts and a 0-23 hour.
 */
export function getStockholmDateHour(instant: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  }
}

export interface ExecuteScheduleOptions {
  /**
   * Defence-in-depth sandbox suppression (ASVS V2.3): callers that resolved
   * `isSandboxCompany` at the route level pass true to skip the auto-send
   * path outright, so the sandbox invariant does not hinge solely on the
   * chokepoint inside sendInvoiceFromSchedule. Freeze-and-retain semantics
   * are unchanged: the invoice is still created as a numbered draft.
   */
  suppressAutoSend?: boolean
}

/**
 * Spawn one invoice from a schedule. Always creates the invoice; auto_send
 * additionally renders + emails + flips status + creates JE + archives PDF.
 *
 * Idempotency: caller must check schedule.last_run_at >= today before calling
 * to prevent double-spawn on cron retries within the same UTC day.
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

  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
  // Gate on the PERMITTED set, not the picker default, exactly like
  // buildInvoiceWriteData: the ML 6 kap. supplies taxed where they are performed
  // (hotel/restaurang 12%, persontransport and event admission 6%,
  // fastighetstjänst and korttidsuthyrning 25%) carry Swedish VAT even to a
  // foreign business customer. A monthly hotel or catering retainer to a German
  // company is such a schedule. The default is still 0% (vatRules.rate is the
  // fallback below), so a Swedish rate only lands here when the schedule set it.
  const permittedRates = getPermittedVatRates(customer.customer_type, customer.vat_number_validated)
  const allowedRates = new Set(permittedRates.map((r) => r.rate))

  // 2. Compute amounts (mirrors POST /api/invoices).
  const items = (schedule.items || []).slice().sort((a, b) => a.sort_order - b.sort_order)
  if (items.length === 0) {
    throw new Error(`schedule ${schedule.id} has no items`)
  }

  const subtotal = items.reduce((sum, it) => sum + it.quantity * it.unit_price, 0)
  let vatAmount = 0
  for (const item of items) {
    const itemRate = item.vat_rate != null ? item.vat_rate : vatRules.rate
    if (!allowedRates.has(itemRate)) {
      throw new Error(
        `VAT rate ${itemRate}% not allowed for customer type ${customer.customer_type}`,
      )
    }
    const lineTotal = item.quantity * item.unit_price
    vatAmount += Math.round((lineTotal * itemRate) / 100 * 100) / 100
  }
  const total = subtotal + vatAmount

  const uniqueRates = new Set(items.map((it) => (it.vat_rate != null ? it.vat_rate : vatRules.rate)))
  const isMixedRate = uniqueRates.size > 1

  // 3. Dates: invoice_date = today (UTC), due_date = +payment_terms_days.
  const yyyy = today.getUTCFullYear().toString().padStart(4, '0')
  const mm = (today.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = today.getUTCDate().toString().padStart(2, '0')
  const invoiceDate = `${yyyy}-${mm}-${dd}`
  const due = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  due.setUTCDate(due.getUTCDate() + schedule.payment_terms_days)
  const dueDate = due.toISOString().slice(0, 10)

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
      subtotalSek = convertToSEK(subtotal, exchangeRate)
      vatAmountSek = convertToSEK(vatAmount, exchangeRate)
      totalSek = convertToSEK(total, exchangeRate)
    }
  }

  // 5. Insert invoice header.
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
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
      vat_treatment: vatRules.treatment,
      vat_rate: isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate),
      moms_ruta: vatRules.momsRuta,
      reverse_charge_text: vatRules.reverseChargeText || null,
      your_reference: schedule.your_reference,
      our_reference: schedule.our_reference,
      notes: schedule.notes,
      // Carried verbatim so cron-spawned invoices book with the same
      // dimension tags a manually created invoice would (PR7 propagation
      // in lib/bookkeeping/invoice-entries.ts reads these columns).
      default_dimensions: schedule.default_dimensions ?? {},
      document_type: 'invoice',
    })
    .select()
    .single()

  if (invoiceError || !invoice) {
    throw new Error(`failed to insert invoice from schedule: ${invoiceError?.message ?? 'unknown'}`)
  }

  // 6. Insert items.
  // NOTE (artikelregister Phase 2): recurring schedule template items have no
  // article_id / revenue_account columns (see recurring_invoice_schedule_items),
  // so generated invoices fall back to the VAT-treatment-derived revenue account.
  // Wiring per-article overrides into recurring invoices needs a schema change
  // and is deliberately out of the artikelregister MVP scope.
  const itemRows = items.map((item, index) => {
    const itemRate = item.vat_rate != null ? item.vat_rate : vatRules.rate
    const lineTotal = item.quantity * item.unit_price
    const itemVat = Math.round((lineTotal * itemRate) / 100 * 100) / 100
    return {
      invoice_id: invoice.id,
      sort_order: index,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: lineTotal,
      vat_rate: itemRate,
      vat_amount: itemVat,
      dimensions: item.dimensions ?? {},
    }
  })
  const { error: itemsError } = await supabase.from('invoice_items').insert(itemRows)
  if (itemsError) {
    // Hard-delete is safe here only because step 5 inserted invoice_number: null,
    // no F-series slot has been consumed yet (step 7 calls ensureInvoiceNumber).
    // Once a number is assigned, the soft-cancel path in step 7 must be used to
    // preserve the sequence per BFL 5 kap 6§ / ML 17 kap 24§.
    await supabase.from('invoices').delete().eq('id', invoice.id)
    throw new Error(`failed to insert invoice items: ${itemsError.message}`)
  }

  // 7. Allocate F-series number.
  try {
    await ensureInvoiceNumber(supabase, schedule.company_id, invoice as Invoice)
  } catch (err) {
    // Soft-cancel to preserve the F-series sequence (ML 17 kap 24§).
    await supabase
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('id', invoice.id)
      .eq('company_id', schedule.company_id)
      .eq('status', 'draft')
    throw new Error(
      `failed to assign invoice number: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 8. Re-fetch with relations so downstream PDF/email/event have full data.
  const { data: completeInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .single()

  if (!completeInvoice) {
    throw new Error('failed to reload created invoice')
  }

  // Always emit invoice.created so existing consumers (event_log, etc.) see it.
  await eventBus.emit({
    type: 'invoice.created',
    payload: {
      invoice: completeInvoice as Invoice,
      companyId: schedule.company_id,
      userId: schedule.user_id,
    },
  })

  let autoSent = false
  let warning: string | null = null

  // 9. Auto-send path. If anything below fails, we keep the invoice (now a
  //    numbered draft) and surface a Swedish warning on the schedule: the
  //    user can manually send from /invoices/[id].
  if (schedule.auto_send && options.suppressAutoSend) {
    // Route-level sandbox suppression: same outcome as the internal sandbox
    // chokepoint below (no email, invoice retained as draft, manual-send
    // warning), reached without entering the send path at all.
    opLog.warn('auto-send suppressed by route-level sandbox guard', {
      invoiceId: invoice.id,
    })
    warning = 'Auto-utskick misslyckades: fakturan finns som utkast och kan skickas manuellt.'
  } else if (schedule.auto_send) {
    try {
      autoSent = await sendInvoiceFromSchedule(
        supabase,
        schedule.company_id,
        schedule.user_id,
        completeInvoice as Invoice & { customer: Customer; items: InvoiceItem[] },
      )
      if (!autoSent) {
        warning = 'Auto-utskick misslyckades: fakturan finns som utkast och kan skickas manuellt.'
      }
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

  return {
    invoiceId: invoice.id,
    invoiceNumber: (completeInvoice as Invoice).invoice_number,
    autoSent,
    warning,
  }
}

/**
 * Render PDF + send email + flip status + create JE + archive PDF.
 * Mirrors /api/invoices/[id]/send/route.ts but inline so we don't depend on
 * the route's auth chain. Returns true if email was sent successfully.
 */
async function sendInvoiceFromSchedule(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice & { customer: Customer; items: InvoiceItem[] },
): Promise<boolean> {
  const emailService = getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('email service not configured; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
    })
    return false
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
    return false
  }
  // Paywall: email sending is a paid capability. The invoice itself is still
  // created (bookkeeping stays free); it just isn't emailed, and the schedule
  // surfaces the standard manual-send warning (freeze-and-retain).
  if (!(await hasCapability(supabase, companyId, CAPABILITY.email_send))) {
    log.warn('company lacks email_send capability; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      companyId,
    })
    return false
  }
  if (!invoice.customer.email?.trim()) {
    log.warn('customer has no email; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      customerId: invoice.customer.id,
    })
    return false
  }

  const { data: company } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single<CompanySettings>()

  if (!company) {
    throw new Error('company settings missing: cannot send invoice')
  }
  if (!hasRequiredInvoicePaymentAccount(company, invoice)) {
    log.warn('invoice currency has no usable payment account; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      currency: invoice.currency,
    })
    return false
  }
  const recipients = resolveInvoiceEmailRecipients({
    to: invoice.customer.email,
    configuredCc: company.invoice_email_cc_addresses,
    configuredBcc: company.invoice_email_bcc_addresses,
    customerCc: invoice.customer.invoice_email_cc_addresses,
    customerBcc: invoice.customer.invoice_email_bcc_addresses,
    legacyCc: company.email,
  })
  if (exceedsInvoiceEmailRecipientLimit(recipients)) {
    log.warn('invoice has too many email recipients; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      recipientCount: invoiceEmailRecipientCount(recipients),
    })
    return false
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
    return false
  }

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
  const { branding, company: renderCompany } = await prepareInvoicePdfRender(
    company,
    renderableInvoice.currency,
  )
  const swishQrDataUrl = await buildSwishQrDataUrl(renderCompany, renderableInvoice)
  const paymentLinkQrDataUrl = await buildPaymentLinkQrDataUrl(renderableInvoice)
  const pdfBuffer = await renderToBuffer(
    InvoicePDF({
      invoice: renderableInvoice,
      customer: invoice.customer,
      items,
      company: renderCompany,
      branding,
      swishQrDataUrl,
      paymentLinkQrDataUrl,
    }),
  )

  const emailData = { invoice: renderableInvoice, customer: invoice.customer, company }
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
  let result
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
      replyTo: company.email || undefined,
      fromName: company.company_name ?? undefined,
      from: await resolveInvoiceSender(supabase, companyId, company.company_name),
      filename,
      pdfBuffer,
    })
  } catch (err) {
    log.error('failed to persist recurring invoice delivery before send', err as Error, {
      invoiceId: invoice.id,
    })
    return false
  }

  if (result.trackingWarning) {
    log.error(
      'recurring invoice delivery snapshot requires reconciliation',
      new Error(result.trackingWarning),
      { invoiceId: invoice.id, deliveryId: result.deliveryId },
    )
  }

  if (!result.success) {
    log.error(
      'email provider failed in recurring schedule auto-send',
      new Error(result.error || 'unknown'),
      { invoiceId: invoice.id },
    )
    return false
  }

  // Email delivered: flip status, create JE, archive PDF. Treat downstream
  // failures as warnings (don't unsend the email).
  await supabase
    .from('invoices')
    .update({ status: 'sent' })
    .eq('id', invoice.id)
    .eq('company_id', companyId)

  const accountingMethod = (company as { accounting_method?: string }).accounting_method
  let journalEntryId: string | undefined
  if (!accountingMethod || accountingMethod === 'accrual') {
    try {
      const journalEntry = await createInvoiceJournalEntry(
        supabase,
        companyId,
        userId,
        invoice,
        company.entity_type,
      )
      if (journalEntry) {
        journalEntryId = journalEntry.id
        await supabase
          .from('invoices')
          .update({ journal_entry_id: journalEntry.id })
          .eq('id', invoice.id)
      }
    } catch (err) {
      log.error('failed to create journal entry for recurring invoice', err as Error, {
        invoiceId: invoice.id,
      })
    }
  }

  if (journalEntryId) {
    try {
      await linkToJournalEntry(supabase, companyId, result.documentId, journalEntryId)
    } catch (err) {
      log.error('failed to link recurring invoice PDF to journal entry', err as Error, {
        invoiceId: invoice.id,
        documentId: result.documentId,
      })
    }
  }

  await eventBus.emit({
    type: 'invoice.sent',
    payload: { invoice, companyId, userId },
  })

  return true
}
