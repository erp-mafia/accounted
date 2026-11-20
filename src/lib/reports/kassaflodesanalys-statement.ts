import type { TrialBalanceRow } from '@/types'
import { roundOre } from '@/lib/money'
import { isAretsResultatAccount } from '@/lib/bookkeeping/bas-data/result-accounts'
import { isCashFlowTaxBridgeAccount } from './cash-flow-tax'

/**
 * Kassaflödesanalys laid out to K3 chapter 7 (BFNAR 2012:1 as amended by
 * BFNAR 2025:3, for financial years starting after 2025-12-31; the same
 * points hold for earlier years except where noted).
 *
 * The statement is the indirect method (7.8-7.9) starting from rörelseresultat,
 * the layout of the K3 example "Kassaflödesanalys (indirekt metod)":
 *
 *   - Interest received, interest paid and dividends received are separate
 *     cash lines in the löpande verksamhet (7.14, 7.15 first paragraph): the
 *     income or expense in the resultaträkning adjusted for the change in
 *     upplupna and förutbetalda räntor (1740, 1760, 2960). Dividends paid are
 *     financing (7.16). The 7.15 second-paragraph option (interest in
 *     investering or finansiering) is not offered: one classification stays
 *     consistent between years by construction.
 *   - Income tax paid is its own löpande line (7.17) and is never split across
 *     categories, so the 7.20 total equals that line.
 *   - Investing and financing flows are gross by kind (7.11): acquisitions and
 *     disposals per immateriella, materiella and finansiella
 *     anläggningstillgångar; borrowing and amortisation separately. 7.12 b
 *     netting is used only for checkräkningskredit and kortfristiga
 *     placeringar, items that turn over quickly.
 *   - The effect of exchange-rate changes on likvida medel is a line of its
 *     own outside the three categories (7.13).
 *   - Likvida medel follow 7.4: 19xx less spärrade bankmedel (1974, not
 *     disponibla), with koncernkonto (1960) included from financial years
 *     starting after 2025-12-31 (7.4 second paragraph, BFNAR 2025:3) and
 *     treated as a receivable before that. Further accounts (a qualifying
 *     18xx placement under 7.4 c, a bostadsrättsförening's klientmedelskonto
 *     under 38.16) are added by the caller.
 *
 * Every trial-balance account lands in exactly one bucket, and every
 * reclassification between lines is a matched pair, so the three categories
 * plus the kursdifferens add up to the change in likvida medel by
 * construction; the reconciliation stays as the guard against postings in
 * the period that do not balance.
 *
 * Output shape: `KassaflodesanalysYear.amounts` is keyed by
 * `KassaflodesanalysLineKey`, and `KASSAFLODESANALYS_LAYOUT` gives the order,
 * the Swedish label and the K3 taxonomy concept for each key. Both are the
 * contract the årsredovisning (PDF) and the iXBRL mapping read: add keys,
 * never rename or repurpose one.
 */

import type {
  KassaflodesanalysJusteringar,
  KassaflodesanalysYear,
  LikvidaMedelComposition,
  LikvidaMedelDefinition,
} from './kassaflodesanalys-layout'

export { KASSAFLODESANALYS_LAYOUT } from './kassaflodesanalys-layout'
export type {
  KassaflodesanalysAmounts,
  KassaflodesanalysJusteringar,
  KassaflodesanalysLayoutRow,
  KassaflodesanalysLineKey,
  KassaflodesanalysPreviousStatus,
  KassaflodesanalysSection,
  KassaflodesanalysStatement,
  KassaflodesanalysYear,
  LikvidaMedelComposition,
  LikvidaMedelDefinition,
} from './kassaflodesanalys-layout'

/** The tax bridge's answer for the year (cash-flow-tax.ts). */
export interface CashFlowTaxBridge {
  paidIncomeTax: number
  otherTaxLiabilityChange: number
  expenseInOperatingProfit: number
}

/** Net debit per account for one voucher, a storno grouped with the entry it reverses. */
export type VoucherMovements = ReadonlyMap<string, number>

// ─── Classification ─────────────────────────────────────────────────────

