import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { equalOre, isZeroOre, roundOre, sumOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, JournalEntry } from '@/types'
import { PRIOR_RESULT_ACCOUNT, RESULT_ACCOUNT } from './result-appropriation-service'

export type HistoricalResultRepairReason =
  | 'ready'
  | 'non_aktiebolag'
  | 'period_closed'
  | 'period_locked'
  | 'already_corrected'
  | 'missing_explicit_opening_balance'
  | 'invalid_opening_balance_entry'
  | 'missing_required_accounts'
  | 'no_result_to_move'
  | 'already_disposed'
  | 'current_balance_differs'
  | 'intervening_2099_activity'

export interface HistoricalResultRepairSnapshot {
  companyId: string
  periodId: string
  periodName: string
  periodStart: string
  entityType: string | null
  isClosed: boolean
  lockedAt: string | null
  openingBalanceEntryId: string | null
  openingBalanceEntryValid: boolean
  /** "A1"-style voucher label of the opening-balance entry, for the underlag reference. */
  openingBalanceVoucherLabel: string | null
  requiredAccountsActive: boolean
  existingPostedAppropriation: boolean
  resultAccountLines: Array<{
    journal_entry_id: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }>
}

export interface HistoricalResultRepairPlan {
  companyId: string
  periodId: string
  periodName: string
  periodStart: string
  openingNet: number
  currentNet: number
  amount: number
  direction: 'profit' | 'loss'
  lines: CreateJournalEntryLineInput[]
  /** The validated opening-balance entry the repair reclassifies: the verifikat's underlag. */
  openingBalanceEntryId: string
  openingBalanceVoucherLabel: string | null
}

interface HistoricalResultRepairAssessmentBase {
  companyId: string
  periodId: string
  periodName: string
  periodStart: string
  openingNet: number
  currentNet: number
  nonOpeningActivityEntries: number
}

export type HistoricalResultRepairAssessment =
  | (HistoricalResultRepairAssessmentBase & {
      status: 'safe'
      reason: 'ready'
      plan: HistoricalResultRepairPlan
    })
  | (HistoricalResultRepairAssessmentBase & {
      status: 'skipped' | 'manual_review'
      reason: Exclude<HistoricalResultRepairReason, 'ready'>
      plan: null
    })

export function getHistoricalResultRepairScopeError(input: {
  commit: boolean
  companyId?: string
  periodId?: string
  userId?: string
}): string | null {
  if (input.periodId && !input.companyId) {
    return '--period-id requires --company-id'
  }
  if (input.commit && (!input.companyId || !input.periodId || !input.userId)) {
    return '--commit requires --company-id, --period-id, and --user-id so one reviewed period is attributed deliberately'
  }
  return null
}

function resultLines(net: number): CreateJournalEntryLineInput[] {
  const amount = roundOre(Math.abs(net))
  return net > 0
    ? [
        {
          account_number: RESULT_ACCOUNT,
          debit_amount: amount,
          credit_amount: 0,
          line_description: 'Omföring av föregående års resultat',
        },
        {
          account_number: PRIOR_RESULT_ACCOUNT,
          debit_amount: 0,
          credit_amount: amount,
          line_description: 'Föregående års resultat',
        },
      ]
    : [
        {
          account_number: PRIOR_RESULT_ACCOUNT,
          debit_amount: amount,
          credit_amount: 0,
          line_description: 'Föregående års resultat',
        },
        {
          account_number: RESULT_ACCOUNT,
          debit_amount: 0,
          credit_amount: amount,
          line_description: 'Omföring av föregående års resultat',
        },
      ]
}

/**
 * Classify one historical period without writing.
 *
 * The normal year-end flow knows that it just generated the opening balance,
 * so it can move that opening 2099 onto 2098 immediately. A historical sweep
 * has no such certainty: users and SIE imports may already have disposed of the
 * result. It is safe to automate only when the explicit opening-balance amount
 * is still the complete current posted 2099 balance and no other entry touched
 * 2099 in the period. Everything else stays unchanged for manual review.
 */
