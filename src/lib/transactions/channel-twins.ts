import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProcessingHistoryActor } from '@/types'
import { dbError } from '@/lib/errors/db-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { appendProcessingHistory, appendProcessingHistoryWithClient, type AppendEventInput } from '@/lib/processing-history/append'
import { contentBucketKey } from '@/lib/transactions/external-id'
import { isImportedTransaction } from '@/lib/transactions/origin'
import { createLogger } from '@/lib/logger'

const log = createLogger('channel-twins')

/**
 * One bank account's movements stored twice, because two sets of its rows
 * that no import ever compared came together on one account (crm#1701).
 *
 * The import never stores a movement twice on one account: rows arriving
 * through a second channel (a statement file after the bank feed, or the
 * feed after the file) are compared with the account's stored rows, and in a
 * (date, öre) bucket where both channels hold the same number of rows the
 * second channel's copies are skipped (buildIngestDedupState in
 * ./ingest.ts). That comparison is per account. A company that imported its
 * statements onto a manual account and connected the bank onto another kept
 * both channels in full, one per account, and the ledger move that merged
 * them (lib/cash-accounts/ledger-change.ts) left every movement twice: in
 * production on 2026-11-08, 903 of one account's 1,155 open rows.
 *
 * The rule here is the import's, applied to two sides that were never
 * compared, and to nothing else (rows of one account were compared when they
 * arrived, and a bucket the import kept asymmetric holds distinct movements):
 *   - Per (date, öre, currency) bucket, as many rows on each side, ignored
 *     rows included: the same movements, once per side. A bucket with rows on
 *     one side only, unequal counts or a hand-entered row stays for a person.
 *   - A whole side goes, as the import skips a whole channel's bucket: the
 *     side set aside must hold only plain open work, and the side kept must
 *     still hold every movement (none of its rows ignored). The later side
 *     goes when it qualifies (the copies the import would have skipped),
 *     else the earlier side. Rows already ignored are no longer live, so a
 *     second run finds nothing to do. A bucket where both sides hold booked
 *     or linked rows is left for a person: same-day rows of one amount
 *     cannot be told apart, so which booking covers which movement is a
 *     person's call; so is a bucket with more such rows than movements.
 *   - Set aside means ignored, the flag the ignore doors set (./ignore.ts):
 *     nothing is deleted, no verifikat is touched, restore undoes it. Only
 *     the bulk ignore's plain open set qualifies (./bulk-ignore.ts): in
 *     open_bank_rows with no pointer and no invoice link, read again at the
 *     write.
 * One processing_history row (BankTransactionTwinsIgnored) names every row
 * set aside and the row it duplicates, also when a later chunk fails.
 */

/** A stored bank row as the rule reads it. */
export interface StoredBankRow {
  id: string
  date: string
  amount: number | string
  currency: string | null
  import_source: string | null
  bank_connection_id: string | null
  created_at: string
  cash_account_id: string | null
  is_ignored: boolean
  /** Plain open work: in open_bank_rows, no pointer, no invoice link. */
  open: boolean
}

export interface TwinSetAside {
  transaction_id: string
  /** The row of the other side this one duplicates. */
  twin_transaction_id: string
}

export interface TwinsPlan {
  setAside: TwinSetAside[]
  /** Buckets left for a person: booked or linked rows on both sides, or more of them than movements. */
  overBookedBuckets: number
}

/** Rows read or written per chunk of ids. */
const ID_CHUNK = 100

function bucketKey(row: StoredBankRow): string {
  return `${contentBucketKey(row.date, row.amount)}|${(row.currency || 'SEK').toUpperCase()}`
}

function bucketsOf(rows: readonly StoredBankRow[]): Map<string, StoredBankRow[]> {
  const buckets = new Map<string, StoredBankRow[]>()
  for (const row of rows) {
    const key = bucketKey(row)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }
  return buckets
}

function firstSeen(rows: readonly StoredBankRow[]): string {
  return rows.reduce((min, r) => (r.created_at < min ? r.created_at : min), rows[0].created_at)
}

const byDateId = (x: StoredBankRow, y: StoredBankRow) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id)

