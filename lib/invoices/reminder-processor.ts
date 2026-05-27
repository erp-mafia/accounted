import { createServerClient } from '@supabase/ssr'
import { getEmailService } from '@/lib/email/service'
import {
  generateReminderEmailHtml,
  generateReminderEmailText,
  generateReminderEmailSubject,
  getReminderDaysConfig
} from '@/lib/email/reminder-templates'
import { calculateLatePaymentInterest } from '@/lib/invoices/late-payment-interest'
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
  existingLevels: number[]
): 1 | 2 | 3 | null {
  const config = getReminderDaysConfig()

  // Check level 3 (45 days)
  if (daysOverdue >= config[3] && !existingLevels.includes(3)) {
    return 3
  }

  // Check level 2 (30 days)
  if (daysOverdue >= config[2] && !existingLevels.includes(2)) {
    return 2
  }

  // Check level 1 (15 days)
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
  interestAmount: number
  interestRate: number
  interestFromDate: string
  interestDays: number
  reminderFee: number
  totalDue: number
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
): Promise<{ success: boolean; error?: string }> {
  const customer = invoice.customer

  if (!customer.email) {
    return { success: false, error: 'Customer has no email' }
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
    fromName: company.company_name || undefined
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
  const config = getReminderDaysConfig()

  // Find all sent invoices that are past due date (at least 15 days overdue)
  const minOverdueDays = config[1]
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - minOverdueDays)

  // Positive allowlist — inherently excludes 'paid', 'partially_paid', 'cancelled', 'credited'.
  // Including 'overdue' ensures level-2 / level-3 reminders re-fire after the first reminder
  // flips status to 'overdue' (see status update below).
  const { data: overdueInvoices, error: invoiceError } = await supabase
    .from('invoices')
    .select(`
      *,
      customer:customers(*)
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

    // Skip if customer already responded (marked paid OR disputed) — they've
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
    const reminderLevel = determineReminderLevel(daysOverdue, existingLevels)

    // Skip if no reminder needed
    if (!reminderLevel) {
      log.info(`Skipping invoice ${invoice.invoice_number}: no reminder needed (${daysOverdue} days overdue, existing levels: ${existingLevels.join(', ')})`)
      continue
    }

    // Get company settings for this user
    const { data: company, error: companyError } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', invoice.company_id)
      .single()

    if (companyError || !company) {
      log.error(`Skipping invoice ${invoice.invoice_number}: company settings not found`)
      results.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        customerEmail: customer.email,
        reminderLevel,
        success: false,
        error: 'Company settings not found'
      })
      continue
    }

    // Per-company kill switch (settings → Fakturering → "Skicka automatiska påminnelser")
    if (company.send_invoice_reminders === false) {
      log.info(`Skipping invoice ${invoice.invoice_number}: automatic reminders disabled for company ${invoice.company_id}`)
      continue
    }

    // Race-window guard — re-check invoice status immediately before sending.
    // The cron runs at 08:00; a payment match arriving during the run shouldn't
    // produce a reminder for an already-paid invoice.
    const { data: currentInvoice } = await supabase
      .from('invoices')
      .select('status')
      .eq('id', invoice.id)
      .single()

    if (!currentInvoice || !['sent', 'overdue'].includes(currentInvoice.status as string)) {
      log.info(`Skipping invoice ${invoice.invoice_number}: status changed to ${currentInvoice?.status ?? 'unknown'} mid-run`)
      continue
    }

    // Compute statutory late-payment interest (Räntelagen §6) using the
    // company override if set, else Riksbankens referensränta + 8 pp.
    const asOfDate = new Date().toISOString().split('T')[0]
    const interest = calculateLatePaymentInterest({
      overdueAmount: invoice.total,
      dueDate: invoice.due_date,
      asOfDate,
      overrideRate: company.reminder_interest_rate_override,
    })

    // Determine the lagstadgad påminnelseavgift (Lag 1981:739, max 60 kr).
    // Clamp at 60 kr — the statute caps the fee even if company_settings
    // somehow holds a higher value (defense in depth against a stale DB row).
    const reminderFee = company.reminder_fee_enabled
      ? Math.min(60, Math.round((company.reminder_fee_amount ?? 60) * 100) / 100)
      : 0

    // Book the fee as a journal entry. Booked BEFORE creating the
    // invoice_reminders row so we can persist fee_journal_entry_id.
    // Failure to book the fee is logged but does not abort the reminder
    // send — the customer still needs to receive the notification.
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
        // Continue — surcharge still appears in the email, but no JE is linked.
      }
    }

    const totalDue =
      Math.round((invoice.total + interest.amount + reminderFee) * 100) / 100

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
        totalDue,
      },
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