export function classifyHistoricalResultRepair(
  snapshot: HistoricalResultRepairSnapshot,
): HistoricalResultRepairAssessment {
  const openingEntryId = snapshot.openingBalanceEntryId
  const openingLines = openingEntryId
    ? snapshot.resultAccountLines.filter((line) => line.journal_entry_id === openingEntryId)
    : []
  const nonOpeningEntryIds = new Set(
    snapshot.resultAccountLines
      .filter((line) => line.journal_entry_id !== openingEntryId)
      .map((line) => line.journal_entry_id),
  )
  const openingNet = sumOre(
    openingLines.map(
      (line) => (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0),
    ),
  )
  const currentNet = sumOre(
    snapshot.resultAccountLines.map(
      (line) => (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0),
    ),
  )
  const base: HistoricalResultRepairAssessmentBase = {
    companyId: snapshot.companyId,
    periodId: snapshot.periodId,
    periodName: snapshot.periodName,
    periodStart: snapshot.periodStart,
    openingNet,
    currentNet,
    nonOpeningActivityEntries: nonOpeningEntryIds.size,
  }
  const finish = (
    status: 'skipped' | 'manual_review',
    reason: Exclude<HistoricalResultRepairReason, 'ready'>,
  ): HistoricalResultRepairAssessment => ({ ...base, status, reason, plan: null })

  if ((snapshot.entityType ?? 'aktiebolag') !== 'aktiebolag') {
    return finish('skipped', 'non_aktiebolag')
  }
  if (snapshot.isClosed) return finish('skipped', 'period_closed')
  if (snapshot.lockedAt) return finish('skipped', 'period_locked')
  if (snapshot.existingPostedAppropriation) {
    return finish('skipped', 'already_corrected')
  }
  if (!openingEntryId) {
    return finish('manual_review', 'missing_explicit_opening_balance')
  }
  if (!snapshot.openingBalanceEntryValid) {
    return finish('manual_review', 'invalid_opening_balance_entry')
  }
  if (!snapshot.requiredAccountsActive) {
    return finish('manual_review', 'missing_required_accounts')
  }
  if (isZeroOre(openingNet) && isZeroOre(currentNet)) {
    return finish('skipped', 'no_result_to_move')
  }
  if (!isZeroOre(openingNet) && isZeroOre(currentNet)) {
    return finish('skipped', 'already_disposed')
  }
  if (!equalOre(currentNet, openingNet)) {
    return finish('manual_review', 'current_balance_differs')
  }
  if (nonOpeningEntryIds.size > 0) {
    return finish('manual_review', 'intervening_2099_activity')
  }

  const amount = roundOre(Math.abs(currentNet))
  const plan: HistoricalResultRepairPlan = {
    companyId: snapshot.companyId,
    periodId: snapshot.periodId,
    periodName: snapshot.periodName,
    periodStart: snapshot.periodStart,
    openingNet,
    currentNet,
    amount,
    direction: currentNet > 0 ? 'profit' : 'loss',
    lines: resultLines(currentNet),
    openingBalanceEntryId: openingEntryId,
    openingBalanceVoucherLabel: snapshot.openingBalanceVoucherLabel,
  }
  return { ...base, status: 'safe', reason: 'ready', plan }
}