type Kind = 'immateriella' | 'materiella' | 'finansiella'

type Bucket =
  | 'likvida_medel'
  | 'tax'
  | 'rorelseresultat'
  | 'justeringar'
  | 'koncernbidrag'
  | 'erhallen_utdelning'
  | 'erhallen_ranta'
  | 'erlagd_ranta'
  | 'ovriga_finansiella_poster'
  | 'varulager'
  | 'rorelsefordringar'
  | 'rorelseskulder'
  | Kind
  | 'kortfristiga_placeringar'
  | 'sparrade_bankmedel'
  | 'lan'
  | 'checkrakningskredit'
  | 'nyemission'
  | 'tillskott'
  | 'eget_kapital'
  | 'ovrigt'

/** An item inside rörelseresultat whose cash belongs to investering. */
interface Transfer {
  kind: Kind
  category: 'avskrivningar_nedskrivningar' | 'realisationsresultat'
}

interface Classification {
  bucket: Bucket
  transfer?: Transfer
}

const startsWithAny = (account: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => account.startsWith(prefix))

const KONCERNKONTO = '1960'
const SPARRADE_BANKMEDEL = '1974'
/** 7.4 second paragraph applies to financial years starting after 2025-12-31. */
const KONCERNKONTO_RULE_FROM = '2026-01-01'

/**
 * The likvida medel definition for a financial year starting on
 * `periodStart`. The comparative year is computed with the current year's
 * definition, so the two columns are comparable.
 */
export function likvidaMedelDefinition(
  periodStart: string,
  extraAccounts: readonly string[] = [],
): LikvidaMedelDefinition {
  const koncernkontoIncluded = periodStart >= KONCERNKONTO_RULE_FROM
  return {
    account_prefixes: ['19', ...extraAccounts],
    koncernkonto_included: koncernkontoIncluded,
    excluded_accounts: koncernkontoIncluded ? [SPARRADE_BANKMEDEL] : [KONCERNKONTO, SPARRADE_BANKMEDEL],
    extra_accounts: [...extraAccounts],
  }
}

function isLikvidaMedel(account: string, definition: LikvidaMedelDefinition): boolean {
  if (definition.excluded_accounts.some((excluded) => account.startsWith(excluded))) return false
  return startsWithAny(account, definition.account_prefixes)
}

// Accumulated depreciation and write-down accounts: the xx8/xx9 contras of
// groups 10-12 (1080-1089, 1180-1189 and 1280-1289 are förskott and pågående
// nyanläggningar, not contras) and the nedskrivning accounts of group 13.
const FINANCIAL_ASSET_WRITE_DOWNS = new Set([
  '1318', '1328', '1332', '1334', '1337', '1342', '1344', '1347', '1358', '1369', '1389',
])
function isAccumulatedContra(account: string): boolean {
  const head = account.slice(0, 4)
  return /^1[012][0-79][89]$/.test(head) || FINANCIAL_ASSET_WRITE_DOWNS.has(head)
}

/** Anskaffningsvärde accounts of a kind: the ones whose growth is an acquisition. */
function isCostAccount(account: string): boolean {
  return /^1[0-3]/.test(account) && !isAccumulatedContra(account)
}

/** Financial items (8000-8799) by where their cash belongs. */
function classifyFinancial(account: string): Bucket {
  // Dividends received. Emissionsinsatser (8016, 8116-8118, 8216) bring no
  // cash: the holding grows instead.
  if (/^(801[6-9]|811[6-9]|821[6-9])/.test(account)) return 'finansiella'
  if (startsWithAny(account, ['801', '811', '821', '834'])) return 'erhallen_utdelning'
  // Avkastningsskatt (8255) is a tax paid, not interest received.
  if (account.startsWith('8255')) return 'ovriga_finansiella_poster'
  if (startsWithAny(account, ['825', '826', '831', '836'])) return 'erhallen_ranta'
  // Interest share of the pension cost: the pension provision grows instead.
  if (account.startsWith('8412')) return 'justeringar'
  if (startsWithAny(account, ['840', '841', '842', '844', '846', '848'])) return 'erlagd_ranta'
  // Exchange differences and value changes follow the item they revalue:
  // long-term receivables, short-term receivables and placements, debts.
  if (startsWithAny(account, ['823'])) return 'finansiella'
  if (startsWithAny(account, ['833'])) return 'rorelsefordringar'
  if (startsWithAny(account, ['843', '845'])) return 'lan'
  // Results on disposals, write-downs, återföringar, fair value and
  // resultatandelar from handelsbolag: non-cash or investing.
  if (startsWithAny(account, [
    '802', '803', '807', '808', '812', '813', '817', '818', '822', '824', '827', '828', '829',
  ])) return 'finansiella'
  if (startsWithAny(account, ['832', '835', '837', '838'])) return 'kortfristiga_placeringar'
  return 'ovriga_finansiella_poster'
}

