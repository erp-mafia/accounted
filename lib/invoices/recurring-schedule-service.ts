/**
 * Recurring invoice schedule service.
 *
 * Two public functions:
 *  - executeRecurringSchedule: spawn one invoice from a schedule, optionally
 *    sending it. Used by the daily cron and by a manual "run now" admin
 *    action.
 *  - computeNextRunDate: pure date helper. Given today + day_of_month, return
 *    the next date the schedule should run. Day-of-month values >28 are
 *    clamped to the last day of shorter months; the schedule keeps its
 *    original day_of_month so it jumps back in months that have it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender } from '@/lib/invoices/pdf-render-helpers'
import { getEmailService } from '@/lib/email/service'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { uploadDocument } from '@/lib/core/documents/document-service'
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

/**
 * Compute the next run date for a schedule given a reference date and the
 * stored day_of_month. The reference is always interpreted in UTC to avoid
 * timezone surprises around the day boundary in Vercel cron.
 *
 * Rules:
 *  - If reference is the same as a valid day_of_month occurrence, returns
 *    NEXT month's occurrence (callers compute the FIRST run via
 *    computeInitialRunDate).
 *  - Day 29-31 in shorter months clamps to that month's last day.
 *  - The schedule's stored day_of_month is unchanged — caller passes it in.
 */
export function computeNextRunDate(reference: Date, dayOfMonth: number): string {
  if (dayOfMonth < 1 || dayOfMonth > 31) {
    throw new Error(`invalid day_of_month: ${dayOfMonth}`)
  }
  const refY = reference.getUTCFullYear()
  const refM = reference.getUTCMonth()
  // Advance to the next month.
  const nextM = refM + 1
  const nextYear = refY + Math.floor(nextM / 12)
  const nextMonth = ((nextM % 12) + 12) % 12
  const clamped = Math.min(dayOfMonth, lastDayOfMonth(nextYear, nextMonth))
  const yyyy = nextYear.toString().padStart(4, '0')
  const mm = (nextMonth + 1).toString().padStart(2, '0')
  const dd = clamped.toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
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
  const availableRates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated)
  const allowedRates = new Set(availableRates.map((r) => r.rate))

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
    const rateData = await fetchExchangeRate(schedule.currency)
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
      document_type: 'invoice',
    })
    .select()
    .single()

  if (invoiceError || !invoice) {
    throw new Error(`failed to insert invoice from schedule: ${invoiceError?.message ?? 'unknown'}`)
  }

  // 6. Insert items.
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
    }
  })
  const { error: itemsError } = await supabase.from('invoice_items').insert(itemRows)
  if (itemsError) {
    // Hard-delete is safe here only because step 5 inserted invoice_number: null
    // — no F-series slot has been consumed yet (step 7 calls ensureInvoiceNumber).
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
  //    numbered draft) and surface a Swedish warning on the schedule — the
  //    user can manually send from /invoices/[id].
  if (schedule.auto_send) {
    try {
      autoSent = await sendInvoiceFromSchedule(
        supabase,
        schedule.company_id,
        schedule.user_id,
        completeInvoice as Invoice & { customer: Customer; items: InvoiceItem[] },
      )
      if (!autoSent) {
        warning = 'Auto-utskick misslyckades — fakturan finns som utkast och kan skickas manuellt.'
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
  if (!invoice.customer.email) {
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
    throw new Error('company settings missing — cannot send invoice')
  }

  const items = (invoice.items || []).slice().sort((a, b) => a.sort_order - b.sort_order)

  // Render PDF with status overridden to 'sent' so the customer doesn't
  // receive a "UTKAST" stamp.
  const renderableInvoice = { ...invoice, status: 'sent' as const }
  const { branding } = prepareInvoicePdfRender(company)
  const pdfBuffer = await renderToBuffer(
    InvoicePDF({
      invoice: renderableInvoice,
      customer: invoice.customer,
      items,
      company,
      branding,
    }),
  )

  const emailData = { invoice, customer: invoice.customer, company }
  const filename = `faktura-${invoice.invoice_number}.pdf`
  const ccAddress = company.email || undefined

  const result = await emailService.sendEmail({
    to: invoice.customer.email,
    cc: ccAddress,
    subject: generateInvoiceEmailSubject(emailData),
    html: generateInvoiceEmailHtml(emailData),
    text: generateInvoiceEmailText(emailData),
    replyTo: company.email || undefined,
    fromName: company.company_name ?? undefined,
    attachments: [
      { filename, content: pdfBuffer, contentType: 'application/pdf' },
    ],
  })

  if (!result.success) {
    log.error(
      'email provider failed in recurring schedule auto-send',
      new Error(result.error || 'unknown'),
      { invoiceId: invoice.id },
    )
    return false
  }

  // Email delivered — flip status, create JE, archive PDF. Treat downstream
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

  try {
    const pdfArrayBuffer = new Uint8Array(pdfBuffer).buffer as ArrayBuffer
    await uploadDocument(
      supabase,
      userId,
      companyId,
      { name: filename, buffer: pdfArrayBuffer, type: 'application/pdf' },
      { upload_source: 'system', journal_entry_id: journalEntryId },
    )
  } catch (err) {
    log.error('failed to archive recurring invoice PDF', err as Error, {
      invoiceId: invoice.id,
    })
  }

  await eventBus.emit({
    type: 'invoice.sent',
    payload: { invoice, companyId, userId },
  })

  return true
}
