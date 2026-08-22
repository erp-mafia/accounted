import { createServerClient } from '@supabase/ssr'
import { getEmailService } from '@/lib/email/service'
import { resolveInvoiceSender, type InvoiceSenderIdentity } from '@/lib/email/invoice-sender'
import {
  generateReminderEmailHtml,
  generateReminderEmailText,
  generateReminderEmailSubject,
  reminderPrincipal,
  getReminderDaysConfig,
  type ReminderDaysConfig,
} from '@/lib/email/reminder-templates'
import { calculateLatePaymentInterest } from '@/lib/invoices/late-payment-interest'
import {
  hasUsableInvoicePaymentAccount,
  resolveInvoicePaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { createReminderFeeEntry } from '@/lib/bookkeeping/reminder-fee-entries'
import { createLogger } from '@/lib/logger'
import type { Invoice, Customer, CompanySettings } from '@/types'

const log = createLogger('reminder-processor')

// Create a service client for cron jobs (no cookie access needed)
function createServiceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return [] },
        setAll() { }
      }
    }
  )
}

export interface ReminderResult {
  invoiceId: string
  invoiceNumber: string
  customerEmail: string
  reminderLevel: 1 | 2 | 3
  success: boolean
  error?: string
}

export interface ProcessRemindersResult {
  processed: number
  sent: number
  failed: number
  results: ReminderResult[]
}

/**
 * Determine which reminder level should be sent based on days overdue
 * Returns null if no reminder should be sent
 */
export function determineReminderLevel(
  daysOverdue: number,
  existingLevels: number[],
  config: ReminderDaysConfig = getReminderDaysConfig(),
): 1 | 2 | 3 | null {
  // Check the highest eligible level first, preserving the existing behavior
  // when a previous cron run was missed.
  if (daysOverdue >= config[3] && !existingLevels.includes(3)) {
    return 3
  }

  if (daysOverdue >= config[2] && !existingLevels.includes(2)) {
    return 2
  }

  if (daysOverdue >= config[1] && !existingLevels.includes(1)) {
    return 1
  }

  return null
}

/**
 * Calculate days overdue from due date
 */
export function calculateDaysOverdue(dueDate: string): number {
  const due = new Date(dueDate)
  const now = new Date()
  const diffTime = now.getTime() - due.getTime()
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))
  return diffDays
}

/**
 * Surcharges computed before sending the reminder. These are passed to the
 * email template and persisted on the invoice_reminders row for audit.
 */
export interface ReminderSurcharges {
  /** Dröjsmålsränta: a share of the invoice total, so it carries the INVOICE currency. */
  interestAmount: number
  interestRate: number
  interestFromDate: string
  interestDays: number
  /**
   * Lagstadgad påminnelseavgift, always in SEK (Lag 1981:739; booked 1510/3990
   * in SEK). Deliberately NOT summed with the invoice-currency amounts here:
   * the template derives the per-currency amount to pay via
   * calculateReminderAmounts().
   */
  reminderFee: number
}

/**
 * Send a single reminder email
 */
export async function sendReminder(
  invoice: Invoice & { customer: Customer },
  company: CompanySettings,
  reminderLevel: 1 | 2 | 3,
  actionToken: string,
  surcharges: ReminderSurcharges,
  sender?: InvoiceSenderIdentity,
): Promise<{ success: boolean; error?: string }> {
  const customer = invoice.customer

  if (!customer.email) {
    return { success: false, error: 'Customer has no email' }
  }

  // Same gate as invoice send: a reminder with no payment account for the
  // invoice currency would either print nothing to pay to or (before this
  // gate) the SEK account's IBAN on a EUR invoice, and a customer has paid
  // to the wrong account that way. Skip and surface it; the user fixes the
  // currency account under Inställningar and the next run picks it up.
  const currency = invoice.currency
  if (!hasUsableInvoicePaymentAccount(resolveInvoicePaymentAccount(company, currency), currency)) {
    log.warn('Skipping reminder: no payment account configured for invoice currency', {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      currency,
    })
    return { success: false, error: `INVOICE_PAYMENT_ACCOUNT_MISSING:${currency}` }
  }

  const daysOverdue = calculateDaysOverdue(invoice.due_date)

  // Build action URL (public page for customer response)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.erp-base.se'
  const actionUrl = `${baseUrl}/invoice-action/${actionToken}`

  const emailData = {
    invoice,
    customer,
    company,
    reminderLevel,
    daysOverdue,
    actionUrl,
    ...surcharges,
  }

  const result = await getEmailService().sendEmail({
    to: customer.email,
    subject: generateReminderEmailSubject(emailData),
    html: generateReminderEmailHtml(emailData),
    text: generateReminderEmailText(emailData),
    replyTo: company.email || undefined,
    fromName: company.company_name || undefined,
    from: sender,
  })

  return result
}

