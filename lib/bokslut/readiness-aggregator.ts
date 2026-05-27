import type { SupabaseClient } from '@supabase/supabase-js'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { computeEfDeclarationPreview } from '@/lib/bokslut/enskild-firma/ef-declaration-preview'
import type { YearEndValidation } from '@/types'

export type ReminderSeverity = 'info' | 'warning'

export interface BokslutReminder {
  /** Stable id so the UI can suppress duplicates and link to docs. */
  code: string
  severity: ReminderSeverity
  /** Swedish, user-facing. */
  message: string
  /** Optional deep link to the relevant resolution surface. */
  href?: string
}

export interface BokslutReadinessReport {
  /** Mirrors validateYearEndReadiness.ready — true ⇔ no blocking errors. */
  ready: boolean
  /** Blocking errors that prevent year-end execution (from year-end-service). */
  blockers: string[]
  /** Non-blocking warnings (from year-end-service). */
  warnings: string[]
  /** Soft reminders (Phase 2+ features not yet shipped, manual steps the user
   *  should consider). Never blockers — surfaced so users know what's manual. */
  reminders: BokslutReminder[]
  /** Convenience counts for the UI header. */
  draftCount: number
  unexplainedGapCount: number
  trialBalanceBalanced: boolean
  /** Bank reconciliation snapshot for the period. */
  reconciliation: {
    is_reconciled: boolean
    unmatched_transaction_count: number
    unmatched_gl_line_count: number
    difference: number
  } | null
  /** Period metadata so the UI can show name/dates without an extra fetch. */
  period: {
    id: string
    name: string
    period_start: string
    period_end: string
    is_closed: boolean
    locked_at: string | null
    closing_entry_id: string | null
  }
  /** Entity type drives which dispositions apply (e.g. bolagsskatt only for AB). */
  entityType: 'aktiebolag' | 'enskild_firma' | 'handelsbolag' | 'kommanditbolag' | 'ekonomisk_forening'
  /** The full raw validation, for callers that want every field. */
  rawValidation: YearEndValidation
}

/**
 * Single-fetch aggregator that drives the bokslut wizard's preflight step.
 *
 * Wraps validateYearEndReadiness (which owns the legally-required checks) and
 * layers on:
 *   - bank reconciliation snapshot for the period (informational warning if
 *     unmatched transactions exist — not a legal blocker)
 *   - soft reminders for Phase 2+ features that ship later (depreciation,
 *     accruals, tax provision). These tell the user what's manual today.
 *
 * Phase 2 will replace each reminder with a concrete proposal once the
 * relevant calculator ships.
 */
export async function buildBokslutReadinessReport(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
): Promise<BokslutReadinessReport> {
  // Fetch period + entity type in parallel with the heavy validation.
  const [periodResult, settingsResult, validation] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, locked_at, closing_entry_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('entity_type')
      .eq('company_id', companyId)
      .maybeSingle(),
    validateYearEndReadiness(supabase, companyId, userId, fiscalPeriodId),
  ])

  if (periodResult.error || !periodResult.data) {
    throw new Error('Fiscal period not found')
  }

  const period = periodResult.data
  const entityType = (settingsResult.data?.entity_type ?? 'aktiebolag') as BokslutReadinessReport['entityType']

  // Bank reconciliation snapshot for the period. Run after period fetch so we
  // know the date range. Failure here must not break the report — fall back
  // to null so the UI degrades gracefully.
  let reconciliation: BokslutReadinessReport['reconciliation'] = null
  try {
    const status = await getReconciliationStatus(
      supabase,
      companyId,
      period.period_start,
      period.period_end,
    )
    reconciliation = {
      is_reconciled: status.is_reconciled,
      unmatched_transaction_count: status.unmatched_transaction_count,
      unmatched_gl_line_count: status.unmatched_gl_line_count,
      difference: status.difference,
    }
  } catch {
    reconciliation = null
  }

  const reminders: BokslutReminder[] = []

  if (reconciliation && !reconciliation.is_reconciled) {
    reminders.push({
      code: 'bank_reconciliation_incomplete',
      severity: 'warning',
      message:
        reconciliation.unmatched_transaction_count > 0
          ? `${reconciliation.unmatched_transaction_count} banktransaktioner är inte matchade. Avstäm banken innan bokslut.`
          : `Bankavstämningen visar en differens på ${reconciliation.difference.toFixed(2)} kr.`,
      href: '/reconciliation/bank',
    })
  }

  // Periodiseringar (accruals) are still manual — no wizard step ships in
  // Phases 1-3. Depreciation, bolagsskatt and periodiseringsfond now have
  // dedicated calculators (DepreciationPanel + DispositionsStep) so they're
  // no longer surfaced as manual reminders.
  reminders.push({
    code: 'accruals_manual',
    severity: 'info',
    message:
      'Periodiseringar (förutbetalda kostnader 17xx, upplupna kostnader 29xx) bokas manuellt. Tänk på att vända dem 1 januari nästa år.',
  })

  if (entityType === 'enskild_firma') {
    // Pre-compute the EF declaration so the wizard's overview reflects what
    // the user will see when they reach the dispositions step. Egenavgifter,
    // räntefördelning, periodiseringsfond-EF and expansionsfond are NOT
    // booked — they go into the NE-bilaga / INK1. This reminder explains
    // the BFL distinction.
    reminders.push({
      code: 'ef_skatt_via_ne',
      severity: 'info',
      message:
        'Egenavgifter, räntefördelning, periodiseringsfond och expansionsfond beräknas i NE-bilagan, inte bokförs. Skatten betalas privat av ägaren.',
    })

    // Surface a soft warning when kapitalunderlag is missing AND the booked
    // surplus is large enough to make positive räntefördelning meaningful
    // (> 50 000 kr — the spärrbelopp). This is non-blocking but actionable:
    // the user should enter their IB equity on the dispositions step.
    try {
      const preview = await computeEfDeclarationPreview(supabase, companyId, fiscalPeriodId)
      if (preview.bookedSurplus > 50_000) {
        reminders.push({
          code: 'ef_kapitalunderlag_missing',
          severity: 'warning',
          message:
            'Kapitalunderlag (IB eget kapital) saknas — räntefördelning beräknas inte. Fyll i på dispositionssteget för att utnyttja skattefördelen.',
        })
      }
    } catch {
      // EF preview is informational — never block readiness on it.
    }
  }

  return {
    ready: validation.ready,
    blockers: validation.errors,
    warnings: validation.warnings,
    reminders,
    draftCount: validation.draftCount,
    unexplainedGapCount: validation.unexplainedGaps.length,
    trialBalanceBalanced: validation.trialBalanceBalanced,
    reconciliation,
    period,
    entityType,
    rawValidation: validation,
  }
}
