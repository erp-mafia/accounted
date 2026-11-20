/**
 * The K10 underlag for one delägare and one inkomstår, under the 3:12 rules
 * after SFS 2025:1361 (IL 57 kap.; figures in k10-parameters.ts). Pure: the
 * inputs come from the company's books and registers (k10.ts) and from what
 * the owner entered; every line names its figure and its source.
 *
 *   grundbelopp            = 4 IBB x the owner's shares / all shares, at the
 *                            start of the year (only in one company)
 *   lönebaserat utrymme    = 50 % x (owner's share x löneunderlag - 8 IBB),
 *                            at least 0, at most 50 x own cash pay
 *   ränta                  = (omkostnadsbelopp - 100 000) x (SLR + 9 pp),
 *                            at least 0
 *   årets gränsbelopp      = the three above
 *   gränsbelopp            = årets gränsbelopp + sparat utdelningsutrymme
 *                            (carried without uplift)
 *   utdelning within it    : 2/3 taxable in kapital (20 % effective)
 *   utdelning above it     : tjänst up to 90 IBB, kapital above that
 *   sparat utdelningsutrymme to next year = gränsbelopp - utdelning, at least 0
 *
 * We produce the underlag; the owner files K10 with their own declaration.
 */
import { roundOre } from '@/lib/money'
import {
  BASIC_AMOUNT_IBB,
  COST_BASIS_THRESHOLD,
  INTEREST_MARGIN_PP,
  OWN_PAY_CAP_MULTIPLE,
  PAYROLL_DEDUCTION_IBB,
  PAYROLL_SHARE,
  SERVICE_CEILING_IBB,
  type K10Parameters,
} from './k10-parameters'

export type K10FigureSource = 'register' | 'payroll' | 'ledger' | 'owner' | 'rule' | 'computed'

export interface K10Figure {
  amount: number
  source: K10FigureSource
  /** Where the figure comes from, in Swedish (e.g. "Lönekörningar 2025 i Accounted"). */
  detail_sv: string
}

export interface K10Input {
  params: K10Parameters
  /** The owner's shares at the start of the inkomstår. */
  shares_at_start: number
  /** Every share of the company at the start of the inkomstår. */
  total_shares_at_start: number
  /** The grundbelopp is used for shares in one company only. */
  uses_basic_amount: boolean
  /** Löneunderlag: cash pay in the year before the inkomstår. */
  payroll_base: K10Figure
  /** The owner's and närståendes own cash pay in the year before (the 50 times cap). */
  own_pay: K10Figure
  /** Omkostnadsbelopp of the shares held at the start of the year. */
  cost_basis: K10Figure
  /** Sparat utdelningsutrymme from the owner's K10 the year before. */
  saved_dividend_space: K10Figure
  /** Dividend the owner received in the inkomstår (betalningsdag in the year). */
  dividend: K10Figure
}

export const K10_LINE_KEYS = [
  'ownership_share',
  'basic_amount_company',
  'basic_amount',
  'payroll_base',
  'payroll_owner_share',
  'payroll_deduction',
  'wage_space_before_cap',
  'own_pay',
  'own_pay_cap',
  'wage_space',
  'cost_basis',
  'cost_basis_threshold',
  'interest_rate',
  'capital_interest',
  'annual_limit',
  'saved_space_brought_forward',
  'total_limit',
  'dividend',
  'dividend_within_limit',
  'dividend_capital_taxable',
  'dividend_service',
  'dividend_above_ceiling',
  'saved_space_carried_forward',
] as const
export type K10LineKey = (typeof K10_LINE_KEYS)[number]

export interface K10Line {
  key: K10LineKey
  label_sv: string
  /** Kronor to the öre, or percent for ownership_share and interest_rate. */
  amount: number
  unit: 'sek' | 'percent'
  source: K10FigureSource
  detail_sv: string
}

export interface K10Result {
  lines: K10Line[]
  basic_amount: number
  wage_space: number
  capital_interest: number
  annual_limit: number
  total_limit: number
  dividend: number
  dividend_within_limit: number
  dividend_service: number
  dividend_above_ceiling: number
  saved_space_carried_forward: number
}

function kr(n: number): string {
  return new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(n).replace(/\u00a0/g, ' ')
}

