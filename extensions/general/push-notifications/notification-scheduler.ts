/**
 * Cron-based notification scheduling.
 *
 * Handles time-dependent checks that cannot be event-driven:
 *   - Tax deadlines approaching (7 days, 1 day, today)
 *   - Invoice due/overdue reminders (3 days before, on due date, 3/7 days overdue)
 *
 * Both functions call `sendNotificationToUser()` from the sender module
 * instead of duplicating the send pipeline.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NotificationType } from '@/types'
import { sendNotificationToUser } from './notification-sender'
import {
  createTaxDeadlinePayload,
  createInvoiceOverduePayload,
  createInvoiceDuePayload,
  createMissingUnderlagPayload,
} from './payload-builders'

/**
 * Send tax deadline notifications.
 * Checks for deadlines due in 7 days, 1 day, or today.
 */
export async function sendTaxDeadlineNotifications(
  supabase: SupabaseClient
): Promise<{ sent: number; skipped: number }> {
  let sent = 0
  let skipped = 0

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString().split('T')[0]

  const in7Days = new Date(today)
  in7Days.setDate(in7Days.getDate() + 7)
  const in7DaysStr = in7Days.toISOString().split('T')[0]

  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().split('T')[0]

  const { data: deadlines } = await supabase
    .from('deadlines')
    .select('id, user_id, title, due_date')
    .eq('deadline_type', 'tax')
    .eq('is_completed', false)
    .in('status', ['upcoming', 'action_needed'])
    .in('due_date', [in7DaysStr, tomorrowStr, todayStr])

  if (!deadlines || deadlines.length === 0) {
    return { sent: 0, skipped: 0 }
  }

  // Group by user
  const userDeadlines = new Map<string, typeof deadlines>()
  for (const deadline of deadlines) {
    const list = userDeadlines.get(deadline.user_id) || []
    list.push(deadline)
    userDeadlines.set(deadline.user_id, list)
  }

  for (const [userId, userDls] of userDeadlines) {
    // Check user-level tax_deadlines_enabled
    const { data: settings } = await supabase
      .from('notification_settings')
      .select('tax_deadlines_enabled')
      .eq('company_id', userId)
      .single()

    if (settings && !settings.tax_deadlines_enabled) {
      skipped += userDls.length
      continue
    }

    for (const deadline of userDls) {
      const daysUntil = Math.ceil(
        (new Date(deadline.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
      )

      const payload = createTaxDeadlinePayload(
        deadline.title,
        deadline.due_date,
        daysUntil,
        deadline.id
      )

      const result = await sendNotificationToUser(
        supabase,
        userId,
        payload,
        'tax_deadline',
        deadline.id,
        daysUntil
      )

      if (result.sent) {
        sent++
      } else {
        skipped++
      }
    }
  }

  return { sent, skipped }
}

/**
 * Send invoice reminder notifications.
 * Checks for invoices due in 3 days, today, or overdue by 3/7 days.
 */
export async function sendInvoiceNotifications(
  supabase: SupabaseClient
): Promise<{ sent: number; skipped: number }> {
  let sent = 0
  let skipped = 0

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString().split('T')[0]

  const in3Days = new Date(today)
  in3Days.setDate(in3Days.getDate() + 3)
  const in3DaysStr = in3Days.toISOString().split('T')[0]

  const daysAgo3 = new Date(today)
  daysAgo3.setDate(daysAgo3.getDate() - 3)
  const daysAgo3Str = daysAgo3.toISOString().split('T')[0]

  const daysAgo7 = new Date(today)
  daysAgo7.setDate(daysAgo7.getDate() - 7)
  const daysAgo7Str = daysAgo7.toISOString().split('T')[0]

  const { data: invoices } = await supabase
    .from('invoices')
    .select('id, user_id, invoice_number, total, due_date, customer:customers(name)')
    .in('status', ['sent', 'overdue'])
    .in('due_date', [in3DaysStr, todayStr, daysAgo3Str, daysAgo7Str])

  if (!invoices || invoices.length === 0) {
    return { sent: 0, skipped: 0 }
  }

  // Group by user
  const userInvoices = new Map<string, typeof invoices>()
  for (const invoice of invoices) {
    const list = userInvoices.get(invoice.user_id) || []
    list.push(invoice)
    userInvoices.set(invoice.user_id, list)
  }

  for (const [userId, userInvs] of userInvoices) {
    // Check user-level invoice_reminders_enabled
    const { data: settings } = await supabase
      .from('notification_settings')
      .select('invoice_reminders_enabled')
      .eq('company_id', userId)
      .single()

    if (settings && !settings.invoice_reminders_enabled) {
      skipped += userInvs.length
      continue
    }

    for (const invoice of userInvs) {
      const dueDate = new Date(invoice.due_date)
      const daysUntil = Math.ceil(
        (dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
      )
      const isOverdue = daysUntil < 0
      const notificationType: NotificationType = isOverdue ? 'invoice_overdue' : 'invoice_due'

      const customer = invoice.customer as unknown as { name: string } | null
      const customerName = customer?.name || 'Okänd kund'

      const payload = isOverdue
        ? createInvoiceOverduePayload(
            invoice.invoice_number,
            customerName,
            invoice.total,
            invoice.due_date,
            invoice.id
          )
        : createInvoiceDuePayload(
            invoice.invoice_number,
            customerName,
            invoice.total,
            invoice.due_date,
            invoice.id
          )

      const result = await sendNotificationToUser(
        supabase,
        userId,
        payload,
        notificationType,
        invoice.id,
        Math.abs(daysUntil)
      )

      if (result.sent) {
        sent++
      } else {
        skipped++
      }
    }
  }

  return { sent, skipped }
}

/**
 * Source types that require supporting documents (underlag).
 */
const NEEDS_ATTACHMENT_SOURCE_TYPES = [
  'manual',
  'bank_transaction',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'import',
]

/**
 * Send missing underlag notifications.
 * Checks all users for posted journal entries without attached documents.
 * Deduplicates via the 'missing-underlag-weekly' tag on the notification payload.
 */
export async function sendMissingUnderlagNotifications(
  supabase: SupabaseClient
): Promise<{ sent: number; skipped: number }> {
  let sent = 0
  let skipped = 0

  // Get all users who have posted entries with source types that need docs
  const { data: entries } = await supabase
    .from('journal_entries')
    .select('id, user_id')
    .eq('status', 'posted')
    .in('source_type', NEEDS_ATTACHMENT_SOURCE_TYPES)

  if (!entries || entries.length === 0) {
    return { sent: 0, skipped: 0 }
  }

  // Get all document_attachments linked to journal entries
  const { data: attachments } = await supabase
    .from('document_attachments')
    .select('journal_entry_id')
    .eq('is_current_version', true)
    .not('journal_entry_id', 'is', null)

  const entriesWithDocs = new Set(
    (attachments || []).map((a) => a.journal_entry_id)
  )

  // Entries the user has explicitly flagged as "no underlag required" (bank
  // fees, interest, internal transfers, salary, tax payments). Treated as
  // satisfied so we don't nag the user about them.
  const { data: exempted } = await supabase
    .from('journal_entry_no_doc_required')
    .select('journal_entry_id')

  const exemptedEntries = new Set(
    (exempted || []).map((e) => e.journal_entry_id)
  )

  // Group missing counts by user
  const userMissingCounts = new Map<string, number>()
  for (const entry of entries) {
    if (!entriesWithDocs.has(entry.id) && !exemptedEntries.has(entry.id)) {
      userMissingCounts.set(
        entry.user_id,
        (userMissingCounts.get(entry.user_id) || 0) + 1
      )
    }
  }

  for (const [userId, count] of userMissingCounts) {
    // Check user setting
    const { data: settings } = await supabase
      .from('notification_settings')
      .select('missing_underlag_enabled')
      .eq('company_id', userId)
      .single()

    if (settings && settings.missing_underlag_enabled === false) {
      skipped++
      continue
    }

    const payload = createMissingUnderlagPayload(count)

    const result = await sendNotificationToUser(
      supabase,
      userId,
      payload,
      'missing_underlag',
      'weekly-check'
    )

    if (result.sent) {
      sent++
    } else {
      skipped++
    }
  }

  return { sent, skipped }
}