/**
 * Process all overdue invoices and send reminders
 * This is the main function called by the cron job
 */
export async function processOverdueReminders(): Promise<ProcessRemindersResult> {
  const supabase = createServiceClient()
  const results: ReminderResult[] = []

  // Company schedules can start as early as one day overdue. Fetch that
  // bounded candidate set, then apply each company's thresholds below.
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - 1)

  // Positive allowlist: inherently excludes 'paid', 'partially_paid', 'cancelled', 'credited'.
  // Including 'overdue' ensures level-2 / level-3 reminders re-fire after the first reminder
  // flips status to 'overdue' (see status update below).
  const { data: overdueInvoices, error: invoiceError } = await supabase
    .from('invoices')
    .select(`
      *,
      customer:customers(*),
      credit_notes:invoices!credited_invoice_id(id, status, creation_complete)
    `)
    .in('status', ['sent', 'overdue'])
    .is('credited_invoice_id', null)
    .lte('due_date', cutoffDate.toISOString().split('T')[0])
    .order('due_date', { ascending: true })

  if (invoiceError) {
    log.error('Error fetching overdue invoices:', invoiceError)
    return { processed: 0, sent: 0, failed: 0, results: [] }
  }

  if (!overdueInvoices || overdueInvoices.length === 0) {
    log.info('No overdue invoices found')
    return { processed: 0, sent: 0, failed: 0, results: [] }
  }

  log.info(`Found ${overdueInvoices.length} overdue invoices to process`)

  // Process each invoice
  for (const invoice of overdueInvoices) {
    const activeCreditNotes = ((invoice as { credit_notes?: Array<{
      status: string
      creation_complete?: boolean
    }> }).credit_notes ?? []).filter(
      (creditNote) => creditNote.status !== 'cancelled' && creditNote.creation_complete !== false,
    )
    if (activeCreditNotes.length > 0) {
      log.info(`Skipping invoice ${invoice.invoice_number}: active credit note exists`)
      continue
    }

    const customer = invoice.customer as Customer

    // Skip if customer has no email
    if (!customer?.email) {
      log.info(`Skipping invoice ${invoice.invoice_number}: customer has no email`)
      continue
    }

    // Get existing reminders for this invoice
    const { data: existingReminders } = await supabase
      .from('invoice_reminders')
      .select('reminder_level, response_type')
      .eq('invoice_id', invoice.id)

    // Skip if customer already responded (marked paid OR disputed): they've
    // told us they don't want another reminder. The business owner still needs
    // to record the actual payment (mark-paid / match-invoice) to flip status
    // and post the journal entry; we don't do that here because the customer
    // action is unauthenticated and posting a JE without a verified payment
    // would put the books out of sync.
    const customerResponded = existingReminders?.some(r => r.response_type !== null)
    if (customerResponded) {
      log.info(`Skipping invoice ${invoice.invoice_number}: customer already responded via reminder link`)
      continue
    }

    const existingLevels = existingReminders?.map(r => r.reminder_level) || []
    const daysOverdue = calculateDaysOverdue(invoice.due_date)

    // Get company settings for this user
    const { data: company, error: companyError } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', invoice.company_id)
      .single()

    if (companyError || !company) {
      log.error(`Skipping invoice ${invoice.invoice_number}: company settings not found`)
      const fallbackLevel = determineReminderLevel(daysOverdue, existingLevels)
      if (fallbackLevel) {
        results.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoice_number,
          customerEmail: customer.email,
          reminderLevel: fallbackLevel,
          success: false,
          error: 'Company settings not found',
        })
      }
      continue
    }

    // Per-company kill switch (settings → Fakturering → "Skicka automatiska påminnelser")
    if (company.send_invoice_reminders === false) {
      log.info(`Skipping invoice ${invoice.invoice_number}: automatic reminders disabled for company ${invoice.company_id}`)
      continue
    }

    const reminderConfig = getReminderDaysConfig(company as CompanySettings)
    const reminderLevel = determineReminderLevel(daysOverdue, existingLevels, reminderConfig)

    if (!reminderLevel) {
      log.info(`Skipping invoice ${invoice.invoice_number}: no reminder needed (${daysOverdue} days overdue, existing levels: ${existingLevels.join(', ')})`)
      continue
    }

    // Race-window guard: re-check invoice status immediately before sending.
    // The cron runs at 08:00; a payment match arriving during the run shouldn't
    // produce a reminder for an already-paid invoice.
    const { data: currentInvoice } = await supabase
      .from('invoices')
      .select('status, credit_notes:invoices!credited_invoice_id(id, status, creation_complete)')
      .eq('id', invoice.id)
      .eq('company_id', invoice.company_id)
      .single()

    const currentCreditNotes = ((currentInvoice as { credit_notes?: Array<{
      status: string
      creation_complete?: boolean
    }> } | null)?.credit_notes ?? []).filter(
      (creditNote) => creditNote.status !== 'cancelled' && creditNote.creation_complete !== false,
    )
    if (
      !currentInvoice ||
      !['sent', 'overdue'].includes(currentInvoice.status as string) ||
      currentCreditNotes.length > 0
    ) {
      log.info(`Skipping invoice ${invoice.invoice_number}: status changed to ${currentInvoice?.status ?? 'unknown'} mid-run`)
      continue
    }

    // Compute statutory late-payment interest (Räntelagen §6) using the
    // company override if set, else Riksbankens referensränta + 8 pp.
    const asOfDate = new Date().toISOString().split('T')[0]
    // Interest accrues on what the customer actually owes: the invoice's
    // "Att betala" (öre-rounded total minus any ROT/RUT-avdrag), never on the
    // Skatteverket share sitting on 1513.
    const interest = calculateLatePaymentInterest({
      overdueAmount: reminderPrincipal(invoice as Invoice, company as CompanySettings),
      dueDate: invoice.due_date,
      asOfDate,
      overrideRate: company.reminder_interest_rate_override,
    })

    // Determine the lagstadgad påminnelseavgift (Lag 1981:739, max 60 kr).
    // Clamp at 60 kr: the statute caps the fee even if company_settings
    // somehow holds a higher value (defense in depth against a stale DB row).
    const reminderFee = company.reminder_fee_enabled
      ? Math.min(60, Math.round((company.reminder_fee_amount ?? 60) * 100) / 100)
      : 0

    // Book the fee as a journal entry. Booked BEFORE creating the
    // invoice_reminders row so we can persist fee_journal_entry_id.
    // Failure to book the fee is logged but does not abort the reminder
    // send: the customer still needs to receive the notification.
    let feeJournalEntryId: string | null = null
    if (reminderFee > 0) {
      try {
        const feeResult = await createReminderFeeEntry(supabase, {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoice_number,
          companyId: invoice.company_id,
          userId: invoice.user_id,
          feeAmount: reminderFee,
          asOfDate,
        })
        feeJournalEntryId = feeResult?.journal_entry_id ?? null
      } catch (feeError) {
        log.error(
          `Failed to book reminder fee for invoice ${invoice.invoice_number}:`,
          feeError as Error,
        )
        // Continue: surcharge still appears in the email, but no JE is linked.
      }
    }

    // No "totalDue" scalar is computed here on purpose: invoice.total and
    // interest.amount are in the invoice currency while reminderFee is a
    // statutory SEK amount. Summing them would produce a nonsense figure for a
    // EUR/USD invoice. The email template splits the amount to pay per currency.

    // Create reminder record first (to get action token), persisting the
    // computed surcharges so the public action page + audit trail show them.
    const { data: reminderRecord, error: reminderError } = await supabase
      .from('invoice_reminders')
      .insert({
        invoice_id: invoice.id,
        user_id: invoice.user_id,
        company_id: invoice.company_id,
        reminder_level: reminderLevel,
        email_to: customer.email,
        interest_amount: interest.amount,
        interest_rate: interest.rate,
        interest_from_date: interest.fromDate,
        interest_days: interest.days,
        reminder_fee: reminderFee,
        fee_journal_entry_id: feeJournalEntryId,
      })
      .select('action_token')
      .single()

    if (reminderError || !reminderRecord) {
      log.error(`Failed to create reminder record for invoice ${invoice.invoice_number}:`, reminderError)
      results.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        customerEmail: customer.email,
        reminderLevel,
        success: false,
        error: 'Failed to create reminder record'
      })
      continue
    }

    // Send the reminder email
    const sendResult = await sendReminder(
      invoice as Invoice & { customer: Customer },
      company as CompanySettings,
      reminderLevel,
      reminderRecord.action_token,
      {
        interestAmount: interest.amount,
        interestRate: interest.rate,
        interestFromDate: interest.fromDate,
        interestDays: interest.days,
        reminderFee,
      },
      await resolveInvoiceSender(supabase, invoice.company_id, company.company_name),
    )

    if (sendResult.success) {
      log.info(`Sent level ${reminderLevel} reminder for invoice ${invoice.invoice_number} to ${customer.email}`)

      // Update invoice status to overdue if not already
      if (invoice.status === 'sent') {
        await supabase
          .from('invoices')
          .update({ status: 'overdue' })
          .eq('id', invoice.id)
      }
    } else {
      log.error(`Failed to send reminder for invoice ${invoice.invoice_number}:`, sendResult.error)
    }

    results.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      customerEmail: customer.email,
      reminderLevel,
      success: sendResult.success,
      error: sendResult.error
    })
  }

  const sent = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  return {
    processed: results.length,
    sent,
    failed,
    results
  }
}
