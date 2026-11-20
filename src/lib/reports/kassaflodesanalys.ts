import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePreviousFiscalPeriod } from '@/lib/core/bookkeeping/period-service'
import { generateTrialBalance } from './trial-balance'
import { calculateCashFlowTax, isCashFlowTaxBridgeAccount } from './cash-flow-tax'
import { fetchVoucherMovements, type CashFlowEntryScope } from './cash-flow-evidence'
import type { TrialBalanceRow } from '@/types'
import { isAretsResultatAccount } from '@/lib/bookkeeping/bas-data/result-accounts'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import {
  buildKassaflodesanalysYear,
  hasPeriodActivity,
  likvidaMedelDefinition,
  needsVoucherEvidence,
  type CashFlowTaxBridge,
  type KassaflodesanalysPreviousStatus,
  type KassaflodesanalysStatement,
  type KassaflodesanalysYear,
  type LikvidaMedelDefinition,
} from '@/lib/reports/kassaflodesanalys-statement'

const log = createLogger('reports/kassaflodesanalys')

/**
 * Kassaflödesanalys (Cash Flow Statement): indirect method per BFNAR 2012:1 ch 7.
 *
 * Three sections:
 *   - Löpande verksamhet (Operating activities)
 *   - Investeringsverksamhet (Investing activities)
 *   - Finansieringsverksamhet (Financing activities)
 *
 * Every trial-balance row is classified into exactly one bucket by its BAS
 * range (see classify below) and every line is the sum of its accounts'
 * change over the period. The changes of a balanced ledger sum to zero, so
 * the three sections add up to the change in 19xx by construction: no
 * account can move without a line taking it. An account outside every range
 * is not dropped: it lands in Övriga poster (löpande) and is named in
 * unclassified_accounts. The report used to be a per-line prefix whitelist,
 * and every account nobody had listed silently broke the reconciliation.
 *
 * Buckets (BAS 2026):
 *   19xx                         cash, the reconciliation target
 *   3000-8799                    resultat efter finansiella poster
 *   8820-8839                    koncernbidrag (löpande: booked against 1660/2860,
 *                                which are working capital, until settled)
 *   21xx and other 88xx,         non-cash on both sides: övriga ej
 *   22xx, 1370 and 894x          kassaflödespåverkande poster
 *   1640, 2510, 2512-2515,       the income-tax bridge (cash-flow-tax.ts); any
 *   2517, 2518, other 89xx       other 25xx is Övriga poster, since the bridge
 *                                does not guess what a tax account holds
 *   14xx                         varulager
 *   15xx-17xx                    kortfristiga fordringar (1690 is nyemission)
 *   24xx, 26xx-29xx              kortfristiga skulder (loans and 2898 excepted)
 *   10xx-13xx                    anläggningstillgångar (investering)
 *   18xx                         kortfristiga placeringar (investering)
 *   23xx, 241x, 248x, 284x       lån (finansiering)
 *   2081-2084, 2087, 2097, 1690  nyemission
 *   2093                         erhållna aktieägartillskott
 *   other 20xx, 2898, 8999       utdelningar and other owner equity: the result
 *                                transfer 8999 → 2099 → 2098 → 2091 and a
 *                                dividend decision 2098 → 2898 net to zero here,
 *                                so only the payment remains
 *
 * P&L items that are not operating cash move out of löpande in matched pairs,
 * which leaves the identity untouched: avskrivningar (78xx) and nedskrivningar
 * of fixed assets are added back and deducted from investering, and the
 * realized result on a disposal leaves löpande for investering, so
 * avyttring shows the proceeds instead of the cost that left the books.
 *
 * With every account classified, a mismatch against 19xx can only come from
 * postings in the period that do not balance; the reconciliation stays as
 * that guard.
 *
 * Scope: the statutory one, the same as the årsredovisning's resultaträkning
 * ('exclude-final'): every entry of the year, bokslut entries (avskrivningar,
 * skatt, bokslutsdispositioner) included, only the resultatavslut left out.
 * The statement's rörelseresultat therefore equals the resultaträkning's.
 *
 * Two layouts come out of the same rows:
 *   - the sections above (lopande / investerings / finansierings and their
 *     reconciliation against 19xx), the summary the K3 årsredovisning PDF
 *     prints today, kept field for field so its readers keep working;
 *   - `statement`, the K3 chapter 7 statement with the previous year
 *     (lib/reports/kassaflodesanalys-statement.ts). New readers use it.
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
    /** Erhållna (+) and lämnade (-) koncernbidrag, 8820-8839. */
    koncernbidrag: number
    /** Change on accounts outside every classified range, named in unclassified_accounts. */
    ovriga_poster: number
    total: number
  }
  investerings: {
    forvarv_anlaggningar: number
    avyttring_anlaggningar: number
    /** Change in kortfristiga placeringar (18xx). */
    kortfristiga_placeringar: number
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
  /** Accounts whose change is in lopande.ovriga_poster, ascending. */
  unclassified_accounts: string[]
  reconciliation: {
    opening_cash_1xxx: number
    closing_cash_1xxx: number
    delta_actual: number
    delta_calculated: number
    mismatch_amount: number
    is_reconciled: boolean
  }
}