/**
 * Pure: which open rows of two never-compared sides are copies of the other
 * side's rows of the same movements, and a row of the other side each one
 * duplicates (same day and amount; rows of one bucket are interchangeable).
 */
export function planTwins(sideA: readonly StoredBankRow[], sideB: readonly StoredBankRow[]): TwinsPlan {
  const bucketsB = bucketsOf(sideB)
  const setAside: TwinSetAside[] = []
  let overBookedBuckets = 0

  for (const [key, a] of bucketsOf(sideA)) {
    const b = bucketsB.get(key)
    if (!b || a.length !== b.length) continue
    // A hand-entered row is a person's own record, never a channel copy.
    if ([...a, ...b].some((r) => !isImportedTransaction(r))) continue
    const movements = a.length
    const liveA = a.filter((r) => !r.is_ignored)
    const liveB = b.filter((r) => !r.is_ignored)
    const keptRows = [...liveA, ...liveB].filter((r) => !r.open).length
    if (keptRows > movements) {
      overBookedBuckets += 1
      continue
    }
    // The side that can go whole: only plain open work, while the other side
    // still holds every movement. Later side first.
    const [later, earlier] = firstSeen(b) > firstSeen(a) ? [liveB, liveA] : [liveA, liveB]
    const canGo = (gone: StoredBankRow[], kept: StoredBankRow[]) =>
      gone.length > 0 && kept.length === movements && gone.every((r) => r.open)
    const choice = canGo(later, earlier) ? { gone: later, kept: earlier } : canGo(earlier, later) ? { gone: earlier, kept: later } : null
    if (!choice) {
      // Nothing live to set aside (a second run), or booked rows on both sides.
      if (liveA.length + liveB.length > movements) overBookedBuckets += 1
      continue
    }
    const gone = [...choice.gone].sort(byDateId)
    const kept = [...choice.kept].sort(byDateId)
    gone.forEach((row, i) => setAside.push({ transaction_id: row.id, twin_transaction_id: kept[i].id }))
  }
  return { setAside, overBookedBuckets }
}

interface RowFilter {
  eq(column: string, value: unknown): RowFilter
  is(column: string, value: null): RowFilter
}

/** The bulk ignore's set: open work with no pointer and no invoice link. */
function plainOpen<Q>(query: Q, companyId: string): Q {
  const q = (query as unknown as RowFilter)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .is('invoice_id', null)
    .is('supplier_invoice_id', null)
  return q as unknown as Q
}

/** Every stored row of these accounts, ignored ones included, with its plain-open flag. */
export async function readAccountRows(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountIds: readonly string[],
): Promise<StoredBankRow[]> {
  if (cashAccountIds.length === 0) return []
  const stored = await fetchAllRows<Omit<StoredBankRow, 'open'>>(({ from, to }) =>
    supabase
      .from('transactions')
      .select('id, date, amount, currency, import_source, bank_connection_id, created_at, cash_account_id, is_ignored')
      .eq('company_id', companyId)
      .in('cash_account_id', [...cashAccountIds])
      .order('id', { ascending: true })
      .range(from, to),
  )
  const open = await fetchAllRows<{ id: string }>(({ from, to }) =>
    plainOpen(supabase.from('open_bank_rows').select('id'), companyId)
      .in('cash_account_id', [...cashAccountIds])
      .order('id', { ascending: true })
      .range(from, to),
  )
  const openIds = new Set(open.map((r) => r.id))
  return stored.map((row) => ({ ...row, is_ignored: Boolean(row.is_ignored), open: openIds.has(row.id) }))
}

/**
 * Before a ledger move saves: the copies between the moving account's rows
 * and the rows of the account already on the ledger account it moves to,
 * which no import compared. One account on each side: two target accounts
 * could be two bank accounts, whose rows would read as one side's
 * movements, so then nothing is planned and the rows stay for a person.
 * Read only.
 */
export async function prepareMoveTwins(
  supabase: SupabaseClient,
  companyId: string,
  movingCashAccountId: string,
  targetCashAccountIds: readonly string[],
): Promise<TwinsPlan> {
  const targets = [...new Set(targetCashAccountIds)].filter((id) => id !== movingCashAccountId)
  if (targets.length !== 1) return { setAside: [], overBookedBuckets: 0 }
  const rows = await readAccountRows(supabase, companyId, [movingCashAccountId, ...targets])
  return planTwins(
    rows.filter((r) => r.cash_account_id === movingCashAccountId),
    rows.filter((r) => r.cash_account_id !== movingCashAccountId),
  )
}

