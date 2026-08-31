import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import {
  validateOpeningBalanceLines,
  buildOpeningBalanceEntryLines,
  type OpeningBalanceLine,
} from './execute-helpers'

/**
 * Cascade an opening-balance correction to subsequent fiscal years.
 *
 * Fortnox/SIE-migrated companies get one IB verifikat per imported year, each
 * linked via fiscal_periods.opening_balance_entry_id. Correcting one year's IB
 * therefore leaves every later year's linked IB verifikat carrying the stale
 * figures. This module applies the same per-account delta (corrected minus
 * original) to each subsequent period's IB the BFL-compliant way: storno the
 * old IB verifikat, book a corrected one, relink the period.
 *
 * Periods that cannot be touched (closed, locked, behind the company lock
 * date, or with a posted bokslut on top) are skipped and reported, never
 * forced: the DB triggers enforcing those states are legally required.
 */

/** Net per-account change of a correction: (new debit-credit) minus (old debit-credit). */
export type AccountDeltas = Map<string, number>

export interface CascadeCorrectedPeriod {
  fiscal_period_id: string
  period_name: string | null
  journal_entry_id: string
  reversed_entry_id: string
}

export type CascadeSkipReason =
  | 'closed'
  | 'locked'
  | 'lock_date'
  | 'year_end'
  | 'no_opening_balance'
  | 'validation_failed'
  | 'correction_failed'

export interface CascadeSkippedPeriod {
  fiscal_period_id: string
  period_name: string | null
  reason: CascadeSkipReason
}

export interface CascadeResult {
  corrected: CascadeCorrectedPeriod[]
  skipped: CascadeSkippedPeriod[]
}

/**
 * Per-account net deltas between the original IB lines and the corrected
 * lines. Accounts whose net balance did not change are omitted, so an empty
 * map means "nothing to cascade".
 */
export function computeAccountDeltas(
  oldLines: OpeningBalanceLine[],
  newLines: OpeningBalanceLine[],
): AccountDeltas {
  const nets = new Map<string, { oldNet: number; newNet: number }>()

  for (const line of oldLines) {
    const slot = nets.get(line.account_number) ?? { oldNet: 0, newNet: 0 }
    slot.oldNet = roundOre(slot.oldNet + (line.debit_amount - line.credit_amount))
    nets.set(line.account_number, slot)
  }
  for (const line of newLines) {
    const slot = nets.get(line.account_number) ?? { oldNet: 0, newNet: 0 }
    slot.newNet = roundOre(slot.newNet + (line.debit_amount - line.credit_amount))
    nets.set(line.account_number, slot)
  }

  const deltas: AccountDeltas = new Map()
  for (const [account, { oldNet, newNet }] of nets) {
    const delta = roundOre(newNet - oldNet)
    if (Math.abs(delta) >= 0.01) deltas.set(account, delta)
  }
  return deltas
}

/**
 * Apply per-account deltas to an existing IB's lines, producing the corrected
 * line set for that period. Nets are computed per account, shifted by the
 * delta, and re-split into debit/credit; zero-net accounts are dropped.
 * Both inputs balance (sum of deltas is zero because both source entries
 * balanced), so the output balances too.
 */
export function applyDeltasToLines(
  existingLines: OpeningBalanceLine[],
  deltas: AccountDeltas,
): OpeningBalanceLine[] {
  const nets = new Map<string, number>()
  for (const line of existingLines) {
    const prev = nets.get(line.account_number) ?? 0
    nets.set(line.account_number, roundOre(prev + (line.debit_amount - line.credit_amount)))
  }
  for (const [account, delta] of deltas) {
    const prev = nets.get(account) ?? 0
    nets.set(account, roundOre(prev + delta))
  }

  return [...nets.entries()]
    .filter(([, net]) => Math.abs(net) >= 0.01)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account_number, net]) => ({
      account_number,
      debit_amount: net > 0 ? net : 0,
      credit_amount: net < 0 ? roundOre(-net) : 0,
    }))
}

/** Fetch an entry's lines in the OpeningBalanceLine shape, paginated. */
export async function fetchEntryOpeningBalanceLines(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
): Promise<OpeningBalanceLine[]> {
  // Two-step entry-lines fetch: verifies company_id ownership on the entry
  // side (defense in depth alongside RLS) and paginates. Same pattern as
  // lib/reports/opening-balances.ts.
  const rows = await fetchEntryLines<{
    id: string
    account_number: string
    debit_amount: number | string
    credit_amount: number | string
  }>({
    supabase,
    lineColumns: 'id, account_number, debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) => q.eq('id', entryId).eq('company_id', companyId),
    attachEntriesAs: null,
  })

  return rows.map((r) => ({
    account_number: r.account_number,
    debit_amount: Number(r.debit_amount) || 0,
    credit_amount: Number(r.credit_amount) || 0,
  }))
}

interface SubsequentPeriodRow {
  id: string
  name: string | null
  period_start: string
  is_closed: boolean
  locked_at: string | null
  opening_balance_entry_id: string | null
  opening_balance_entry: {
    voucher_series: string | null
    voucher_number: number | null
  } | null
}

export interface CascadeOptions {
  /** period_start of the period whose IB was just corrected. */
  basePeriodStart: string
  /** Per-account net deltas from the base correction. */
  deltas: AccountDeltas
  /** company_settings.bookkeeping_locked_through, already fetched by the caller. */
  lockDate: string | null
  log: Logger
}

