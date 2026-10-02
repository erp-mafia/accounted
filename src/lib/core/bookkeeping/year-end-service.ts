import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'
import { createLogger } from '@/lib/logger'

const log = createLogger('year-end-service')
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  fetchPaymentsAsOf,
  outstandingAsOf,
  todayIsoDate,
  type PaymentsAsOf,
} from '@/lib/reports/reskontra-payments'
import {
  lockPeriod,
  closePeriod,
  countUnbookedInPeriod,
  createNextPeriod,
  findNextPeriod,
} from './period-service'
import { generateResultAppropriation, previewResultAppropriation } from './result-appropriation-service'
import {
  previewCurrencyRevaluation,
  executeCurrencyRevaluation,
} from '@/lib/bookkeeping/currency-revaluation'
import { validateBalanceContinuity } from '@/lib/reports/continuity-check'
import { assessKontantmetodCutoff, undatedSettlementsNote } from './kontantmetod-cutoff'
import { ENTITY_TYPES, resolveCompanyEntityType, resultClosingAccounts } from '@/lib/company/entity-type'
import { formatCurrency } from '@/lib/utils'
import { overDisposedAmount, resultAccountLeftover, resultAccountResidual } from './prior-result-guard'
import { priorResultCarry } from './prior-result-carry'
import { buildOpeningBalanceLines, fetchObjectClosingBalances } from './opening-balance-split'
import type { ObjectBalanceSplit } from '@/lib/bookkeeping/dimension-carry'
import type {
  YearEndValidation,
  YearEndBlocker,
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
  // Each blocker carries a stable machine code (YearEndBlockerCode) that the
  // bokslut wizard matches on to attach remediation links; `errors` mirrors
  // the messages for consumers of the plain string list.
  const blockers: YearEndBlocker[] = []
  const warnings: string[] = []

  // Fetch the period
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  // The blocker/warning strings below are Swedish: they render verbatim in the
  // bokslut wizard (a "stays Swedish" surface per .claude/rules/i18n.md).
  // Blockers are routed on `code`, never on the wording, so rewording a
  // message is safe. Adding a NEW code is not: the MCP year_end_readiness tool
  // maps every YearEndBlockerCode to its public `kind`, so a new code needs a
  // matching entry in extensions/general/mcp-server/server.ts.
  if (fetchError || !period) {
    const notFound: YearEndBlocker[] = [
      { code: 'PERIOD_NOT_FOUND', message: 'Räkenskapsperioden hittades inte' },
    ]
    return {
      ready: false,
      blockers: notFound,
      errors: notFound.map((b) => b.message),
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
    blockers.push({
      code: 'PERIOD_NOT_ENDED',
      message: 'Perioden kan inte stängas: slutdatumet har inte passerat ännu',
    })
  }

  // Check: period not already closed
  if (period.is_closed) {
    blockers.push({ code: 'PERIOD_ALREADY_CLOSED', message: 'Perioden är redan stängd' })
  }

  // Check: period not locked. executeYearEndClosing posts the closing entry
  // INTO this period (step 4) and locks it itself (step 7), so a lock taken
  // beforehand only surfaces at commit as the period-lock trigger's "Cannot
  // write to locked/closed fiscal period", after readiness said ready. The
  // MCP year-end skill used to prescribe lock -> run_year_end (feedback seq
  // 392722); name the fix here instead. A closed period is locked too, but
  // "unlock it" would be wrong advice there: PERIOD_ALREADY_CLOSED covers it.
  if (!period.is_closed && period.locked_at) {
    blockers.push({
      code: 'PERIOD_LOCKED',
      message:
        'Perioden är låst: lås upp den först. Bokslutet bokför bokslutsverifikationen i perioden och låser den sedan självt',
    })
  }

  // Check: closing entry doesn't already exist
  if (period.closing_entry_id) {
    blockers.push({
      code: 'CLOSING_ENTRY_EXISTS',
      message: 'Bokslutsverifikation finns redan för perioden',
    })
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
    blockers.push({
      code: 'DRAFT_ENTRIES',
      message: `${drafts} utkast måste bokföras eller raderas innan bokslut`,
    })
  }

  // Check: voucher continuity across all series
  const voucherGaps: VoucherGap[] = []
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

  // Check gap explanations: unexplained gaps block year-end (BFNAR 2013:2 punkt 5.8)
  const unexplainedGaps: VoucherGap[] = []
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
          `Verifikationsnummerglapp i serie ${gap.series} (${gap.gap_start}-${gap.gap_end}): dokumenterat`
        )
      } else {
        unexplainedGaps.push(gap)
        blockers.push({
          code: 'UNEXPLAINED_VOUCHER_GAP',
          message: `Oförklarat verifikationsnummerglapp i serie ${gap.series}: ${gap.gap_start}-${gap.gap_end}`,
        })
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
          blockers.push({
            code: 'SEQUENCE_COUNTER_BEHIND',
            message: `Nummerserien i serie ${row.voucher_series} stämmer inte: räknaren står på ${sequenceCounter} men högsta verifikationsnummer är ${actualMax}`,
          })
        } else {
          warnings.push(
            `Nummerräknaren ligger före bokförda verifikationer i serie ${row.voucher_series}: räknare=${sequenceCounter}, högsta verifikationsnummer=${actualMax}`
          )
        }
      }
    }
  }

  // Check: trial balance is balanced
  const trialBalance = await generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' })
  const trialBalanceBalanced = trialBalance.isBalanced

  if (!trialBalanceBalanced) {
    blockers.push({
      code: 'TRIAL_BALANCE_UNBALANCED',
      message: `Råbalansen balanserar inte: debet=${trialBalance.totalDebit}, kredit=${trialBalance.totalCredit}`,
    })
  }

  // Check: the "årets resultat" account holds only this year's result. A prior
  // year's result still sitting there (typically carried in by imported opening
  // balances that no Accounted year-end ever moved) would be added to this
  // year's by the closing entry, and the balance sheet's Årets resultat would
  // no longer match the income statement (PostHog PH 120). Only before the
  // close: once a closing entry exists, CLOSING_ENTRY_EXISTS already blocks.
  // Fails open (logged): a lookup error must not block every close. The free
  // pre-check on the trial balance keeps the form lookup off the common path:
  // only a leftover on one of the forms' result accounts, or one that shows
  // once this year's hand-closed result is taken off, is worth resolving.
  const resultAccountCandidates = [
    ...new Set(
      ENTITY_TYPES.map((t) => resultClosingAccounts(t))
        .filter((a) => a.priorYearCarry)
        .map((a) => a.closing),
    ),
  ]
  if (
    !period.closing_entry_id &&
    resultAccountCandidates.some(
      (account) =>
        resultAccountLeftover(trialBalance.rows, account) !== 0 ||
        resultAccountResidual(trialBalance.rows, account) !== 0,
    )
  ) {
    try {
      const { data: formSettings } = await supabase
        .from('company_settings')
        .select('entity_type')
        .eq('company_id', companyId)
        .maybeSingle()
      const entityType = await resolveCompanyEntityType(supabase, companyId, formSettings?.entity_type)
      // Null for forms that close straight into equity (enskild firma, 2010).
      // A balance that is this year's result, already booked by hand, is not
      // a carry and does not block (PostHog PH 108's re-run): only what is
      // left of the ingående balans after the omföring and hand-booked
      // dispositions counts.
      const carry = await priorResultCarry(supabase, companyId, period, entityType)
      if (carry && carry.remaining !== 0) {
        blockers.push({
          code: 'PRIOR_RESULT_NOT_DISPOSED',
          message:
            `Konto ${carry.resultAccount} ${carry.resultAccountName} bär fortfarande ${formatCurrency(Math.abs(carry.remaining))} från föregående års resultat. ` +
            `Flytta det till ${carry.priorResultAccount} eller ${carry.retainedAccount} (resultatdisposition) innan bokslutet, annars räknas det in i årets resultat.`,
        })
      }
      // The other way round (an SIE-migrated aktiebolag, 2026-09-29): the
      // prior result moved off more than it was, typically the automatic
      // omföring plus the previous system's own disposition imported into the
      // same year. The account then carries the excess with the opposite sign
      // and the close adds this year's result on top. Measured net of this
      // year's result already closed onto the account by hand (899x), so the
      // amount is what a correction must move back and the block clears once
      // one is booked.
      const excess = carry
        ? overDisposedAmount(carry.overMoved, resultAccountResidual(trialBalance.rows, carry.resultAccount))
        : 0
      if (carry && excess !== 0) {
        const amount = formatCurrency(Math.abs(excess))
        const dispositionAccounts = `${carry.priorResultAccount} eller ${carry.retainedAccount}`
        // A profit moved off too often leaves a debit, credited back; a loss the other way.
        const [debit, credit] =
          excess < 0 ? [dispositionAccounts, carry.resultAccount] : [carry.resultAccount, dispositionAccounts]
        blockers.push({
          code: 'PRIOR_RESULT_OVER_DISPOSED',
          message:
            `Från konto ${carry.resultAccount} ${carry.resultAccountName} har ${amount} mer än föregående års resultat förts bort (verifikat ${carry.movedBy.join(', ')}). ` +
            `Boka en rättelse daterad i räkenskapsåret, senast ${period.period_end}, som för tillbaka ${amount} till ${carry.resultAccount} från ${dispositionAccounts}, där beloppet bokades för mycket (debet ${debit}, kredit ${credit}). ` +
            'Annars stämmer årets resultat i balansräkningen inte med resultaträkningen.',
        })
      }
    } catch (err) {
      log.warn('year-end: prior-result check skipped', {
        operation: 'year_end.prior_result_check',
        companyId,
        entityType: 'fiscal_period',
        entityId: fiscalPeriodId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Check: at least some entries exist
  const { count: entryCount } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'posted')

  if ((entryCount ?? 0) === 0) {
    warnings.push('Inga bokförda verifikationer i perioden')
  }

  // Check: foreign-currency items open on balansdagen (ÅRL 4 kap. 13 §).
  //
  // Only a revaluation dated ON balansdagen discharges the duty. The previous
  // gate accepted any currency_revaluation verifikat anywhere in the period,
  // so one interim run (a June month-end revaluation) silenced the check for
  // every item still outstanding on 31 December: "we already did one, so stop
  // looking". An interim revaluation says nothing about the balansdagen value.
  const { count: balansdagenRevalCount } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('source_type', 'currency_revaluation')
    .eq('status', 'posted')
    .eq('entry_date', period.period_end)

  // Both states below are warnings, never blockers: nothing in the bokslut
  // rules makes an unvalued FX item a bar to closing, and executeYearEndClosing
  // runs the revaluation itself in step 2. Escalating would block a close that
  // the very next step performs.
  try {
    const openFx = await countOpenFxItemsAtBalansdagen(supabase, companyId, period.period_end)

    // Loudest case first. A row with no exchange_rate is invisible to the
    // revaluation: previewCurrencyRevaluation partitions it into
    // `unconvertedFx` and drops it, so re-running the year-end will never
    // value it. It needs a rate on the invoice, and these rows are typically
    // the largest unmeasured exposure precisely because nothing warns on them.
    // The old query's `.not('exchange_rate','is',null)`, inherited from the
    // revaluation code, excluded exactly this case: a company whose only open
    // FX items were unconverted got no warning at all.
    if (openFx.unconverted > 0) {
      warnings.push(
        `${openFx.unconverted} post(er) i utländsk valuta var öppna på balansdagen ${period.period_end} men saknar valutakurs: de kan inte värderas till balansdagskurs (ÅRL 4 kap. 13 §) och utelämnas ur omvärderingen. Registrera kursen på fakturan.`
      )
    }

    // Separate state, separate remedy: these can be valued, they just have not
    // been yet. Suppressed only by a revaluation dated on balansdagen.
    if (openFx.revaluable > 0 && (balansdagenRevalCount ?? 0) === 0) {
      warnings.push(
        `${openFx.revaluable} post(er) i utländsk valuta var öppna på balansdagen ${period.period_end} och har inte omvärderats till balansdagskurs (ÅRL 4 kap. 13 §)`
      )
    }
  } catch (err) {
    // A failed lookup must not read as "no FX exposure". Say the check did not
    // run rather than let silence pass for a clean bill of health.
    log.error('year-end: could not measure open FX items at balansdagen', err as Error, {
      operation: 'year_end.fx_readiness',
      companyId,
      entityType: 'fiscal_period',
      entityId: fiscalPeriodId,
    })
    warnings.push(
      'Kontrollen av öppna poster i utländsk valuta (ÅRL 4 kap. 13 §) kunde inte genomföras: stäm av dem manuellt innan bokslut'
    )
  }

  // Check: continuity_verified flag from prior year-end
  if (period.continuity_verified === false) {
    blockers.push({
      code: 'CONTINUITY_MISMATCH',
      message: 'IB/UB-kontinuiteten stämmer inte för perioden: åtgärda avvikelserna innan bokslut',
    })
  }

  // Check: next period state. A pre-existing next period (from SIE import,
  // manual creation, or a prior partial run) is fine (we'll reuse it), but
  // one with opening balances already booked blocks closing because we
  // can't post a second IB on top.
  //
  // The period name is not interpolated into the message: although the
  // name is user-supplied at create time and confined to the company,
  // surfacing DB-sourced strings through error paths is the kind of
  // injection footgun we'd rather close at the source than rely on the UI
  // to escape (text rendering and aria-label propagation differ).
  const nextPeriod = await findNextPeriod(supabase, companyId, fiscalPeriodId)
  if (nextPeriod) {
    if (nextPeriod.opening_balance_entry_id) {
      blockers.push({
        code: 'NEXT_PERIOD_HAS_IB',
        message: 'Nästa räkenskapsperiod har redan ingående balanser bokförda',
      })
    } else {
      warnings.push('Nästa räkenskapsperiod finns redan: ingående balanser bokförs i den')
    }
  }

  // Kontantmetoden is a legal hard gate, not an advisory: BFL 5 kap 2 §
  // requires every unpaid receivable and liability to be booked at the fiscal
  // year end. Gate before executeYearEndClosing posts its closing entry. A
  // later lock-time check would leave a partial close behind on failure.
  //
  // Not for a closed period: nothing can be posted into it any more (the
  // cut-off tool and its executor refuse a closed period, as does the
  // period-lock trigger), and PERIOD_ALREADY_CLOSED already says why this
  // close cannot run. A year marked closed outside the year-end
  // (close_fiscal_period_external) otherwise kept a blocker nobody could
  // clear (feedback seq 798354).
  if (!period.is_closed) {
    try {
      const { data: settings, error: settingsError } = await supabase
        .from('company_settings')
        .select('accounting_method, entity_type')
        .eq('company_id', companyId)
        .maybeSingle()

      if (settingsError) throw settingsError

      if (settings?.accounting_method === 'cash') {
        if (!nextPeriod) {
          blockers.push({
            code: 'KONTANTMETOD_CUTOFF_REQUIRED',
            message:
              'Kontantmetodens bokslutsavgränsning kan inte bokföras förrän nästa räkenskapsår är upplagt. Skapa nästa period, förhandsgranska och bokför avgränsningen innan bokslut.',
          })
        } else {
          const assessment = await assessKontantmetodCutoff(
            supabase,
            companyId,
            period,
            nextPeriod.id,
            await resolveCompanyEntityType(supabase, companyId, settings.entity_type),
          )
          const invalidCount =
            assessment.collection.unknownVatTreatment.length +
            assessment.collection.strayVatOnZeroRate.length
          const outstandingCount =
            assessment.collection.receivables.length + assessment.collection.payables.length

          // A warning, never a blocker: the assumption is the reskontra's own
          // as-of rule, and nothing in the books can date what the previous
          // system never recorded. The user can, against the bank.
          const undatedNote = undatedSettlementsNote(
            assessment.collection.undatedSettlements.length,
            period.period_end,
          )
          if (undatedNote) warnings.push(undatedNote)

          if (invalidCount > 0) {
            blockers.push({
              code: 'KONTANTMETOD_CUTOFF_REQUIRED',
              message:
                `${invalidCount} fakturor kan inte tas med i kontantmetodens bokslutsavgränsning på grund av saknad eller oförenlig momsinställning. Rätta fakturorna och bokför avgränsningen innan bokslut.`,
            })
          } else if (!assessment.postings.complete) {
            blockers.push({
              code: 'KONTANTMETOD_CUTOFF_REQUIRED',
              message:
                outstandingCount > 0
                  ? `${outstandingCount} obetalda fakturor var utestående vid periodens slut. Förhandsgranska och bokför kontantmetodens bokslutsavgränsning med vändningar innan bokslut (BFL 5 kap 2 §).`
                  : 'En tidigare kontantmetodavgränsning stämmer inte längre med reskontran. Kontrollera och rätta verifikaten innan bokslut.',
            })
          }
        }
      }
    } catch (err) {
      log.warn('kontantmetoden cut-off readiness check failed', err as Error)
      blockers.push({
        code: 'KONTANTMETOD_CUTOFF_CHECK_FAILED',
        message:
          'Kontrollen av kontantmetodens bokslutsavgränsning kunde inte genomföras: försök igen innan bokslut',
      })
    }
  }

  // Check: unbooked bank transactions in the period. lockPeriod enforces this
  // at step 7 of executeYearEndClosing, AFTER the closing entry has already
  // posted at step 4: without this readiness check a period with unbooked
  // transactions reported ready: true and then aborted mid-flow, leaving a
  // posted closing entry on an unlocked, unclosed period. Same counter as the
  // lock guard (countUnbookedInPeriod), so the number reconciles with the
  // "att bokföra" badge. Fails CLOSED like lockPeriod: a check that could not
  // run must not pass.
  let unbookedTransactionCount = 0
  try {
    const unbooked = await countUnbookedInPeriod(
      supabase,
      companyId,
      period.period_start,
      period.period_end,
    )
    unbookedTransactionCount = unbooked.untriaged + unbooked.businessUnbooked
    if (unbookedTransactionCount > 0) {
      blockers.push({
        code: 'UNBOOKED_TRANSACTIONS',
        message: `${unbookedTransactionCount} transaktioner i perioden saknar bokföring: bokför dem eller markera dem som privata innan bokslut`,
      })
    }
  } catch (err) {
    log.warn('unbooked-transaction readiness check failed', err as Error)
    blockers.push({
      code: 'UNBOOKED_CHECK_FAILED',
      message: 'Kontrollen av obokförda transaktioner kunde inte genomföras: försök igen',
    })
  }

  return {
    ready: blockers.length === 0,
    blockers,
    errors: blockers.map((b) => b.message),
    warnings,
    draftCount: drafts,
    voucherGaps,
    unexplainedGaps,
    sequenceMismatches,
    trialBalanceBalanced,
    unbookedTransactionCount,
  }
}

/**
 * Preview year-end closing without persisting anything.
 * Shows the net result, closing account, and the journal entry lines that would be created,
 * plus the omföring the close books in the next period (`resultAppropriation`) unless the
 * caller opts out.
 */
export async function previewYearEndClosing(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  options: { resultAppropriation?: boolean } = {},
): Promise<YearEndPreview> {

  // Get entity type to determine closing account
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .single()

  const entityType = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)
  const { closing: closingAccount, closingName: closingAccountName } = resultClosingAccounts(entityType)

  // Get trial balance for individual account balances in class 3-8
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' })
  const resultAccounts = rows.filter(
    (r) => r.account_class >= 3 && r.account_class <= 8
  )

  // Build closing lines: zero each result account
  const closingLines: CreateJournalEntryLineInput[] = []
  const resultAccountSummary: { account_number: string; account_name: string; amount: number }[] = []

  for (const account of resultAccounts) {
    const netBalance = account.closing_debit - account.closing_credit

    if (Math.abs(netBalance) < ORE_TOLERANCE) continue

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
        credit_amount: roundOre(netBalance),
        line_description: `Closing: ${account.account_name}`,
      })
    } else {
      // Account has credit balance → debit it to zero
      closingLines.push({
        account_number: account.account_number,
        debit_amount: roundOre(Math.abs(netBalance)),
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

  // netResult must equal, by construction, the signed amount transferred to the
  // closing account (2099/2010) by the balancing line below: positive = credit
  // = vinst, negative = debit = forlust. It is deliberately NOT taken from
  // generateIncomeStatement: that report excludes source_type='year_end'
  // entries, and bokslut-flow entries (annual depreciation, dispositioner)
  // carry that tag, so the income-statement figure misses them and the
  // summary card would mismatch the bokslutsverifikation table (issue #766).
  const netResult = roundOre(totalClosingDebit - totalClosingCredit)

  const balancingAmount = roundOre(Math.abs(totalClosingDebit - totalClosingCredit))

  if (balancingAmount > ORE_TOLERANCE) {
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

  // Advisory check: an AB closing a profit year should normally have booked
  // bolagsskatt (Dr 8910 / Cr 2512) in the dispositions step. If no 89xx tax
  // account is among the accounts being closed, the profit is untaxed. This
  // is a warning, not a blocker: zero tax is legitimate when underskotts-
  // avdrag zeroes the taxable result. 8999 is excluded: it is the manual
  // result-closing account, not a tax account.
  // Scanning resultAccountSummary is equivalent to a full 89xx trial-balance
  // scan: it is built from every class 3-8 account with a non-zero closing
  // balance, regardless of voucher series, so a booked tax entry cannot be
  // missed by this check.
  const hasTaxAccount = resultAccountSummary.some(
    (a) => a.account_number.startsWith('89') && a.account_number !== '8999'
  )
  const bolagsskattMissing =
    closingAccount === '2099' && netResult > ORE_TOLERANCE && !hasTaxAccount

  // The close books a second verifikat: step 11's omföring of the result off
  // the result account in the next period. Disclose it with the same rule
  // (feedback seq 707985). The next period's ingående balans on the result
  // account will be what the account holds now plus this year's result,
  // including the balansdagen revaluation step 2 books first.
  const resultAppropriation = periodData && options.resultAppropriation !== false
    ? await previewResultAppropriation(supabase, companyId, {
        periodId: fiscalPeriodId,
        periodEnd: periodData.period_end,
        entityType,
        projectedIbNet: roundOre(
          resultAccountLeftover(rows, closingAccount) + netResult + (currencyRevaluation?.netEffect ?? 0),
        ),
      })
    : null

  return {
    netResult,
    closingAccount,
    closingAccountName,
    closingLines,
    resultAccountSummary,
    currencyRevaluation,
    bolagsskattMissing,
    resultAppropriation,
  }
}

/**
 * Execute year-end closing for a fiscal period.
 *
 * 1. Validate readiness
 * 2. Run currency revaluation (FX gains/losses to 3960/7960)
 * 3. Generate closing preview and check öre balance
 * 4. Create closing entry (zeros class 3-8 accounts)
 * 5. Set closing_entry_id on the period
 * 6. Resolve next fiscal period (reuse existing or create new)
 * 7. Lock the period
 * 8. Close the period (irreversible, every guard must run before this)
 * 9. Generate opening balances in next period
 * 10. Validate IB/UB continuity
 * 11. Omföra föregående års resultat (2099 → 2098) in the new period (AB only)
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
    throw new Error(`Bokslutet kan inte verkställas: ${validation.errors.join('; ')}`)
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

  // 3. Get closing preview (now includes revaluation effects in trial balance).
  //    Without the omföring disclosure: step 11 books it from the real IB, and
  //    here the estimate would only add queries that could fail the close.
  const preview = await previewYearEndClosing(supabase, companyId, userId, fiscalPeriodId, {
    resultAppropriation: false,
  })

  if (preview.closingLines.length === 0) {
    throw new Error('No result accounts to close: period has no activity')
  }

  // 3a. INVARIANT: closing entry must balance to the öre before commit.
  // This guards against rounding drift in previewYearEndClosing: the DB
  // balance trigger would catch it too, but we want a clear Swedish error
  // surfaced to the user, not a generic Postgres exception.
  const preCommitDebit = roundOre(
    preview.closingLines.reduce((s, l) => s + l.debit_amount, 0)
  )
  const preCommitCredit = roundOre(
    preview.closingLines.reduce((s, l) => s + l.credit_amount, 0)
  )
  if (Math.abs(preCommitDebit - preCommitCredit) > ORE_TOLERANCE) {
    throw new Error(
      `Bokslutsverifikationen balanserar inte: debet=${preCommitDebit}, kredit=${preCommitCredit}`
    )
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

  // 4a. INVARIANT: after the closing entry, class 3-8 net must be exactly 0
  // (to the öre). If not, we have a logic bug: fail loud rather than
  // proceed into IB generation with a corrupt trial balance.
  // createJournalEntry has no transactional grouping with the next call;
  // the engine commits atomically per-entry via commit_journal_entry RPC,
  // so a failure here means we need to reverse the just-committed entry.
  try {
    const postCloseTB = await generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' })
    let resultNet = 0
    for (const row of postCloseTB.rows) {
      if (row.account_class >= 3 && row.account_class <= 8) {
        resultNet += row.closing_debit - row.closing_credit
      }
    }
    resultNet = roundOre(resultNet)
    if (Math.abs(resultNet) > ORE_TOLERANCE) {
      throw new Error(
        `Resultatkonton (klass 3-8) saknar nollställning efter bokslut: nettot är ${resultNet} SEK`
      )
    }
  } catch (err) {
    // Best-effort reversal of the closing entry before re-throwing.
    await safeReverse(supabase, companyId, userId, closingEntry.id, 'closing entry')
    throw err
  }

  // 5. Update fiscal period with closing_entry_id
  const { error: updateError } = await supabase
    .from('fiscal_periods')
    .update({ closing_entry_id: closingEntry.id })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)

  if (updateError) {
    throw new Error(`Failed to set closing_entry_id: ${updateError.message}`)
  }

  // 6. Resolve the next period BEFORE locking/closing this one. A pre-existing
  //    next period is common (SIE import, manual creation, prior partial
  //    year-end run); reusing it is fine as long as no IB has been booked
  //    into it. Doing this check after closePeriod would leave the books in
  //    a half-closed state if a concurrent process posted IB into the next
  //    period between validateYearEndReadiness and step 8 (TOCTOU race).
  //
  //    The thrown error is intentionally a stable English string with no
  //    DB-sourced data interpolated: the route layer maps it to a
  //    structured error code, and the next period name (if any) is surfaced
  //    only through the structured details payload after explicit checks.
  const existingNextPeriod = await findNextPeriod(supabase, companyId, fiscalPeriodId)
  let nextPeriod
  if (existingNextPeriod) {
    if (existingNextPeriod.opening_balance_entry_id) {
      throw new Error(
        'Next fiscal period already has opening balance entry posted; reverse it before re-running year-end'
      )
    }
    nextPeriod = existingNextPeriod
  } else {
    nextPeriod = await createNextPeriod(supabase, companyId, userId, fiscalPeriodId)
  }

  // 7. Lock the period
  await lockPeriod(supabase, companyId, userId, fiscalPeriodId)

  // 8. Close the period: irreversible per BFL. Every guard that can fail
  //    on prior state must run before this point.
  await closePeriod(supabase, companyId, userId, fiscalPeriodId)

  // 9. Generate opening balances in next period
  const openingBalanceEntry = await generateOpeningBalances(
    supabase,
    companyId,
    userId,
    fiscalPeriodId,
    nextPeriod.id
  )

  // 10. Validate IB/UB continuity and persist result.
  // INVARIANT: any account differing by more than ORE_TOLERANCE is a hard
  // failure. Best-effort rollback of both the IB entry and the closing
  // entry so the user sees a clean state and can re-run the wizard.
  //
  // Note on atomicity: createJournalEntry uses an atomic commit_journal_entry
  // RPC per entry, but the closing + IB entries are two separate commits with
  // a period lock/close in between. Once committed, posted entries are
  // immutable by DB trigger: true rollback isn't possible. reverseEntry()
  // posts a compensating storno entry instead. The closed period was also
  // locked & closed, but reverseEntry uses an entry_date that (under the
  // period-lock trigger) may be blocked. We attempt reversal but tolerate
  // failure, surfacing the original continuity error either way.
  const continuity = await validateBalanceContinuity(supabase, companyId, nextPeriod.id)

  await supabase
    .from('fiscal_periods')
    .update({ continuity_verified: continuity.valid })
    .eq('id', nextPeriod.id)
    .eq('company_id', companyId)

  const overTolerance = continuity.discrepancies.filter(
    (d) => Math.abs(d.difference) > ORE_TOLERANCE
  )
  if (overTolerance.length > 0) {
    await safeReverse(supabase, companyId, userId, openingBalanceEntry.id, 'opening balance entry')
    await safeReverse(supabase, companyId, userId, closingEntry.id, 'closing entry')

    throw new Error(
      `IB/UB-kontinuitet misslyckades: ${overTolerance.length} konto(n) avviker. ` +
        overTolerance
          .map(
            (d) =>
              `${d.account_number}: UB=${d.previous_ub_net}, IB=${d.current_ib_net}, diff=${d.difference}`
          )
          .join('; ')
    )
  }

  // 11. Omföra föregående års resultat: move 2099 "Årets resultat" off onto
  //     2098 in the new period so it starts the year at zero (aktiebolag only).
  //     This is a SEPARATE verifikat by design: folding it into the IB entry
  //     would make the continuity check above fail, since that check reads IB
  //     solely from the opening_balance entry. Non-fatal: the close and IB are
  //     already valid and immutable; a failure here is logged and left for the
  //     retroactive catch-up script (scripts/repair-result-appropriation.ts).
  let resultAppropriationEntry: JournalEntry | null = null
  let resultAppropriationFailed = false
  try {
    resultAppropriationEntry = await generateResultAppropriation(
      supabase,
      companyId,
      userId,
      nextPeriod.id
    )
  } catch (err) {
    resultAppropriationFailed = true
    // alert:true routes this to the observability sink (lib/observability) in
    // addition to the log line: a silent accounting failure must not wait for
    // a manual audit. The sink is a no-op until a provider is configured, so
    // today this reaches the JSON log only. The new period now opens with 2099 still carrying the
    // prior result; resultAppropriationFailed below drives a UI warning and the
    // catch-up script (scripts/repair-result-appropriation.ts) posts the fix.
    log.error('year-end: result appropriation omföring failed (non-fatal)', err as Error, {
      operation: 'year_end.result_appropriation',
      alert: true,
      companyId,
      entityType: 'fiscal_period',
      entityId: nextPeriod.id,
    })
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
    resultAppropriationEntry,
    resultAppropriationFailed,
    continuity,
  }
}

/**
 * Generate opening balance entries in the next period from the closed period's
 * balance sheet accounts (class 1-2).
 *
 * Each account's closing balance becomes its opening balance, split per
 * project (issue #3313, lib/core/bookkeeping/opening-balance-split.ts): one
 * line per object of an accumulating dimension carrying that object's
 * closing balance, plus an untagged remainder. The VAT accounts (26xx) are
 * never split: their IB stays one untagged line. Per-account totals are the
 * trial balance's, exactly as before the split.
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
  const { rows } = await generateTrialBalance(supabase, companyId, closedPeriodId, { closingEntry: 'include' })

  // Filter to balance sheet accounts (class 1-2) with non-zero closing balance
  const balanceSheetAccounts = rows.filter(
    (r) => r.account_class >= 1 && r.account_class <= 2
  )

  // Project split. This runs after the period was closed (irreversible), so
  // a failure must not leave the year without an IB: fall back to one line
  // per account, alert, and leave the split to be redone later. Totals are
  // identical either way.
  let objectBalances = new Map<string, ObjectBalanceSplit[]>()
  try {
    objectBalances = await fetchObjectClosingBalances(supabase, companyId, closedPeriodId)
  } catch (err) {
    log.error('year-end: opening balance project split failed, IB booked per account (non-fatal)', err as Error, {
      operation: 'year_end.opening_balance_split',
      alert: true,
      companyId,
      entityType: 'fiscal_period',
      entityId: nextPeriodId,
    })
  }

  const accountTotals = balanceSheetAccounts.map((account) => ({
    account_number: account.account_number,
    account_name: account.account_name,
    net: account.closing_debit - account.closing_credit,
  }))
  const openingLines: CreateJournalEntryLineInput[] = buildOpeningBalanceLines(accountTotals, objectBalances)

  if (openingLines.length === 0) {
    throw new Error('No balance sheet accounts with non-zero closing balance')
  }

  // Verify balance before creating
  const totalDebit = openingLines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = openingLines.reduce((sum, l) => sum + l.credit_amount, 0)

  if (Math.abs(totalDebit - totalCredit) > ORE_TOLERANCE) {
    throw new Error(
      `Ingående balanser balanserar inte: debet=${roundOre(totalDebit)}, kredit=${roundOre(totalCredit)}`
    )
  }

  // Create opening balance entry in next period. The project bags are copied
  // from posted history, so the registry must not refuse them: a project
  // archived during the year can still hold a 1470 balance (replayDimensions,
  // scoped to this generator; see CreateEntryOptions).
  const openingEntryInput = (lines: CreateJournalEntryLineInput[]) => ({
    fiscal_period_id: nextPeriodId,
    entry_date: nextPeriod.period_start,
    description: `Ingående balans ${nextPeriod.name}`,
    source_type: 'opening_balance' as const,
    voucher_series: 'A',
    lines,
  })
  let openingEntry: JournalEntry
  try {
    openingEntry = await createJournalEntry(
      supabase, companyId, userId, openingEntryInput(openingLines), undefined, undefined, { replayDimensions: true }
    )
  } catch (err) {
    // The period is already closed, so a split that the database refuses
    // (a line insert constraint, e.g. a legacy bag the NOT VALID
    // jel_dimensions_well_formed CHECK never saw, or a commit trigger) must
    // not leave the year without an IB. Retrying per account must never
    // double the IB, so it runs only when nothing can have been posted:
    // - create_entry_lines: the draft never reached commit_journal_entry;
    // - commit_entry with a Postgres error code: the database answered with
    //   a rejection, so the commit transaction rolled back. A commit error
    //   without one (a transport failure, a lost response) may hide a
    //   commit that succeeded, so it fails as before;
    // and only after re-reading that the next period holds no posted IB.
    // Anything else, or an IB that had no split, fails as before.
    const refusedBeforePosting =
      err instanceof BookkeepingDatabaseError &&
      (err.operation === 'create_entry_lines' || (err.operation === 'commit_entry' && Boolean(err.pgCode)))
    const hadSplit = openingLines.some((line) => line.dimensions !== undefined)
    if (!hadSplit || !refusedBeforePosting) throw err
    if (await mayHavePostedOpeningBalance(supabase, companyId, nextPeriodId)) throw err
    log.error('year-end: opening balance with project split refused, IB booked per account (non-fatal)', err as Error, {
      operation: 'year_end.opening_balance_split',
      alert: true,
      companyId,
      entityType: 'fiscal_period',
      entityId: nextPeriodId,
    })
    openingEntry = await createJournalEntry(
      supabase, companyId, userId, openingEntryInput(buildOpeningBalanceLines(accountTotals, new Map()))
    )
  }

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

/**
 * True unless a read confirms the period holds no posted opening balance
 * entry. Guards the per-account IB retry: a second posted IB would double
 * every balance and count as period activity. A failed read is treated as
 * "may have posted", so the retry is skipped and the original error stands.
 */
async function mayHavePostedOpeningBalance(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('source_type', 'opening_balance')
    .eq('status', 'posted')
    .limit(1)
  if (error) return true
  return Array.isArray(data) && data.length > 0
}

/**
 * Open foreign-currency items as they stood on balansdagen, split by whether
 * the ÅRL 4 kap. 13 § valuation can reach them at all. The two states have
 * different remedies, so they are counted apart rather than summed.
 */
interface OpenFxAtBalansdagen {
  /** Carries a usable exchange_rate: revaluable to the balansdagen rate. */
  revaluable: number
  /**
   * No exchange_rate on file, so there is no original SEK value to revalue
   * from. Counted rather than dropped, the same contract `unconverted_fx_count`
   * carries on the reskontra reports (lib/reports/supplier-ledger.ts): an
   * excluded row has to show up as a number somewhere.
   */
  unconverted: number
}

/** The subset of an invoice row this check reads. */
interface FxLedgerRow {
  id: string
  status: string | null
  currency: string | null
  exchange_rate: number | string | null
  total: number | string | null
  paid_amount: number | string | null
  remaining_amount: number | string | null
  paid_at: string | null
}

/** A stored rate is usable only when present and strictly positive. */
function hasUsableFxRate(rate: number | string | null | undefined): boolean {
  return rate != null && Number(rate) > 0
}

/**
 * Count the foreign-currency receivables and payables that were still open on
 * balansdagen.
 *
 * Measured AS OF balansdagen, not as of now. ÅRL 4 kap. 13 § values monetary
 * items at the balance-sheet date, so an invoice settled in March of the
 * following year was still an open FX item on 31 December and still had to be
 * valued there; the live `status` column only says what is open today. For a
 * historical balansdagen the population is therefore widened to invoices dated
 * on or before it (including ones settled since) and the outstanding amount is
 * recomputed from the payment history, the same reconstruction the reskontra
 * reports use (lib/reports/ar-ledger.ts, lib/reports/supplier-ledger.ts). For
 * today or a future balansdagen the stored open-invoice state IS the as-of
 * state, so no reconstruction is attempted.
 *
 * Limits, inherited from `outstandingAsOf` and identical to what the reskontra
 * reports already accept: an invoice with no payment rows and no `paid_at`
 * cannot be dated, so its live outstanding is assumed to have stood at
 * balansdagen; and an invoice cancelled or credited since is treated as never
 * having been open, because neither event carries a reliable date. The status
 * population, date scoping and outstanding reconstruction are kept identical
 * to what the revaluation engine acts on (`getOpenForeignCurrencyReceivables`
 * / `...Payables` with the same as-of date).
 *
 * Deliberately NOT gated by `fxExposureScope`, unlike the revaluation itself.
 * An unbooked FX row is exactly the case worth warning about: it is not on
 * 1510/2440 yet, so the revaluation skips it, but POST /api/invoices/[id]/book
 * still books it at its own invoice_date, i.e. into the year about to close.
 * Once step 7/8 lock and close the period that remedy is gone for good, so
 * suppressing the warning here would convert a recoverable state into a
 * permanent misstatement.
 */
async function countOpenFxItemsAtBalansdagen(
  supabase: SupabaseClient,
  companyId: string,
  balansdagen: string
): Promise<OpenFxAtBalansdagen> {
  const isHistorical = balansdagen < todayIsoDate()
  const columns =
    'id, status, currency, exchange_rate, total, paid_amount, remaining_amount, paid_at'

  const receivables = await fetchAllRows<FxLedgerRow>(
    ({ from, to }) => {
      const base = supabase
        .from('invoices')
        .select(columns)
        .eq('company_id', companyId)
        // Proformas, delivery notes and quotes are never receivables (kept in
        // lockstep with getOpenForeignCurrencyReceivables).
        .eq('document_type', 'invoice')
        .neq('currency', 'SEK')
      // 'partially_paid' is a live status for customer invoices (payment-sync
      // sets it on partial settlements); the unpaid remainder was open on
      // balansdagen just like a 'sent' invoice. Kept in lockstep with
      // getOpenForeignCurrencyReceivables so this warning never points at
      // rows the revaluation engine cannot see.
      const scoped = isHistorical
        ? base
            .in('status', ['sent', 'overdue', 'partially_paid', 'paid'])
            .lte('invoice_date', balansdagen)
        : base.in('status', ['sent', 'overdue', 'partially_paid'])
      // Stable total order for correct paging (see fetch-all.ts).
      return scoped.order('id', { ascending: true }).range(from, to)
    },
    { dedupeBy: (r) => r.id }
  )

  const payables = await fetchAllRows<FxLedgerRow>(
    ({ from, to }) => {
      const base = supabase
        .from('supplier_invoices')
        .select(columns)
        .eq('company_id', companyId)
        .neq('currency', 'SEK')
      const scoped = isHistorical
        ? base
            .in('status', ['registered', 'approved', 'overdue', 'partially_paid', 'paid'])
            .lte('invoice_date', balansdagen)
        : base.in('status', ['registered', 'approved', 'overdue', 'partially_paid'])
      return scoped.order('id', { ascending: true }).range(from, to)
    },
    { dedupeBy: (r) => r.id }
  )

  // Payment history is only needed to walk a since-settled invoice back to what
  // it owed on balansdagen, and only when there is something to walk back.
  const receivablePayments =
    isHistorical && receivables.length > 0
      ? await fetchPaymentsAsOf(supabase, 'invoice_payments', 'invoice_id', companyId, balansdagen)
      : null
  const payablePayments =
    isHistorical && payables.length > 0
      ? await fetchPaymentsAsOf(
          supabase,
          'supplier_invoice_payments',
          'supplier_invoice_id',
          companyId,
          balansdagen
        )
      : null

  const counts: OpenFxAtBalansdagen = { revaluable: 0, unconverted: 0 }

  function tally(
    rows: FxLedgerRow[],
    payments: PaymentsAsOf | null,
    liveOutstanding: (row: FxLedgerRow) => number
  ): void {
    for (const row of rows) {
      const total = Number(row.total) || 0
      const live = liveOutstanding(row)
      const outstanding = payments
        ? outstandingAsOf(row, total, live, payments, balansdagen)
        : live
      // Settled on or before balansdagen: nothing was open to value.
      if (outstanding <= 0) continue
      if (hasUsableFxRate(row.exchange_rate)) counts.revaluable += 1
      else counts.unconverted += 1
    }
  }

  // Each side uses its own reskontra's definition of outstanding so these
  // counts reconcile with what the user sees there: kundreskontran derives it
  // from paid_amount, leverantörsreskontran reads the maintained
  // remaining_amount.
  tally(receivables, receivablePayments, (r) =>
    roundOre((Number(r.total) || 0) - (Number(r.paid_amount) || 0))
  )
  tally(payables, payablePayments, (r) => Number(r.remaining_amount) || 0)

  return counts
}

/**
 * Best-effort reversal used by executeYearEndClosing's rollback paths.
 *
 * Posted journal entries are immutable per DB trigger: we can't truly
 * roll them back, only post a compensating storno via reverseEntry().
 * Closed/locked periods may also block the reversal date. We swallow
 * failures here so the caller can re-throw the original invariant error
 * with maximum diagnostic value; the orphaned entries (if any) become
 * a manual cleanup task documented in the surfaced Swedish error.
 */
async function safeReverse(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  label: string
): Promise<void> {
  try {
    await reverseEntry(supabase, companyId, userId, entryId)
  } catch (err) {
    log.error(`year-end rollback: could not reverse ${label}`, err as Error, {
      operation: 'year_end.rollback',
      companyId,
      entityType: 'journal_entry',
      entityId: entryId,
    })
  }
}
