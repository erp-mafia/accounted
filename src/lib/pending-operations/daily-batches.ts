import { COLLECTIONS_BATCH_TYPE } from '@/lib/collections/batch'
import { REMINDER_BATCH_TYPE } from '@/lib/reminders/batch'

/**
 * The daily batches a cron stages once a day per company: the collections
 * run (collections_daily_batch) and the reminders (reminder_daily_batch).
 * A person reviews each in its own dialog (items to untick, the ones left
 * out, what was sent), never through the generic approval card, and Att
 * göra counts each on a row of its own instead of as an agent proposal.
 * Client-safe.
 */
export const DAILY_BATCH_TYPES = [COLLECTIONS_BATCH_TYPE, REMINDER_BATCH_TYPE] as const
export type DailyBatchType = (typeof DAILY_BATCH_TYPES)[number]

/**
 * The daily batch types as a PostgREST in-list, for the counts of agent
 * proposals that leave them to their own rows:
 * .not('operation_type', 'in', DAILY_BATCH_TYPES_FILTER).
 */
export const DAILY_BATCH_TYPES_FILTER = `(${DAILY_BATCH_TYPES.join(',')})`

/** The operation's daily batch type, or null for every other operation. */
export function dailyBatchTypeOf(operationType: string): DailyBatchType | null {
  return DAILY_BATCH_TYPES.find((type) => type === operationType) ?? null
}

/** The daily batch type of an operation still waiting for its review, or null. */
export function pendingDailyBatchTypeOf(op: { operation_type: string; status: string }): DailyBatchType | null {
  return op.status === 'pending' ? dailyBatchTypeOf(op.operation_type) : null
}