/** Avskrivningar, nedskrivningar and realised results inside rörelseresultat. */
function operatingTransfer(account: string): Transfer | undefined {
  if (account.startsWith('781')) return { kind: 'immateriella', category: 'avskrivningar_nedskrivningar' }
  if (account.startsWith('78')) return { kind: 'materiella', category: 'avskrivningar_nedskrivningar' }
  if (startsWithAny(account, ['771', '776'])) return { kind: 'immateriella', category: 'avskrivningar_nedskrivningar' }
  if (startsWithAny(account, ['772', '773', '777', '778'])) return { kind: 'materiella', category: 'avskrivningar_nedskrivningar' }
  if (startsWithAny(account, ['3971', '7971'])) return { kind: 'immateriella', category: 'realisationsresultat' }
  if (startsWithAny(account, ['397', '797'])) return { kind: 'materiella', category: 'realisationsresultat' }
  return undefined
}

/** The one bucket an account belongs to. First match wins, so order matters. */
function classify(account: string, definition: LikvidaMedelDefinition): Classification {
  if (isLikvidaMedel(account, definition)) return { bucket: 'likvida_medel' }
  if (account.startsWith(SPARRADE_BANKMEDEL)) return { bucket: 'sparrade_bankmedel' }
  // Koncernkonto before 7.4 second paragraph applies: a receivable on the
  // group, like 166x.
  if (account.startsWith('19')) return { bucket: 'rorelsefordringar' }
  if (isCashFlowTaxBridgeAccount(account)) return { bucket: 'tax' }
  if (startsWithAny(account, ['882', '883'])) return { bucket: 'koncernbidrag' }
  // Bokslutsdispositioner against obeskattade reserver (21xx), avsättningar
  // against their expense, and deferred tax against 2240/1370.
  if (startsWithAny(account, ['88', '894', '21', '22', '137'])) return { bucket: 'justeringar' }
  if (isAretsResultatAccount(account)) return { bucket: 'eget_kapital' }
  if (/^[3-7]/.test(account)) return { bucket: 'rorelseresultat', transfer: operatingTransfer(account) }
  if (account.startsWith('8')) return { bucket: classifyFinancial(account) }
  if (account.startsWith('14')) return { bucket: 'varulager' }
  // 1690 fordringar för tecknat men ej inbetalt kapital: an emission booked
  // before it is paid nets to zero instead of showing as financing now and
  // as an operating receivable later.
  if (startsWithAny(account, ['169', '2081', '2082', '2083', '2084', '2087', '2097'])) return { bucket: 'nyemission' }
  // Accrued and prepaid interest: the interest lines show what was paid.
  if (account.startsWith('174')) return { bucket: 'erlagd_ranta' }
  if (account.startsWith('176')) return { bucket: 'erhallen_ranta' }
  if (startsWithAny(account, ['15', '16', '17'])) return { bucket: 'rorelsefordringar' }
  if (account.startsWith('10')) return { bucket: 'immateriella' }
  if (startsWithAny(account, ['11', '12'])) return { bucket: 'materiella' }
  if (account.startsWith('13')) return { bucket: 'finansiella' }
  if (account.startsWith('18')) return { bucket: 'kortfristiga_placeringar' }
  if (account.startsWith('2093')) return { bucket: 'tillskott' }
  // Other owner equity with 2898 (outstanding dividend): the result transfer
  // 8999 -> 2099 -> 2098 -> 2091 and a dividend decision 2098 -> 2898 net to
  // zero here, so only the payment remains.
  if (startsWithAny(account, ['20', '2898'])) return { bucket: 'eget_kapital' }
  // Kontokredit (checkräkningskredit), long and short.
  if (startsWithAny(account, ['233', '248'])) return { bucket: 'checkrakningskredit' }
  if (startsWithAny(account, ['23', '241', '284'])) return { bucket: 'lan' }
  if (account.startsWith('296')) return { bucket: 'erlagd_ranta' }
  if (startsWithAny(account, ['24', '26', '27', '28', '29'])) return { bucket: 'rorelseskulder' }
  return { bucket: 'ovrigt' }
}

