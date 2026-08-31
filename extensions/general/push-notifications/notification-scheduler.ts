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
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/types'
import { sendNotificationToUser, readNotificationSettings } from './notification-sender'
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
    // Check user-level tax_deadlines_enabled. Unreadable settings mean no
    // send; a missing row means the defaults (enabled) apply.
    const settingsRead = await readNotificationSettings(supabase, userId)
    if (!settingsRead.readable) {
      skipped += userDls.length
      continue
    }
    if (settingsRead.settings && !settingsRead.settings.tax_deadlines_enabled) {
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
    .select('id, user_id, invoice_number, total, currency, due_date, customer:customers(name)')
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
    // Check user-level invoice_reminders_enabled. Unreadable settings mean no
    // send; a missing row means the defaults (enabled) apply.
    const settingsRead = await readNotificationSettings(supabase, userId)
    if (!settingsRead.readable) {
      skipped += userInvs.length
      continue
    }
    if (settingsRead.settings && !settingsRead.settings.invoice_reminders_enabled) {
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
            invoice.currency,
            invoice.due_date,
            invoice.id
          )
        : createInvoiceDuePayload(
            invoice.invoice_number,
            customerName,
            invoice.total,
            invoice.currency,
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
 * Source types that require supporting documents (underlag). Shared source
 * of truth (lib/worklist/types.ts) so this cron can never disagree with the
 * worklist badge (skeptic finding on #1881: a hardcoded copy here missed
 * webshop_order).
 */
const NEEDS_ATTACHMENT_SOURCE_TYPES = [...NEEDS_DOC_SOURCE_TYPES]

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

  // Get all users who have posted entries with source types that need docs.
  // This is a GLOBAL cron over every company, so each read below must page
  // past PostgREST's 1000-row cap: a truncated read here would under-count
  // candidates, and a truncated docs/reference read would over-count missing
  // underlag, producing false "saknade underlag" notifications.
  const entries = await fetchAllRows<{ id: string; user_id: string }>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('id, user_id')
      .eq('status', 'posted')
      .in('source_type', NEEDS_ATTACHMENT_SOURCE_TYPES)
      .order('id')
      .range(from, to)
  )

  if (entries.length === 0) {
    return { sent: 0, skipped: 0 }
  }

  // Get all document_attachments linked to journal entries
  const attachments = await fetchAllRows<{ journal_entry_id: string | null }>(({ from, to }) =>
    supabase
      .from('document_attachments')
      .select('journal_entry_id')
      .eq('is_current_version', true)
      .not('journal_entry_id', 'is', null)
      .order('id')
      .range(from, to)
  )

  const entriesWithDocs = new Set(attachments.map((a) => a.journal_entry_id))

  // BFL 5 kap 7 § hänvisning: entries referenced by a supplier invoice whose
  // document is retained and anchored to a journal entry count as covered
  // (mirrors the verifikat_without_documents RPC): typically the payment
  // verifikat, whose invoice document hangs on the registration verifikat.
  const siRefs = await fetchAllRows<{
    registration_journal_entry_id: string | null
    payment_journal_entry_id: string | null
    document: { journal_entry_id: string | null } | null
  }>(({ from, to }) =>
    supabase
      .from('supplier_invoices')
      .select(
        'registration_journal_entry_id, payment_journal_entry_id, document:document_attachments(journal_entry_id)'
      )
      .not('document_id', 'is', null)
      .order('id')
      .range(from, to) as unknown as PromiseLike<{
      data: {
        registration_journal_entry_id: string | null
        payment_journal_entry_id: string | null
        document: { journal_entry_id: string | null } | null
      }[] | null
      error: { message: string } | null
    }>
  )

  for (const si of siRefs) {
    if (!si.document?.journal_entry_id) continue // unanchored: not underlag
    if (si.registration_journal_entry_id) entriesWithDocs.add(si.registration_journal_entry_id)
    if (si.payment_journal_entry_id) entriesWithDocs.add(si.payment_journal_entry_id)
  }

  const sipRefs = await fetchAllRows<{
    journal_entry_id: string | null
    supplier_invoice: {
      document_id: string | null
      document: { journal_entry_id: string | null } | null
    } | null
  }>(({ from, to }) =>
    supabase
      .from('supplier_invoice_payments')
      .select(
        'journal_entry_id, supplier_invoice:supplier_invoices(document_id, document:document_attachments(journal_entry_id))'
      )
      .not('journal_entry_id', 'is', null)
      .order('id')
      .range(from, to) as unknown as PromiseLike<{
      data: {
        journal_entry_id: string | null
        supplier_invoice: {
          document_id: string | null
          document: { journal_entry_id: string | null } | null
        } | null
      }[] | null
      error: { message: string } | null
    }>
  )

  for (const sip of sipRefs) {
    if (sip.journal_entry_id && sip.supplier_invoice?.document?.journal_entry_id) {
      entriesWithDocs.add(sip.journal_entry_id)
    }
  }

  // Entries the user has explicitly flagged as "no underlag required" (bank
  // fees, interest, internal transfers, salary, tax payments). Treated as
  // satisfied so we don't nag the user about them.
  const exempted = await fetchAllRows<{ journal_entry_id: string }>(({ from, to }) =>
    supabase
      .from('journal_entry_no_doc_required')
      .select('journal_entry_id')
      .order('journal_entry_id')
      .range(from, to)
  )

  const exemptedEntries = new Set(exempted.map((e) => e.journal_entry_id))

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
    // Check user setting. Unreadable settings mean no send; a missing row
    // means the defaults (enabled) apply.
    const settingsRead = await readNotificationSettings(supabase, userId)
    if (!settingsRead.readable) {
      skipped++
      continue
    }
    if (settingsRead.settings && settingsRead.settings.missing_underlag_enabled === false) {
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
