import type { SupabaseClient } from '@supabase/supabase-js'
import { filesIncomeReturn, resolveCompanyEntityType } from '@/lib/company/entity-type'
import type { EntityType } from '@/types'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { resolveCashAccountScope } from '@/lib/reconciliation/cash-account-scope'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { generateReconciliation as generateAPReconciliation } from '@/lib/reports/supplier-reconciliation'
import { computeEfDeclarationPreview } from '@/lib/bokslut/enskild-firma/ef-declaration-preview'
import { createLogger } from '@/lib/logger'
import { describeFiscalYearGap, findFiscalYearGaps, type PeriodLike } from '@/lib/bookkeeping/fiscal-year-gaps'
import { listReconciliationAccounts } from '@/lib/reconciliation/service'
import type { YearEndBlocker, YearEndValidation } from '@/types'

const log = createLogger('bokslut-readiness')

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
  /** Mirrors validateYearEndReadiness.ready: true ⇔ no blocking errors. */
  ready: boolean
  /** Blocking errors that prevent year-end execution (from year-end-service). */
  blockers: string[]
  /** Same blockers with stable machine codes (same order as `blockers`).
   *  The wizard matches on `code` to attach remediation links; `blockers`
   *  stays as plain strings for existing consumers. */
  blockerItems: YearEndBlocker[]
  /** Non-blocking warnings (from year-end-service). */
  warnings: string[]
  /** Soft reminders (Phase 2+ features not yet shipped, manual steps the user
   *  should consider). Never blockers: surfaced so users know what's manual. */
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
  entityType: EntityType | 'handelsbolag' | 'kommanditbolag'
  /** The period holds history imported from a previous bookkeeping system
   *  (an imported verifikat or a completed SIE import for the year). The
   *  wizard asks "bokslutet redan gjort i ett tidigare program?" only then. */
  holdsImportedHistory: boolean
  /** The full raw validation, for callers that want every field. */
  rawValidation: YearEndValidation
}

/**
 * Single-fetch aggregator that drives the bokslut wizard's preflight step.
 *
 * Wraps validateYearEndReadiness (which owns the legally-required checks) and
 * layers on:
 *   - bank reconciliation snapshot for the period (informational warning if
 *     unmatched transactions exist: not a legal blocker)
 *   - soft reminders for Phase 2+ features that ship later (depreciation,
 *     accruals, tax provision). These tell the user what's manual today.
 *
 * Phase 2 will replace each reminder with a concrete proposal once the
 * relevant calculator ships.
 */
/**
 * A missing räkenskapsår anywhere in the chain is a warning on every
 * bokslut: balances do not roll across a hole (a one-file SIE migration
 * that skipped a year is the usual cause). Advisory: a failed read costs
 * only this warning.
 */