/**
 * Storno + rebook + relink each subsequent period's IB with the deltas
 * applied. Each period is independent: a failure in one year is compensated
 * (the freshly booked replacement is stornoed) and reported as skipped, and
 * the cascade continues with the next year.
 */
export async function cascadeOpeningBalanceCorrection(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  options: CascadeOptions,
): Promise<CascadeResult> {
  const { basePeriodStart, deltas, lockDate, log } = options
  const result: CascadeResult = { corrected: [], skipped: [] }

  if (deltas.size === 0) return result

  const { data: periods, error: periodsError } = await supabase
    .from('fiscal_periods')
    .select(
      'id, name, period_start, is_closed, locked_at, opening_balance_entry_id, opening_balance_entry:journal_entries!opening_balance_entry_id(voucher_series, voucher_number)',
    )
    .eq('company_id', companyId)
    .gt('period_start', basePeriodStart)
    .order('period_start', { ascending: true })

  if (periodsError) {
    // The base correction already succeeded; surface the cascade as fully
    // skipped rather than failing the request.
    log.error('opening balance cascade: could not list subsequent periods', {
      audit: true,
      event: 'opening_balance.cascade_list_failed',
      companyId,
      reason: periodsError.message,
    })
    return result
  }

  for (const period of (periods ?? []) as unknown as SubsequentPeriodRow[]) {
    const skip = (reason: CascadeSkipReason) => {
      result.skipped.push({
        fiscal_period_id: period.id,
        period_name: period.name,
        reason,
      })
    }

    if (!period.opening_balance_entry_id) {
      // No linked IB verifikat: reports fall back to computing prior balances,
      // which already reflect the base correction. Reported for transparency.
      skip('no_opening_balance')
      continue
    }
    if (period.is_closed) {
      skip('closed')
      continue
    }
    if (period.locked_at) {
      skip('locked')
      continue
    }
    if (lockDate && period.period_start <= lockDate) {
      skip('lock_date')
      continue
    }

    const { count: yearEndCount } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('fiscal_period_id', period.id)
      .eq('source_type', 'year_end')
      .eq('status', 'posted')

    if ((yearEndCount ?? 0) > 0) {
      skip('year_end')
      continue
    }

    const oldEntryId = period.opening_balance_entry_id

    let correctedLines: OpeningBalanceLine[]
    try {
      const existingLines = await fetchEntryOpeningBalanceLines(supabase, companyId, oldEntryId)
      correctedLines = applyDeltasToLines(existingLines, deltas)
    } catch (err) {
      log.error('opening balance cascade: line fetch failed', {
        audit: true,
        event: 'opening_balance.cascade_period_failed',
        companyId,
        fiscalPeriodId: period.id,
        oldEntryId,
        reason: err instanceof Error ? err.message : 'unknown',
      })
      skip('correction_failed')
      continue
    }

    const validation = validateOpeningBalanceLines(correctedLines)
    if (!validation.ok) {
      skip('validation_failed')
      continue
    }

    // BFL 5 kap 5§: reference the verifikat being rättat, same convention as
    // the base correction.
    const voucherLabel =
      period.opening_balance_entry?.voucher_series && period.opening_balance_entry?.voucher_number
        ? `${period.opening_balance_entry.voucher_series}${period.opening_balance_entry.voucher_number}`
        : null
    const description = voucherLabel
      ? `Ingående balanser (korrigerade, rättelse av ${voucherLabel})`
      : 'Ingående balanser (korrigerade)'

    const auditFailure = (fields: Record<string, unknown>) => {
      log.error('audit: opening balance cascade correction failed', {
        audit: true,
        event: 'opening_balance.cascade_period_failed',
        companyId,
        userId,
        fiscalPeriodId: period.id,
        oldEntryId,
        ...fields,
      })
    }

    // Same create-before-reverse order and compensation pattern as the base
    // correction: the period must never be left without an opening balance.
    let newEntry: { id: string }
    try {
      newEntry = await createJournalEntry(supabase, companyId, userId, {
        fiscal_period_id: period.id,
        entry_date: period.period_start,
        description,
        source_type: 'opening_balance',
        voucher_series: 'A',
        lines: buildOpeningBalanceEntryLines(validation.validLines),
      })
    } catch (err) {
      auditFailure({ phase: 'create_failed', reason: err instanceof Error ? err.message : 'unknown' })
      skip('correction_failed')
      continue
    }

    try {
      await reverseEntry(supabase, companyId, userId, oldEntryId)

      const { error: relinkError } = await supabase.rpc('replace_period_opening_balance_link', {
        p_company_id: companyId,
        p_period_id: period.id,
        p_new_entry_id: newEntry.id,
      })
      if (relinkError) {
        throw new Error(`replace_period_opening_balance_link failed: ${relinkError.message}`)
      }

      result.corrected.push({
        fiscal_period_id: period.id,
        period_name: period.name,
        journal_entry_id: newEntry.id,
        reversed_entry_id: oldEntryId,
      })
    } catch (seqErr) {
      const reason = seqErr instanceof Error ? seqErr.message : 'unknown'
      auditFailure({ phase: 'sequence_failed', reason, newEntryId: newEntry.id })

      try {
        await reverseEntry(supabase, companyId, userId, newEntry.id)
        auditFailure({ phase: 'compensated', reason, newEntryId: newEntry.id })
      } catch (compErr) {
        auditFailure({
          phase: 'compensation_failed',
          reason,
          newEntryId: newEntry.id,
          compensationError: compErr instanceof Error ? compErr.message : 'unknown',
        })
      }

      skip('correction_failed')
    }
  }

  return result
}
