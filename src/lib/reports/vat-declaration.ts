import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  VatDeclaration,
  VatDeclarationRutor,
  VatPeriodType,
  VatRevenueAccountWithoutRuta,
} from '@/types'
import { ORE_ROUNDING_ACCOUNT } from '@/lib/money'
import { VAT_ACCOUNT_TABLE } from '@/lib/vat/moms-box-mapping'
import type { VatCheckAccountTotals } from './vat-declaration-checks'
import { rcBasisTotalsByRate } from './vat-filing-gate'
import { fetchDynamicVatAccounts, type DynamicVatAccounts } from './vat-revenue-accounts'

/**
 * Calculate VAT declaration (Momsdeklaration) for a given period.
 *
 * Reads directly from the general ledger: sums posted journal entry lines
 * on 26xx (VAT) and 3xxx (revenue) accounts for the period. This makes the
 * momsdeklaration a pure projection from the double-entry bookkeeping ledger.
 *
 * The accounting method (accrual vs cash) is already reflected in when
 * journal entries were created by the entry generators, so no separate
 * filtering logic is needed here.
 */

/**
 * Account-to-ruta mapping for the Swedish momsdeklaration (SKV 4700): the
 * declared rows of VAT_ACCOUNT_TABLE (lib/vat/moms-box-mapping.ts, where the
 * accounts and their rutor are listed and explained), keyed by ruta field.
 *
 * Pure ledger projection: every Ruta on the SKV 4700 form maps to one or more
 * BAS account balances aggregated over the period. Reverse-charge purchase
 * bases are read from the cost account the journal entry posted to (debit
 * balance), not from supplier classification. The company's OWN class 3
 * accounts marked with a moms-sats join ruta 05 on top of this fixed list: see
 * fetchDynamicRuta05Accounts (#1261).
 */
export const ACCOUNT_RUTA: Readonly<Record<string, { box: keyof VatDeclarationRutor; side: 'credit' | 'debit' }>> =
  Object.fromEntries(
    Object.entries(VAT_ACCOUNT_TABLE)
      .filter(([, row]) => row.declared !== false)
      .map(([account, row]) => [account, { box: `ruta${row.box}` as keyof VatDeclarationRutor, side: row.side }]),
  )

/**
 * The fixed BAS accounts that define a momsdeklaration line, and with it the
 * settlement SHAPE detector passed as `p_ruta_accounts` to both
 * get_vat_declaration_totals and get_vat_ruta_source_lines. Exported so the
 * ruta drill-down route detects shape from the same list the figure does; a
 * second copy is what let the two disagree.
 */
export const VAT_ACCOUNTS = Object.keys(ACCOUNT_RUTA)

/**
 * 26xx output VAT accounts feeding rutor 10/11/12, 30/31/32 and 60/61/62.
 * Derived from ACCOUNT_RUTA so the KPI vatLiability widget can never drift
 * from the momsdeklaration (ruta 49) calculation.
 */
export const VAT_OUTPUT_ACCOUNTS = Object.entries(ACCOUNT_RUTA)
  .filter(([account, mapping]) => account.startsWith('26') && mapping.side === 'credit')
  .map(([account]) => account)

/** Input VAT accounts feeding ruta 48 (2640-2649 series). */
export const VAT_INPUT_ACCOUNTS = Object.entries(ACCOUNT_RUTA)
  .filter(([, mapping]) => mapping.box === 'ruta48')
  .map(([account]) => account)

/**
 * The reverse-charge INPUT VAT accounts the momsdeklaration completeness check
 * compares rutor 30-32 against: 2645 (beräknad ingående moms på förvärv från
 * utlandet, EU and non-EU) and 2647 (ingående moms, omvänd betalningsskyldighet
 * i Sverige). The other five ruta 48 accounts are not reverse charge and stay
 * out, 2649 (blandad verksamhet) above all: counting it would reintroduce the
 * aggregation the sharpened check exists to remove.
 *
 * Mirrors RC_INPUT_ACCOUNTS in ./vat-declaration-checks, which keeps its copy
 * private. The two lists are pinned together behaviourally in
 * __tests__/vat-declaration.test.ts: it feeds the projected pair and a full
 * totals map carrying a balance on every OTHER ruta 48 account to
 * runVatDeclarationChecks and asserts identical findings, so widening the list
 * on one side without the other fails there.
 */