export interface ApplyTwinsOptions {
  actor: ProcessingHistoryActor
  correlationId: string
  reason: 'ledger_move' | 'repair'
  /**
   * Where the record is appended. processing_history takes no insert from a
   * person's client, so the default is the server's service client
   * (appendProcessingHistory); a script passes its own.
   */
  historyClient?: Pick<SupabaseClient, 'from'>
}

/**
 * Set aside a plan's rows that are copies on one account now: a row and its
 * twin must sit on the same account (after a move, the save merged them),
 * and the row must still be plain open work. Records what it set aside, also
 * when a later chunk throws; then rethrows.
 */
export async function applyTwins(
  supabase: SupabaseClient,
  companyId: string,
  plan: TwinsPlan,
  options: ApplyTwinsOptions,
): Promise<TwinSetAside[]> {
  if (plan.setAside.length === 0) return []
  const done: TwinSetAside[] = []
  const accountOf = new Map<string, string | null>()
  try {
    // Where the rows and their twins are now: only pairs on one account are copies there.
    const ids = [...new Set(plan.setAside.flatMap((s) => [s.transaction_id, s.twin_transaction_id]))]
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await supabase
        .from('transactions')
        .select('id, cash_account_id')
        .eq('company_id', companyId)
        .in('id', ids.slice(i, i + ID_CHUNK))
      if (error) throw dbError(error, null)
      for (const row of (data ?? []) as Array<{ id: string; cash_account_id: string | null }>) {
        accountOf.set(row.id, row.cash_account_id)
      }
    }
    const together = plan.setAside.filter((s) => {
      const account = accountOf.get(s.transaction_id)
      return !!account && account === accountOf.get(s.twin_transaction_id)
    })
    const twinOf = new Map(together.map((s) => [s.transaction_id, s.twin_transaction_id]))
    const asideIds = [...twinOf.keys()]

    for (let i = 0; i < asideIds.length; i += ID_CHUNK) {
      const part = asideIds.slice(i, i + ID_CHUNK)
      const { data: live, error: readError } = await plainOpen(supabase.from('open_bank_rows').select('id'), companyId).in('id', part)
      if (readError) throw dbError(readError, null)
      const eligible = ((live ?? []) as Array<{ id: string }>).map((r) => r.id)
      if (eligible.length === 0) continue
      const { data: written, error: writeError } = await supabase
        .from('transactions')
        .update({ is_ignored: true })
        .eq('company_id', companyId)
        .in('id', eligible)
        .eq('is_ignored', false)
        .is('journal_entry_id', null)
        .select('id')
      if (writeError) throw dbError(writeError, null)
      for (const row of (written ?? []) as Array<{ id: string }>) {
        done.push({ transaction_id: row.id, twin_transaction_id: twinOf.get(row.id)! })
      }
    }
    return done
  } finally {
    if (done.length > 0) {
      await recordSetAside(companyId, accountOf.get(done[0].transaction_id) ?? done[0].transaction_id, done, options)
    }
  }
}

/** The record follows the act, best effort like every append: a failure is logged with the ids. */
async function recordSetAside(
  companyId: string,
  cashAccountId: string,
  done: TwinSetAside[],
  options: ApplyTwinsOptions,
): Promise<void> {
  const record: AppendEventInput = {
    companyId,
    correlationId: options.correlationId,
    aggregateType: 'BankTransaction',
    aggregateId: cashAccountId,
    eventType: 'BankTransactionTwinsIgnored',
    payload: { cash_account_id: cashAccountId, reason: options.reason, count: done.length, set_aside: done },
    actor: options.actor,
    occurredAt: new Date(),
  }
  try {
    if (options.historyClient) await appendProcessingHistoryWithClient(options.historyClient, record)
    else await appendProcessingHistory(record)
  } catch (err) {
    log.error('bank rows set aside as channel twins without their processing record', {
      companyId,
      setAside: done,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
