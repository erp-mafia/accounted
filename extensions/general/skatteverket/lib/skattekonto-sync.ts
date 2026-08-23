import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExtensionContext } from '@/lib/extensions/types'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { formatRedovisare } from '@/lib/skatteverket/format'
import { computeDedupKey, contentSignature } from '@/lib/skatteverket/skattekonto-dedup'
import { getEarliestFiscalPeriodStart } from '@/lib/core/bookkeeping/period-service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { settleAgiTaxPayments } from './agi-tax-settlement'
import { refreshSkattekontoProposals } from './skattekonto-proposals'
import { getSkattekontoReconciliationStatus } from '@/lib/reconciliation/skattekonto-reconciliation'
import {
  SKATTEKONTO_RECONCILIATION_LATEST_KEY,
  type SkattekontoReconciliationLatest,
} from '@/lib/reconciliation/skattekonto-latest'
import { getSaldo, getTransaktioner } from './skattekonto-client'
import { SkatteverketAuthError, type SkvAuth } from './api-client'
import type {
  SkatteverketBookedTransaction,
  SkatteverketUpcomingTransaction,
  SkatteverketSaldoResponse,
  SkattekontoBalanceSnapshot,
  StoredSkattekontoTransaction,
} from '../types'

const log = createLogger('skattekonto-sync')

const BALANCE_SNAPSHOT_KEY = 'skattekonto_balance_snapshot'
const LAST_SYNCED_AT_KEY = 'skattekonto_last_synced_at'

/** SKV's default lookback for tidigare transaktioner when no datumFrom is sent. */
const SKV_DEFAULT_WINDOW_DAYS = 555

function isoDateDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/**
 * Clamp the bookkeeping-start lower bound to SKV's own window.
 *
 * Sending a datumFrom OLDER than the 555-day default would silently widen
 * the fetch past what an unbounded call returns, and anything older than
 * ~915 days is rejected outright (felkod 2). In both cases omitting the
 * parameter is identical to what we actually want (the default window), so
 * a bound is only sent when it is strictly inside the default window.
 */
function clampDatumFrom(earliestPeriodStart: string | null): string | undefined {
  if (!earliestPeriodStart) return undefined
  const defaultFrom = isoDateDaysAgo(SKV_DEFAULT_WINDOW_DAYS)
  return earliestPeriodStart > defaultFrom ? earliestPeriodStart : undefined
}

export interface SkattekontoSyncResult {
  /** Number of new or status-promoted booked rows */
  booked: number
  /** Number of new or updated upcoming rows */
  upcoming: number
  /** Saldo at end of sync (mirrors snapshot) */
  saldoSkatteverket: number
  saldoKronofogden: number
  /** Sync timestamp */
  syncedAt: string
}

// Dedup key computation moved to core (lib/skatteverket/skattekonto-dedup):
// the skattekontoutdrag file importer is a second producer of this table and
// must compute byte-identical keys. Re-exported so existing extension-side
// imports keep working.
export { computeDedupKey }

/**
 * Resolve the org/personnummer to send to Skatteverket as `omfragad`.
 * Reads from company_settings: same source the existing momsdeklaration
 * flow uses.
 */
async function resolveOmfragad(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('org_number, entity_type')
    .eq('company_id', companyId)
    .single()

  if (!settings?.org_number) {
    throw new Error('Organisationsnummer saknas i företagsinställningar')
  }

  return formatRedovisare(settings.org_number, settings.entity_type)
}

/**
 * Build the row to insert/upsert into skattekonto_transactions.
 */
// file_import_id is excluded from the upsert payload on purpose: when the
// sync takes over a file-imported row (see below) the provenance link back
// to the uploaded file should survive the conflict-update. is_ignored is
// likewise excluded: it is a user decision, and a nightly sync must never
// silently un-ignore a row via the conflict-update.
type SyncRow = Omit<
  StoredSkattekontoTransaction,
  'id' | 'imported_at' | 'updated_at' | 'journal_entry_id' | 'file_import_id' | 'is_ignored'
>

function bookedToRow(companyId: string, tx: SkatteverketBookedTransaction): SyncRow {
  return {
    company_id: companyId,
    transaktionsidentitet: tx.transaktionsidentitet,
    dedup_key: computeDedupKey(tx),
    transaktionsdatum: tx.transaktionsdatum,
    forfallodatum: null,
    ranteberakningsdatum: tx.ranteberakningsdatum,
    transaktionstext: tx.transaktionstext,
    belopp_skatteverket: tx.beloppSkatteverket,
    belopp_kronofogden: tx.beloppKronofogden,
    status: 'booked',
    source: 'api',
  }
}

