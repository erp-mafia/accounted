import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import type { CashAccount, ProcessingHistoryActor } from '@/types'
import { createLogger } from '@/lib/logger'
import { appendProcessingHistoryWithClient } from '@/lib/processing-history/append'
import {
  findMovableTransactionIds,
  ledgersWithPostedLines,
  physicalAccountKey,
  pickKeeper,
  rebindMovableTransactions,
  setPrimary,
  upsertFromPsd2,
} from '@/lib/cash-accounts/service'

const log = createLogger('cash-accounts-heal')

/**
 * Merge the twin cash_accounts rows a broken reconnect left behind (one IBAN +
 * currency, several rows), so one bank account is one row on one ledger again.
 *
 * Per group:
 *   1. pickKeeper names the row that stays (posted lines, then primary, then
 *      oldest). A group whose posted lines already sit on two ledgers is
 *      SKIPPED: any correction there is a storno the user decides on.
 *   2. The live row is the one whose (connection, uid) an ACTIVE connection
 *      still lists in accounts_data. No such row, or several: SKIPPED (a
 *      re-auth goes through resolvePsd2LedgerAccount, which ranks the same way).
 *      Also SKIPPED when accounts_data routes that uid onto a ledger outside
 *      the group.
 *   3. accounts_data is re-pointed at the keeper's ledger FIRST: sync routes by
 *      that ledger (enable-banking sync, settlementAccount), so from this write
 *      on new transactions land on the keeper whatever happens next.
 *   4. When the keeper is not the live row, upsertFromPsd2 re-keys it to the
 *      live uid through its existing reuse path, which rebinds the movable
 *      transactions, demotes or deletes the live duplicate and hands over the
 *      primary flag.
 *   5. Every other stale row has its movable transactions rebound. A
 *      connection-held row is then deleted when empty, demoted to manual when
 *      booked transactions remain. A row that is ALREADY manual is never
 *      deleted: it may be the company's seeded account.
 *
 * Posted journal entries and their lines are never touched. Booked or anchored
 * transactions keep their binding: their voucher carries the old 19xx line.
 *
 * The whole company is PLANNED before anything is written. A write run must
 * name the fingerprint of the plan the operator reviewed; a plan that changed
 * in between (a sync, a re-auth) aborts before the first write. The steps are
 * PostgREST calls, not one transaction, so they are ordered to leave a safe
 * state after every prefix (routing first, primary handover before any row is
 * retired) and a re-run picks up where a failed run stopped.
 *
 * Each merged group writes one CashAccountTwinsMerged behandlingshistorik
 * event (BFNAR 2013:2 p. 9.16), before its first mutation: re-pointing accounts_data changes which BAS
 * account future bank transactions land on, and a deleted row leaves no other
 * durable trace that the twin existed.
 */

export type TwinSkipReason =
  | 'split-ledgers'
  | 'no-live-row'
  | 'several-live-rows'
  | 'routing-outside-group'

export interface TwinRowReport {
  id: string
  ledger_account: string
  movable: number
  /** Transactions that stay bound (booked or anchored). */
  staying: number
  outcome: 'rekeyed-into-keeper' | 'deleted' | 'demoted-to-manual' | 'kept-manual'
}

export interface TwinGroupReport {
  physicalKey: string
  ledgers: string[]
  postedLedgers: string[]
  skipped: TwinSkipReason | null
  keeper: { id: string; ledger_account: string } | null
  liveRowId: string | null
  /** accounts_data ledger before the heal, when it differs from the keeper's. */
  accountsDataLedgerFrom: string | null
  retired: TwinRowReport[]
}

export interface HealTwinsResult {
  companyId: string
  dryRun: boolean
  /** Identifies this exact plan; a write run must echo it back. */
  fingerprint: string
  groups: TwinGroupReport[]
}

export type HealTwinsOptions =
  | { dryRun: true }
  | {
      dryRun: false
      /** `fingerprint` of the dry run the operator reviewed. */
      expectedFingerprint: string
      /** Recorded on every CashAccountTwinsMerged event. */
      actor: ProcessingHistoryActor
    }

