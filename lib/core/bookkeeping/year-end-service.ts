import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { lockPeriod, closePeriod, createNextPeriod } from './period-service'
import {
  previewCurrencyRevaluation,
  executeCurrencyRevaluation,
} from '@/lib/bookkeeping/currency-revaluation'
import { validateBalanceContinuity } from '@/lib/reports/continuity-check'
import type {
  YearEndValidation,
  YearEndPreview,
  YearEndResult,
  CreateJournalEntryLineInput,
  FiscalPeriod,
  JournalEntry,
  VoucherGap,
  SequenceMismatch,
} from '@/types'

/**
 * Validate whether a fiscal period is ready for year-end closing.
 * Returns blocking errors and informational warnings.
 */
export async function validateYearEndReadiness(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<YearEndValidation> {
  const errors: string[] = []
  const warnings: string[] = []

  // Fetch the period
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    return {
      ready: false,
      errors: ['Fiscal period not found'],
      warnings: [],
      draftCount: 0,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: false,
    }
  }

  // Check: period must have ended (BFNAR 2017:3 / ÅRL 2:1)
  const today = new Date().toISOString().split('T')[0]
  if (period.period_end > today) {
    errors.push('Cannot close a fiscal period that has not yet ended')
  }

  // Check: period not already closed
  if (period.is_closed) {
    errors.push('Period is already closed')
  }

  // Check: closing entry doesn't already exist
  if (period.closing_entry_id) {
    errors.push('Year-end closing entry already exists for this period')
  }

  // Check: no draft entries
  const { count: draftCount } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'draft')

  const drafts = draftCount ?? 0
  if (drafts > 0) {
    errors.push(`${drafts} draft journal entries must be posted or deleted before closing`)
  }

  // Check: voucher continuity across all series
  let voucherGaps: VoucherGap[] = []
  const { data: seriesRows } = await supabase
    .from('voucher_sequences')
    .select('voucher_series')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)

  const seriesToCheck = seriesRows && seriesRows.length > 0
    ? seriesRows.map((r: { voucher_series: string }) => r.voucher_series)
    : ['A']

  for (const series of seriesToCheck) {
    const { data: gaps, error: gapsError } = await supabase.rpc('detect_voucher_gaps', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriodId,
      p_series: series,
    })

    if (!gapsError && gaps && gaps.length > 0) {
      const tagged = (gaps as Array<{ gap_start: number; gap_end: number }>).map((g) => ({
        ...g,
        series,
      }))
      voucherGaps.push(...tagged)
    }
  }

  // Check gap explanations — unexplained gaps block year-end (BFNAR 2013:2 punkt 5.8)
  let unexplainedGaps: VoucherGap[] = []
  if (voucherGaps.length > 0) {
    const { data: explanations } = await supabase
      .from('voucher_gap_explanations')
      .select('voucher_series, gap_start, gap_end')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)

    const explanationSet = new Set(
      (explanations ?? []).map(
        (e: { voucher_series: string; gap_start: number; gap_end: number }) =>
          `${e.voucher_series}:${e.gap_start}:${e.gap_end}`
      )
    )

    for (const gap of voucherGaps) {
      const key = `${gap.series}:${gap.gap_start}:${gap.gap_end}`
      if (explanationSet.has(key)) {
        warnings.push(
          `Voucher gap in series ${gap.series} (${gap.gap_start}-${gap.gap_end}) — documented`
        )
      } else {
        unexplainedGaps.push(gap)
        errors.push(
          `Unexplained voucher gap in series ${gap.series}: ${gap.gap_start}-${gap.gap_end}`
        )
      }
    }
  }

  // Check: sequence counter reconciliation
  const sequenceMismatches: SequenceMismatch[] = []
  if (seriesRows && seriesRows.length > 0) {
    for (const row of seriesRows as Array<{ voucher_series: string }>) {
      const { data: seqData } = await supabase
        .from('voucher_sequences')
        .select('last_number')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('voucher_series', row.voucher_series)
        .single()

      const { data: maxData } = await supabase
        .from('journal_entries')
        .select('voucher_number')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('voucher_series', row.voucher_series)
        .neq('status', 'draft')
        .order('voucher_number', { ascending: false })
        .limit(1)
        .maybeSingle()

      const sequenceCounter = seqData?.last_number ?? 0
      const actualMax = maxData?.voucher_number ?? 0

      if (sequenceCounter !== actualMax) {
        sequenceMismatches.push({
          series: row.voucher_series,
          sequenceCounter,
          actualMax,
        })

        if (sequenceCounter < actualMax) {
          errors.push(
            `Sequence counter integrity error in series ${row.voucher_series}: counter=${sequenceCounter} but max voucher=${actualMax}`
          )
        } else {
          warnings.push(
            `Sequence counter ahead of actual entries in series ${row.voucher_series}: counter=${sequenceCounter}, max voucher=${actualMax}`
          )
        }
      }
    }
  }

  // Check: trial balance is balanced
  const trialBalance = await generateTrialBalance(supabase, companyId, fiscalPeriodId)
  const trialBalanceBalanced = trialBalance.isBalanced

  if (!trialBalanceBalanced) {
    errors.push(
      `Trial balance is not balanced: debit=${trialBalance.totalDebit}, credit=${trialBalance.totalCredit}`
    )
  }

  // Check: at least some entries exist
  const { count: entryCount } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'posted')

  if ((entryCount ?? 0) === 0) {
    warnings.push('No posted journal entries in this period')
  }

  // Check: foreign currency items exist but haven't been revalued
  const { count: revalCount } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('source_type', 'currency_revaluation')
    .eq('status', 'posted')

  if ((revalCount ?? 0) === 0) {
    // Check if there are any open foreign currency items
    const { count: fxReceivables } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', ['sent', 'overdue'])
      .neq('currency', 'SEK')
      .not('exchange_rate', 'is', null)

    const { count: fxPayables } = await supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', ['registered', 'approved', 'overdue', 'partially_paid'])
      .neq('currency', 'SEK')
      .not('exchange_rate', 'is', null)

    if (((fxReceivables ?? 0) + (fxPayables ?? 0)) > 0) {
      warnings.push(
        'Open foreign currency items exist but have not been revalued (ÅRL 4:13)'
      )
    }
  }

  // Check: continuity_verified flag from prior year-end
  if (period.continuity_verified === false) {
    errors.push('Opening balance continuity check failed for this period — resolve discrepancies before closing')
  }

  return {
    ready: errors.length === 0,
    errors,
    warnings,
    draftCount: drafts,
    voucherGaps,
    unexplainedGaps,
    sequenceMismatches,
    trialBalanceBalanced,
  }
}

