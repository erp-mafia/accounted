import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExtensionContext } from '@/lib/extensions/types'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { formatRedovisare } from '@/lib/skatteverket/format'
import { settleAgiTaxPayments } from './agi-tax-settlement'
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

/**
 * Compute the dedup key for a transaction.
 *
 * - When `transaktionsidentitet` is present (always on tidigare, sometimes
 *   on kommande), use it directly. It's stable across syncs.
 * - Otherwise compute a sha256 hex over (date|amount|text): stable enough
 *   for kommande, which graduate to tidigare with the same content.
 *
 * The point of this function is reproducibility: the same logical
 * transaction must always produce the same dedup_key.
 */
export function computeDedupKey(tx: {
  transaktionsidentitet?: number | null
  transaktionsdatum: string
  beloppSkatteverket: number
  transaktionstext: string
}): string {
  if (tx.transaktionsidentitet != null) {
    return `id:${tx.transaktionsidentitet}`
  }
  const material = `${tx.transaktionsdatum}|${tx.beloppSkatteverket}|${tx.transaktionstext}`
  return `h:${crypto.createHash('sha256').update(material).digest('hex')}`
}

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
function bookedToRow(
  companyId: string,
  tx: SkatteverketBookedTransaction,
): Omit<StoredSkattekontoTransaction, 'id' | 'imported_at' | 'updated_at' | 'journal_entry_id'> {
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
  }
}

function upcomingToRow(
  companyId: string,
  tx: SkatteverketUpcomingTransaction,
): Omit<StoredSkattekontoTransaction, 'id' | 'imported_at' | 'updated_at' | 'journal_entry_id'> {
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
  // Defaults to the ctx user's personal token: the interactive manual-sync
  // route keeps its exact pre-hybrid behavior. The cron passes system auth
  // for companies with a verified lasombud grant.
  auth: SkvAuth = { mode: 'user', supabase: ctx.supabase, userId: ctx.userId },
): Promise<SkattekontoSyncResult> {
  const omfragad = await resolveOmfragad(ctx.supabase, ctx.companyId)

  let saldo: SkatteverketSaldoResponse
  let transaktioner: Awaited<ReturnType<typeof getTransaktioner>>
  try {
    ;[saldo, transaktioner] = await Promise.all([
      getSaldo(auth, omfragad),
      getTransaktioner(auth, omfragad),
    ])
  } catch (err) {
    if (err instanceof SkatteverketAuthError) {
      if (
        err.code === 'REFRESH_EXHAUSTED' ||
        err.code === 'SESSION_EXPIRED' ||
        err.code === 'TOKEN_CORRUPTED'
      ) {
        await eventBus.emit({
          type: 'skattekonto.connection.expired',
          payload: {
            reason: err.code,
            userId: ctx.userId,
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

  if (allRows.length > 0) {
    const { error } = await ctx.supabase
      .from('skattekonto_transactions')
      .upsert(allRows, {
        onConflict: 'company_id,dedup_key',
        // Don't return rows: we already know what we wrote.
        ignoreDuplicates: false,
      })
    if (error) {
      log.error('upsert failed', { companyId: ctx.companyId, message: error.message })
      throw new Error(`Kunde inte spara skattekonto-transaktioner: ${error.message}`)
    }
  }

  // Auto-settle AGI tax payments: when the "Arbetsgivardeklaration YYYYMM"
  // debit is booked and the account is not in deficit, the period is paid.
  // Best-effort inside (never throws).
  await settleAgiTaxPayments(
    ctx.supabase,
    ctx.companyId,
    bookedRows,
    saldo.saldoSkatteverket,
  )

  // Cache balance snapshot.
  const snapshot: SkattekontoBalanceSnapshot = {
    saldo,
    fetchedAt: Date.now(),
  }
  await ctx.settings.set(BALANCE_SNAPSHOT_KEY, snapshot)
  await ctx.settings.set(LAST_SYNCED_AT_KEY, new Date().toISOString())

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