export interface KassaflodesanalysOptions {
  /** Also build the previous financial year's statement (K3 3.5 comparatives). */
  includePreviousYear?: boolean
  /**
   * Accounts outside 19xx whose balance is likvida medel: a short-term
   * placement that qualifies under K3 7.4 c, or a bostadsrättsförening's
   * klientmedelskonto (K3 38.16). Prefixes, like '1689'.
   */
  extraLikvidaMedelAccounts?: string[]
}

/** The report with the K3 chapter 7 statement. */
export type KassaflodesanalysFullReport = KassaflodesanalysReport & {
  statement: KassaflodesanalysStatement
}

// Normalize -0 → 0 so callers (and tests) never observe a signed zero:
// rounding a tiny negative amount such as -0.001 gives -0, because
// Math.round preserves the sign of zero.
const r2 = (n: number) => {
  const rounded = roundOre(n)
  return rounded === 0 ? 0 : rounded
}

/**
 * Returns the signed balance change for an account between IB and UB.
 *
 * For asset accounts (debit-normal): positive = increase, negative = decrease
 * For liability/equity accounts (credit-normal): positive = increase
 *
 * We always compute `(closing_debit - closing_credit) - (opening_debit - opening_credit)`,
 * which gives the signed *debit-side* movement. A line adds the negation: an
 * asset that grew consumed cash, a liability, equity or income that grew
 * brought it in.
 */
function debitSideDelta(row: TrialBalanceRow): number {
  const opening = (row.opening_debit || 0) - (row.opening_credit || 0)
  const closing = (row.closing_debit || 0) - (row.closing_credit || 0)
  return closing - opening
}

type Bucket =
  | 'cash'
  | 'tax'
  | 'resultat'
  | 'koncernbidrag'
  | 'ej_kassaflode'
  | 'varulager'
  | 'fordringar'
  | 'skulder'
  | 'anlaggningar'
  | 'placeringar'
  | 'lan'
  | 'nyemission'
  | 'tillskott'
  | 'eget_kapital'
  | 'ovrigt'

const startsWithAny = (account: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => account.startsWith(prefix))

