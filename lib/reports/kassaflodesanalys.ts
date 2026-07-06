import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { generateIncomeStatement } from './income-statement'
import type { TrialBalanceRow } from '@/types'

/**
 * Kassaflödesanalys (Cash Flow Statement): indirect method per BFNAR 2012:1 ch 7.
 *
 * Three sections:
 *   - Löpande verksamhet (Operating activities)
 *   - Investeringsverksamhet (Investing activities)
 *   - Finansieringsverksamhet (Financing activities)
 *
 * The indirect method starts from "Resultat efter finansiella poster", adds
 * back non-cash items (avskrivningar, periodiseringar), and adjusts for
 * working-capital movements. The sum across all three sections must equal
 * the actual change in cash & bank (19xx) balance over the period.
 *
 * Account-class mapping (BAS 2026):
 *   14xx  Lager / varulager                          → operating (Δ inventory)
 *   15xx  Kortfristiga fordringar (kundfordringar)   → operating (Δ receivables)
 *   24xx  Kortfristiga skulder (leverantörsskulder)  → operating (Δ payables)
 *   26xx  Moms och punktskatter                      → operating (Δ VAT)
 *   29xx  Upplupna kostnader/förutbetalda intäkter   → operating (Δ accruals)
 *   2510  Skatteskuld (income tax)                   → operating (skatt betald)
 *
 *   10xx-13xx  Anläggningstillgångar (capital goods) → investing
 *
 *   20xx  Eget kapital (nyemission, utdelning,
 *         erhållna aktieägartillskott 2093)          → financing
 *   23xx  Långfristiga skulder (lån)                 → financing
 *
 *   19xx  Kassa och bank                             → reconciliation (target)
 *
 * The reconciliation invariant: total_cash_flow MUST equal
 *   closing(19xx) - opening(19xx)
 * within 1 öre. Any mismatch signals a bookkeeping invariant violation
 * (e.g., journal entry posted to an account class we haven't mapped) and is
 * surfaced as a warning in the report so a human can investigate.
 */

export type KassaflodesanalysReport = {
  fiscal_period_id: string
  period_start: string
  period_end: string
  lopande: {
    resultat_efter_finansiella_poster: number
    avskrivningar: number
    ovriga_ej_kassaflodesposter: number
    delta_kortfristiga_fordringar: number
    delta_varulager: number
    delta_kortfristiga_skulder: number
    skatt_betald: number
    total: number
  }
  investerings: {
    forvarv_anlaggningar: number
    avyttring_anlaggningar: number
    total: number
  }
  finansierings: {
    delta_lan: number
    utdelningar: number
    nyemission: number
    erhallna_aktieagartillskott: number
    total: number
  }
  total_cash_flow: number
  reconciliation: {
    opening_cash_1xxx: number
    closing_cash_1xxx: number
    delta_actual: number
    delta_calculated: number
    mismatch_amount: number
    is_reconciled: boolean
  }
}

// Normalize -0 → 0 so callers (and tests) never observe a signed zero.
// Math.round(0 * 100) / 100 happens to be 0, but Math.round(-0.001 * 100) / 100
// returns -0 because Math.round preserves the sign of zero.
const r2 = (n: number) => {
  const rounded = Math.round(n * 100) / 100
  return rounded === 0 ? 0 : rounded
}

/**
 * Returns the signed balance change for an account between IB and UB.
 *
 * For asset accounts (debit-normal): positive = increase, negative = decrease
 * For liability/equity accounts (credit-normal): positive = increase
 *
 * We always compute `(closing_debit - closing_credit) - (opening_debit - opening_credit)`,
 * which gives the signed *debit-side* movement. Callers negate as needed for
 * credit-normal accounts.
 */
function debitSideDelta(row: TrialBalanceRow): number {
  const opening = (row.opening_debit || 0) - (row.opening_credit || 0)
  const closing = (row.closing_debit || 0) - (row.closing_credit || 0)
  return closing - opening
}