/** Order-independent digest of what a plan would do. */
export function planFingerprint(groups: readonly TwinGroupReport[]): string {
  const canonical = groups
    .map((g) => ({
      key: g.physicalKey,
      skipped: g.skipped,
      keeper: g.keeper ? `${g.keeper.id}:${g.keeper.ledger_account}` : null,
      live: g.liveRowId,
      from: g.accountsDataLedgerFrom,
      retired: g.retired
        .map((r) => `${r.id}:${r.ledger_account}:${r.outcome}:${r.movable}:${r.staying}`)
        .sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12)
}

type ConnectionRow = {
  id: string
  status: string
  accounts_data: Array<{ uid?: string; ledger_account?: string }> | null
}

export async function healTwinCashAccounts(
  supabase: SupabaseClient,
  companyId: string,
  options: HealTwinsOptions,
): Promise<HealTwinsResult> {
  const result: HealTwinsResult = { companyId, dryRun: options.dryRun, fingerprint: '', groups: [] }
  result.fingerprint = planFingerprint(result.groups)

  const { data: rowData, error: rowError } = await supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
  if (rowError) throw new Error(`cash_accounts read failed: ${rowError.message}`)

  const byKey = new Map<string, CashAccount[]>()
  for (const row of (rowData ?? []) as CashAccount[]) {
    const key = physicalAccountKey(row)
    if (!key) continue
    const group = byKey.get(key)
    if (group) group.push(row)
    else byKey.set(key, [row])
  }
  const twinGroups = [...byKey.entries()].filter(([, rows]) => rows.length > 1)
  if (twinGroups.length === 0) return result
  const executions: Array<() => Promise<void>> = []

  const { data: connData, error: connError } = await supabase
    .from('bank_connections')
    .select('id, status, accounts_data')
    .eq('company_id', companyId)
  if (connError) throw new Error(`bank_connections read failed: ${connError.message}`)
  const connections = new Map(((connData ?? []) as ConnectionRow[]).map((c) => [c.id, c]))

  const posted = await ledgersWithPostedLines(
    supabase,
    companyId,
    twinGroups.flatMap(([, rows]) => rows.map((r) => r.ledger_account)),
  )

  for (const [physicalKey, rows] of twinGroups) {
    const report: TwinGroupReport = {
      physicalKey,
      ledgers: rows.map((r) => r.ledger_account),
      postedLedgers: rows.map((r) => r.ledger_account).filter((l) => posted.has(l)),
      skipped: null,
      keeper: null,
      liveRowId: null,
      accountsDataLedgerFrom: null,
      retired: [],
    }
    result.groups.push(report)

    const keeper = pickKeeper(rows, posted)
    if (!keeper) {
      report.skipped = 'split-ledgers'
      continue
    }
    report.keeper = { id: keeper.id, ledger_account: keeper.ledger_account }

    const liveRows = rows.filter((r) => {
      const conn = r.bank_connection_id ? connections.get(r.bank_connection_id) : undefined
      return (
        conn?.status === 'active' &&
        (conn.accounts_data ?? []).some((a) => a.uid === r.external_uid)
      )
    })
    if (liveRows.length !== 1) {
      report.skipped = liveRows.length === 0 ? 'no-live-row' : 'several-live-rows'
      continue
    }
    const live = liveRows[0]
    report.liveRowId = live.id
    const liveConn = connections.get(live.bank_connection_id as string) as ConnectionRow
    const liveEntry = (liveConn.accounts_data ?? []).find((a) => a.uid === live.external_uid)
    // Seen on prod: accounts_data routes the live uid onto a ledger NO row of
    // this group holds (another account's 1930). Re-pointing it would move the
    // feed between two different accounts' ledgers, which is not this merge's
    // call to make.
    if (liveEntry?.ledger_account && !rows.some((r) => r.ledger_account === liveEntry.ledger_account)) {
      report.skipped = 'routing-outside-group'
      report.accountsDataLedgerFrom = liveEntry.ledger_account
      continue
    }
    if (liveEntry?.ledger_account !== keeper.ledger_account) {
      report.accountsDataLedgerFrom = liveEntry?.ledger_account ?? null
    }

    for (const row of rows) {
      if (row.id === keeper.id) continue
      const movable = (await findMovableTransactionIds(supabase, companyId, row.id)).length
      const total = await countTransactions(supabase, companyId, row.id)
      const staying = total - movable
      report.retired.push({
        id: row.id,
        ledger_account: row.ledger_account,
        movable,
        staying,
        outcome:
          row.id === live.id
            ? 'rekeyed-into-keeper'
            : row.bank_connection_id === null
              ? 'kept-manual'
              : staying > 0
                ? 'demoted-to-manual'
                : 'deleted',
      })
    }
    executions.push(async () => {
      // The behandlingshistorik record is written BEFORE the first mutation.
      // An event whose merge then fails half-way is recoverable: the re-run
      // plans what is left and records that too. A finished merge whose event
      // failed is not: the rows are no longer a twin group, so nothing would
      // ever write it. No IBAN in the payload: row ids and ledgers identify
      // the accounts.
      await appendProcessingHistoryWithClient(supabase, {
        companyId,
        correlationId,
        aggregateType: 'System',
        aggregateId: keeper.id,
        eventType: 'CashAccountTwinsMerged',
        payload: {
          keeper: report.keeper,
          live_row_id: live.id,
          bank_connection_id: liveConn.id,
          sync_ledger_before: liveEntry?.ledger_account ?? null,
          sync_ledger_after: keeper.ledger_account,
          retired: report.retired,
          plan_fingerprint: result.fingerprint,
        },
        actor,
        occurredAt: new Date(),
      })

      // Primary handover first: a stale primary must never be retired while
      // it still carries the flag, or a failure in between leaves the company
      // without the intended primary. The RPC swaps atomically.
      if (rows.some((r) => r.id !== keeper.id && r.is_primary)) {
        await setPrimary(supabase, companyId, keeper.id)
      }

      // Step 3: route the next sync onto the keeper's ledger before any row moves.
      if (liveEntry?.ledger_account !== keeper.ledger_account) {
        const nextAccounts = (liveConn.accounts_data ?? []).map((a) =>
          a.uid === live.external_uid ? { ...a, ledger_account: keeper.ledger_account } : a,
        )
        const { error } = await supabase
          .from('bank_connections')
          .update({ accounts_data: nextAccounts })
          .eq('id', liveConn.id)
          .eq('company_id', companyId)
        if (error) throw new Error(`accounts_data re-point failed: ${error.message}`)
        liveConn.accounts_data = nextAccounts
      }

      // Step 4: re-key the keeper to the live uid through the existing reuse path.
      if (live.id !== keeper.id) {
        await upsertFromPsd2(supabase, companyId, {
          bank_connection_id: live.bank_connection_id as string,
          external_uid: live.external_uid as string,
          currency: live.currency,
          ledger_account: keeper.ledger_account,
          iban: live.iban,
          bban: live.bban,
          name: keeper.name ?? live.name,
          balance: live.balance,
          available_balance: live.available_balance,
          balance_updated_at: live.balance_updated_at,
          enabled: live.enabled,
          reuse_cash_account_id: keeper.id,
        })
      }

      // Step 5: the remaining stale rows.
      for (const row of rows) {
        if (row.id === keeper.id || row.id === live.id) continue
        await rebindMovableTransactions(supabase, companyId, row.id, keeper.id)
        if (row.bank_connection_id === null) continue
        const remaining = await countTransactions(supabase, companyId, row.id)
        const { error } =
          remaining > 0
            ? await supabase
                .from('cash_accounts')
                .update({ bank_connection_id: null, external_uid: null })
                .eq('id', row.id)
                .eq('company_id', companyId)
            : await supabase.from('cash_accounts').delete().eq('id', row.id).eq('company_id', companyId)
        if (error) throw new Error(`retiring cash account ${row.id} failed: ${error.message}`)
      }

      log.info('healed twin cash accounts', {
        companyId,
        keeperId: keeper.id,
        keeperLedger: keeper.ledger_account,
        retired: report.retired.map((r) => ({ id: r.id, outcome: r.outcome, movable: r.movable })),
        accountsDataLedgerFrom: report.accountsDataLedgerFrom,
      })
    })
  }

  result.fingerprint = planFingerprint(result.groups)
  if (options.dryRun) return result
  if (options.expectedFingerprint !== result.fingerprint) {
    throw new Error(
      `plan changed since the reviewed dry run (expected ${options.expectedFingerprint}, now ${result.fingerprint}): nothing written, review the new dry run`,
    )
  }
  const actor = options.actor
  const correlationId = randomUUID()
  for (const execute of executions) await execute()

  return result
}

async function countTransactions(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('cash_account_id', cashAccountId)
  if (error) throw new Error(`transactions count failed: ${error.message}`)
  return count ?? 0
}