export const RC_INPUT_VAT_ACCOUNTS = ['2645', '2647'] as const

/**
 * Calculate period start and end dates
 */
export function calculatePeriodDates(
  periodType: VatPeriodType,
  year: number,
  period: number
): { start: string; end: string } {
  let startMonth: number
  let endMonth: number

  switch (periodType) {
    case 'monthly':
      // period is 1-12
      startMonth = period
      endMonth = period
      break
    case 'quarterly':
      // period is 1-4
      startMonth = (period - 1) * 3 + 1
      endMonth = period * 3
      break
    case 'yearly':
      // period is 1
      startMonth = 1
      endMonth = 12
      break
    default:
      startMonth = 1
      endMonth = 12
  }

  const startDate = new Date(year, startMonth - 1, 1)
  const endDate = new Date(year, endMonth, 0) // Last day of end month

  return {
    start: formatDate(startDate),
    end: formatDate(endDate),
  }
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Round to 2 decimal places
 */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Resolve the start/end dates for a VAT period.
 *
 * Monthly and quarterly VAT periods are always calendar months/quarters
 * (kalendermånad / kalenderkvartal per SFL 26 kap), so they use the plain
 * calendar calculation.
 *
 * Annual VAT (helårsmoms), however, is reported per *räkenskapsår* (the
 * beskattningsår), not per calendar year (SFL 26 kap 10-11 §§). A räkenskapsår
 * can be extended or shortened (up to 18 months for a first/changed year per
 * BFL 3 kap 3 §), so a calendar Jan-Dec span would silently drop part of an
 * extended year (e.g. a first year 2025-07-03 → 2026-12-31). When the caller
 * supplies the fiscal period we therefore use its actual bounds. If the period
 * can't be resolved we fall back to the calendar span so behaviour degrades
 * gracefully instead of erroring.
 *
 * `source` names the branch that answered. The yearly fallback is silent on
 * purpose (a calendar-FY company with no fiscal_periods row still works), so a
 * caller that puts the range on the wire must be able to tell a resolved
 * räkenskapsår from a guessed Jan-Dec: for a broken fiscal year the guess puts
 * both the figures and the Skatteverket redovisningsperiod on the wrong period.
 */
export type VatPeriodSource = 'fiscal_period' | 'calendar' | 'calendar_fallback'

export async function resolvePeriodDates(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  fiscalPeriodId?: string
): Promise<{ start: string; end: string; source: VatPeriodSource }> {
  if (periodType === 'yearly') {
    if (fiscalPeriodId) {
      const { data: fp } = await supabase
        .from('fiscal_periods')
        .select('period_start, period_end')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .maybeSingle()
      if (fp?.period_start && fp?.period_end) {
        return { start: fp.period_start, end: fp.period_end, source: 'fiscal_period' }
      }
    } else {
      // No explicit fiscal period: resolve the räkenskapsår ending in `year`
      // instead of assuming a calendar FY. Helårsmoms is filed per
      // räkenskapsår (SFL 26 kap 10-11 §§), so for a broken fiscal year the
      // calendar-year assumption would put both the redovisningsperiod and
      // the figures on the wrong period. For calendar-FY companies this
      // resolves to Jan-Dec of `year`, identical to the arithmetic fallback.
      const { data: fp } = await supabase
        .from('fiscal_periods')
        .select('period_start, period_end')
        .eq('company_id', companyId)
        .gte('period_end', `${year}-01-01`)
        .lte('period_end', `${year}-12-31`)
        .order('period_end', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (fp?.period_start && fp?.period_end) {
        return { start: fp.period_start, end: fp.period_end, source: 'fiscal_period' }
      }
    }
  }
  return {
    ...calculatePeriodDates(periodType, year, period),
    // Monthly and quarterly ARE calendar periods by law; only the yearly
    // branch landing here means a räkenskapsår was asked for and not found.
    source: periodType === 'yearly' ? 'calendar_fallback' : 'calendar',
  }
}

/**
 * Accounts a momsredovisning settles the period's net against: 2650
 * (Redovisningskonto för moms, att betala) and 1650 (Momsfordran, att återfå).
 * Mirrors VAT_SETTLEMENT_ACCOUNT/VAT_REFUND_ACCOUNT in vat-settlement.ts,
 * which imports from this module and therefore cannot be imported here.
 */
export const VAT_SETTLEMENT_NET_ACCOUNTS = ['2650', '1650']

/**
 * How a verifikat kept out of the rutor was recognised as a momsredovisning,
 * as the MCP VAT report labels it:
 *   - `tagged`: source_type 'vat_settlement';
 *   - `net_account_shape`: a declaration account AND a 2650/1650 line;
 *   - `tax_account_shape`: a pure 26xx / skattekonto (/ 3740) verifikat.
 * The classification itself is get_vat_declaration_totals' (migration
 * 20260920182259); there is deliberately no TypeScript copy of it.
 */
export type MomsredovisningDetection = 'tagged' | 'net_account_shape' | 'tax_account_shape'

/** A momsredovisning entry detected by shape rather than source_type. */
export interface VatSettlementShapedEntry {
  id: string
  status: string
  entry_date: string
  source_type: string | null
  voucher_series: string | null
  voucher_number: number | null
}

export interface VatAccountTotals {
  totals: Map<string, { debit: number; credit: number }>
  /**
   * Untagged momsredovisning entries found in the period, by either shape
   * (manual vouchers, SIE-imported settlements, stornos of a settlement, VAT
   * moved straight against the skattekonto). Already excluded from `totals`;
   * surfaced so the settlement proposal can warn and gate.
   */
  settlementShapedEntries: VatSettlementShapedEntry[]
  /**
   * Posted/reversed entry counts per source_type for the whole period,
   * INCLUDING tagged vat_settlement entries (they never match the
   * invoice/transaction buckets, and the metadata scan always counted them).
   * Comes back in the same RPC round trip so the declaration metadata no
   * longer needs its own paginated entry scan.
   */
  sourceTypeCounts: Record<string, number>
}

/** Wire shape of the get_vat_declaration_totals RPC jsonb payload. */
interface VatTotalsRpcPayload {
  totals: Array<{ account_number: string; debit: number; credit: number }>
  settlement_shaped_entries: VatSettlementShapedEntry[]
  source_type_counts: Record<string, number>
}

/**
 * Fetch and aggregate debit/credit totals per VAT-relevant account
 * (ACCOUNT_RUTA) for a period. Shared by the declaration calculation, the
 * settlement proposal (lib/reports/vat-settlement.ts) and the MCP VAT report
 * and close check, so none of them can disagree on which ledger lines count.
 * Never re-derive this from a journal scan: a second definition is how the
 * MCP report came to count the bokslutsverifikat (crm#1139).
 *
 * The period's posted closing entry (fiscal_periods.closing_entry_id) is
 * excluded: it moves the class 3-8 balances to equity (2099/2010), which is no
 * sale or purchase, and counting it zeroes ruta 05 and rutor 20-24 once a year
 * is closed.
 *
 * Momsredovisning entries are excluded. They are bookkeeping about the
 * declaration, not VAT-bearing business activity; including them would zero
 * out the rutor the moment the settlement is booked, turning the report, its
 * exports, and a later Skatteverket submission into an empty declaration
 * (#984). Intent is not recorded on manual and imported verifikat, so beyond
 * the tag it is inferred from shape. Three detection paths, all in the SQL:
 *
 *   - tagged: source_type 'vat_settlement' (the app's own settlement flow),
 *     filtered in the query;
 *   - net-account shape: an entry with at least one line on a declaration
 *     account (ACCOUNT_RUTA) and at least one on 2650/1650. This catches
 *     settlements booked before the tagged flow existed, manual vouchers,
 *     SIE-imported settlements, and storno reversals of a settlement
 *     (source_type 'storno', which would otherwise re-inflate the rutor after
 *     annullera). Deliberately broad: every arithmetic narrowing tried against
 *     production broke real settlements (#2805), so it stays as it is;
 *   - tax-account shape (#2805): an entry with a 26xx declaration account and
 *     a skattekonto line (1630), no 2650/1650 line,
 *     and NOTHING else but 26xx and 3740. VAT settled, refunded or reassessed
 *     straight against 1630 is a movement between a VAT account and the
 *     skattekonto, not a sale or a purchase. Purity is what keeps business
 *     verifikat in: 1630 D / 3980 K (a bidrag) and 5410 D / 2641 D / 1630 K
 *     still count.
 *
 * Opening-balance entries are exempt from both shape rules: 26xx balances
 * carried in by a migrating company are unsettled VAT that belongs in the
 * next declaration, even when the same entry carries a 2650/1650 balance.
 *
 * The shapes cannot tell a settlement from a business verifikat that happens
 * to touch 2650 (a supplier invoice with input VAT booked against 2650, say).
 * No rule separates that tail; it needs an explicit per-entry override.
 */
export async function fetchVatAccountTotals(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
  dynamicRuta05Accounts: string[] = []
): Promise<VatAccountTotals> {
  // Aggregation, settlement-shape detection, and source_type counts all
  // happen in one SQL pass (get_vat_declaration_totals). The previous
  // implementation paged every entry + line for the period through PostgREST
  // and reduced in JS: dozens of round trips for a busy quarter. The account
  // lists are parameters so ACCOUNT_RUTA stays the single source of truth.
  //
  // The company's own ruta 05 accounts join p_accounts (they must be summed)
  // but deliberately NOT p_ruta_accounts. That second list is the settlement
  // SHAPE detector: an entry with a line on it plus a line on 2650/1650 (or,
  // for its 26xx members, a pure movement against the skattekonto) is
  // classified a momsredovisning and dropped from the totals entirely. A plain
  // sale booked 1930 / 3013 / 2650 (a company clearing moms straight off the
  // revenue voucher) would then vanish from its own declaration. The fixed
  // ACCOUNT_RUTA list is what defines settlement shape; user accounts widen
  // what is measured, never what counts as a momsredovisning.
  const { data, error } = await supabase.rpc('get_vat_declaration_totals', {
    p_company_id: companyId,
    p_start: start,
    p_end: end,
    p_accounts: [...VAT_ACCOUNTS, ...VAT_SETTLEMENT_NET_ACCOUNTS, ...dynamicRuta05Accounts],
    p_ruta_accounts: VAT_ACCOUNTS,
    p_net_accounts: VAT_SETTLEMENT_NET_ACCOUNTS,
  })
  if (error) {
    throw new Error(`get_vat_declaration_totals failed: ${error.message}`)
  }

  const payload = (data ?? {}) as Partial<VatTotalsRpcPayload>
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const row of payload.totals ?? []) {
    totals.set(row.account_number, {
      debit: Number(row.debit) || 0,
      credit: Number(row.credit) || 0,
    })
  }

  return {
    totals,
    settlementShapedEntries: payload.settlement_shaped_entries ?? [],
    sourceTypeCounts: payload.source_type_counts ?? {},
  }
}

/**
 * The rutor ruta 49 nets (FK009): summaMoms = (10 + 11 + 12 + 30 + 31 + 32 +
 * 60 + 61 + 62) - 48, as box and sign. rutorFromTotals spells the same sum
 * out; a breakdown of ruta 49 by account (the vat_payable measure,
 * lib/measures) reads it from here, and a test there pins the two together.
 */
export const RUTA_49_TERMS: ReadonlyArray<{ box: keyof VatDeclarationRutor; sign: 1 | -1 }> = [
  { box: 'ruta10', sign: 1 },
  { box: 'ruta11', sign: 1 },
  { box: 'ruta12', sign: 1 },
  { box: 'ruta30', sign: 1 },
  { box: 'ruta31', sign: 1 },
  { box: 'ruta32', sign: 1 },
  { box: 'ruta60', sign: 1 },
  { box: 'ruta61', sign: 1 },
  { box: 'ruta62', sign: 1 },
  { box: 'ruta48', sign: -1 },
]

/** One account's balance as it lands in one ruta, unrounded. */
export interface VatRutaContribution {
  account_number: string
  box: keyof VatDeclarationRutor
  side: 'credit' | 'debit'
  /** The account's balance on its ruta's side: credit - debit for 'credit'. */
  amount: number
}

type DynamicRutaAccounts = Pick<DynamicVatAccounts, 'mappingByAccount' | 'explicitAccounts'> | string[]

/**
 * What each account adds to its ruta, in the order rutorFromTotals adds it:
 * the fixed BAS map (ACCOUNT_RUTA) first, minus the accounts the company
 * classified itself, then the company's own classification. rutorFromTotals
 * is a fold over this list, so a breakdown read from it cannot disagree with
 * the filed rutor.
 */
export function vatRutaContributions(
  totals: Map<string, { debit: number; credit: number }>,
  dynamicVatAccounts?: DynamicRutaAccounts,
): VatRutaContribution[] {
  const dynamic = Array.isArray(dynamicVatAccounts)
    ? {
        mappingByAccount: new Map(dynamicVatAccounts.map((account) => [
          account, { box: 'ruta05' as const, side: 'credit' as const },
        ])),
        explicitAccounts: new Set<string>(),
      }
    : dynamicVatAccounts
  const contributions: VatRutaContribution[] = []

  for (const [account, mapping] of Object.entries(ACCOUNT_RUTA)) {
    if (dynamic?.explicitAccounts.has(account)) continue
    const t = totals.get(account)
    if (!t) continue
    const balance = mapping.side === 'credit'
      ? t.credit - t.debit
      : t.debit - t.credit
    contributions.push({ account_number: account, box: mapping.box, side: mapping.side, amount: balance })
  }

  for (const [account, mapping] of dynamic?.mappingByAccount ?? []) {
    const t = totals.get(account)
    if (!t) continue
    const balance = mapping.side === 'credit' ? t.credit - t.debit : t.debit - t.credit
    contributions.push({ account_number: account, box: mapping.box, side: mapping.side, amount: balance })
  }

  return contributions
}

/**
 * Map aggregated per-account totals to the momsdeklaration boxes, including
 * the recomputed ruta 49 net (FK009). Pure projection over ACCOUNT_RUTA plus
 * the company's own ruta 05 accounts (fetchDynamicRuta05Accounts), folded
 * over vatRutaContributions.
 *
 * `dynamicRuta05Accounts` is optional so callers that only need the 26xx boxes
 * keep working untouched: ruta 05 is a beskattningsunderlag, not moms, so it
 * never reaches ruta 49 and the settlement proposal nets the same either way.
 */
export function rutorFromTotals(
  totals: Map<string, { debit: number; credit: number }>,
  dynamicVatAccounts?: DynamicRutaAccounts,
): VatDeclarationRutor {
  const rutor: VatDeclarationRutor = {
    ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
    ruta10: 0, ruta11: 0, ruta12: 0,
    ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
    ruta30: 0, ruta31: 0, ruta32: 0,
    ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
    ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
    ruta48: 0, ruta49: 0,
    ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
  }

  for (const contribution of vatRutaContributions(totals, dynamicVatAccounts)) {
    rutor[contribution.box] = round(rutor[contribution.box] + contribution.amount)
  }

  // FK009: summaMoms = (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - 48
  rutor.ruta49 = round(
    rutor.ruta10 + rutor.ruta11 + rutor.ruta12 +
    rutor.ruta30 + rutor.ruta31 + rutor.ruta32 +
    rutor.ruta60 + rutor.ruta61 + rutor.ruta62 -
    rutor.ruta48
  )

  return rutor
}

/** The momsdeklaration of a period as the ledger gives it, before any presentation. */
export interface VatDeclarationLedger extends VatAccountTotals {
  dynamicVatAccounts: DynamicVatAccounts
  rutor: VatDeclarationRutor
}

/**
 * The one definition of a period's rutor: the company's own account
 * classification (momskod on class 3-6 accounts, momsruta on 26xx accounts),
 * the ledger totals measured over those accounts and the fixed BAS map, and
 * rutorFromTotals over both. The declaration and the settlement proposal both
 * read it, so the net the settlement books is the net the declaration files.
 * The settlement once called rutorFromTotals without the company's accounts:
 * a 26xx account with its own momsruta then landed in its BAS ruta (or, for a
 * number BAS does not know, in none), and the whole-krona net moved.
 */
export async function loadVatDeclarationLedger(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
): Promise<VatDeclarationLedger> {
  // Which of the company's OWN class 3 accounts count as momspliktig
  // försäljning. Resolved from their "Standard moms" rather than a fixed BAS
  // list, because Accounted seeds no varugrupp accounts: every 3011/3013-style
  // konto is user-added and would otherwise never be fetched at all (#1261).
  const dynamicVatAccounts = await fetchDynamicVatAccounts(supabase, companyId)

  // The unconfigured class 3 accounts ride along so the declaration can name
  // the ones with a balance (revenueAccountsWithoutRuta). They join p_accounts
  // only, which measures; rutorFromTotals never sums them, so no filed figure
  // moves.
  const ledger = await fetchVatAccountTotals(
    supabase, companyId, start, end,
    [...dynamicVatAccounts.accounts, ...dynamicVatAccounts.unconfiguredRevenueAccounts.keys()],
  )

  return { ...ledger, dynamicVatAccounts, rutor: rutorFromTotals(ledger.totals, dynamicVatAccounts) }
}

/**
 * Every VAT account (26xx) a VAT ruta of this declaration reads: the fixed BAS
 * output accounts (rutor 10-12, 30-32, 60-62) and input accounts (ruta 48),
 * plus any 26xx account the company routed to a ruta itself (vat_box, e.g. a
 * Fortnox chart's 2617). These are the accounts a momsredovisning clears.
 */
export function vatClearingAccounts(
  dynamicVatAccounts: Pick<DynamicVatAccounts, 'mappingByAccount'>,
): string[] {
  const accounts = new Set([...VAT_OUTPUT_ACCOUNTS, ...VAT_INPUT_ACCOUNTS])
  for (const account of dynamicVatAccounts.mappingByAccount.keys()) {
    if (account.startsWith('26')) accounts.add(account)
  }
  return [...accounts].sort()
}

/**
 * Project the reverse-charge input pair (2645/2647) out of a full totals map,
 * for `VatDeclaration.rcInputAccountTotals`.
 *
 * Both keys are always present, zeros included, so the wire shape is stable and
 * an absent field keeps meaning "this producer does not carry the pair" rather
 * than "no reverse charge in the period".
 */
function rcInputTotals(
  totals: Map<string, { debit: number; credit: number }>
): Record<string, { debit: number; credit: number }> {
  const pair: Record<string, { debit: number; credit: number }> = {}
  for (const account of RC_INPUT_VAT_ACCOUNTS) {
    const t = totals.get(account)
    pair[account] = { debit: round(t?.debit ?? 0), credit: round(t?.credit ?? 0) }
  }
  return pair
}

/**
 * Rebuild the per-account totals map `runVatDeclarationChecks` takes as its
 * optional second argument, from a declaration that may have arrived as JSON
 * over HTTP.
 *
 * Returns undefined when the pair is absent, which makes the check fall back to
 * its weaker ruta 48 comparison. That is deliberate: an empty map would read as
 * "0 kr beräknad ingående moms" and turn a correct declaration into a warning.
 */
export function rcInputTotalsFromDeclaration(
  declaration: Pick<VatDeclaration, 'rcInputAccountTotals'>
): VatCheckAccountTotals | undefined {
  const pair = declaration.rcInputAccountTotals
  return pair ? new Map(Object.entries(pair)) : undefined
}

/**
 * Class 3 accounts that are not omsättning at all and that Accounted's own
 * flows book without moms on ordinary sales and payments: 3740 Öres- och
 * kronutjämning (invoice and payment rounding, the momsredovisning's own
 * rounding line) and 3960 Valutakursvinster (exchange differences on
 * receivables and payables). Neither belongs in any ruta and no momskod fits
 * them, so listing them in REVENUE_ACCOUNT_WITHOUT_RUTA would fire for nearly
 * every invoicing company every period with advice that cannot be followed.
 * Any other account that is not a sale is silenced by setting momssats 0 %.
 */
const NON_TURNOVER_REVENUE_ACCOUNTS: ReadonlySet<string> = new Set([
  ORE_ROUNDING_ACCOUNT,
  '3960',
])

/**
 * The class 3 accounts with a balance in the period that this declaration puts
 * in no ruta (#3387): no momskod, no momssats (configured or inferred) and not
 * in ACCOUNT_RUTA. Feeds the REVENUE_ACCOUNT_WITHOUT_RUTA warning.
 *
 * Derived from the SAME resolution the figures use, so the warning and the
 * declaration cannot disagree: `unconfiguredRevenueAccounts` is what
 * fetchDynamicVatAccounts left out of `mappingByAccount` for want of any
 * classification, and ACCOUNT_RUTA is exactly what rutorFromTotals sums by
 * number. An account in ACCOUNT_TO_BOX (lib/vat/moms-box-mapping.ts) but not
 * in ACCOUNT_RUTA is listed on purpose: the declaration does not sum it.
 *
 * Read-only: nothing here changes a filed figure. Whether such an account
 * should be inferred into ruta 05 is an open decision; until then the user is
 * told and sets the momskod.
 *
 * `amount` is the net credit balance rounded to öre; zero balances (activity
 * that nets out) are dropped because they understate nothing. Sorted by
 * account number so the message is stable.
 */
export function revenueAccountsWithoutRuta(
  totals: VatCheckAccountTotals,
  dynamicVatAccounts: Partial<Pick<DynamicVatAccounts, 'unconfiguredRevenueAccounts'>>,
): VatRevenueAccountWithoutRuta[] {
  const result: VatRevenueAccountWithoutRuta[] = []
  for (const [account, name] of dynamicVatAccounts.unconfiguredRevenueAccounts ?? []) {
    if (ACCOUNT_RUTA[account] || NON_TURNOVER_REVENUE_ACCOUNTS.has(account)) continue
    const t = totals.get(account)
    if (!t) continue
    const amount = round(t.credit - t.debit)
    if (amount === 0) continue
    result.push({ account_number: account, account_name: name, amount })
  }
  return result.sort((a, b) => a.account_number.localeCompare(b.account_number))
}

/**
 * The declaration plus what a reader of it needs and the declaration itself
 * does not carry: which branch of resolvePeriodDates produced the range, and
 * the untagged verifikat the totals left out as momsredovisning. The agent VAT
 * report and close check (./vat-close-check.ts) read these, so they show the
 * filed rutor instead of projecting the aggregate a second time.
 */
export interface ComputedVatDeclaration {
  declaration: VatDeclaration
  periodSource: VatPeriodSource
  settlementShapedEntries: VatSettlementShapedEntry[]
}

/**
 * Calculate VAT declaration from the general ledger.
 *
 * Sums posted journal entry lines on the BAS accounts in ACCOUNT_RUTA per the
 * SKV 4700 form mapping. Pure ledger projection: no supplier classification
 * or other side-channel signals.
 *
 *   - ruta 49 = (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - 48
 *
 * INVARIANT: the company's accounting method (faktureringsmetoden vs
 * kontantmetoden) needs no parameter here and must not become one. The method
 * is already baked into journal entry TIMING: kontantmetod companies post
 * VAT-bearing entries at payment date, faktureringsmetod companies at invoice
 * date, so summing posted lines per period is correct for both. A method
 * parameter existed until 2026-07-23 and was silently ignored; it was removed
 * so no future code path can branch on a value that callers hard-code.
 */
export async function computeVatDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  options: { fiscalPeriodId?: string } = {}
): Promise<ComputedVatDeclaration> {
  // For yearly VAT this resolves to the räkenskapsår bounds (when a fiscal
  // period is supplied), not the calendar year: see resolvePeriodDates.
  const { start, end, source: periodSource } = await resolvePeriodDates(
    supabase, companyId, periodType, year, period, options.fiscalPeriodId
  )

  // The rutor, the per-account totals behind them and the per-source_type
  // entry counts for the metadata, from the one definition the settlement
  // proposal reads too (loadVatDeclarationLedger).
  const { totals, sourceTypeCounts, settlementShapedEntries, dynamicVatAccounts, rutor } =
    await loadVatDeclarationLedger(supabase, companyId, start, end)

  // Compute per-rate base amounts from individual revenue accounts. The
  // company's own accounts carry their rate on the konto itself, so they land
  // in the same three buckets: without that, a 3013 company would show a
  // ruta 05 base that none of base25/12/6 accounts for.
  //
  // These three are REPORTING metadata (breakdown.invoices), not check inputs:
  // vat-declaration-checks.ts derives its expected base from the output-VAT
  // rutor (ruta10/0.25 + ruta11/0.12 + ruta12/0.06) and never reads base25/12/6.
  // So an incomplete split understates nothing that gets filed; it only makes
  // the breakdown fail to add up to ruta 05.
  const revenueByRate = {
    base25: 0,  // 3001
    base12: 0,  // 3002
    base6: 0,   // 3003
  }
  const RATE_BUCKET = { 0.25: 'base25', 0.12: 'base12', 0.06: 'base6' } as const
  for (const [account, rate] of [['3001', 'base25'], ['3002', 'base12'], ['3003', 'base6']] as const) {
    if (dynamicVatAccounts.explicitAccounts.has(account)) continue
    const t = totals.get(account)
    if (t) revenueByRate[rate] = round(t.credit - t.debit)
  }
  for (const [account, rate] of dynamicVatAccounts.rateByAccount) {
    const t = totals.get(account)
    if (!t) continue
    const bucket = RATE_BUCKET[rate as keyof typeof RATE_BUCKET]
    if (!bucket) continue
    revenueByRate[bucket] = round(revenueByRate[bucket] + (t.credit - t.debit))
  }
  // Accounts the static map ALREADY sums into ruta 05 (3000, the 30xx
  // gruppkonto) but whose rate only exists as the konto's "Standard moms".
  // Rate-only on purpose: their balance is in ruta 05 either way, so adding
  // them to dynamicRuta05.accounts would double the filed figure.
  for (const [account, rate] of dynamicVatAccounts.staticRateByAccount) {
    const t = totals.get(account)
    if (!t) continue
    const bucket = RATE_BUCKET[rate as keyof typeof RATE_BUCKET]
    if (!bucket) continue
    revenueByRate[bucket] = round(revenueByRate[bucket] + (t.credit - t.debit))
  }

  // Entry counts by source type for metadata: aggregated by the RPC in the
  // same round trip as the totals (SQL GROUP BY, so a busy VAT period can
  // never truncate the counts).
  const invoiceSources = new Set([
    'invoice_created', 'invoice_paid', 'invoice_cash_payment', 'credit_note',
  ])
  let invoiceCount = 0
  let transactionCount = 0
  for (const [sourceType, n] of Object.entries(sourceTypeCounts)) {
    if (invoiceSources.has(sourceType)) invoiceCount += n
    else if (sourceType === 'bank_transaction') transactionCount += n
  }

  const declaration: VatDeclaration = {
    period: { type: periodType, year, period, start, end },
    rutor,
    // The 2645/2647 pair travels with the declaration so an HTTP caller can run
    // the sharp RC_INPUT_VAT_MISMATCH comparison instead of the ruta 48
    // fallback: see VatDeclaration.rcInputAccountTotals.
    rcInputAccountTotals: rcInputTotals(totals),
    // Per-momssats RC basis balances (44xx/45xx), the downgrade evidence for
    // the per-voucher gap tiering: see VatDeclaration.rcBasisByRate.
    rcBasisByRate: rcBasisTotalsByRate(totals, dynamicVatAccounts),
    // Class 3 balances that reach no ruta, for REVENUE_ACCOUNT_WITHOUT_RUTA:
    // see VatDeclaration.revenueAccountsWithoutRuta.
    revenueAccountsWithoutRuta: revenueAccountsWithoutRuta(totals, dynamicVatAccounts),
    invoiceCount,
    transactionCount,
    breakdown: {
      invoices: {
        ruta05: rutor.ruta05,
        ruta06: rutor.ruta06,
        ruta07: rutor.ruta07,
        ruta10: rutor.ruta10,
        ruta11: rutor.ruta11,
        ruta12: rutor.ruta12,
        ruta39: rutor.ruta39,
        ruta40: rutor.ruta40,
        base25: revenueByRate.base25,
        base12: revenueByRate.base12,
        base6: revenueByRate.base6,
      },
      transactions: { ruta48: rutor.ruta48 },
      receipts: { ruta48: 0 },
      reverseCharge: {
        ruta20: rutor.ruta20,
        ruta21: rutor.ruta21,
        ruta22: rutor.ruta22,
        ruta23: rutor.ruta23,
        ruta24: rutor.ruta24,
        ruta30: rutor.ruta30,
        ruta31: rutor.ruta31,
        ruta32: rutor.ruta32,
      },
    },
  }
  return { declaration, periodSource, settlementShapedEntries }
}

/**
 * The momsdeklaration as filed (computeVatDeclaration's declaration), for callers
 * that only need the declaration itself.
 */
export async function calculateVatDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  options: { fiscalPeriodId?: string } = {}
): Promise<VatDeclaration> {
  return (await computeVatDeclaration(supabase, companyId, periodType, year, period, options)).declaration
}

/**
 * Format period label for display
 */
export function formatPeriodLabel(
  periodType: VatPeriodType,
  year: number,
  period: number
): string {
  switch (periodType) {
    case 'monthly':
      const monthNames = [
        'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
        'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December'
      ]
      return `${monthNames[period - 1]} ${year}`
    case 'quarterly':
      return `Kvartal ${period} ${year}`
    case 'yearly':
      return `Helår ${year}`
    default:
      return `${year}`
  }
}