/**
 * Sum the debit-side delta for all accounts whose number starts with one of
 * the given prefixes. Useful for grouping by BAS account class/range.
 */
function sumDeltaByPrefix(rows: TrialBalanceRow[], prefixes: string[]): number {
  return rows
    .filter((r) => prefixes.some((p) => r.account_number.startsWith(p)))
    .reduce((sum, r) => sum + debitSideDelta(r), 0)
}

/**
 * Sum *period activity* (not delta) on the debit side for the given account
 * prefixes. Used for avskrivningar where the depreciation expense for the
 * period is the relevant figure, not the cumulative change in the contra
 * account (which would also reflect disposals).
 */
function sumPeriodDebitByPrefix(rows: TrialBalanceRow[], prefixes: string[]): number {
  return rows
    .filter((r) => prefixes.some((p) => r.account_number.startsWith(p)))
    .reduce((sum, r) => sum + ((r.period_debit || 0) - (r.period_credit || 0)), 0)
}

export async function generateKassaflodesanalys(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string
): Promise<KassaflodesanalysReport> {
  // Fetch period info for the report header.
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError) throw new Error(periodError.message)
  if (!period) throw new Error('Fiscal period not found')

  // Trial balance gives us opening + closing per account for the period.
  // We pass excludeYearEndClosing=true so that the working-capital movements
  // reflect actual transactional activity, not the year-end reclassification
  // entries that move resultaträkning balances into equity (8999 → 2099).
  // Without this filter, the closing entry for class 3-8 would inflate
  // "övriga ej-kassaflödesposter" and break the reconciliation.
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    excludeYearEndClosing: true,
  })

  // Net result before tax (resultat efter finansiella poster) comes from the
  // P&L generator, which already excludes 8999 (year-end closing account)
  // and applies the K2/K3 sign convention. We then subtract any tax expense
  // (8910, periodiseringsfond moves, etc.) to land at *before-tax* result.
  const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)

  // Resultat efter finansiella poster = total_revenue - total_expenses + total_financial
  // EXCEPT we want to keep tax (89xx) out: net_result already nets tax in.
  // Use the same formula as net_result but without subtracting 89xx items:
  // net_result = revenue - expenses + financial (where financial includes 89xx)
  // We want: revenue - expenses + (financial - tax_portion)
  //
  // To keep this simple: scan financial_sections, separate tax (89xx) from
  // rest, and assemble resultat efter finansiella poster.
  // Filter ROWS by 89xx prefix (not just the section's first row): a single
  // section can mix tax and non-tax accounts, and the old first-row heuristic
  // silently misclassified the rest.
  const taxAmount = incomeStatement.financial_sections.reduce((sum, s) => {
    const sectionTax = s.rows
      .filter((r) => r.account_number.startsWith('89'))
      .reduce((acc, r) => acc + r.amount, 0)
    return sum + sectionTax
  }, 0)
  const nonTaxFinancial = incomeStatement.total_financial - taxAmount

  const resultatEfterFinansiella = r2(
    incomeStatement.total_revenue - incomeStatement.total_expenses + nonTaxFinancial
  )

  // ─── Löpande verksamhet ────────────────────────────────────────────────
  // Avskrivningar (depreciation): 78xx debit movements in the period.
  // Sign convention: depreciation is an expense that reduced result but did
  // not consume cash, so we add it BACK to result. period_debit on 78xx is
  // positive; we report it as a positive number to be added.
  const avskrivningar = r2(sumPeriodDebitByPrefix(rows, ['78']))

  // Övriga ej-kassaflödesposter: this category is used for non-cash items
  // beyond depreciation (e.g., reversals of provisions, unrealized FX).
  // v1 places it at 0: extensions can compute it from specific account
  // patterns. Kept in the type so the structure is stable.
  const ovrigaEjKassaflodesposter = 0

  // Δ Kortfristiga fordringar (15xx). Increase in receivables = cash NOT
  // received yet → cash outflow → NEGATE the debit-side delta.
  // Positive delta on a debit-normal account means asset grew → subtract.
  const deltaKortfristigaFordringar = r2(-sumDeltaByPrefix(rows, ['15']))

  // Δ Varulager (14xx). Same sign as receivables: stock grew → cash out.
  const deltaVarulager = r2(-sumDeltaByPrefix(rows, ['14']))

  // Δ Kortfristiga skulder (24xx, 26xx, 29xx) EXCLUDING tax skulder (2510).
  // 24xx = leverantörsskulder; 26xx = moms; 29xx = upplupna kostnader.
  // These are credit-normal accounts: increase → cash retained → ADD the
  // credit-side delta. debitSideDelta returns the *debit*-side delta which
  // is the inverse, so we negate.
  //
  // 25xx is excluded because we handle skatt separately (line below).
  const deltaKortfristigaSkulder = r2(
    -sumDeltaByPrefix(rows, ['24', '26', '29'])
  )

  // Skatt betald: actual cash tax outflow over the period. Approximated as
  // the negative of the change in 2510 (income tax payable). If 2510 went
  // down, tax was paid → negative cash flow. The current-year tax expense
  // (8910) was already netted into resultat efter finansiella; here we only
  // capture the cash side.
  // Sign: 2510 is credit-normal. Decrease in liability = cash outflow.
  // debitSideDelta(2510): if liability dropped (UB credit < IB credit),
  // delta is positive. We want that as a negative cash flow.
  const skattBetald = r2(-sumDeltaByPrefix(rows, ['2510']))

  const totalLopande = r2(
    resultatEfterFinansiella +
      avskrivningar +
      ovrigaEjKassaflodesposter +
      deltaKortfristigaFordringar +
      deltaVarulager +
      deltaKortfristigaSkulder +
      skattBetald
  )

  // ─── Investeringsverksamhet ────────────────────────────────────────────
  // Förvärv av anläggningstillgångar: net debit movement on 10xx-13xx.
  // An increase in fixed assets (positive debit-side delta) is a cash
  // outflow → negate to surface as negative.
  //
  // We exclude accumulated-depreciation contra-asset accounts because their
  // movement is non-cash (it's already added back to löpande as avskrivningar).
  // Without this filter, depreciation would show up twice: once as an
  // add-back in löpande and once as a phantom "avyttring" in investeringar:
  // breaking the reconciliation against 19xx.
  //
  // Note: this naive netting can blend purchases with disposals when a
  // disposal credits the same account. Item #2 in the plan (asset disposal)
  // will refine this by linking disposal proceeds to specific entries; for
  // now, the net figure is the best we can derive from balances alone.
  const ACCUMULATED_DEPRECIATION_ACCOUNTS = [
    '1119', // ack avskr balanserade utgifter
    '1129', // ack avskr koncessioner
    '1139', // ack avskr hyresrätter
    '1149', // ack avskr goodwill
    '1159', // ack avskr förskott immateriella
    '1219', // ack avskr maskiner och inventarier
    '1229', // ack avskr inventarier och verktyg
    '1239', // ack avskr installationer
    '1249', // ack avskr bilar
    '1259', // ack avskr datorer
    '1269', // ack avskr leasade tillgångar
    '1279', // ack avskr byggn. inventarier
    '1289', // ack avskr övriga maskiner
  ]
  const fixedAssetDelta = rows
    .filter((r) => {
      if (!['10', '11', '12', '13'].some((p) => r.account_number.startsWith(p))) return false
      return !ACCUMULATED_DEPRECIATION_ACCOUNTS.includes(r.account_number)
    })
    .reduce((sum, r) => sum + debitSideDelta(r), 0)
  const forvarv = r2(fixedAssetDelta > 0 ? -fixedAssetDelta : 0)
  const avyttring = r2(fixedAssetDelta < 0 ? -fixedAssetDelta : 0)

  const totalInvesterings = r2(forvarv + avyttring)

  // ─── Finansieringsverksamhet ───────────────────────────────────────────
  // Δ Lån (23xx: långfristiga skulder). Credit-normal: increase in loan
  // = cash inflow → ADD credit-side delta = negate debit-side delta.
  const deltaLan = r2(-sumDeltaByPrefix(rows, ['23']))

  // Utdelningar: capture as the debit movements on 2898 (decided dividends)
  // and 8910 isn't a dividend (it's tax). Better marker is 2091 / 2898.
  // v1: scan for 2898 period_debit. Conservative: better to under-report
  // than to mis-classify. Report as negative cash flow.
  const utdelningar = r2(-sumPeriodDebitByPrefix(rows, ['2898']))

  // Nyemission: increase in 20xx equity (excluding result-of-the-year and
  // dividends). Credit-normal: positive credit-side delta = cash inflow.
  // We sum 2081 (share capital) + 2082 (ej registrerat aktiekapital) + 2083
  // (medlemsinsatser) + 2086/2097 (bunden/fri överkursfond: the premium on
  // an emission lands there under K2/K3) + 2087 (pågående nyemission),
  // specifically avoiding 2099 (årets resultat is non-cash).
  const nyemissionDebit = sumDeltaByPrefix(rows, ['2081', '2082', '2083', '2086', '2087', '2097'])
  const nyemission = r2(-nyemissionDebit)

  // Erhållna aktieägartillskott (2093, villkorade + ovillkorade): a cash
  // contribution from shareholders booked straight to equity. Credit-normal:
  // increase = cash inflow → negate the debit-side delta. Issue #716: this
  // account was previously unmapped, so any tillskott during the period
  // showed 0 under finansiering and broke the 19xx reconciliation by exactly
  // the contributed amount.
  const erhallnaAktieagartillskott = r2(-sumDeltaByPrefix(rows, ['2093']))

  const totalFinansierings = r2(
    deltaLan + utdelningar + nyemission + erhallnaAktieagartillskott
  )

  // ─── Total cash flow ───────────────────────────────────────────────────
  const totalCashFlow = r2(totalLopande + totalInvesterings + totalFinansierings)

  // ─── Reconciliation against 19xx ───────────────────────────────────────
  const cash1xxxRows = rows.filter((r) => r.account_number.startsWith('19'))
  const openingCash = r2(
    cash1xxxRows.reduce(
      (sum, r) => sum + ((r.opening_debit || 0) - (r.opening_credit || 0)),
      0
    )
  )
  const closingCash = r2(
    cash1xxxRows.reduce(
      (sum, r) => sum + ((r.closing_debit || 0) - (r.closing_credit || 0)),
      0
    )
  )
  const deltaActual = r2(closingCash - openingCash)
  const mismatchAmount = r2(deltaActual - totalCashFlow)
  const isReconciled = Math.abs(mismatchAmount) < 0.01

  return {
    fiscal_period_id: fiscalPeriodId,
    period_start: period.period_start,
    period_end: period.period_end,
    lopande: {
      resultat_efter_finansiella_poster: resultatEfterFinansiella,
      avskrivningar,
      ovriga_ej_kassaflodesposter: ovrigaEjKassaflodesposter,
      delta_kortfristiga_fordringar: deltaKortfristigaFordringar,
      delta_varulager: deltaVarulager,
      delta_kortfristiga_skulder: deltaKortfristigaSkulder,
      skatt_betald: skattBetald,
      total: totalLopande,
    },
    investerings: {
      forvarv_anlaggningar: forvarv,
      avyttring_anlaggningar: avyttring,
      total: totalInvesterings,
    },
    finansierings: {
      delta_lan: deltaLan,
      utdelningar,
      nyemission,
      erhallna_aktieagartillskott: erhallnaAktieagartillskott,
      total: totalFinansierings,
    },
    total_cash_flow: totalCashFlow,
    reconciliation: {
      opening_cash_1xxx: openingCash,
      closing_cash_1xxx: closingCash,
      delta_actual: deltaActual,
      delta_calculated: totalCashFlow,
      mismatch_amount: mismatchAmount,
      is_reconciled: isReconciled,
    },
  }
}
