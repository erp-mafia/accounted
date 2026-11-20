/**
 * CASH_ACCOUNT_OPERATION_BUSY: the bank-anchor guards (guard_cash_transaction_
 * binding, lock_cash_history_for_journal_line, assert_bank_anchor_journal)
 * observe the company and its cash accounts with FOR SHARE NOWAIT, while
 * commit_journal_entry holds the company row FOR NO KEY UPDATE until it
 * commits. So a write that links a bank row, or adds verifikat lines, is
 * refused at once whenever another booking of the same company is being
 * numbered: a batch of five parallel bookings hits it constantly. The holder
 * is a single short transaction, so the refusal is transient: the same write
 * a moment later goes through. Each attempt is its own request and holds no
 * lock while it waits, so retrying cannot deadlock.
 */

/**
 * Waits between attempts, in milliseconds (a little jitter is added so
 * parallel requests do not retry in lockstep). Four retries, under two
 * seconds in all: far longer than one commit_journal_entry holds the lock.
 * Mutable only so tests can run without real waits.
 */
export const CASH_ACCOUNT_BUSY_RETRY: { delaysMs: readonly number[] } = {
  delaysMs: [100, 250, 500, 1000],
}

/** True for the database's CASH_ACCOUNT_OPERATION_BUSY refusal in any wrapping (PostgREST error, BookkeepingDatabaseError). */
export function isCashAccountBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (code === 'CASH_ACCOUNT_OPERATION_BUSY') return true
  return typeof message === 'string' && message.includes('CASH_ACCOUNT_OPERATION_BUSY')
}

export function waitBeforeBusyRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  const jitter = Math.floor(Math.random() * (delayMs / 2))
  return new Promise((resolve) => setTimeout(resolve, delayMs + jitter))
}

/**
 * Runs `attempt` and runs it again, after each configured wait, for as long
 * as `isBusy` says its outcome was the transient refusal. Returns the first
 * outcome that is not, or the last one when the waits run out. Only for an
 * attempt that changes nothing when refused (one statement the database
 * rolled back).
 */
export async function retryWhileCashAccountBusy<T>(
  attempt: () => Promise<T>,
  isBusy: (outcome: T) => boolean,
): Promise<T> {
  let outcome = await attempt()
  for (const delayMs of CASH_ACCOUNT_BUSY_RETRY.delaysMs) {
    if (!isBusy(outcome)) return outcome
    await waitBeforeBusyRetry(delayMs)
    outcome = await attempt()
  }
  return outcome
}