/** The one bucket an account belongs to. First match wins, so order matters. */
function classify(account: string): Bucket {
  if (account.startsWith('19')) return 'cash'
  if (isCashFlowTaxBridgeAccount(account)) return 'tax'
  if (startsWithAny(account, ['882', '883'])) return 'koncernbidrag'
  // Bokslutsdispositioner against obeskattade reserver (21xx), avsättningar
  // against their expense, and deferred tax against 2240/1370.
  if (startsWithAny(account, ['88', '894', '21', '22', '137'])) return 'ej_kassaflode'
  if (isAretsResultatAccount(account)) return 'eget_kapital'
  if (/^[3-8]/.test(account)) return 'resultat'
  if (startsWithAny(account, ['10', '11', '12', '13'])) return 'anlaggningar'
  if (account.startsWith('14')) return 'varulager'
  // 1690 fordringar för tecknat men ej inbetalt aktiekapital: an emission
  // booked before it is paid nets to zero instead of showing as financing
  // now and as an operating receivable later.
  if (startsWithAny(account, ['169', '2081', '2082', '2083', '2084', '2087', '2097'])) return 'nyemission'
  if (startsWithAny(account, ['15', '16', '17'])) return 'fordringar'
  if (account.startsWith('18')) return 'placeringar'
  if (account.startsWith('2093')) return 'tillskott'
  if (startsWithAny(account, ['20', '2898'])) return 'eget_kapital'
  if (startsWithAny(account, ['23', '241', '248', '284'])) return 'lan'
  if (startsWithAny(account, ['24', '26', '27', '28', '29'])) return 'skulder'
  return 'ovrigt'
}

// P&L accounts inside resultat efter finansiella poster whose amount is not
// operating cash. Each is removed from löpande and put where its balance
// sheet side is, so the pair nets to zero across the sections.
const DEPRECIATION = ['78']
const FIXED_ASSET_NON_CASH = [
  '771', '772', '773', '776', '777', '778', // nedskrivningar and återföringar
  '397', '797', // vinst/förlust vid avyttring
  '802', '812', '822', // resultat vid försäljning av andelar och långfristiga fordringar
  '803', '813', '824', // resultatandelar från handelsbolag
  '807', '808', '817', '818', '827', '828', '829', // nedskrivningar, återföringar, verkligt värde
]
const SHORT_TERM_INVESTMENT_NON_CASH = ['832', '835', '837', '838']

// Accumulated depreciation and write-down accounts: the xx8/xx9 contras of
// groups 10-12 (1080-1089, 1180-1189 and 1280-1289 are förskott and pågående
// nyanläggningar, not contras) and the nedskrivning accounts of group 13.
const FINANCIAL_ASSET_WRITE_DOWNS = new Set([
  '1318', '1328', '1332', '1334', '1337', '1342', '1344', '1347', '1358', '1369', '1389',
])
const isAccumulatedContra = (account: string) =>
  /^1[012][0-79][89]$/.test(account.slice(0, 4)) || FINANCIAL_ASSET_WRITE_DOWNS.has(account.slice(0, 4))
const isConstructionOrAdvance = (account: string) => /^1[012]8/.test(account)

interface CashFlowPeriod {
  id: string
  period_start: string
  period_end: string
  opening_balance_entry_id: string | null
}

/** One year's inputs: the trial balance and the tax bridge over the same entries. */
interface CashFlowYearData {
  rows: TrialBalanceRow[]
  tax: CashFlowTaxBridge
  scope: CashFlowEntryScope
}

/**
 * The resultatavslut entries 'exclude-final' leaves out of the trial balance
 * (result_closing_entry_ids), so the journal reads below see the same entries.
 */
async function fetchResultClosingEntryIds(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<string[]> {
  const { data, error } = await supabase.rpc('result_closing_entry_ids', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
  })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data.map(String) : []
}

async function loadCashFlowYear(
  supabase: SupabaseClient,
  companyId: string,
  period: CashFlowPeriod,
): Promise<CashFlowYearData> {
  // Trial balance gives us opening + closing per account for the period.
  // Statutory scope: the resultaträkning of the årsredovisning reads the same
  // ('exclude-final'), so rörelseresultat here is the one printed there.
  // Every line reads these same rows, resultat included, which is what makes
  // the sections add up.
  const [{ rows }, excludedEntryIds] = await Promise.all([
    generateTrialBalance(supabase, companyId, period.id, { closingEntry: 'exclude-final' }),
    fetchResultClosingEntryIds(supabase, companyId, period.id),
  ])
  const scope: CashFlowEntryScope = {
    openingEntryId: period.opening_balance_entry_id ?? null,
    excludedEntryIds,
  }
  const tax = await calculateCashFlowTax(supabase, companyId, period.id, scope, rows)
  return { rows, tax, scope }
}