async function fiscalYearGapWarnings(supabase: SupabaseClient, companyId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end')
      .eq('company_id', companyId)
    if (error) throw new Error(error.message)
    return findFiscalYearGaps((data ?? []) as PeriodLike[]).map(describeFiscalYearGap)
  } catch (err) {
    log.warn('fiscal year gap check failed', { companyId, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/** The period's own rows, as the report carries them. */
type ReadinessPeriod = BokslutReadinessReport['period']

/**
 * Starts the period's checks, which read independently of each other and of
 * the validation once the period and the company's settings are known: the
 * bank snapshot, the reskontra tie-outs, the sign-off list, the EF preview
 * and the fiscal-year chain. The caller assembles the reminders in their
 * fixed order.
 */
async function startPeriodChecks(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  period: ReadinessPeriod,
  settings: { entity_type?: string | null; accounting_method?: string | null } | null,
) {
  const entityType: EntityType = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)
  const accountingMethod = settings?.accounting_method ?? 'accrual'

  // Bank reconciliation snapshot for the period. Failure here must not break
  // the report: fall back to null so the UI degrades gracefully.
  const reconciliationRead = (async (): Promise<BokslutReadinessReport['reconciliation']> => {
    try {
      // Scope to the company's bank account. A 4-arg call leaves cashAccountId
      // undefined and the bank side then sums every SEK cash account while the GL
      // side stays on 1930 alone: the wizard surfaced that as "Bankavstämningen
      // visar en differens" with nothing to match (#1290).
      //
      // resolveCashAccountScope fails CLOSED on a lookup error, so the catch below
      // turns a failed lookup into "no reconciliation snapshot" rather than into
      // the unscoped pooling path that produced the phantom difference.
      const scope = await resolveCashAccountScope(supabase, companyId)
      const status = await getReconciliationStatus(
        supabase,
        companyId,
        period.period_start,
        period.period_end,
        scope.accountNumber,
        scope.currency,
        scope.cashAccountId,
        scope.includeUnassigned,
      )
      return {
        is_reconciled: status.is_reconciled,
        unmatched_transaction_count: status.unmatched_transaction_count,
        unmatched_gl_line_count: status.unmatched_gl_line_count,
        difference: status.difference,
      }
    } catch {
      return null
    }
  })()

  // AR/AP tie-outs: Phase 1 avstämningar per the bokslut process, open
  // sub-ledger vs konto 1510 / 2440. Accrual companies only: under
  // kontantmetoden open invoices are deliberately not on 1510/2440 until the
  // cut-off entry below puts them there, so the tie-out is "unreconciled" by
  // construction for the whole year and would only mislead.
  // Warnings, never blockers: a difference can be legitimate (e.g. partial
  // payments settled at a different FX rate than the invoice-date rate).
  const tieOutsRead =
    accountingMethod === 'accrual'
      ? Promise.allSettled([
          (async () => generateARReconciliation(supabase, companyId, fiscalPeriodId))(),
          (async () => generateAPReconciliation(supabase, companyId, fiscalPeriodId))(),
        ])
      : null

  // Bokslutsbilagor: every balance account signed off per balansdagen is what
  // Reko 760/765 asks for. Advisory: a failed read costs only this reminder.
  const bilagorReminderRead = (async (): Promise<BokslutReminder | null> => {
    try {
      const accounts = await listReconciliationAccounts(supabase, companyId, {
        today: period.period_end,
        windowFrom: period.period_start,
        windowTo: period.period_end,
        withStatus: false,
      })
      const live = accounts.filter((a) => !a.superseded_by)
      const unsigned = live.filter((a) => !a.signed_off_through || a.signed_off_through < period.period_end)
      if (live.length === 0) return null
      return {
        code: 'bilagor_unsigned',
        severity: unsigned.length > 0 ? 'warning' : 'info',
        message:
          unsigned.length > 0
            ? `${unsigned.length} av ${live.length} balanskonton är inte signerade per balansdagen ${period.period_end}. Bokslutsbilagorna samlar avstämning, underlag och signering per konto.`
            : `Alla ${live.length} balanskonton är signerade per balansdagen ${period.period_end}. Bokslutsbilagorna kan skrivas ut.`,
        href: '/reports/bokslutsbilagor',
      }
    } catch (err) {
      log.warn('bilagor reminder failed', { companyId, fiscalPeriodId, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  })()

  // Only a form that files NE-bilagan gets the EF declaration reminder and
  // preview; the preview itself refuses every other form, so the capability
  // is read here rather than the form compared to a string.
  //
  // Pre-compute the EF declaration so the wizard's overview reflects what
  // the user will see when they reach the dispositions step. Egenavgifter,
  // räntefördelning, periodiseringsfond-EF and expansionsfond are NOT
  // booked: they go into the NE-bilaga / INK1 (explained behind the
  // Dispositioner step's "?"). EF preview is informational: never block
  // readiness on it.
  const efPreviewRead =
    filesIncomeReturn(entityType) === 'NE'
      ? (async () => computeEfDeclarationPreview(supabase, companyId, fiscalPeriodId, { entityType }))().catch(() => null)
      : null

  const gapWarningsRead = fiscalYearGapWarnings(supabase, companyId)

  return { period, entityType, reconciliationRead, tieOutsRead, bilagorReminderRead, efPreviewRead, gapWarningsRead }
}

/**
 * Whether the period holds history imported from a previous bookkeeping
 * system: a verifikat with source_type 'import' (SIE file and provider
 * migrations alike) or a completed SIE import for the year (a balances-only
 * file brings no verifikat). Two id-only reads capped at one row.
 *
 * Only such a year can have had its bokslut done elsewhere, so the wizard
 * prompts for Klarmarkera only then; the action itself stays reachable for
 * every eligible year. Advisory: a failed read answers false and costs only
 * the prompt.
 */
async function periodHoldsImportedHistory(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<boolean> {
  try {
    const [entries, imports] = await Promise.all([
      supabase
        .from('journal_entries')
        .select('id')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('source_type', 'import')
        .limit(1),
      supabase
        .from('sie_imports')
        .select('id')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'completed')
        .limit(1),
    ])
    for (const failed of [entries.error, imports.error]) {
      if (failed) log.warn('imported history read failed', { companyId, fiscalPeriodId, error: failed.message })
    }
    return (entries.data?.length ?? 0) > 0 || (imports.data?.length ?? 0) > 0
  } catch (err) {
    log.warn('imported history check failed', { companyId, fiscalPeriodId, error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

export async function buildBokslutReadinessReport(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
): Promise<BokslutReadinessReport> {
  // The period and the company's settings are all the period's checks need,
  // so those start as soon as the two are read and run alongside the heavy
  // validation. Promise.resolve: a query builder sends its request on every
  // then(), and both readers below await these two.
  const periodRead = Promise.resolve(
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, locked_at, closing_entry_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
  )
  const settingsRead = Promise.resolve(
    supabase
      .from('company_settings')
      .select('entity_type, accounting_method')
      .eq('company_id', companyId)
      .maybeSingle(),
  )
  const checksRead = Promise.all([periodRead, settingsRead]).then(([periodResult, settingsResult]) =>
    periodResult.error || !periodResult.data
      ? null
      : startPeriodChecks(supabase, companyId, fiscalPeriodId, periodResult.data, settingsResult.data),
  )
  // A failure surfaces where checksRead is awaited below, after the
  // validation's as before; this only keeps one that lands while the
  // validation still runs from counting as unhandled.
  checksRead.catch(() => undefined)

  const [periodResult, , validation, holdsImportedHistory] = await Promise.all([
    periodRead,
    settingsRead,
    validateYearEndReadiness(supabase, companyId, userId, fiscalPeriodId),
    periodHoldsImportedHistory(supabase, companyId, fiscalPeriodId),
  ])

  const checks = await checksRead
  if (periodResult.error || !periodResult.data || !checks) {
    throw new Error('Fiscal period not found')
  }
  const { period, entityType, reconciliationRead, tieOutsRead, bilagorReminderRead, efPreviewRead, gapWarningsRead } =
    checks

  const reconciliation = await reconciliationRead
  const reminders: BokslutReminder[] = []

  if (reconciliation && !reconciliation.is_reconciled) {
    reminders.push({
      code: 'bank_reconciliation_incomplete',
      severity: 'warning',
      message:
        reconciliation.unmatched_transaction_count > 0
          ? `${reconciliation.unmatched_transaction_count} banktransaktioner är inte matchade. Avstäm banken innan bokslut.`
          : `Bankavstämningen visar en differens på ${reconciliation.difference.toFixed(2)} kr.`,
      href: '/reconciliation',
    })
  }

  if (tieOutsRead) {
    const [arResult, apResult] = await tieOutsRead
    // A failed tie-out degrades to "no reminder" (these are advisory), but a
    // silently swallowed failure is indistinguishable from "reconciled" in
    // the report, so the rejection must at least be traceable in logs
    // (compliance review on the avstämning controls, BFNAR 2013:2 p. 9.16).
    if (arResult.status === 'rejected') {
      log.warn('AR tie-out (kundreskontra vs 1510) failed; reminder omitted', arResult.reason)
    }
    if (apResult.status === 'rejected') {
      log.warn('AP tie-out (leverantörsreskontra vs 2440) failed; reminder omitted', apResult.reason)
    }
    if (arResult.status === 'fulfilled' && !arResult.value.is_reconciled) {
      reminders.push({
        code: 'ar_reconciliation_mismatch',
        severity: 'warning',
        message:
          arResult.value.unconverted_fx_count > 0
            ? `Kundreskontran kan inte stämmas av mot konto 1510: ${arResult.value.unconverted_fx_count} fakturor i utländsk valuta saknar valutakurs.`
            : `Kundreskontran stämmer inte mot konto 1510: differens ${arResult.value.difference.toFixed(2)} kr. Kontrollera obetalda kundfakturor innan bokslut.`,
        href: '/reports/kundreskontra',
      })
    }
    if (apResult.status === 'fulfilled' && !apResult.value.is_reconciled) {
      reminders.push({
        code: 'ap_reconciliation_mismatch',
        severity: 'warning',
        message:
          apResult.value.unconverted_fx_count > 0
            ? `Leverantörsreskontran kan inte stämmas av mot konto 2440: ${apResult.value.unconverted_fx_count} fakturor i utländsk valuta saknar valutakurs.`
            : `Leverantörsreskontran stämmer inte mot konto 2440: differens ${apResult.value.difference.toFixed(2)} kr. Kontrollera obetalda leverantörsfakturor innan bokslut.`,
        href: '/reports/supplier-ledger',
      })
    }
  }

  // Reminders are this year's findings only. The static guidance that used to
  // ride along on every report (accruals are manual and reversed on day one
  // of the next year; EF egenavgifter & co. are computed in the NE-bilaga,
  // not booked) lives behind the wizard's "?" on the step it belongs to, so
  // the Kontroll step does not announce the very next step on every year.

  const bilagorReminder = await bilagorReminderRead
  if (bilagorReminder) reminders.push(bilagorReminder)

  if (efPreviewRead) {
    // Surface a soft warning when kapitalunderlag is missing AND the booked
    // surplus is large enough to make positive räntefördelning meaningful
    // (> 50 000 kr: the spärrbelopp). This is non-blocking but actionable:
    // the user should enter their IB equity on the dispositions step.
    const preview = await efPreviewRead
    if (preview && preview.bookedSurplus > 50_000) {
      reminders.push({
        code: 'ef_kapitalunderlag_missing',
        severity: 'warning',
        message:
          'Kapitalunderlag (IB eget kapital) saknas: räntefördelning beräknas inte. Fyll i på dispositionssteget för att utnyttja skattefördelen.',
      })
    }
  }

  const gapWarnings = await gapWarningsRead

  return {
    ready: validation.ready,
    blockers: validation.errors,
    blockerItems: validation.blockers,
    warnings: [...validation.warnings, ...gapWarnings],
    reminders,
    draftCount: validation.draftCount,
    unexplainedGapCount: validation.unexplainedGaps.length,
    trialBalanceBalanced: validation.trialBalanceBalanced,
    reconciliation,
    period,
    entityType,
    holdsImportedHistory,
    rawValidation: validation,
  }
}