/**
 * Preview year-end closing without persisting anything.
 * Shows the net result, closing account, and the journal entry lines that would be created.
 */
export async function previewYearEndClosing(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<YearEndPreview> {

  // Get entity type to determine closing account
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .single()

  const entityType = settings?.entity_type ?? 'aktiebolag'
  const closingAccount = entityType === 'enskild_firma' ? '2010' : '2099'
  const closingAccountName =
    entityType === 'enskild_firma'
      ? 'Eget kapital'
      : 'Årets resultat'

  // Get income statement for net result
  const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
  const netResult = incomeStatement.net_result

  // Get trial balance for individual account balances in class 3-8
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId)
  const resultAccounts = rows.filter(
    (r) => r.account_class >= 3 && r.account_class <= 8
  )

  // Build closing lines: zero each result account
  const closingLines: CreateJournalEntryLineInput[] = []
  const resultAccountSummary: { account_number: string; account_name: string; amount: number }[] = []

  for (const account of resultAccounts) {
    const netBalance = account.closing_debit - account.closing_credit

    if (Math.abs(netBalance) < 0.005) continue

    resultAccountSummary.push({
      account_number: account.account_number,
      account_name: account.account_name,
      amount: netBalance,
    })

    // To zero this account: reverse its net balance
    if (netBalance > 0) {
      // Account has debit balance → credit it to zero
      closingLines.push({
        account_number: account.account_number,
        debit_amount: 0,
        credit_amount: Math.round(netBalance * 100) / 100,
        line_description: `Closing: ${account.account_name}`,
      })
    } else {
      // Account has credit balance → debit it to zero
      closingLines.push({
        account_number: account.account_number,
        debit_amount: Math.round(Math.abs(netBalance) * 100) / 100,
        credit_amount: 0,
        line_description: `Closing: ${account.account_name}`,
      })
    }
  }

  // Final line: transfer net result to closing account (2099/2010)
  // Net result = revenue - expenses + financial
  // If positive (profit): credit to equity (2099/2010)
  // If negative (loss): debit to equity (2099/2010)
  const totalClosingDebit = closingLines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalClosingCredit = closingLines.reduce((sum, l) => sum + l.credit_amount, 0)
  const balancingAmount = Math.round(Math.abs(totalClosingDebit - totalClosingCredit) * 100) / 100

  if (balancingAmount > 0.005) {
    if (totalClosingDebit > totalClosingCredit) {
      // More debits than credits → need credit on closing account
      closingLines.push({
        account_number: closingAccount,
        debit_amount: 0,
        credit_amount: balancingAmount,
        line_description: `Årets resultat → ${closingAccountName}`,
      })
    } else {
      // More credits than debits → need debit on closing account
      closingLines.push({
        account_number: closingAccount,
        debit_amount: balancingAmount,
        credit_amount: 0,
        line_description: `Årets resultat → ${closingAccountName}`,
      })
    }
  }

  // Fetch fiscal period for closing date
  const { data: periodData } = await supabase
    .from('fiscal_periods')
    .select('period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  let currencyRevaluation = null
  if (periodData) {
    const revalPreview = await previewCurrencyRevaluation(
      supabase,
      companyId,
      periodData.period_end
    )
    if (revalPreview.items.length > 0) {
      currencyRevaluation = revalPreview
    }
  }

  return {
    netResult,
    closingAccount,
    closingAccountName,
    closingLines,
    resultAccountSummary,
    currencyRevaluation,
  }
}

/**
 * Execute year-end closing for a fiscal period.
 *
 * 1. Validate readiness
 * 2. Create closing entry (zeros class 3-8 accounts)
 * 3. Set closing_entry_id on the period
 * 4. Lock the period
 * 5. Close the period
 * 6. Create next fiscal period
 * 7. Generate opening balances in next period
 */
export async function executeYearEndClosing(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<YearEndResult> {
  // 1. Validate readiness
  const validation = await validateYearEndReadiness(supabase, companyId, userId, fiscalPeriodId)
  if (!validation.ready) {
    throw new Error(`Year-end closing not ready: ${validation.errors.join('; ')}`)
  }

  // Fetch the period for dates
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    throw new Error('Fiscal period not found')
  }

  // 2. Execute currency revaluation BEFORE closing entry
  //    Revaluation posts to 3960/7960 (class 3/7 result accounts) which
  //    the closing entry then zeros out.
  const revaluationResult = await executeCurrencyRevaluation(
    supabase,
    companyId,
    period.period_end,
    fiscalPeriodId,
    userId
  )

  // 3. Get closing preview (now includes revaluation effects in trial balance)
  const preview = await previewYearEndClosing(supabase, companyId, userId, fiscalPeriodId)

  if (preview.closingLines.length === 0) {
    throw new Error('No result accounts to close — period has no activity')
  }

  // 4. Create closing entry via the journal engine
  const closingEntry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: period.period_end,
    description: `Årsbokslut ${period.name}`,
    source_type: 'year_end',
    voucher_series: 'A',
    lines: preview.closingLines,
  })

  // 5. Update fiscal period with closing_entry_id
  const { error: updateError } = await supabase
    .from('fiscal_periods')
    .update({ closing_entry_id: closingEntry.id })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)

  if (updateError) {
    throw new Error(`Failed to set closing_entry_id: ${updateError.message}`)
  }

  // 6. Lock the period
  await lockPeriod(supabase, companyId, userId, fiscalPeriodId)

  // 7. Close the period
  await closePeriod(supabase, companyId, userId, fiscalPeriodId)

  // 8. Create next period
  const nextPeriod = await createNextPeriod(supabase, companyId, userId, fiscalPeriodId)

  // 9. Generate opening balances in next period
  const openingBalanceEntry = await generateOpeningBalances(
    supabase,
    companyId,
    userId,
    fiscalPeriodId,
    nextPeriod.id
  )

  // 10. Validate IB/UB continuity and persist result
  const continuity = await validateBalanceContinuity(supabase, companyId, nextPeriod.id)

  await supabase
    .from('fiscal_periods')
    .update({ continuity_verified: continuity.valid })
    .eq('id', nextPeriod.id)
    .eq('company_id', companyId)

  if (!continuity.valid) {
    throw new Error(
      `IB/UB continuity check failed: ${continuity.discrepancies.length} account(s) differ. ` +
      continuity.discrepancies.map(d =>
        `${d.account_number}: UB=${d.previous_ub_net}, IB=${d.current_ib_net}, diff=${d.difference}`
      ).join('; ')
    )
  }

  // Fetch the now-closed period for the event payload
  const { data: closedPeriod } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (closedPeriod) {
    await eventBus.emit({
      type: 'period.year_closed',
      payload: { period: closedPeriod as FiscalPeriod, companyId, userId },
    })
  }

  return {
    closingEntry,
    nextPeriod,
    openingBalanceEntry,
    revaluationEntry: revaluationResult?.entry ?? null,
  }
}

