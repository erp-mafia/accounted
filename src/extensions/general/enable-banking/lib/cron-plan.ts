/**
 * Work list for one run of the hourly bank sync cron.
 *
 * The cron used to run once a day and sync whatever fit in one invocation,
 * so the day's capacity was one invocation's capacity and everything past it
 * waited a day. Now it runs hourly and each run takes only what is DUE, so
 * capacity is 24 invocations and a run that hits its budget just leaves the
 * rest due for the next hour.
 *
 * Pure: the route fetches the rows, this decides. Every connection lands in
 * exactly one bucket, so the run can report why anything was not synced.
 */
import type { StoredAccount } from '../types'

/**
 * One hour short of a day, on purpose. The cron fires on the hour, so a
 * 24h threshold makes a connection synced at 05:03 due at 05:03 and picked
 * up at 06:00: every connection would slide an hour later each day and stop
 * being fresh in the morning. At 23h it keeps its hour, one sync per day.
 */
export const SYNC_DUE_AFTER_MS = 23 * 60 * 60 * 1000

export interface PlannableConnection {
  id: string
  company_id: string
  last_synced_at: string | null
  sync_lease_until?: string | null
  accounts_data?: unknown
}

export interface BankSyncPlan<T> {
  /** Due, lease free, within the batch limit. Never-synced first, then oldest sync. */
  selected: T[]
  stats: {
    /** Active connections of companies holding the bank_sync capability. */
    eligible: number
    /** Active connections excluded by design: no bank_sync grant. */
    notEntitled: number
    /** Every account deselected: nothing to fetch. */
    noAccounts: number
    /** Synced within SYNC_DUE_AFTER_MS. */
    fresh: number
    /** Due, but the lease is held: a recent attempt or a bank rate-limit cooldown. */
    coolingDown: number
    due: number
    selected: number
    /** Due but past the batch limit: stays due for the next run. */
    deferredByBatchLimit: number
    /** Hours past due of the most overdue synced-before connection, cooling down included. */
    oldestOverdueHours: number
  }
}

export function planBankSyncRun<T extends PlannableConnection>(
  connections: readonly T[],
  entitledCompanyIds: ReadonlySet<string>,
  now: number,
  maxConnections: number,
): BankSyncPlan<T> {
  const dueBefore = now - SYNC_DUE_AFTER_MS
  const due: T[] = []
  let notEntitled = 0
  let noAccounts = 0
  let fresh = 0
  let coolingDown = 0
  let oldestOverdueMs = 0

  for (const connection of connections) {
    if (!entitledCompanyIds.has(connection.company_id)) {
      notEntitled++
      continue
    }
    const accounts = (connection.accounts_data as StoredAccount[] | null) ?? []
    if (!accounts.some(account => account.enabled !== false)) {
      noAccounts++
      continue
    }
    const lastSynced = connection.last_synced_at ? new Date(connection.last_synced_at).getTime() : null
    if (lastSynced !== null && lastSynced > dueBefore) {
      fresh++
      continue
    }
    if (lastSynced !== null) oldestOverdueMs = Math.max(oldestOverdueMs, dueBefore - lastSynced)
    const leaseUntil = connection.sync_lease_until ? new Date(connection.sync_lease_until).getTime() : 0
    if (leaseUntil > now) {
      coolingDown++
      continue
    }
    due.push(connection)
  }

  const syncedAt = (c: T) => (c.last_synced_at ? new Date(c.last_synced_at).getTime() : -Infinity)
  due.sort((a, b) => syncedAt(a) - syncedAt(b) || (a.id < b.id ? -1 : 1))
  const selected = due.slice(0, maxConnections)

  return {
    selected,
    stats: {
      eligible: connections.length - notEntitled,
      notEntitled,
      noAccounts,
      fresh,
      coolingDown,
      due: due.length,
      selected: selected.length,
      deferredByBatchLimit: due.length - selected.length,
      oldestOverdueHours: Math.round((oldestOverdueMs / 3_600_000) * 10) / 10,
    },
  }
}
