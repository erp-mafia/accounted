import type { SupabaseClient } from '@supabase/supabase-js'
import { isCompanyAdmin } from '@/lib/auth/require-write'
import { loadBatchRemovals } from '@/lib/collections/batch-removals'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getEmailService } from '@/lib/email/service'
import { remindersActiveFor } from '@/lib/invoices/reminders-enabled'
import { createLogger, type Logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'
import type { ReminderChannel } from './channel'
import { createEmailReminderChannel } from './channels/email'
import {
  REMINDER_BATCH_ITEM_KIND,
  reminderBatchParamsSchema,
  remainingReminderItems,
  type ReminderBatchCommitResult,
  type ReminderBatchSkipReason,
} from './batch'
import { dispatchReminder, type DispatchReminderOutcome } from './dispatch'

/**
 * Commit an approved daily reminder batch. Runs only from the staged
 * operation commit (commitPendingOperation) after an owner or administrator
 * approved the batch in the web UI: the type is web-only (risk-tiers.ts) and
 * reminderBatchApprovalRefusal is asked before the operation is claimed.
 *
 * The staged items less the ones taken out are sent one by one through
 * dispatchReminder, the only send path, which decides each invoice again
 * from fresh facts and checks the bank again. An item whose bank was not
 * synced when the batch was gathered goes out because the approver saw that
 * in the review and approved it (bankAttested); a possible payment found
 * now still stops it. Idempotent per invoice and level (dispatch reserves
 * one invoice_reminders row per level), so a commit that runs again after a
 * crash sends nothing twice.
 */

const log = createLogger('reminders/batch-commit')

export interface ReminderBatchApprovalRefusal {
  code: string
  status: number
  messageSv: string
}

/**
 * Asked before the batch is claimed, so a refused batch stays pending: the
 * approver must be the company's owner or an administrator, and reminders
 * must still be on (the company's switch and the product's). Runs with the
 * approver's own client.
 */
export async function reminderBatchApprovalRefusal(
  supabase: SupabaseClient,
  companyId: string,
  deps: { isAdmin?: (supabase: SupabaseClient, companyId: string) => Promise<boolean>; sendingEnabled?: boolean } = {},
): Promise<ReminderBatchApprovalRefusal | null> {
  const refusal = (code: string, status: number): ReminderBatchApprovalRefusal => ({
    code,
    status,
    messageSv: getErrorEntry(code)?.message_sv ?? code,
  })
  if (!(await (deps.isAdmin ?? isCompanyAdmin)(supabase, companyId))) return refusal('COLLECTION_BATCH_ADMIN_ONLY', 403)

  const { data, error } = await supabase.from('company_settings').select('send_invoice_reminders').eq('company_id', companyId).maybeSingle()
  if (error) throw new Error(`company_settings lookup failed: ${error.message}`)
  const on = remindersActiveFor((data as { send_invoice_reminders?: boolean | null } | null)?.send_invoice_reminders, deps.sendingEnabled)
  return on ? null : refusal('REMINDERS_OFF', 409)
}

export interface CommitReminderBatchInput {
  userId: string
  companyId: string
  operation: { id: string; params: Record<string, unknown> }
}

export interface CommitReminderBatchDeps {
  /** Service role for the sends; default createServiceClient(). */
  db?: SupabaseClient
  channel?: ReminderChannel
  now?: () => Date
  sendingEnabled?: boolean
  log?: Logger
}

export type CommitReminderBatchOutcome =
  | { ok: true; data: ReminderBatchCommitResult }
  | { ok: false; code: string; status: number; message: string }

/** The one reason a dispatch outcome other than sent reads as in the result. */
export function reminderSkipReason(outcome: Exclude<DispatchReminderOutcome, { status: 'sent' }>): ReminderBatchSkipReason {
  if (outcome.status === 'failed') return 'failed'
  switch (outcome.reason) {
    case 'paid':
      return 'paid'
    case 'possible_payment':
    case 'bank_not_fresh':
      return 'bank'
    default:
      // Credited, answered by the customer, already sent, turned off since
      // the morning: the invoice is no longer what was approved.
      return 'changed'
  }
}

export async function commitReminderDailyBatch(
  input: CommitReminderBatchInput,
  deps: CommitReminderBatchDeps = {},
): Promise<CommitReminderBatchOutcome> {
  const parsed = reminderBatchParamsSchema.safeParse(input.operation.params)
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION_ERROR', status: 422, message: 'Omgången kunde inte läsas.' }
  }
  const batchLog = deps.log ?? log
  const db = deps.db ?? createServiceClient()
  const channel = deps.channel ?? createEmailReminderChannel(await getEmailService())

  // Read after the claim: nothing can be taken out once the batch is committing.
  const removals = await loadBatchRemovals(db, input.companyId, input.operation.id)
  const removed = removals.filter((r) => (r.kind as string) === REMINDER_BATCH_ITEM_KIND).map((r) => r.invoice_id)
  const items = remainingReminderItems(parsed.data, removed)

  const result: ReminderBatchCommitResult = {
    batch_date: parsed.data.batch_date,
    sent: [],
    skipped: [],
    sent_count: 0,
    skipped_count: 0,
  }
  for (const item of items) {
    try {
      const outcome = await dispatchReminder(
        { db, channel, now: deps.now, sendingEnabled: deps.sendingEnabled, log: batchLog },
        {
          companyId: input.companyId,
          invoiceId: item.invoice_id,
          level: item.level,
          actorUserId: input.userId,
          mode: 'approved',
          // The review showed this item's bank as unchecked, and the person approved it.
          bankAttested: item.bank !== 'fresh',
        },
      )
      if (outcome.status === 'sent') {
        result.sent.push({ invoice_id: item.invoice_id, level: item.level, reminder_id: outcome.reminderId })
      } else {
        result.skipped.push({
          invoice_id: item.invoice_id,
          reason: reminderSkipReason(outcome),
          code: outcome.status === 'failed' ? outcome.code : outcome.reason,
        })
      }
    } catch (error) {
      batchLog.error('reminder batch item failed', error as Error, { operationId: input.operation.id, invoiceId: item.invoice_id })
      result.skipped.push({ invoice_id: item.invoice_id, reason: 'error', code: 'INTERNAL_ERROR' })
    }
  }
  result.sent_count = result.sent.length
  result.skipped_count = result.skipped.length
  batchLog.info('reminder batch committed', { operationId: input.operation.id, sent: result.sent_count, skipped: result.skipped_count })
  return { ok: true, data: result }
}