async function buildStatementYear(
  supabase: SupabaseClient,
  companyId: string,
  period: CashFlowPeriod,
  data: CashFlowYearData,
  definition: LikvidaMedelDefinition,
): Promise<KassaflodesanalysYear> {
  const vouchers = needsVoucherEvidence(data.rows, definition)
    ? await fetchVoucherMovements(supabase, companyId, period.id, data.scope)
    : null
  return buildKassaflodesanalysYear({
    periodStart: period.period_start,
    periodEnd: period.period_end,
    rows: data.rows,
    tax: data.tax,
    vouchers,
    definition,
  })
}

/**
 * The comparative year: the period ending the day before this one starts,
 * with the current year's likvida medel definition. A previous year that
 * cannot be built (its tax postings cannot be split, its reads fail) leaves
 * the column out instead of failing the report.
 */
async function buildPreviousYear(
  supabase: SupabaseClient,
  companyId: string,
  current: CashFlowPeriod,
  definition: LikvidaMedelDefinition,
): Promise<{ previous: KassaflodesanalysYear | null; status: KassaflodesanalysPreviousStatus }> {
  try {
    const period = await resolvePreviousFiscalPeriod<CashFlowPeriod>(
      supabase,
      companyId,
      current,
      'id, period_start, period_end, opening_balance_entry_id',
    )
    if (!period) return { previous: null, status: 'no_previous_period' }
    const data = await loadCashFlowYear(supabase, companyId, period)
    if (!hasPeriodActivity(data.rows)) return { previous: null, status: 'no_activity' }
    return {
      previous: await buildStatementYear(supabase, companyId, period, data, definition),
      status: 'included',
    }
  } catch (error) {
    // The comparative column is left out, the report still renders; the
    // status tells the reader, the log tells us.
    log.warn('previous-year kassaflödesanalys unavailable', {
      companyId,
      fiscalPeriodId: current.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return { previous: null, status: 'unavailable' }
  }
}

/**
 * The summary sections only, the shape the K3 årsredovisning reads today.
 * Same computation as generateKassaflodesanalysWithStatement.
 */
export async function generateKassaflodesanalys(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<KassaflodesanalysReport> {
  return generateKassaflodesanalysWithStatement(supabase, companyId, fiscalPeriodId)
}

/** The summary sections and the K3 chapter 7 statement. */
export async function generateKassaflodesanalysWithStatement(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: KassaflodesanalysOptions = {},
): Promise<KassaflodesanalysFullReport> {
  // Fetch period info for the report header.
  const { data: periodRow, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end, opening_balance_entry_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError) throw new Error(periodError.message)
  if (!periodRow) throw new Error('Fiscal period not found')
  const period: CashFlowPeriod = { ...periodRow, id: fiscalPeriodId }

  const data = await loadCashFlowYear(supabase, companyId, period)
  const sections = buildSections(period, data.rows, data.tax)

  const definition = likvidaMedelDefinition(period.period_start, options.extraLikvidaMedelAccounts)
  const [current, comparative] = await Promise.all([
    buildStatementYear(supabase, companyId, period, data, definition),
    options.includePreviousYear
      ? buildPreviousYear(supabase, companyId, period, definition)
      : Promise.resolve({ previous: null, status: 'not_requested' as const }),
  ])

  return {
    ...sections,
    statement: {
      method: 'indirect',
      current,
      previous: comparative.previous,
      previous_status: comparative.status,
    },
  }
}

/** The summary sections, reconciled against 19xx. */
function buildSections(
  period: CashFlowPeriod,
  rows: readonly TrialBalanceRow[],
  tax: CashFlowTaxBridge,
): KassaflodesanalysReport {
  // Cash contribution per bucket: the negated debit-side change.
  const cashIn = new Map<Bucket, number>()
  let avskrivningar = 0
  let nonCashAddBack = 0
  let fixedAssetAdjustment = 0
  let shortTermInvestmentAdjustment = 0
  const acquisitionsByGroup = new Map<string, number>()
  const unclassified: string[] = []

  for (const row of rows) {
    const account = row.account_number
    const delta = debitSideDelta(row)
    const bucket = classify(account)
    cashIn.set(bucket, (cashIn.get(bucket) ?? 0) - delta)

    if (bucket === 'resultat') {
      // The expense reduced the result without consuming cash (or the gain
      // raised it without bringing any in): reverse it in löpande and give
      // it to the section that holds the balance-sheet side.
      if (startsWithAny(account, DEPRECIATION)) {
        avskrivningar += delta
        fixedAssetAdjustment -= delta
      } else if (startsWithAny(account, FIXED_ASSET_NON_CASH)) {
        nonCashAddBack += delta
        fixedAssetAdjustment -= delta
      } else if (startsWithAny(account, SHORT_TERM_INVESTMENT_NON_CASH)) {
        nonCashAddBack += delta
        shortTermInvestmentAdjustment -= delta
      }
    } else if (bucket === 'anlaggningar' && !isAccumulatedContra(account)) {
      // Gross acquisitions per group: an asset account that grew. Pågående
      // and förskott count net, so moving a finished project onto its asset
      // account is not a second acquisition.
      const group = account.slice(0, 2)
      if (isConstructionOrAdvance(account) || delta > 0) {
        acquisitionsByGroup.set(group, (acquisitionsByGroup.get(group) ?? 0) + delta)
      }
    } else if (bucket === 'ovrigt' && r2(delta) !== 0) {
      unclassified.push(account)
    }
  }

  const sum = (bucket: Bucket) => cashIn.get(bucket) ?? 0

  // ─── Löpande verksamhet ────────────────────────────────────────────────
  // Resultat efter finansiella poster: 3000-8799. Bokslutsdispositioner
  // (88xx) and skatt (89xx) come after it in the resultaträkning.
  const resultatEfterFinansiella = r2(sum('resultat'))
  const avskrivningarLine = r2(avskrivningar)

  // Foreign income-tax expense on 6996/6997 already reduced the starting
  // result; the tax bridge supplies the payment. Provisions, obeskattade
  // reserver, deferred tax and the non-cash P&L items above are added back.
  const ovrigaEjKassaflodesposter = r2(
    tax.expenseInOperatingProfit + sum('ej_kassaflode') + nonCashAddBack
  )

  // Receivables include skattekonto (1630). Depositing bank funds there is
  // a cash outflow; a later tax charge reduces this receivable and must not
  // count as a second bank outflow. Income-tax receivables (1640) belong to
  // the tax bridge instead, so they are not counted twice.
  const deltaKortfristigaFordringar = r2(sum('fordringar'))
  const deltaVarulager = r2(sum('varulager'))

  // Working-capital liabilities include property/pension/yield taxes. Their
  // expenses already reduce operating profit; they are not income-tax payments.
  const deltaKortfristigaSkulder = r2(sum('skulder') + tax.otherTaxLiabilityChange)

  // The starting result excludes tax expense. An unpaid provision therefore
  // needs expense and liability movement to cancel; a payment remains negative.
  // The 'tax' bucket is not summed here: the bridge returns exactly its
  // accounts' change, split between this line and the working capital above.
  const skattBetald = tax.paidIncomeTax
  const koncernbidrag = r2(sum('koncernbidrag'))
  const ovrigaPoster = r2(sum('ovrigt'))

  const totalLopande = r2(
    resultatEfterFinansiella +
      avskrivningarLine +
      ovrigaEjKassaflodesposter +
      deltaKortfristigaFordringar +
      deltaVarulager +
      deltaKortfristigaSkulder +
      skattBetald +
      koncernbidrag +
      ovrigaPoster
  )

  // ─── Investeringsverksamhet ────────────────────────────────────────────
  // Net cash from anläggningstillgångar: the change in 10xx-13xx including
  // the contra accounts, less the avskrivningar and nedskrivningar already
  // added back in löpande, plus the realized result. Acquisitions are the
  // gross growth of the asset accounts; the rest is what disposals brought
  // in, so a sale shows its proceeds, not the cost that left the books.
  const anlaggningarNet = r2(sum('anlaggningar') + fixedAssetAdjustment)
  const acquisitions = r2(
    [...acquisitionsByGroup.values()].reduce((total, value) => total + Math.max(0, value), 0)
  )
  const avyttring = r2(Math.max(0, anlaggningarNet + acquisitions))
  const forvarv = r2(anlaggningarNet - avyttring)
  const kortfristigaPlaceringar = r2(sum('placeringar') + shortTermInvestmentAdjustment)

  const totalInvesterings = r2(forvarv + avyttring + kortfristigaPlaceringar)

  // ─── Finansieringsverksamhet ───────────────────────────────────────────
  // Lån: långfristiga skulder, kortfristiga lån från kreditinstitut,
  // kontokredit and kortfristiga låneskulder. Credit-normal: a new loan is
  // an inflow, an amortization an outflow.
  const deltaLan = r2(sum('lan'))

  // Owner equity other than capital contributions, with 2898 and 8999. A
  // dividend decided and paid in the period shows once, as the payment; a
  // dividend decided but unpaid nets to zero.
  const utdelningar = r2(sum('eget_kapital'))
  const nyemission = r2(sum('nyemission'))

  // Erhållna aktieägartillskott (2093): a cash contribution from
  // shareholders booked straight to equity (issue #716).
  const erhallnaAktieagartillskott = r2(sum('tillskott'))

  const totalFinansierings = r2(
    deltaLan + utdelningar + nyemission + erhallnaAktieagartillskott
  )

  // ─── Total cash flow ───────────────────────────────────────────────────
  const totalCashFlow = r2(totalLopande + totalInvesterings + totalFinansierings)

  // ─── Reconciliation against 19xx ───────────────────────────────────────
  const cash1xxxRows = rows.filter((r) => classify(r.account_number) === 'cash')
  const openingCash = r2(
    cash1xxxRows.reduce(
      (total, r) => total + ((r.opening_debit || 0) - (r.opening_credit || 0)),
      0
    )
  )
  const closingCash = r2(
    cash1xxxRows.reduce(
      (total, r) => total + ((r.closing_debit || 0) - (r.closing_credit || 0)),
      0
    )
  )
  const deltaActual = r2(closingCash - openingCash)
  const mismatchAmount = r2(deltaActual - totalCashFlow)
  const isReconciled = Math.abs(mismatchAmount) < 0.01

  return {
    fiscal_period_id: period.id,
    period_start: period.period_start,
    period_end: period.period_end,
    lopande: {
      resultat_efter_finansiella_poster: resultatEfterFinansiella,
      avskrivningar: avskrivningarLine,
      ovriga_ej_kassaflodesposter: ovrigaEjKassaflodesposter,
      delta_kortfristiga_fordringar: deltaKortfristigaFordringar,
      delta_varulager: deltaVarulager,
      delta_kortfristiga_skulder: deltaKortfristigaSkulder,
      skatt_betald: skattBetald,
      koncernbidrag,
      ovriga_poster: ovrigaPoster,
      total: totalLopande,
    },
    investerings: {
      forvarv_anlaggningar: forvarv,
      avyttring_anlaggningar: avyttring,
      kortfristiga_placeringar: kortfristigaPlaceringar,
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
    unclassified_accounts: unclassified.sort(),
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
