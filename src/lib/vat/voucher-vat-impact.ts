/**
 * What a verifikat that is not posted yet would do to the momsdeklaration
 * (crm#1447): the VAT period its date falls in, whether the declaration reads
 * it at all, and how much each ruta moves. The staged gnubok_create_voucher
 * preview carries it, so the agent and the approver see the effect before the
 * voucher is posted instead of in the next VAT report.
 *
 * Which verifikat the declaration reads is decided in SQL, over posted
 * verifikat only (vat_declaration_special_entries, latest definition in
 * migration 20261023094030). A staged voucher is not in the ledger yet, so
 * the per-verifikat part of that decision is restated here over its lines.
 * Only that part: a manual voucher is never tagged vat_settlement, never a
 * kontantmetod cut-off reversal and never the posted bokslut, so what is left
 * is the two momsredovisning shapes (line for line the shape_flags predicates)
 * and the opening-balance rule. The account lists are the ones the app passes
 * to the SQL (VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS, and the SQL's own
 * skattekonto_shape_accounts), so a list can never differ; the predicate
 * cases are those the pg tests pin on the SQL
 * (tests/pg/vat-skattekonto-counter-entries.pg.test.ts and
 * tests/pg/vat-totals-shape-pass.pg.test.ts), repeated in this module's unit
 * test. A change to the shapes in SQL must change momsredovisningShapeOfLines
 * with it.
 *
 * The rutor a counted voucher moves come from vatRutaContributions, the fold
 * rutorFromTotals files, over the voucher's own account totals: the same
 * account-to-ruta map, including the company's own classification.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MomsPeriod, VatDeclarationRutor } from '@/types'
import { ORE_ROUNDING_ACCOUNT, roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import {
  formatPeriodLabel,
  isMomsAccount,
  resolvePeriodDates,
  RUTA_49_TERMS,
  VAT_ACCOUNTS,
  VAT_SETTLEMENT_NET_ACCOUNTS,
  vatRutaContributions,
  type MomsredovisningDetection,
} from '@/lib/reports/vat-declaration'
import { fetchDynamicVatAccounts, type DynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { listVatFilings } from './filing-record-store'

const log = createLogger('vat/voucher-vat-impact')

/** One line of the voucher as it would post. Account numbers are strings. */
export interface VoucherImpactLine {
  account_number: string
  debit_amount: number
  credit_amount: number
}

/** A momsredovisning shape, as get_vat_report's excluded_settlement_entries labels it. */
export type VoucherMomsredovisningShape = Exclude<MomsredovisningDetection, 'tagged'>

/**
 * Why the declaration would leave the voucher out:
 *   - `net_account_shape`: a line on a declaration account AND one on 2650/1650;
 *   - `tax_account_shape`: only 26xx, the skattekonto and 3740, with a 26xx
 *     declaration line and a skattekonto line;
 *   - `opening_balance`: an ingående balans dated on the VAT period's first
 *     day, which carries only earlier periods.
 */
export type VoucherVatExclusion = VoucherMomsredovisningShape | 'opening_balance'

const DECLARATION_ACCOUNTS: ReadonlySet<string> = new Set(VAT_ACCOUNTS)
const NET_ACCOUNTS: ReadonlySet<string> = new Set(VAT_SETTLEMENT_NET_ACCOUNTS)

/**
 * The momsredovisning shape of a verifikat with these line accounts, or null
 * when it is an ordinary verifikat the rutor read. The shape_flags predicates
 * of vat_declaration_special_entries over one verifikat:
 *
 *   net_shape: a line on a declaration account AND a line on 2650/1650.
 *   tax_shape: a 26xx declaration line, a skattekonto line, no 2650/1650
 *     line, and nothing else but 26xx, the skattekonto and 3740.
 *
 * `taxAccounts` is skattekonto_shape_accounts for the company: 1630, plus
 * 2012 for an enskild firma. The shapes are disjoint on the 2650/1650 line.
 */