function upcomingToRow(companyId: string, tx: SkatteverketUpcomingTransaction): SyncRow {
  return {
    company_id: companyId,
    transaktionsidentitet: tx.transaktionsidentitet ?? null,
    dedup_key: computeDedupKey(tx),
    transaktionsdatum: tx.transaktionsdatum,
    forfallodatum: tx.forfallodatum,
    ranteberakningsdatum: tx.ranteberakningsdatum,
    transaktionstext: tx.transaktionstext,
    belopp_skatteverket: tx.beloppSkatteverket,
    belopp_kronofogden: tx.beloppKronofogden,
    status: 'upcoming',
    source: 'api',
  }
}

/**
 * Sync skattekonto data for the active company in `ctx`.
 *
 * Steps:
 * 1. Resolve omfragad from company_settings.
 * 2. Fetch saldo + transaktioner in parallel (rate-limited).
 * 3. Upsert rows by (company_id, dedup_key). When a kommande row graduates
 *    to tidigare it's updated in place: same dedup_key, status flips,
 *    transaktionsidentitet populated.
 * 4. Auto-settle AGI tax payments from booked AGI debit rows (see
 *    agi-tax-settlement.ts).
 * 5. Cache the saldo response in extension_data with a fetched-at timestamp.
 * 6. Emit skattekonto.synced and (when applicable) other events.
 */