/** The K10 underlag for one owner. */
export function computeK10(input: K10Input): K10Result {
  const p = input.params
  const prior = p.income_year - 1
  const share = input.total_shares_at_start > 0 ? input.shares_at_start / input.total_shares_at_start : 0
  const sharePct = roundOre(share * 100)

  const basicCompany = BASIC_AMOUNT_IBB * p.ibb_prior_year
  const basic = input.uses_basic_amount ? roundOre(basicCompany * share) : 0

  const payrollBase = roundOre(Math.max(0, input.payroll_base.amount))
  const payrollOwnerShare = roundOre(payrollBase * share)
  const deduction = PAYROLL_DEDUCTION_IBB * p.ibb_prior_year
  const beforeCap = roundOre(Math.max(0, PAYROLL_SHARE * (payrollOwnerShare - deduction)))
  const ownPay = roundOre(Math.max(0, input.own_pay.amount))
  const cap = roundOre(OWN_PAY_CAP_MULTIPLE * ownPay)
  const wageSpace = Math.min(beforeCap, cap)

  const costBasis = roundOre(Math.max(0, input.cost_basis.amount))
  const ratePct = roundOre(p.slr_percent + INTEREST_MARGIN_PP)
  const interest = roundOre(Math.max(0, costBasis - COST_BASIS_THRESHOLD) * (ratePct / 100))

  const annual = roundOre(basic + wageSpace + interest)
  const saved = roundOre(Math.max(0, input.saved_dividend_space.amount))
  const total = roundOre(annual + saved)

  const dividend = roundOre(Math.max(0, input.dividend.amount))
  const within = Math.min(dividend, total)
  const capitalTaxable = roundOre((within * 2) / 3)
  const above = roundOre(dividend - within)
  const ceiling = SERVICE_CEILING_IBB * p.ibb_income_year
  const service = Math.min(above, ceiling)
  const aboveCeiling = roundOre(above - service)
  const carried = roundOre(Math.max(0, total - dividend))

  const line = (key: K10LineKey, label_sv: string, amount: number, source: K10FigureSource, detail_sv: string, unit: 'sek' | 'percent' = 'sek'): K10Line => ({
    key,
    label_sv,
    amount,
    unit,
    source,
    detail_sv,
  })

  const lines: K10Line[] = [
    line('ownership_share', 'Ägarandel vid årets ingång', sharePct, 'register', `${kr(input.shares_at_start)} av ${kr(input.total_shares_at_start)} aktier enligt aktieboken ${prior}-12-31`, 'percent'),
    line('basic_amount_company', 'Grundbelopp för bolaget', basicCompany, 'rule', `4 inkomstbasbelopp ${prior} (4 x ${kr(p.ibb_prior_year)} kr)`),
    line(
      'basic_amount',
      'Grundbelopp för dina aktier',
      basic,
      input.uses_basic_amount ? 'computed' : 'owner',
      input.uses_basic_amount ? 'Grundbeloppet fördelat efter antal aktier' : 'Grundbeloppet används i ett annat bolag (ditt val)',
    ),
    line('payroll_base', `Löneunderlag (kontant lön ${prior})`, payrollBase, input.payroll_base.source, input.payroll_base.detail_sv),
    line('payroll_owner_share', 'Din andel av löneunderlaget', payrollOwnerShare, 'computed', `Löneunderlaget x ägarandelen ${kr(sharePct)} %`),
    line('payroll_deduction', 'Avdrag 8 inkomstbasbelopp', deduction, 'rule', `8 x ${kr(p.ibb_prior_year)} kr (inkomstbasbelopp ${prior})`),
    line('wage_space_before_cap', 'Lönebaserat utrymme före spärr', beforeCap, 'computed', '50 % av andelen över avdraget'),
    line('own_pay', `Egen kontant lön ${prior} (du och närstående)`, ownPay, input.own_pay.source, input.own_pay.detail_sv),
    line('own_pay_cap', 'Spärr: 50 gånger egen lön', cap, 'computed', '50 x egen kontant lön'),
    line('wage_space', 'Lönebaserat utrymme', wageSpace, 'computed', 'Det lägsta av utrymmet och spärren'),
    line('cost_basis', 'Omkostnadsbelopp vid årets ingång', costBasis, input.cost_basis.source, input.cost_basis.detail_sv),
    line('cost_basis_threshold', 'Avdrag från omkostnadsbeloppet', COST_BASIS_THRESHOLD, 'rule', 'Räntan beräknas på belopp över 100 000 kr'),
    line('interest_rate', 'Räntesats', ratePct, 'rule', `Statslåneräntan 30 november ${prior} (${kr(p.slr_percent)} %) plus 9 procentenheter`, 'percent'),
    line('capital_interest', 'Ränta på omkostnadsbeloppet', interest, 'computed', '(Omkostnadsbelopp - 100 000 kr) x räntesatsen'),
    line('annual_limit', `Årets gränsbelopp ${p.income_year}`, annual, 'computed', 'Grundbelopp + lönebaserat utrymme + ränta'),
    line('saved_space_brought_forward', 'Sparat utdelningsutrymme från föregående år', saved, input.saved_dividend_space.source, input.saved_dividend_space.detail_sv),
    line('total_limit', 'Gränsbelopp', total, 'computed', 'Årets gränsbelopp + sparat utdelningsutrymme (räknas inte upp)'),
    line('dividend', `Utdelning ${p.income_year}`, dividend, input.dividend.source, input.dividend.detail_sv),
    line('dividend_within_limit', 'Utdelning inom gränsbeloppet', within, 'computed', 'Beskattas i inkomstslaget kapital'),
    line('dividend_capital_taxable', 'Skattepliktig del i kapital (2/3)', capitalTaxable, 'computed', 'Två tredjedelar av utdelningen inom gränsbeloppet'),
    line('dividend_service', 'Utdelning över gränsbeloppet, tjänst', service, 'computed', `Beskattas som tjänst, högst 90 inkomstbasbelopp ${p.income_year} (${kr(ceiling)} kr)`),
    line('dividend_above_ceiling', 'Utdelning över takbeloppet, kapital', aboveCeiling, 'computed', 'Beskattas i inkomstslaget kapital'),
    line('saved_space_carried_forward', `Sparat utdelningsutrymme till ${p.income_year + 1}`, carried, 'computed', 'Gränsbelopp - utdelning'),
  ]

  return {
    lines,
    basic_amount: basic,
    wage_space: wageSpace,
    capital_interest: interest,
    annual_limit: annual,
    total_limit: total,
    dividend,
    dividend_within_limit: within,
    dividend_service: service,
    dividend_above_ceiling: aboveCeiling,
    saved_space_carried_forward: carried,
  }
}
