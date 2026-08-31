import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { CreateJournalEntryLineInput } from '@/types'
import { roundOre } from '@/lib/money'
import { replaceOpeningBalanceEntry } from '@/lib/bookkeeping/engine'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import {
  validateOpeningBalanceLines,
  type OpeningBalanceLine,
} from './execute-helpers'

/**
 * Cascade an opening-balance correction to subsequent fiscal years.
 *
 * Fortnox/SIE-migrated companies get one IB verifikat per imported year, each
 * linked via fiscal_periods.opening_balance_entry_id. Correcting one year's IB
 * therefore leaves every later year's linked IB verifikat carrying the stale
 * figures. This module applies the same per-account delta (corrected minus
 * original) to each subsequent period's IB the BFL-compliant way, via the
 * atomic replaceOpeningBalanceEntry engine primitive (one DB transaction owns
 * the storno, the corrected voucher, and the period pointer swap, with a CAS
 * on the expected old entry id), so a failure leaves the period untouched.
 *
 * The corrected verifikat keeps the original lines verbatim (descriptions and
 * dimensions included) and appends one adjustment line per changed account,
 * so years the user never opened stay reviewable line by line.
 *
 * Periods that cannot be touched (closed, locked, behind the company lock
 * date, or with a posted bokslut on top) are skipped and reported, never
 * forced: the DB triggers enforcing those states are legally required.
 */

/** Net per-account change of a correction: (new debit-credit) minus (old debit-credit). */
export type AccountDeltas = Map<string, number>

/** An existing IB line with the fields the rebooked verifikat must preserve. */
export interface CascadeSourceLine extends OpeningBalanceLine {
  line_description: string | null
  dimensions: Record<string, string> | null
}

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
 * Build the corrected line set for a subsequent period: the existing lines
 * verbatim (keeping description and dimensions), plus one labelled adjustment
 * line per delta account. Both the existing entry and the delta set balance
 * (deltas come from two balanced entries), so the result balances too.
 */
export function buildCascadedLines(
  existingLines: CascadeSourceLine[],
  deltas: AccountDeltas,
): CreateJournalEntryLineInput[] {
  const kept: CreateJournalEntryLineInput[] = existingLines
    .filter((l) => l.debit_amount > 0 || l.credit_amount > 0)
    .map((l) => ({
      account_number: l.account_number,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
      line_description: l.line_description ?? undefined,
      dimensions: l.dimensions ?? undefined,
    }))

  const adjustments: CreateJournalEntryLineInput[] = [...deltas.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account_number, delta]) => ({
      account_number,
      debit_amount: delta > 0 ? delta : 0,
      credit_amount: delta < 0 ? roundOre(-delta) : 0,
      line_description: `IB-rättelse ${account_number}`,
    }))

  return [...kept, ...adjustments]
}

/** Fetch an entry's lines with the fields a cascaded rebook must preserve. */
export async function fetchEntryOpeningBalanceLines(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
): Promise<CascadeSourceLine[]> {
  // Two-step entry-lines fetch: verifies company_id ownership on the entry
  // side (defense in depth alongside RLS) and paginates. Same pattern as
  // lib/reports/opening-balances.ts.
  const rows = await fetchEntryLines<{
    id: string
    account_number: string
    debit_amount: number | string
    credit_amount: number | string
    line_description: string | null
    dimensions: Record<string, string> | null
  }>({
    supabase,
    lineColumns: 'id, account_number, debit_amount, credit_amount, line_description, dimensions',
    filterEntries: (q: EntryLinesQuery) => q.eq('id', entryId).eq('company_id', companyId),
    attachEntriesAs: null,
  })

  return rows.map((r) => ({
    account_number: r.account_number,
    debit_amount: Number(r.debit_amount) || 0,
    credit_amount: Number(r.credit_amount) || 0,
    line_description: r.line_description ?? null,
    dimensions: r.dimensions ?? null,
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
 * Replace each subsequent period's IB with the deltas applied, one atomic
 * engine replacement per period. Each period is independent: a failure is
 * reported as skipped (the RPC transaction leaves that period untouched) and
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

    const auditFailure = (fields: Record<string, unknown>) => {
      log.error('audit: opening balance cascade correction failed', {
        audit: true,
        event: 'opening_balance.cascade_period_failed',
        companyId,
        userId,
        fiscalPeriodId: period.id,
        oldEntryId: period.opening_balance_entry_id,
        ...fields,
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

    // Fail CLOSED: a failed lookup must not read as "no bokslut", or the
    // cascade would rewrite the IB of a period with a posted year-end.
    const { count: yearEndCount, error: yearEndError } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('fiscal_period_id', period.id)
      .eq('source_type', 'year_end')
      .eq('status', 'posted')

    if (yearEndError) {
      auditFailure({ phase: 'year_end_check_failed', reason: yearEndError.message })
      skip('correction_failed')
      continue
    }
    if ((yearEndCount ?? 0) > 0) {
      skip('year_end')
      continue
    }

    const oldEntryId = period.opening_balance_entry_id

    let lines: CreateJournalEntryLineInput[]
    try {
      const existingLines = await fetchEntryOpeningBalanceLines(supabase, companyId, oldEntryId)
      lines = buildCascadedLines(existingLines, deltas)
    } catch (err) {
      auditFailure({
        phase: 'line_fetch_failed',
        reason: err instanceof Error ? err.message : 'unknown',
      })
      skip('correction_failed')
      continue
    }

    const validation = validateOpeningBalanceLines(
      lines.map((l) => ({
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
      })),
    )
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

    // One RPC transaction: storno the old IB, commit the corrected one, swap
    // fiscal_periods.opening_balance_entry_id, CAS-guarded on oldEntryId. Any
    // failure (including a period locked between our pre-check and the write)
    // rolls the whole period back: no compensation pass, no half states.
    try {
      const replacement = await replaceOpeningBalanceEntry(supabase, companyId, userId, oldEntryId, {
        fiscal_period_id: period.id,
        entry_date: period.period_start,
        description,
        source_type: 'opening_balance',
        voucher_series: 'A',
        lines,
      })

      result.corrected.push({
        fiscal_period_id: period.id,
        period_name: period.name,
        journal_entry_id: replacement.newEntryId,
        reversed_entry_id: oldEntryId,
      })
    } catch (err) {
      auditFailure({
        phase: 'replacement_failed',
        reason: err instanceof Error ? err.message : 'unknown',
      })
      skip('correction_failed')
    }
  }

  return result
}