export function momsredovisningShapeOfLines(
  accounts: readonly string[],
  taxAccounts: readonly string[],
): VoucherMomsredovisningShape | null {
  const tax = new Set(taxAccounts)
  const netLine = accounts.some((a) => NET_ACCOUNTS.has(a))
  if (netLine) {
    return accounts.some((a) => DECLARATION_ACCOUNTS.has(a)) ? 'net_account_shape' : null
  }
  const momsDeclarationLine = accounts.some((a) => DECLARATION_ACCOUNTS.has(a) && isMomsAccount(a))
  const taxLine = accounts.some((a) => tax.has(a))
  const otherLine = accounts.some(
    (a) => !isMomsAccount(a) && !tax.has(a) && a !== ORE_ROUNDING_ACCOUNT,
  )
  return momsDeclarationLine && taxLine && !otherLine ? 'tax_account_shape' : null
}

type RutaKey = keyof VatDeclarationRutor

/**
 * How much each ruta moves when the declaration reads these lines, signed as
 * filed (ruta 49 positive = more moms att betala). Only the rutor that move;
 * an empty object when the voucher touches no ruta account.
 */
export function rutorChangeOfLines(
  lines: readonly VoucherImpactLine[],
  dynamicVatAccounts?: Pick<DynamicVatAccounts, 'mappingByAccount' | 'explicitAccounts'>,
): Partial<Record<RutaKey, number>> {
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const line of lines) {
    const t = totals.get(line.account_number) ?? { debit: 0, credit: 0 }
    t.debit = roundOre(t.debit + (Number(line.debit_amount) || 0))
    t.credit = roundOre(t.credit + (Number(line.credit_amount) || 0))
    totals.set(line.account_number, t)
  }

  const change: Partial<Record<RutaKey, number>> = {}
  for (const contribution of vatRutaContributions(totals, dynamicVatAccounts)) {
    change[contribution.box] = roundOre((change[contribution.box] ?? 0) + contribution.amount)
  }
  let net = 0
  for (const term of RUTA_49_TERMS) net += term.sign * (change[term.box] ?? 0)
  change.ruta49 = roundOre(net)

  const moved: Partial<Record<RutaKey, number>> = {}
  for (const [box, amount] of Object.entries(change) as Array<[RutaKey, number]>) {
    if (amount !== 0) moved[box] = amount
  }
  return moved
}

/** The VAT period a date falls in, in the (period_type, year, period) form gnubok_get_vat_report takes. */
export interface VoucherVatPeriod {
  type: MomsPeriod
  year: number
  period: number
  start: string
  end: string
  label: string
  /**
   * When the company has this period on record as filed (the momsdeklaration
   * filing record, ./filing-record-store.ts), the date it was filed;
   * null when it is not on record as filed.
   */
  filed_on: string | null
}

export interface VoucherVatDeclarationImpact {
  /**
   * `ok`: computed. `not_vat_registered`: the company files no
   * momsdeklaration. `unavailable`: a read failed; nothing is claimed.
   */
  status: 'ok' | 'not_vat_registered' | 'unavailable'
  /** Null when the company has no momsperiod set (or status is not ok). */
  vat_period: VoucherVatPeriod | null
  /**
   * false: the declaration leaves the voucher out and no ruta moves. null:
   * not decided until posting (an opening balance dated after the VAT
   * period's first day counts only when no other verifikat of the period is
   * dated before it), or status is not ok.
   */
  counted: boolean | null
  excluded_as: VoucherVatExclusion | null
  /** Ruta -> signed change as filed, only the rutor that move. Empty when counted is false. */
  rutor_change: Partial<Record<RutaKey, number>>
  /** The same in one Swedish sentence, for the approver. */
  summary: string
}

const RUTA_ORDER: readonly RutaKey[] = [
  'ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12',
  'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32',
  'ruta35', 'ruta36', 'ruta37', 'ruta38', 'ruta39', 'ruta40', 'ruta41', 'ruta42',
  'ruta48', 'ruta50', 'ruta60', 'ruta61', 'ruta62', 'ruta49',
]

