/**
 * The register-side mirror of a storno of a K3 component replacement voucher
 * (commit_asset_component_replacement, K3 17.21A).
 *
 * reverseEntry() (lib/bookkeeping/engine.ts) is the sanctioned way back from
 * a replacement booked by mistake. The storno puts the replaced component's
 * cost and accumulated depreciation back on the books, so the register must
 * show it active again: afterReversal clears its derecognition, which
 * guard_asset_components permits only once the voucher is reversed by a
 * posted storno (the trust rule of 20260925194235). The component that
 * replaced it stays: its expenditure is still on the asset account.
 *
 * beforeReversal refuses the storno once depreciation for a later year, or
 * for the derecognition year itself, has been posted for the asset: that
 * posting was planned without the replaced component, and bringing the
 * component back underneath it would leave its charge for those years out.
 * Reverse that depreciation first.
 *
 * Kept free of engine imports so the engine can import it without a cycle.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export class AssetComponentReversalBlockedError extends Error {
  readonly code = 'ASSET_COMPONENT_REVERSAL_BLOCKED'
  constructor() {
    super('ASSET_COMPONENT_REVERSAL_BLOCKED')
    this.name = 'AssetComponentReversalBlockedError'
  }
}

interface DerecognisedRow {
  id: string
  asset_id: string
  derecognised_at: string
}

async function componentsDerecognisedBy(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<DerecognisedRow[]> {
  const { data, error } = await supabase
    .from('asset_components')
    .select('id, asset_id, derecognised_at')
    .eq('company_id', companyId)
    .eq('derecognition_journal_entry_id', journalEntryId)
  if (error) throw new Error(`component replacement lookup by voucher failed: ${error.message}`)
  return (data ?? []) as DerecognisedRow[]
}

export async function assertComponentReplacementReversible(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<void> {
  const rows = await componentsDerecognisedBy(supabase, companyId, journalEntryId)
  for (const row of rows) {
    const { data, error } = await supabase
      .from('depreciation_schedules')
      .select('id, fiscal_period:fiscal_periods!depreciation_schedules_fiscal_period_id_fkey(period_end)')
      .eq('company_id', companyId)
      .eq('asset_id', row.asset_id)
      .not('journal_entry_id', 'is', null)
    if (error) throw new Error(`component replacement reversal check failed: ${error.message}`)
    const later = ((data ?? []) as Array<{ fiscal_period: { period_end: string } | { period_end: string }[] | null }>).some(
      (schedule) => {
        const period = Array.isArray(schedule.fiscal_period) ? schedule.fiscal_period[0] : schedule.fiscal_period
        return Boolean(period && period.period_end >= row.derecognised_at)
      },
    )
    if (later) throw new AssetComponentReversalBlockedError()
  }
}

export async function releaseComponentsAfterReversal(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<void> {
  const rows = await componentsDerecognisedBy(supabase, companyId, journalEntryId)
  if (rows.length === 0) return
  const { error } = await supabase
    .from('asset_components')
    .update({ derecognised_at: null, derecognition_journal_entry_id: null, derecognition_depreciation: 0 })
    .eq('company_id', companyId)
    .eq('derecognition_journal_entry_id', journalEntryId)
  if (error) throw new Error(`component release after reversal failed: ${error.message}`)
}

// ── Nedskrivning (ÅRL 4:5, K3 27) ───────────────────────────────────
//
// A write-down's rows stop counting the moment its voucher is reversed
// (asset_value_adjustments counts posted vouchers only), so a storno needs
// no register mirror. It is refused when something later was planned or
// assessed from the written-down carrying amount: depreciation for a later
// year, a later write-down or reversal, or the disposal. Undo those first,
// latest first.

export class AssetValueAdjustmentReversalBlockedError extends Error {
  readonly code = 'ASSET_VALUE_ADJUSTMENT_REVERSAL_BLOCKED'
  constructor() {
    super('ASSET_VALUE_ADJUSTMENT_REVERSAL_BLOCKED')
    this.name = 'AssetValueAdjustmentReversalBlockedError'
  }
}

type PeriodEmbed = { period_start: string } | { period_start: string }[] | null
type StatusEmbed = { status: string } | { status: string }[] | null

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value
}

export async function assertValueAdjustmentReversible(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<void> {
  const { data: rows, error } = await supabase
    .from('asset_value_adjustments')
    .select('asset_id, adjustment_date')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
    .limit(1)
  if (error) throw new Error(`write-down lookup by voucher failed: ${error.message}`)
  const row = (rows ?? [])[0] as { asset_id: string; adjustment_date: string } | undefined
  if (!row) return

  const [schedules, adjustments, asset] = await Promise.all([
    supabase
      .from('depreciation_schedules')
      .select('id, fiscal_period:fiscal_periods!depreciation_schedules_fiscal_period_id_fkey(period_start)')
      .eq('company_id', companyId)
      .eq('asset_id', row.asset_id)
      .not('journal_entry_id', 'is', null),
    supabase
      .from('asset_value_adjustments')
      .select('adjustment_date, journal_entry:journal_entries!asset_value_adjustments_journal_entry_id_fkey(status)')
      .eq('company_id', companyId)
      .eq('asset_id', row.asset_id)
      .gt('adjustment_date', row.adjustment_date),
    supabase
      .from('assets')
      .select('disposed_at')
      .eq('company_id', companyId)
      .eq('id', row.asset_id)
      .maybeSingle(),
  ])
  if (schedules.error || adjustments.error || asset.error) {
    throw new Error(
      `write-down reversal check failed: ${(schedules.error ?? adjustments.error ?? asset.error)?.message}`,
    )
  }
  const laterDepreciation = ((schedules.data ?? []) as Array<{ fiscal_period: PeriodEmbed }>).some((schedule) => {
    const period = one(schedule.fiscal_period)
    return Boolean(period && period.period_start > row.adjustment_date)
  })
  const laterAdjustment = ((adjustments.data ?? []) as Array<{ journal_entry: StatusEmbed }>).some(
    (later) => one(later.journal_entry)?.status === 'posted',
  )
  const disposed = Boolean((asset.data as { disposed_at: string | null } | null)?.disposed_at)
  if (laterDepreciation || laterAdjustment || disposed) throw new AssetValueAdjustmentReversalBlockedError()
}