/** Exchange-difference accounts a revaluation of likvida medel is booked against. */
const isCashFxAccount = (account: string) => /^(396|796|833)/.test(account)

// ─── Builder ────────────────────────────────────────────────────────────

const ore = (value: number) => roundOre(value) || 0

/** The signed debit-side change between IB and UB; a line adds its negation. */
function debitSideDelta(row: TrialBalanceRow): number {
  const opening = (row.opening_debit || 0) - (row.opening_credit || 0)
  const closing = (row.closing_debit || 0) - (row.closing_credit || 0)
  return closing - opening
}

function composition(
  rows: readonly TrialBalanceRow[],
  definition: LikvidaMedelDefinition,
  side: 'opening' | 'closing',
): LikvidaMedelComposition {
  const result = { kassamedel: 0, bank: 0, kortfristiga_placeringar: 0, koncernkonto: 0, total: 0 }
  for (const row of rows) {
    const account = row.account_number
    if (!isLikvidaMedel(account, definition)) continue
    const balance = side === 'opening'
      ? (row.opening_debit || 0) - (row.opening_credit || 0)
      : (row.closing_debit || 0) - (row.closing_credit || 0)
    if (account.startsWith('191')) result.kassamedel += balance
    else if (account.startsWith(KONCERNKONTO)) result.koncernkonto += balance
    else if (account.startsWith('195') || account.startsWith('18')) result.kortfristiga_placeringar += balance
    else result.bank += balance
    result.total += balance
  }
  return {
    kassamedel: ore(result.kassamedel),
    bank: ore(result.bank),
    kortfristiga_placeringar: ore(result.kortfristiga_placeringar),
    koncernkonto: ore(result.koncernkonto),
    total: ore(result.total),
  }
}

/**
 * Split a net flow into its gross inflow and outflow from per-voucher
 * evidence. When the evidence does not add up to the net (none was read, or
 * it disagrees with the trial balance), the net is shown on the side its sign
 * points to: the statement still reconciles, it is only less gross.
 */
function grossSplit(net: number, inflow: number, outflow: number): { inflow: number; outflow: number } {
  if (ore(inflow + outflow) === ore(net)) return { inflow: ore(inflow), outflow: ore(outflow) }
  return net >= 0 ? { inflow: ore(net), outflow: 0 } : { inflow: 0, outflow: ore(net) }
}

export interface BuildKassaflodesanalysYearInput {
  periodStart: string
  periodEnd: string
  rows: readonly TrialBalanceRow[]
  tax: CashFlowTaxBridge
  /**
   * Per-voucher movements of the year (same scope as `rows`), or null when
   * no account needs them: they split loans and acquisitions into gross
   * flows and find exchange differences on likvida medel. Read them with
   * `needsVoucherEvidence`.
   */
  vouchers: readonly VoucherMovements[] | null
  definition: LikvidaMedelDefinition
}

/**
 * Whether the trial balance alone cannot give the gross flows: a loan or an
 * asset kind moved in both directions, or an exchange-difference account
 * moved in a year with likvida medel in more than one account.
 */