function signedAmount(amount: number): string {
  const formatted = formatCurrency(Math.abs(amount))
  return amount < 0 ? `-${formatted}` : `+${formatted}`
}

function describeChange(change: Partial<Record<RutaKey, number>>): string {
  return RUTA_ORDER
    .filter((box) => change[box] !== undefined)
    .map((box) => `ruta ${box.slice(4)} ${signedAmount(change[box] as number)}`)
    .join(', ')
}

function inPeriod(period: VoucherVatPeriod | null): string {
  return period ? ` för ${period.label}` : ''
}

/** Said when the voucher moves a ruta of a period already filed. */
function filedNote(period: VoucherVatPeriod | null): string {
  return period?.filed_on
    ? ` Momsperioden är redan deklarerad (inlämnad ${period.filed_on}): ändringen når inte Skatteverket av sig själv.`
    : ''
}

/**
 * The impact itself, from what the async loader read. Pure, so every branch
 * is testable without a database.
 */
export function voucherVatDeclarationImpact(input: {
  lines: readonly VoucherImpactLine[]
  entryDate: string
  isOpeningBalance: boolean
  vatPeriod: VoucherVatPeriod | null
  taxAccounts: readonly string[]
  dynamicVatAccounts?: Pick<DynamicVatAccounts, 'mappingByAccount' | 'explicitAccounts'>
}): VoucherVatDeclarationImpact {
  const { lines, entryDate, isOpeningBalance, vatPeriod } = input
  const base = { status: 'ok' as const, vat_period: vatPeriod }

  // An opening balance is never a shape (the SQL keeps every IB chain member
  // out of them); it counts only when it is the period's first carrier.
  if (isOpeningBalance) {
    if (vatPeriod && entryDate <= vatPeriod.start) {
      return {
        ...base,
        counted: false,
        excluded_as: 'opening_balance',
        rutor_change: {},
        summary: `Ingår inte i momsdeklarationen${inPeriod(vatPeriod)}: en ingående balans på momsperiodens första dag bär bara tidigare perioder.`,
      }
    }
    const change = rutorChangeOfLines(lines, input.dynamicVatAccounts)
    return {
      ...base,
      counted: null,
      excluded_as: null,
      rutor_change: change,
      summary: Object.keys(change).length === 0
        ? 'Påverkar ingen ruta i momsdeklarationen.'
        : `En ingående balans inne i momsperioden räknas i momsdeklarationen${inPeriod(vatPeriod)} bara om inget annat verifikat i perioden är daterat före den. Räknas den: ${describeChange(change)}.${filedNote(vatPeriod)}`,
    }
  }

  const shape = momsredovisningShapeOfLines(lines.map((l) => l.account_number), input.taxAccounts)
  if (shape) {
    return {
      ...base,
      counted: false,
      excluded_as: shape,
      rutor_change: {},
      summary: shape === 'net_account_shape'
        ? `Ingår inte i momsdeklarationen${inPeriod(vatPeriod)}: verifikatet har en rad på ett momsdeklarationskonto och en på 2650/1650 och räknas därför som momsredovisning. Ingen ruta ändras.`
        : `Ingår inte i momsdeklarationen${inPeriod(vatPeriod)}: verifikatet flyttar bara moms mellan momskonton och skattekontot och räknas därför som momsredovisning. Ingen ruta ändras.`,
    }
  }

  const change = rutorChangeOfLines(lines, input.dynamicVatAccounts)
  return {
    ...base,
    counted: true,
    excluded_as: null,
    rutor_change: change,
    summary: Object.keys(change).length === 0
      ? 'Påverkar ingen ruta i momsdeklarationen.'
      : `Ändrar momsdeklarationen${inPeriod(vatPeriod)}: ${describeChange(change)}.${filedNote(vatPeriod)}`,
  }
}