/** Load and classify one historical period. This function never writes. */
export async function assessHistoricalResultRepair(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
): Promise<HistoricalResultRepairAssessment> {
  const [settingsResult, periodResult, existingResult] = await Promise.all([
    supabase
      .from('company_settings')
      .select('entity_type')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('fiscal_periods')
      .select('name, period_start, is_closed, locked_at, opening_balance_entry_id')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', periodId)
      .eq('source_type', 'result_appropriation')
      .eq('status', 'posted')
      .limit(1)
      .maybeSingle(),
  ])

  if (settingsResult.error) {
    throw new Error(`Failed to read company settings: ${settingsResult.error.message}`)
  }
  if (periodResult.error || !periodResult.data) {
    throw new Error(`Failed to read fiscal period: ${periodResult.error?.message ?? 'not found'}`)
  }
  if (existingResult.error) {
    throw new Error(`Failed to check existing result appropriation: ${existingResult.error.message}`)
  }

  const period = periodResult.data
  const openingBalanceEntryId = period.opening_balance_entry_id as string | null
  const baseSnapshot: HistoricalResultRepairSnapshot = {
    companyId,
    periodId,
    periodName: period.name,
    periodStart: period.period_start,
    entityType: settingsResult.data?.entity_type ?? null,
    isClosed: period.is_closed,
    lockedAt: period.locked_at,
    openingBalanceEntryId,
    openingBalanceEntryValid: false,
    openingBalanceVoucherLabel: null,
    requiredAccountsActive: false,
    existingPostedAppropriation: Boolean(existingResult.data),
    resultAccountLines: [],
  }

  if (
    (baseSnapshot.entityType ?? 'aktiebolag') !== 'aktiebolag' ||
    baseSnapshot.isClosed ||
    baseSnapshot.lockedAt ||
    baseSnapshot.existingPostedAppropriation ||
    !openingBalanceEntryId
  ) {
    return classifyHistoricalResultRepair(baseSnapshot)
  }

  const [openingEntryResult, requiredAccountsResult, resultAccountLines] = await Promise.all([
    supabase
      .from('journal_entries')
      .select('id, status, source_type, voucher_series, voucher_number')
      .eq('id', openingBalanceEntryId)
      .eq('company_id', companyId)
      .eq('fiscal_period_id', periodId)
      .maybeSingle(),
    supabase
      .from('chart_of_accounts')
      .select('account_number')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .in('account_number', [RESULT_ACCOUNT, PRIOR_RESULT_ACCOUNT]),
    fetchEntryLines<HistoricalResultRepairSnapshot['resultAccountLines'][number]>({
      supabase,
      lineColumns: 'id, journal_entry_id, debit_amount, credit_amount',
      filterEntries: (query: EntryLinesQuery) =>
        query
          .eq('company_id', companyId)
          .eq('fiscal_period_id', periodId)
          .in('status', ['posted', 'reversed']),
      filterLines: (query: EntryLinesQuery) => query.eq('account_number', RESULT_ACCOUNT),
      attachEntriesAs: null,
    }),
  ])

  if (openingEntryResult.error) {
    throw new Error(`Failed to read opening-balance entry: ${openingEntryResult.error.message}`)
  }
  if (requiredAccountsResult.error) {
    throw new Error(`Failed to read required accounts: ${requiredAccountsResult.error.message}`)
  }

  const activeAccounts = new Set(
    (requiredAccountsResult.data ?? []).map((row) => row.account_number),
  )
  const openingEntry = openingEntryResult.data

  return classifyHistoricalResultRepair({
    ...baseSnapshot,
    openingBalanceEntryValid:
      openingEntry?.status === 'posted' && openingEntry.source_type === 'opening_balance',
    openingBalanceVoucherLabel:
      openingEntry?.voucher_series != null && openingEntry.voucher_number != null
        ? `${openingEntry.voucher_series}${openingEntry.voucher_number}`
        : null,
    requiredAccountsActive:
      activeAccounts.has(RESULT_ACCOUNT) && activeAccounts.has(PRIOR_RESULT_ACCOUNT),
    resultAccountLines,
  })
}

/**
 * The posted entry is attributed to userId. Require an actual membership row
 * so a mistyped uuid cannot attribute a financial journal entry to a user
 * outside the company (service-role scripts bypass RLS, so nothing else
 * would catch it).
 */
export async function assertRepairAttributionUser(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to verify company membership: ${error.message}`)
  }
  if (!data) {
    throw new Error(
      `User ${userId} is not a member of company ${companyId}: refusing to attribute the repair entry`,
    )
  }
}

/**
 * Re-assess immediately before posting and write only an unambiguous plan.
 * All journal writes still pass through the bookkeeping engine.
 */
export async function postHistoricalResultRepair(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  periodId: string,
): Promise<{
  assessment: HistoricalResultRepairAssessment
  entry: JournalEntry | null
}> {
  await assertRepairAttributionUser(supabase, companyId, userId)
  const assessment = await assessHistoricalResultRepair(supabase, companyId, periodId)
  if (assessment.status !== 'safe') return { assessment, entry: null }

  // BFL 5 kap 6-7 §§: the verifikat must reference its underlag. For this
  // historical repair the underlag is the validated opening-balance entry,
  // linked machine-readably via source_id and human-readably in the note.
  const underlagLabel = assessment.plan.openingBalanceVoucherLabel
    ? `verifikat ${assessment.plan.openingBalanceVoucherLabel}`
    : `verifikat ${assessment.plan.openingBalanceEntryId}`
  const entry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: periodId,
    entry_date: assessment.plan.periodStart,
    description: `Omföring av föregående års resultat (${RESULT_ACCOUNT} → ${PRIOR_RESULT_ACCOUNT})`,
    source_type: 'result_appropriation',
    source_id: assessment.plan.openingBalanceEntryId,
    voucher_series: 'A',
    notes: `Underlag: ingående balans, ${underlagLabel} (${assessment.plan.openingBalanceEntryId}). Historisk rättelse av kvarliggande föregående års resultat på ${RESULT_ACCOUNT}.`,
    lines: assessment.plan.lines,
  })

  return { assessment, entry }
}