export function needsVoucherEvidence(
  rows: readonly TrialBalanceRow[],
  definition: LikvidaMedelDefinition,
): boolean {
  const directions = new Map<string, { debit: boolean; credit: boolean }>()
  let fxMoved = false
  for (const row of rows) {
    const account = row.account_number
    const moved = (row.period_debit || 0) !== 0 || (row.period_credit || 0) !== 0
    if (!moved) continue
    if (isCashFxAccount(account)) fxMoved = true
    const { bucket } = classify(account, definition)
    const key = bucket === 'lan'
      ? 'lan'
      : (bucket === 'immateriella' || bucket === 'materiella' || bucket === 'finansiella') && isCostAccount(account)
        ? bucket
        : null
    if (!key) continue
    const seen = directions.get(key) ?? { debit: false, credit: false }
    if ((row.period_debit || 0) !== 0) seen.debit = true
    if ((row.period_credit || 0) !== 0) seen.credit = true
    directions.set(key, seen)
  }
  if (fxMoved) return true
  return [...directions.values()].some((seen) => seen.debit && seen.credit)
}

export function buildKassaflodesanalysYear(input: BuildKassaflodesanalysYearInput): KassaflodesanalysYear {
  const { rows, tax, vouchers, definition } = input

  // Cash contribution per bucket: the negated debit-side change.
  const cashIn = new Map<Bucket, number>()
  const add = (bucket: Bucket, amount: number) => cashIn.set(bucket, (cashIn.get(bucket) ?? 0) + amount)
  const justeringar: KassaflodesanalysJusteringar = {
    avskrivningar_nedskrivningar: 0,
    realisationsresultat: 0,
    orealiserade_kursdifferenser: 0,
    ovriga: 0,
  }
  const bucketOf = new Map<string, Classification>()
  const unclassified: string[] = []
  // Fallback gross amounts from the trial balance, used when no vouchers were read.
  const costDebits = new Map<Kind, number>()
  let loanCredits = 0
  let loanDebits = 0

  for (const row of rows) {
    const account = row.account_number
    const classification = classify(account, definition)
    bucketOf.set(account, classification)
    const contribution = -debitSideDelta(row)
    const { bucket, transfer } = classification
    if (bucket === 'likvida_medel') continue
    add(bucket, contribution)

    if (transfer) {
      // The expense reduced rörelseresultat without consuming cash (or the
      // gain raised it without bringing any in): reverse it in löpande and
      // give it to the kind that holds the balance-sheet side.
      justeringar[transfer.category] -= contribution
      add(transfer.kind, contribution)
    }
    if ((bucket === 'immateriella' || bucket === 'materiella' || bucket === 'finansiella') && isCostAccount(account)) {
      costDebits.set(bucket, (costDebits.get(bucket) ?? 0) + (row.period_debit || 0))
    }
    if (bucket === 'lan') {
      loanCredits += row.period_credit || 0
      loanDebits += row.period_debit || 0
    }
    if (bucket === 'ovrigt' && ore(contribution) !== 0) unclassified.push(account)
  }

  // ─── Per-voucher evidence ────────────────────────────────────────────
  let kursdifferens = 0
  const acquisitions = new Map<Kind, number>()
  let loanInflow = 0
  let loanOutflow = 0
  if (vouchers) {
    for (const voucher of vouchers) {
      const kindCost = new Map<Kind, number>()
      let loanNet = 0
      let cashLines = 0
      let fxLines = 0
      let otherLines = 0
      for (const [account, netDebit] of voucher) {
        if (netDebit === 0) continue
        const classification = bucketOf.get(account) ?? classify(account, definition)
        const { bucket } = classification
        if (bucket === 'likvida_medel') cashLines++
        else if (isCashFxAccount(account)) fxLines++
        else otherLines++
        if ((bucket === 'immateriella' || bucket === 'materiella' || bucket === 'finansiella') && isCostAccount(account)) {
          kindCost.set(bucket, (kindCost.get(bucket) ?? 0) + netDebit)
        }
        if (bucket === 'lan') loanNet -= netDebit
      }
      for (const [kind, net] of kindCost) {
        if (net > 0) acquisitions.set(kind, (acquisitions.get(kind) ?? 0) + net)
      }
      if (loanNet > 0) loanInflow += loanNet
      else loanOutflow += loanNet
      // A voucher that only moves likvida medel against exchange-difference
      // accounts is a revaluation (or an exchange between currencies): the
      // difference changed likvida medel without any cash flow (7.13).
      if (cashLines > 0 && fxLines > 0 && otherLines === 0) {
        for (const [account, netDebit] of voucher) {
          if (!isCashFxAccount(account)) continue
          const fx = -netDebit
          kursdifferens += fx
          const { bucket } = bucketOf.get(account) ?? classify(account, definition)
          if (bucket === 'rorelseresultat') justeringar.orealiserade_kursdifferenser -= fx
          else add(bucket, -fx)
        }
      }
    }
  } else {
    for (const [kind, debits] of costDebits) acquisitions.set(kind, debits)
    loanInflow = loanCredits
    loanOutflow = -loanDebits
  }

  const sum = (bucket: Bucket) => cashIn.get(bucket) ?? 0

  // ─── Den löpande verksamheten ────────────────────────────────────────
  // Foreign income tax already in rörelseresultat (6996/6997): the tax
  // bridge supplies the payment, so the expense is added back here.
  justeringar.ovriga = sum('justeringar') + tax.expenseInOperatingProfit
  const rorelseresultat = ore(sum('rorelseresultat'))
  const justeringarTotal = ore(
    justeringar.avskrivningar_nedskrivningar
      + justeringar.realisationsresultat
      + justeringar.orealiserade_kursdifferenser
      + justeringar.ovriga,
  )
  const erhallenUtdelning = ore(sum('erhallen_utdelning'))
  const erhallenRanta = ore(sum('erhallen_ranta'))
  const erlagdRanta = ore(sum('erlagd_ranta'))
  const ovrigaFinansiellaPoster = ore(sum('ovriga_finansiella_poster'))
  const betaldInkomstskatt = ore(tax.paidIncomeTax)
  const koncernbidrag = ore(sum('koncernbidrag'))
  const foreRorelsekapital = ore(
    rorelseresultat + justeringarTotal + erhallenUtdelning + erhallenRanta + erlagdRanta
      + ovrigaFinansiellaPoster + betaldInkomstskatt + koncernbidrag,
  )
  const forandringVarulager = ore(sum('varulager'))
  const forandringRorelsefordringar = ore(sum('rorelsefordringar'))
  // Other taxes (property, pension, yield) are working capital: their
  // expense is already in rörelseresultat.
  const forandringRorelseskulder = ore(sum('rorelseskulder') + tax.otherTaxLiabilityChange)
  const ovrigaPoster = ore(sum('ovrigt'))
  const kassaflodeLopande = ore(
    foreRorelsekapital + forandringVarulager + forandringRorelsefordringar + forandringRorelseskulder + ovrigaPoster,
  )

  // ─── Investeringsverksamheten ────────────────────────────────────────
  // Per kind: the net cash is the change of every account of the kind
  // (contras included) plus the avskrivningar, nedskrivningar and realised
  // results moved here from löpande. Acquisitions are the gross growth of
  // the anskaffningsvärde accounts; the rest is what disposals brought in,
  // so a sale shows its proceeds, not the cost that left the books.
  const byKind = (kind: Kind) => {
    const net = ore(sum(kind))
    const acquired = ore(acquisitions.get(kind) ?? 0)
    const disposed = ore(Math.max(0, net + acquired))
    return { investering: ore(net - disposed), forsaljning: disposed }
  }
  const immateriella = byKind('immateriella')
  const materiella = byKind('materiella')
  const finansiella = byKind('finansiella')
  const kortfristigaPlaceringar = ore(sum('kortfristiga_placeringar'))
  const sparradeBankmedel = ore(sum('sparrade_bankmedel'))
  const kassaflodeInvestering = ore(
    immateriella.investering + immateriella.forsaljning + materiella.investering + materiella.forsaljning
      + finansiella.investering + finansiella.forsaljning + kortfristigaPlaceringar + sparradeBankmedel,
  )

  // ─── Finansieringsverksamheten ───────────────────────────────────────
  const loans = grossSplit(sum('lan'), loanInflow, loanOutflow)
  const checkrakningskredit = ore(sum('checkrakningskredit'))
  const nyemission = ore(sum('nyemission'))
  const tillskott = ore(sum('tillskott'))
  const utdelning = ore(sum('eget_kapital'))
  const kassaflodeFinansiering = ore(
    loans.inflow + loans.outflow + checkrakningskredit + nyemission + tillskott + utdelning,
  )

  // ─── Likvida medel ───────────────────────────────────────────────────
  const aretsKassaflode = ore(kassaflodeLopande + kassaflodeInvestering + kassaflodeFinansiering)
  const ib = composition(rows, definition, 'opening')
  const ub = composition(rows, definition, 'closing')
  const kursdifferensLine = ore(kursdifferens)
  const deltaActual = ore(ub.total - ib.total)
  const deltaCalculated = ore(aretsKassaflode + kursdifferensLine)
  const mismatch = ore(deltaActual - deltaCalculated)

  return {
    period_start: input.periodStart,
    period_end: input.periodEnd,
    amounts: {
      rorelseresultat,
      justeringar_ej_kassaflode: justeringarTotal,
      erhallen_utdelning: erhallenUtdelning,
      erhallen_ranta: erhallenRanta,
      erlagd_ranta: erlagdRanta,
      ovriga_finansiella_poster: ovrigaFinansiellaPoster,
      betald_inkomstskatt: betaldInkomstskatt,
      koncernbidrag,
      kassaflode_fore_rorelsekapital: foreRorelsekapital,
      forandring_varulager: forandringVarulager,
      forandring_rorelsefordringar: forandringRorelsefordringar,
      forandring_rorelseskulder: forandringRorelseskulder,
      ovriga_poster: ovrigaPoster,
      kassaflode_lopande: kassaflodeLopande,
      investering_immateriella: immateriella.investering,
      forsaljning_immateriella: immateriella.forsaljning,
      investering_materiella: materiella.investering,
      forsaljning_materiella: materiella.forsaljning,
      investering_finansiella: finansiella.investering,
      forsaljning_finansiella: finansiella.forsaljning,
      forandring_kortfristiga_placeringar: kortfristigaPlaceringar,
      forandring_sparrade_bankmedel: sparradeBankmedel,
      kassaflode_investering: kassaflodeInvestering,
      upptagna_lan: loans.inflow,
      amortering_lan: loans.outflow,
      forandring_checkrakningskredit: checkrakningskredit,
      nyemission,
      erhallna_aktieagartillskott: tillskott,
      utbetald_utdelning: utdelning,
      kassaflode_finansiering: kassaflodeFinansiering,
      arets_kassaflode: aretsKassaflode,
      likvida_medel_ib: ib.total,
      kursdifferens_likvida_medel: kursdifferensLine,
      likvida_medel_ub: ub.total,
    },
    justeringar: {
      avskrivningar_nedskrivningar: ore(justeringar.avskrivningar_nedskrivningar),
      realisationsresultat: ore(justeringar.realisationsresultat),
      orealiserade_kursdifferenser: ore(justeringar.orealiserade_kursdifferenser),
      ovriga: ore(justeringar.ovriga),
    },
    likvida_medel: { definition, ib, ub },
    total_tax_payments: betaldInkomstskatt,
    unclassified_accounts: unclassified.sort(),
    reconciliation: {
      delta_actual: deltaActual,
      delta_calculated: deltaCalculated,
      mismatch_amount: mismatch,
      is_reconciled: Math.abs(mismatch) < 0.01,
    },
  }
}

/**
 * Whether a year has anything to compare against: a previous period that
 * holds only an opening balance (an import's first year) has no flows, and
 * printing zeros as its kassaflödesanalys would be wrong.
 */
export function hasPeriodActivity(rows: readonly TrialBalanceRow[]): boolean {
  return rows.some((row) => (row.period_debit || 0) !== 0 || (row.period_credit || 0) !== 0)
}