/** The VAT period of `entryDate` for a company filing `momsPeriod`. */
async function vatPeriodOfDate(
  supabase: SupabaseClient,
  companyId: string,
  momsPeriod: MomsPeriod,
  entryDate: string,
  fiscalPeriodId: string | null,
): Promise<VoucherVatPeriod> {
  const year = Number(entryDate.slice(0, 4))
  const month = Number(entryDate.slice(5, 7))
  const period = momsPeriod === 'monthly' ? month : momsPeriod === 'quarterly' ? Math.ceil(month / 3) : 1
  // Helårsmoms is the räkenskapsår (resolvePeriodDates), named by the year it ends.
  const { start, end } = await resolvePeriodDates(
    supabase, companyId, momsPeriod, year, period, fiscalPeriodId ?? undefined,
  )
  const periodYear = momsPeriod === 'yearly' ? Number(end.slice(0, 4)) : year
  // A record declares its own range (a helårsmoms record spans its
  // räkenskapsår), so the one holding the date answers for any cadence.
  const filings = await listVatFilings(supabase, companyId)
  const filed = filings.find((f) => f.period_start <= entryDate && entryDate <= f.period_end)
  return {
    type: momsPeriod,
    year: periodYear,
    period,
    start,
    end,
    label: formatPeriodLabel(momsPeriod, periodYear, period),
    filed_on: filed?.filed_on ?? null,
  }
}

function isMomsPeriod(value: unknown): value is MomsPeriod {
  return value === 'monthly' || value === 'quarterly' || value === 'yearly'
}

/**
 * Read what the impact needs (the company's VAT settings and filing record,
 * its skattekonto accounts from the SQL that decides the shapes, its own
 * account classification) and compute it. Read-only, and it never throws: a failed
 * read answers `unavailable` so a staging tool stages either way, and says
 * so instead of claiming the voucher changes nothing.
 */
export async function previewVoucherVatDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  input: {
    entryDate: string
    fiscalPeriodId: string | null
    lines: readonly VoucherImpactLine[]
    isOpeningBalance: boolean
  },
): Promise<VoucherVatDeclarationImpact> {
  try {
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('vat_registered, moms_period')
      .eq('company_id', companyId)
      .maybeSingle()
    if (settingsError) throw new Error(settingsError.message)
    const row = (settings ?? null) as { vat_registered?: boolean | null; moms_period?: unknown } | null
    if (row?.vat_registered === false) {
      return {
        status: 'not_vat_registered',
        vat_period: null,
        counted: null,
        excluded_as: null,
        rutor_change: {},
        summary: 'Företaget är inte momsregistrerat: ingen momsdeklaration påverkas.',
      }
    }

    const [taxAccountsResult, dynamicVatAccounts, vatPeriod] = await Promise.all([
      supabase.rpc('skattekonto_shape_accounts', { p_company_id: companyId }),
      fetchDynamicVatAccounts(supabase, companyId),
      isMomsPeriod(row?.moms_period)
        ? vatPeriodOfDate(supabase, companyId, row.moms_period, input.entryDate, input.fiscalPeriodId)
        : Promise.resolve(null),
    ])
    if (taxAccountsResult.error) throw new Error(taxAccountsResult.error.message)
    const taxAccounts = taxAccountsResult.data
    if (!Array.isArray(taxAccounts) || !taxAccounts.every((a) => typeof a === 'string')) {
      throw new Error('skattekonto_shape_accounts returned no account list')
    }

    return voucherVatDeclarationImpact({
      lines: input.lines,
      entryDate: input.entryDate,
      isOpeningBalance: input.isOpeningBalance,
      vatPeriod,
      taxAccounts,
      dynamicVatAccounts,
    })
  } catch (err) {
    log.warn('voucher VAT impact unavailable', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      status: 'unavailable',
      vat_period: null,
      counted: null,
      excluded_as: null,
      rutor_change: {},
      summary: 'Momspåverkan kunde inte beräknas: kontrollera momsrapporten för perioden efter bokföring.',
    }
  }
}