/**
 * Generate opening balance entries in the next period from the closed period's
 * balance sheet accounts (class 1-2).
 *
 * Each account's closing balance becomes its opening balance.
 * The entry must be balanced (total debit openings = total credit openings).
 */
export async function generateOpeningBalances(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  closedPeriodId: string,
  nextPeriodId: string
): Promise<JournalEntry> {

  // Get next period for the entry date
  const { data: nextPeriod } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', nextPeriodId)
    .eq('company_id', companyId)
    .single()

  if (!nextPeriod) {
    throw new Error('Next fiscal period not found')
  }

  // Get trial balance of closed period (includes the closing entry)
  const { rows } = await generateTrialBalance(supabase, companyId, closedPeriodId)

  // Filter to balance sheet accounts (class 1-2) with non-zero closing balance
  const balanceSheetAccounts = rows.filter(
    (r) => r.account_class >= 1 && r.account_class <= 2
  )

  const openingLines: CreateJournalEntryLineInput[] = []

  for (const account of balanceSheetAccounts) {
    const netBalance = account.closing_debit - account.closing_credit

    if (Math.abs(netBalance) < 0.005) continue

    if (netBalance > 0) {
      // Debit balance → opening debit
      openingLines.push({
        account_number: account.account_number,
        debit_amount: Math.round(netBalance * 100) / 100,
        credit_amount: 0,
        line_description: `Ingående balans: ${account.account_name}`,
      })
    } else {
      // Credit balance → opening credit
      openingLines.push({
        account_number: account.account_number,
        debit_amount: 0,
        credit_amount: Math.round(Math.abs(netBalance) * 100) / 100,
        line_description: `Ingående balans: ${account.account_name}`,
      })
    }
  }

  if (openingLines.length === 0) {
    throw new Error('No balance sheet accounts with non-zero closing balance')
  }

  // Verify balance before creating
  const totalDebit = openingLines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = openingLines.reduce((sum, l) => sum + l.credit_amount, 0)

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(
      `Opening balances are not balanced: debit=${totalDebit}, credit=${totalCredit}`
    )
  }

  // Create opening balance entry in next period
  const openingEntry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: nextPeriodId,
    entry_date: nextPeriod.period_start,
    description: `Ingående balans ${nextPeriod.name}`,
    source_type: 'opening_balance',
    voucher_series: 'A',
    lines: openingLines,
  })

  // Mark next period with opening balance entry
  const { error: updateError } = await supabase
    .from('fiscal_periods')
    .update({
      opening_balance_entry_id: openingEntry.id,
      opening_balances_set: true,
    })
    .eq('id', nextPeriodId)
    .eq('company_id', companyId)

  if (updateError) {
    throw new Error(`Failed to set opening_balance_entry_id: ${updateError.message}`)
  }

  return openingEntry
}