export async function syncSkattekonto(
  ctx: ExtensionContext,
  // Defaults to the ctx user's personal token (the post-connect refresh, where
  // the ctx user just consented). The manual-sync route and the cron pass
  // resolved auth: system credentials for companies with a verified lasombud
  // grant, otherwise the token of whichever member connected the company.
  auth: SkvAuth = { mode: 'user', supabase: ctx.supabase, userId: ctx.userId, companyId: ctx.companyId },
): Promise<SkattekontoSyncResult> {
  const omfragad = await resolveOmfragad(ctx.supabase, ctx.companyId)

  // Lower-bound the transaction fetch at the company's bookkeeping start.
  // Without datumFrom, SKV defaults to ~555 days back, which for an enskild
  // firma (whose skattekonto is the owner's PERSONAL account) imports private
  // pre-company rows that can never be booked (no fiscal period covers them).
  // Applied uniformly to EF and AB, but clamped to SKV's window (see
  // clampDatumFrom): a company whose bookkeeping started more than 555 days
  // ago gets no datumFrom at all, because sending one would either widen the
  // window past the default or (past ~915 days) fail the whole sync with
  // felkod 2. No fiscal period yet (brand-new company) -> no bound either.
  const earliestPeriodStart = await getEarliestFiscalPeriodStart(
    ctx.supabase,
    ctx.companyId,
  )
  const datumFrom = clampDatumFrom(earliestPeriodStart)

  let saldo: SkatteverketSaldoResponse
  let transaktioner: Awaited<ReturnType<typeof getTransaktioner>>
  try {
    ;[saldo, transaktioner] = await Promise.all([
      getSaldo(auth, omfragad),
      getTransaktioner(auth, omfragad, datumFrom),
    ])
  } catch (err) {
    if (err instanceof SkatteverketAuthError) {
      if (
        err.code === 'REFRESH_EXHAUSTED' ||
        err.code === 'SESSION_EXPIRED' ||
        err.code === 'TOKEN_CORRUPTED'
      ) {
        // Notify the token OWNER, not whoever triggered the sync: only the
        // owner can redo the BankID consent, and the notification handler
        // keys its dedup on the owner's token row.
        await eventBus.emit({
          type: 'skattekonto.connection.expired',
          payload: {
            reason: err.code,
            userId: auth.mode === 'user' ? auth.userId : ctx.userId,
            companyId: ctx.companyId,
          },
        })
      }
    }
    throw err
  }

  const previousSnapshot = await ctx.settings.get<SkattekontoBalanceSnapshot>(
    BALANCE_SNAPSHOT_KEY,
  )
  const previousBalance = previousSnapshot?.saldo.saldoSkatteverket ?? null

  const bookedRows = transaktioner.tidigareTransaktioner.map(tx =>
    bookedToRow(ctx.companyId, tx),
  )
  const upcomingRows = transaktioner.kommandeTransaktioner.map(tx =>
    upcomingToRow(ctx.companyId, tx),
  )

  // Upsert in two steps to keep the conflict target consistent. We rely on
  // the (company_id, dedup_key) unique constraint defined in the migration.
  const allRows = [...bookedRows, ...upcomingRows]

  // Find which dedup_keys are NEW (not yet in the table) so we can fire
  // the `skattekonto.transaction.upcoming` event only for first-appearance
  // upcoming rows.
  const dedupKeys = allRows.map(r => r.dedup_key)
  const { data: existingRows } = dedupKeys.length
    ? await ctx.supabase
        .from('skattekonto_transactions')
        .select('dedup_key, status')
        .eq('company_id', ctx.companyId)
        .in('dedup_key', dedupKeys)
    : { data: [] }

  const existingMap = new Map<string, { status: 'booked' | 'upcoming' }>()
  for (const row of existingRows ?? []) {
    existingMap.set(row.dedup_key as string, {
      status: row.status as 'booked' | 'upcoming',
    })
  }

  // Take over hash-keyed rows for transactions the API now identifies.
  //
  // The skattekontoutdrag file importer writes booked rows with `h:` keys
  // (statement exports carry no transaktionsidentitet); the API keys the
  // same logical transactions `id:`. Without this step, connecting the API
  // after a file import would duplicate every imported row. Pair each
  // incoming id-keyed booked row that is NOT yet in the table against an
  // unconsumed existing `h:` row with equal content and rewrite that row's
  // identity in place: the row (and any journal_entry_id link on it)
  // survives, and the upsert below then resolves onto the new key.
  const newIdBooked = bookedRows.filter(
    r => r.transaktionsidentitet != null && !existingMap.has(r.dedup_key),
  )
  if (newIdBooked.length > 0) {
    const dates = newIdBooked.map(r => r.transaktionsdatum).sort()
    // Paged: PostgREST silently caps unpaged reads at 1000 rows, and a file
    // import covering several years can leave more hash rows than that in
    // the window; unadopted candidates would duplicate on the upsert below.
    const hashRows = await fetchAllRows<{
      id: string
      dedup_key: string
      status: string
      transaktionsdatum: string
      transaktionstext: string
      belopp_skatteverket: number
    }>(({ from, to }) =>
      ctx.supabase
        .from('skattekonto_transactions')
        .select('id, dedup_key, status, transaktionsdatum, transaktionstext, belopp_skatteverket')
        .eq('company_id', ctx.companyId)
        .like('dedup_key', 'h:%')
        .gte('transaktionsdatum', dates[0])
        .lte('transaktionsdatum', dates[dates.length - 1])
        .order('id', { ascending: true })
        .range(from, to),
    )

    if (hashRows.length > 0) {
      // Multiset pairing by content signature; booked (imported) rows are
      // preferred over stale upcoming rows with identical content.
      const bySig = new Map<string, { id: string; status: string }[]>()
      for (const row of hashRows) {
        const sig = contentSignature(
          row.transaktionsdatum,
          row.belopp_skatteverket,
          row.transaktionstext,
        )
        const queue = bySig.get(sig)
        if (queue) queue.push({ id: row.id, status: row.status })
        else bySig.set(sig, [{ id: row.id, status: row.status }])
      }
      // A proper two-argument comparator: the earlier `sort(a => ...)` form
      // is an inconsistent relation and could leave an upcoming row at the
      // head of a 3+ candidate queue, adopting the wrong row.
      for (const queue of bySig.values()) {
        queue.sort((a, b) =>
          a.status === b.status ? 0 : a.status === 'booked' ? -1 : 1,
        )
      }

      let takenOver = 0
      for (const incoming of newIdBooked) {
        const sig = contentSignature(
          incoming.transaktionsdatum,
          incoming.belopp_skatteverket,
          incoming.transaktionstext,
        )
        const queue = bySig.get(sig)
        const match = queue?.shift()
        if (!match) continue
        const { error } = await ctx.supabase
          .from('skattekonto_transactions')
          .update({
            dedup_key: incoming.dedup_key,
            transaktionsidentitet: incoming.transaktionsidentitet,
            source: 'api',
          })
          .eq('id', match.id)
          .eq('company_id', ctx.companyId)
        if (error) {
          // Non-fatal: the upsert below will then insert a fresh row, which
          // is the pre-takeover behavior (a duplicate, but never data loss).
          log.warn('hash-row takeover failed', {
            companyId: ctx.companyId,
            rowId: match.id,
            message: error.message,
          })
          continue
        }
        existingMap.set(incoming.dedup_key, { status: 'booked' })
        takenOver++
      }
      if (takenOver > 0) {
        log.info('took over file-imported rows', { companyId: ctx.companyId, takenOver })
      }
    }
  }

  // A booked row must never be flipped back to upcoming. The API's booked
  // rows always carry transaktionsidentitet, but a file-imported booked row
  // hash-keys on the same material an id-less kommande row would, so an
  // upcoming row colliding with an existing booked row is dropped rather
  // than upserted.
  const safeRows = allRows.filter(
    r => r.status !== 'upcoming' || existingMap.get(r.dedup_key)?.status !== 'booked',
  )

  if (safeRows.length > 0) {
    const { error } = await ctx.supabase
      .from('skattekonto_transactions')
      .upsert(safeRows, {
        onConflict: 'company_id,dedup_key',
        // Don't return rows: we already know what we wrote.
        ignoreDuplicates: false,
      })
    if (error) {
      log.error('upsert failed', { companyId: ctx.companyId, message: error.message })
      throw new Error(`Kunde inte spara skattekonto-transaktioner: ${error.message}`)
    }
  }

  // Auto-settle AGI tax payments: when the period's AGI debit is booked
  // (one combined "Arbetsgivardeklaration YYYYMM" row in the test
  // environment, the "Avdragen skatt" + "Arbetsgivaravgift" pair in prod)
  // and the account is not in deficit, the period is paid.
  // Best-effort inside (never throws).
  await settleAgiTaxPayments(
    ctx.supabase,
    ctx.companyId,
    bookedRows,
    saldo.saldoSkatteverket,
  )

  // Exact-twin proposals for the open rows (migration 20260823120000): the
  // reconciliation page, the worklist and agents read them from the row
  // instead of recomputing per request. Best-effort inside (never throws).
  const proposals = await refreshSkattekontoProposals(ctx.supabase, ctx.companyId)
  if (proposals.proposed > 0 || proposals.cleared > 0) {
    log.info('proposals refreshed', { companyId: ctx.companyId, ...proposals })
  }

  // Cache balance snapshot.
  const snapshot: SkattekontoBalanceSnapshot = {
    saldo,
    fetchedAt: Date.now(),
  }
  await ctx.settings.set(BALANCE_SNAPSHOT_KEY, snapshot)
  await ctx.settings.set(LAST_SYNCED_AT_KEY, new Date().toISOString())

  // Persist the reconciliation summary so the Hem notice and the attention
  // resource can read "skattekontot stämmer inte med bokföringen" cheaply
  // instead of recomputing the bridge on every render. Best effort.
  try {
    const status = await getSkattekontoReconciliationStatus(ctx.supabase, ctx.companyId)
    if (status) {
      const latest: SkattekontoReconciliationLatest = {
        as_of: status.as_of,
        computed_at: new Date().toISOString(),
        external_balance: status.external_balance,
        ledger_balance: status.ledger_balance,
        unexplained_difference: status.unexplained_difference,
        counts: {
          proposed: status.counts.proposed,
          unmatched_external: status.counts.unmatched_external,
          unmatched_ledger: status.counts.unmatched_ledger,
        },
      }
      await ctx.settings.set(SKATTEKONTO_RECONCILIATION_LATEST_KEY, latest)
    }
  } catch (err) {
    log.warn('reconciliation summary not persisted', {
      companyId: ctx.companyId,
      message: err instanceof Error ? err.message : String(err),
    })
  }

  // Emit events.
  await ctx.emit({
    type: 'skattekonto.synced',
    payload: {
      booked: bookedRows.length,
      upcoming: upcomingRows.length,
      balanceSkv: saldo.saldoSkatteverket,
      balanceKfm: saldo.saldoKronofogden,
      userId: ctx.userId,
      companyId: ctx.companyId,
    },
  })

  // Sign flip → fire balance.changed.
  if (
    previousBalance !== null &&
    Math.sign(previousBalance) !== Math.sign(saldo.saldoSkatteverket)
  ) {
    await ctx.emit({
      type: 'skattekonto.balance.changed',
      payload: {
        previousBalance,
        currentBalance: saldo.saldoSkatteverket,
        userId: ctx.userId,
        companyId: ctx.companyId,
      },
    })
  }

  // First-appearance upcoming transactions.
  for (const tx of transaktioner.kommandeTransaktioner) {
    const key = computeDedupKey(tx)
    if (existingMap.has(key)) continue
    await ctx.emit({
      type: 'skattekonto.transaction.upcoming',
      payload: {
        transaktionsdatum: tx.transaktionsdatum,
        forfallodatum: tx.forfallodatum,
        transaktionstext: tx.transaktionstext,
        beloppSkatteverket: tx.beloppSkatteverket,
        userId: ctx.userId,
        companyId: ctx.companyId,
      },
    })
  }

  return {
    booked: bookedRows.length,
    upcoming: upcomingRows.length,
    saldoSkatteverket: saldo.saldoSkatteverket,
    saldoKronofogden: saldo.saldoKronofogden,
    syncedAt: new Date().toISOString(),
  }
}

export const SKATTEKONTO_BALANCE_SNAPSHOT_KEY = BALANCE_SNAPSHOT_KEY
export const SKATTEKONTO_LAST_SYNCED_AT_KEY = LAST_SYNCED_AT_KEY
