/**
 * The proposal preview shows the verifikat the booking posts.
 *
 * The browser used to compute proposal lines with its own copy of the
 * mapping builders (proposal-lines.ts computeProposalLines), and every
 * booking fix had to land twice. The preview now runs the builders the
 * booking posts with; these are the cases that copy was pinned by, asserted
 * on the engine path in the shape the review shows (sides, amounts, the
 * money leg flagged), and the preview checked against the categorize dry run
 * line for line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { buildMappingResultFromCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { buildMappingResultFromTemplate, getTemplateById, type BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { reconcileRcBasisWithCostLines } from '@/lib/bookkeeping/rc-basis-reconcile'
import { chartVatTreatmentsOf, type ChartVatTreatments } from '@/lib/bookkeeping/vat-entries'
import { roundOre } from '@/lib/money'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import type { LinePatternEntry, MappingResult, Transaction, TransactionCategory, VatTreatment } from '@/types'

vi.mock('@/lib/transactions/booking-duplicate-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }) }))
vi.mock('@/lib/transactions/invoice-match-suggestion', () => ({
  findInvoiceMatchSuggestion: vi.fn().mockResolvedValue(null),
}))

import { previewProposalLines, toProposalLines, type ProposalPreviewRequest } from '../proposal-preview'
import { categorizeTransaction, type CategorizeInput } from '@/lib/transactions/categorize-core'

/** The company's momskoder: account -> momskod, or [momskod, momssats]. */
function chartOf(codes: Record<string, string | [string, number]> = {}): ChartVatTreatments {
  return chartVatTreatmentsOf(Object.entries(codes).map(([account_number, code]) => ({
    account_number,
    default_vat_treatment: Array.isArray(code) ? code[0] : code,
    default_vat_rate: Array.isArray(code) ? code[1] : null,
  })))
}

const sek = (amount: number, over: Partial<Transaction> = {}) =>
  makeTransaction({ amount, amount_sek: amount, currency: 'SEK', exchange_rate: 1, ...over })

/** The lines the review shows for a mapping: the booking's own assembly, the basis settled with the chart. */
function shown(tx: Transaction, mapping: MappingResult, chart: ChartVatTreatments = chartOf()): ProposalLine[] {
  return toProposalLines(tx, buildTransactionEntryLines(tx, reconcileRcBasisWithCostLines(mapping, chart)))
}

type Row = [ProposalLine['side'], string, number, ('s' | '')?]
const shape = (lines: ProposalLine[]) =>
  lines.map((l) => `${l.side}:${l.account}:${l.amount}${l.settlement ? ':s' : ''}`).sort()
const rows = (expected: Row[]) => expected.map(([side, account, amount, s]) => `${side}:${account}:${amount}${s ? ':s' : ''}`).sort()
const sum = (lines: ProposalLine[], side: ProposalLine['side']) =>
  roundOre(lines.filter((l) => l.side === side).reduce((acc, l) => acc + l.amount, 0))

function expectBalanced(lines: ProposalLine[]) {
  expect(sum(lines, 'debet')).toBe(sum(lines, 'kredit'))
}

/** A catalog-shaped template of one pair, for the template builder. */
function pair(over: Partial<BookingTemplate> & Pick<BookingTemplate, 'debit_account' | 'credit_account'>): BookingTemplate {
  return {
    ...getTemplateById('it_saas_eu')!,
    id: 'pair',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account_ab: undefined,
    credit_account_ab: undefined,
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    default_private: false,
    ...over,
  }
}

const learned = (over: Parameters<typeof makeCategorizationTemplate>[0]) => ({
  template: makeCategorizationTemplate(over),
  matchMethod: 'exact_alias' as const,
  confidence: 0.9,
})

describe('the review shows the money leg the booking posts', () => {
  const categories = ['income_services', 'income_products', 'income_other', 'expense_software', 'expense_bank_fees', 'private'] as const
  const treatments = [undefined, 'standard_25', 'reduced_12', 'reduced_6', 'exempt', 'export', 'reverse_charge'] as const
  const amounts = [-125, 125, -102.06, 102.06, -0.07, 0.07]

  it('flags exactly the bank leg, on the side the money moved, balanced, for every category, treatment and direction', () => {
    for (const category of categories) for (const vatTreatment of treatments) for (const amount of amounts) {
      const tx = sek(amount)
      const mapping = buildMappingResultFromCategory(category as TransactionCategory, tx, category !== 'private', 'enskild_firma', vatTreatment as VatTreatment | undefined)
      const lines = shown(tx, mapping)
      const label = `${category} ${vatTreatment} ${amount}`
      const settlement = lines.filter((l) => l.settlement)
      expect(settlement, label).toEqual([{ side: amount < 0 ? 'kredit' : 'debet', account: '1930', amount: Math.abs(amount), settlement: true }])
      expectBalanced(lines)
    }
  })
})

describe('category bookings', () => {
  it('books an expense with its moms out of the gross, the bank leg the settlement', () => {
    const tx = sek(-123.45)
    expect(shape(shown(tx, buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'standard_25')))).toEqual(rows([
      ['debet', '5420', 98.76], ['debet', '2641', 24.69], ['kredit', '1930', 123.45, 's'],
    ]))
  })

  it('books income with utgående moms and the bank debited', () => {
    const tx = sek(106)
    expect(shape(shown(tx, buildMappingResultFromCategory('income_services', tx, true, 'enskild_firma', 'reduced_6')))).toEqual(rows([
      ['debet', '1930', 106, 's'], ['kredit', '2631', 6], ['kredit', '3003', 100],
    ]))
  })

  it('books a foreign row in kronor', () => {
    const tx = makeTransaction({ amount: -100, currency: 'EUR', amount_sek: -1150, exchange_rate: 11.5 })
    const lines = shown(tx, buildMappingResultFromCategory('expense_other', tx, true, 'enskild_firma', 'standard_25'))
    expect(lines.find((l) => l.settlement)).toEqual({ side: 'kredit', account: '1930', amount: 1150, settlement: true })
    expect(sum(lines, 'debet')).toBe(1150)
  })

  it('books the whole reverse-charge set, the basis pair on the chosen kind', () => {
    const tx = sek(-1000)
    expect(shape(shown(tx, buildMappingResultFromCategory('expense_software', tx, true, 'aktiebolag', 'reverse_charge')))).toEqual(rows([
      ['debet', '5420', 1000], ['kredit', '1930', 1000, 's'], ['debet', '2645', 250], ['kredit', '2614', 250],
      ['debet', '4535', 1000], ['kredit', '4598', 1000],
    ]))
    const nonEu = shown(tx, buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'reverse_charge', null, undefined, 'non_eu_services'))
    expect(nonEu).toContainEqual({ side: 'debet', account: '4531', amount: 1000 })
  })

  it('balances 12 % amounts whose moms is an exact half öre (net by subtraction)', () => {
    const tx = sek(-102.06)
    const lines = shown(tx, buildMappingResultFromCategory('expense_representation', tx, true, 'enskild_firma'))
    expect(shape(lines)).toEqual(rows([['debet', '6071', 91.12], ['debet', '2641', 10.94], ['kredit', '1930', 102.06, 's']]))
  })

  it('books a refund to a customer with the revenue and utgående moms debited', () => {
    const tx = sek(-125)
    expect(shape(shown(tx, buildMappingResultFromCategory('income_services', tx, true, 'enskild_firma', 'standard_25')))).toEqual(rows([
      ['debet', '3001', 100], ['debet', '2611', 25], ['kredit', '1930', 125, 's'],
    ]))
  })

  it('self-assesses nothing on the refund of a sale to an EU business', () => {
    const tx = sek(-125)
    expect(shape(shown(tx, buildMappingResultFromCategory('income_services', tx, true, 'enskild_firma', 'reverse_charge')))).toEqual(rows([
      ['debet', '3308', 125], ['kredit', '1930', 125, 's'],
    ]))
  })
})

describe('catalog templates', () => {
  it('books an expense pair with its moms out of the gross', () => {
    const tx = sek(-125)
    expect(shape(shown(tx, buildMappingResultFromTemplate(pair({ debit_account: '6212', credit_account: '1930', vat_treatment: 'standard_25', vat_rate: 0.25 }), tx, 'enskild_firma')))).toEqual(rows([
      ['debet', '6212', 100], ['debet', '2641', 25], ['kredit', '1930', 125, 's'],
    ]))
  })

  it('books income with the rate-mapped utgående moms account', () => {
    const tx = sek(112)
    const template = pair({ direction: 'income', debit_account: '1930', credit_account: '3002', vat_treatment: 'reduced_12', vat_rate: 0.12 })
    expect(shape(shown(tx, buildMappingResultFromTemplate(template, tx, 'enskild_firma')))).toEqual(rows([
      ['debet', '1930', 112, 's'], ['kredit', '3002', 100], ['kredit', '2621', 12],
    ]))
  })

  it('books the full reverse-charge verifikat, and no basis pair on a basis account', () => {
    const tx = sek(-1000)
    const rc = (debit_account: string) =>
      pair({ debit_account, credit_account: '1930', vat_treatment: 'reverse_charge', reverse_charge_supplier_type: 'eu_business' })
    const lines = shown(tx, buildMappingResultFromTemplate(rc('6540'), tx, 'enskild_firma'))
    expect(shape(lines)).toEqual(rows([
      ['debet', '6540', 1000], ['kredit', '1930', 1000, 's'], ['debet', '2645', 250], ['kredit', '2614', 250],
      ['debet', '4535', 1000], ['kredit', '4598', 1000],
    ]))
    expectBalanced(lines)
    expect(shown(tx, buildMappingResultFromTemplate(rc('4535'), tx, 'enskild_firma')).map((l) => l.account).sort()).toEqual(['1930', '2614', '2645', '4535'])
  })

  it('rounds fiktiv moms the way the booking does on an exact-half figure', () => {
    const tx = sek(-8.62)
    const lines = shown(tx, buildMappingResultFromTemplate(pair({ debit_account: '6540', credit_account: '1930', vat_treatment: 'reverse_charge' }), tx, 'enskild_firma'))
    const fiktiv = lines.find((l) => l.account === '2645')?.amount
    expect(lines.find((l) => l.account === '2614')?.amount).toBe(fiktiv)
    expect([2.15, 2.16]).toContain(fiktiv)
    expectBalanced(lines)
  })

  it('balances 12 % template amounts by net-by-subtraction', () => {
    const tx = sek(-100.94)
    expect(shape(shown(tx, buildMappingResultFromTemplate(pair({ debit_account: '5831', credit_account: '1930', vat_treatment: 'reduced_12', vat_rate: 0.12 }), tx, 'enskild_firma')))).toEqual(rows([
      ['debet', '5831', 90.12], ['debet', '2641', 10.82], ['kredit', '1930', 100.94, 's'],
    ]))
  })
})

describe('learned counterparty pairs', () => {
  it('books both reverse-charge pairs on a purchase and mirrors them on a refund', () => {
    const rc = learned({ debit_account: '6540', credit_account: '1930', vat_treatment: 'reverse_charge' })
    const purchase = sek(-12500)
    expect(shape(shown(purchase, buildMappingResultFromCounterpartyTemplate(rc, purchase, 'enskild_firma')))).toEqual(rows([
      ['debet', '6540', 12500], ['kredit', '1930', 12500, 's'], ['debet', '2645', 3125], ['kredit', '2614', 3125],
      ['debet', '4535', 12500], ['kredit', '4598', 12500],
    ]))
    const refund = sek(1000)
    expect(shape(shown(refund, buildMappingResultFromCounterpartyTemplate(rc, refund, 'aktiebolag')))).toEqual(rows([
      ['debet', '1930', 1000, 's'], ['kredit', '6540', 1000], ['kredit', '2645', 250], ['debet', '2614', 250],
      ['kredit', '4535', 1000], ['debet', '4598', 1000],
    ]))
  })

  it('takes ingående moms from the learned treatment on an expense pair, and mirrors it on a refund', () => {
    const vat = learned({ debit_account: '6212', credit_account: '1930', vat_treatment: 'standard_25' })
    const out = sek(-125)
    expect(shape(shown(out, buildMappingResultFromCounterpartyTemplate(vat, out, 'enskild_firma')))).toEqual(rows([
      ['debet', '6212', 100], ['debet', '2641', 25], ['kredit', '1930', 125, 's'],
    ]))
    const back = sek(125)
    const refund = shown(back, buildMappingResultFromCounterpartyTemplate(vat, back, 'enskild_firma'))
    expect(shape(refund)).toEqual(rows([['debet', '1930', 125, 's'], ['kredit', '6212', 100], ['kredit', '2641', 25]]))
    expectBalanced(refund)
  })

  it('books an income-learned pair gross, both ways', () => {
    const income = learned({ debit_account: '1930', credit_account: '3001', vat_treatment: 'standard_25' })
    const sale = sek(1250)
    expect(shape(shown(sale, buildMappingResultFromCounterpartyTemplate(income, sale, 'enskild_firma')))).toEqual(rows([
      ['debet', '1930', 1250, 's'], ['kredit', '3001', 1250],
    ]))
    const repayment = sek(-500)
    expect(shape(shown(repayment, buildMappingResultFromCounterpartyTemplate(income, repayment, 'enskild_firma')))).toEqual(rows([
      ['debet', '3001', 500], ['kredit', '1930', 500, 's'],
    ]))
  })
})

describe('learned line patterns', () => {
  const vatPattern: LinePatternEntry[] = [
    { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
    { account: '6212', type: 'business', side: 'debit', ratio: 1 },
  ]
  const incomePattern: LinePatternEntry[] = [
    { account: '2611', type: 'vat', side: 'credit', vat_rate: 0.25 },
    { account: '3001', type: 'business', side: 'credit', ratio: 1 },
  ]
  const of = (line_pattern: LinePatternEntry[], debit_account = '6212', credit_account = '1930') =>
    learned({ debit_account, credit_account, line_pattern })

  it('books the settlement, the moms and the business lines, and mirrors them on a refund', () => {
    const out = sek(-1000)
    expect(shape(shown(out, buildMappingResultFromCounterpartyTemplate(of(vatPattern), out, 'enskild_firma')))).toEqual(rows([
      ['kredit', '1930', 1000, 's'], ['debet', '2641', 200], ['debet', '6212', 800],
    ]))
    const back = sek(1000)
    const refund = shown(back, buildMappingResultFromCounterpartyTemplate(of(vatPattern), back, 'enskild_firma'))
    expect(shape(refund)).toEqual(rows([['debet', '1930', 1000, 's'], ['kredit', '2641', 200], ['kredit', '6212', 800]]))
    expectBalanced(refund)
    const sale = sek(1250)
    expect(shape(shown(sale, buildMappingResultFromCounterpartyTemplate(of(incomePattern, '1930', '3001'), sale, 'enskild_firma')))).toEqual(rows([
      ['debet', '1930', 1250, 's'], ['kredit', '2611', 250], ['kredit', '3001', 1000],
    ]))
  })

  it('settles on the learned money account: 2440 on a purchase, 1510 on a sale, swapped on a refund', () => {
    const purchase = sek(-1250)
    expect(shown(purchase, buildMappingResultFromCounterpartyTemplate(of(vatPattern, '4010', '2440'), purchase, 'enskild_firma')).find((l) => l.settlement))
      .toEqual({ side: 'kredit', account: '2440', amount: 1250, settlement: true })
    const sale = sek(1250)
    expect(shown(sale, buildMappingResultFromCounterpartyTemplate(of(incomePattern, '1510', '3001'), sale, 'enskild_firma')).find((l) => l.settlement))
      .toEqual({ side: 'debet', account: '1510', amount: 1250, settlement: true })
    const refund = sek(1000)
    expect(shown(refund, buildMappingResultFromCounterpartyTemplate(of(vatPattern, '4010', '2440'), refund, 'enskild_firma')).find((l) => l.settlement))
      .toEqual({ side: 'debet', account: '2440', amount: 1000, settlement: true })
  })

  it('books the öre difference on 3740: on the business side under-allocated, opposite over-allocated, mirrored on a refund (#1898)', () => {
    const thirds = (ratio: number): LinePatternEntry[] => ['6110', '6212', '6991'].map((account) => ({ account, type: 'business', side: 'debit', ratio }))
    const under = sek(-100)
    expect(shown(under, buildMappingResultFromCounterpartyTemplate(of(thirds(0.333)), under, 'enskild_firma'))).toContainEqual({ side: 'debet', account: '3740', amount: 0.1 })
    const over = shown(under, buildMappingResultFromCounterpartyTemplate(of(thirds(0.3334)), under, 'enskild_firma'))
    expect(over).toContainEqual({ side: 'kredit', account: '3740', amount: 0.02 })
    expect(sum(over, 'debet')).toBe(100.02)
    const back = sek(100)
    const mirrored = shown(back, buildMappingResultFromCounterpartyTemplate(of(thirds(0.3334)), back, 'enskild_firma'))
    expect(mirrored).toContainEqual({ side: 'kredit', account: '6110', amount: 33.34 })
    expect(mirrored).toContainEqual({ side: 'debet', account: '3740', amount: 0.02 })
    expectBalanced(mirrored)
  })

  it('balances a 50/50 pattern on every amount 0.01 to 50.00 kr (#1898)', () => {
    const half: LinePatternEntry[] = [
      { account: '6110', type: 'business', side: 'debit', ratio: 0.5 },
      { account: '6212', type: 'business', side: 'debit', ratio: 0.5 },
    ]
    const odd = sek(-100.03)
    const lines = shown(odd, buildMappingResultFromCounterpartyTemplate(of(half, '6110'), odd, 'enskild_firma'))
    expect(lines).toContainEqual({ side: 'debet', account: '6110', amount: 50.02 })
    expect(lines).toContainEqual({ side: 'kredit', account: '3740', amount: 0.01 })
    for (let ore = 1; ore <= 5000; ore++) {
      const tx = sek(-(ore / 100))
      expectBalanced(shown(tx, buildMappingResultFromCounterpartyTemplate(of(half, '6110'), tx, 'enskild_firma')))
    }
  })

  it('books a learned reverse-charge basis pair balanced, and ignores a stray ratio on a moms entry', () => {
    const basis: LinePatternEntry[] = [
      { account: '4531', type: 'business', side: 'debit', ratio: 0.3334 },
      { account: '4598', type: 'business', side: 'credit', ratio: 0.3333 },
      { account: '5420', type: 'business', side: 'debit', ratio: 0.3333 },
    ]
    for (const amount of [-250, -0.01, -99.99, -1234.56, 250, 0.03]) {
      const tx = sek(amount)
      expectBalanced(shown(tx, buildMappingResultFromCounterpartyTemplate(of(basis, '5420'), tx, 'enskild_firma')))
    }
    const tx = sek(-250)
    expect(shape(shown(tx, buildMappingResultFromCounterpartyTemplate(of(basis, '5420'), tx, 'enskild_firma')))).toEqual(rows([
      ['kredit', '1930', 250, 's'], ['debet', '5420', 250], ['debet', '2645', 62.5], ['kredit', '2614', 62.5],
      ['debet', '4531', 250], ['kredit', '4598', 250],
    ]))
    const stray: LinePatternEntry[] = [
      { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25, ratio: 0.5 },
      { account: '6212', type: 'business', side: 'debit', ratio: 1 },
    ]
    const out = sek(-1000)
    expect(shown(out, buildMappingResultFromCounterpartyTemplate(of(stray), out, 'enskild_firma')).map((l) => l.account).sort()).toEqual(['1930', '2641', '6212'])
  })
})

// crm#1096: a cost account the company gave a reverse-charge momskod reports
// ruta 20-24 itself, at its momssats; the booking settles the set with the chart.
describe('company momskoder', () => {
  const purchase = () => sek(-1000)

  it('books no basis pair on an account that reports it, at the account’s momssats', () => {
    const tx = purchase()
    const onConfigured = buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'reverse_charge')
    onConfigured.debit_account = '6540'
    expect(shown(tx, onConfigured, chartOf({ '6540': 'reverse_charge_eu_services' })).map((l) => l.account)).not.toContain('4598')
    const atTwelve = buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'reverse_charge')
    atTwelve.debit_account = '4057'
    expect(shape(shown(tx, atTwelve, chartOf({ '4057': ['reverse_charge_eu_goods', 0.12] })))).toEqual(rows([
      ['kredit', '1930', 1000, 's'], ['kredit', '2624', 120], ['debet', '2645', 120], ['debet', '4057', 1000],
    ]))
  })

  it('settles a catalog template and a learned pair with the chart, and keeps the pair without it', () => {
    const tx = purchase()
    const saas = buildMappingResultFromTemplate(getTemplateById('it_saas_eu')!, tx, 'enskild_firma')
    expect(shown(tx, saas, chartOf({ '5420': 'reverse_charge_eu_services' })).map((l) => l.account).sort()).toEqual(['1930', '2614', '2645', '5420'])
    expect(shown(tx, saas).map((l) => l.account)).toContain('4598')
    const goods = learned({ debit_account: '4056', credit_account: '1930', vat_treatment: 'reverse_charge' })
    for (const amount of [-1000, 1000]) {
      const row = sek(amount)
      expect(shown(row, buildMappingResultFromCounterpartyTemplate(goods, row, 'aktiebolag'), chartOf({ '4056': 'reverse_charge_eu_goods' })).map((l) => l.account)).not.toContain('4535')
    }
  })

  it('shrinks a learned pattern’s pair by the cost lines that report the basis, re-rating them', () => {
    const linePattern: LinePatternEntry[] = [
      { account: '4531', type: 'business', side: 'debit', ratio: 0.5 },
      { account: '4598', type: 'business', side: 'credit', ratio: 0.5 },
      { account: '5420', type: 'business', side: 'debit', ratio: 0.25 },
      { account: '6540', type: 'business', side: 'debit', ratio: 0.25 },
    ]
    const tx = purchase()
    const mapping = () => buildMappingResultFromCounterpartyTemplate(learned({ debit_account: '5420', credit_account: '1930', vat_treatment: null, line_pattern: linePattern }), tx, 'aktiebolag')
    expect(shown(tx, mapping(), chartOf({ '6540': 'reverse_charge_non_eu_services' })).find((l) => l.account === '4531')?.amount).toBe(500)
    const atSix = shown(tx, mapping(), chartOf({ '6540': ['reverse_charge_non_eu_services', 0.06] }))
    expect(atSix.find((l) => l.account === '2634')?.amount).toBe(30)
    expectBalanced(atSix)
  })
})

// ── previewProposalLines against the booking ──────────────────────────

const COMPANY_ID = 'company-1'
const TX_ID = '6f1c2b8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log } as never

const row = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  company_id: COMPANY_ID,
  date: '2026-05-12',
  amount: -1250,
  currency: 'SEK',
  amount_sek: -1250,
  exchange_rate: 1,
  description: 'KONTORSBOLAGET',
  merchant_name: 'Kontorsbolaget',
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  transaction_voucher_links: [],
  ...over,
})

function ledger(tables: Parameters<typeof createTableMockSupabase>[0] = {}, txRow = row()) {
  return createTableMockSupabase({
    transactions: { data: txRow, error: null },
    company_settings: { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1, vat_registered: true }, error: null },
    cash_accounts: { data: [], error: null },
    chart_of_accounts: { data: [], error: null },
    ...tables,
  })
}

async function previewOf(booking: CategorizeInput, tables?: Parameters<typeof ledger>[0], txRow?: ReturnType<typeof row>) {
  return previewProposalLines({ supabase: ledger(tables, txRow).supabase as never, companyId: COMPANY_ID, log }, { transaction_id: TX_ID, booking })
}

async function dryRunOf(booking: CategorizeInput, tables?: Parameters<typeof ledger>[0], txRow?: ReturnType<typeof row>) {
  const outcome = await categorizeTransaction(ledger(tables, txRow).supabase as never, 'user-1', COMPANY_ID, TX_ID, booking, {
    onBooked: 'refuse',
    dryRun: true,
  })
  if (!outcome.ok || !outcome.dryRun) throw new Error(`dry run refused: ${outcome.ok ? 'booked' : outcome.code}`)
  return toProposalLines(outcome.preview.transaction, outcome.preview.lines)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('previewProposalLines for a bank row: the categorize dry run, line for line', () => {
  const activeAccount = (account_number: string, account_class: number) => ({
    chart_of_accounts: { data: { account_number, account_class, is_active: true }, error: null },
  })

  it.each<[string, CategorizeInput, Parameters<typeof ledger>[0]?]>([
    ['a category with its moms', { is_business: true, category: 'expense_software', vat_treatment: 'standard_25' }],
    ['a catalog template', { is_business: true, category: 'expense_software', template_id: 'it_saas_eu' }],
    ['the underlag’s moms over the rate', { is_business: true, category: 'expense_representation', vat_treatment: 'reduced_12', vat_amount: 120 }],
    ['an account the person picked', { is_business: true, category: 'expense_other', account_override: '6540', vat_treatment: 'standard_25' }, activeAccount('6540', 6)],
    ['a private marking', { is_business: false }],
  ])('%s', async (_label, booking, tables) => {
    const preview = await previewOf(booking, tables)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.lines.length).toBeGreaterThanOrEqual(2)
    expect(preview.lines.filter((l) => l.settlement)).toHaveLength(1)
    expect(preview.lines).toEqual(await dryRunOf(booking, tables))
    expectBalanced(preview.lines)
  })

  it('books the underlag’s moms instead of the rate’s, the net absorbing the difference', async () => {
    const preview = await previewOf(
      { is_business: true, category: 'expense_representation', vat_treatment: 'reduced_12', vat_amount: 73.17 },
      undefined,
      row({ amount: -546, amount_sek: -546 }),
    )
    expect(preview.ok && preview.lines).toEqual(expect.arrayContaining([
      { side: 'debet', account: '2641', amount: 73.17 },
      { side: 'debet', account: expect.any(String), amount: 472.83 },
      { side: 'kredit', account: '1930', amount: 546, settlement: true },
    ]))
  })

  it('places an account the chart has inactive, as the review activates it on booking; the booking refuses it until then', async () => {
    const booking: CategorizeInput = { is_business: true, category: 'expense_other', account_override: '6541', vat_treatment: 'standard_25' }
    const inactive = { chart_of_accounts: { data: { account_number: '6541', account_class: 6, is_active: false }, error: null } }
    const preview = await previewOf(booking, inactive)
    expect(preview.ok && preview.lines.find((l) => l.side === 'debet' && !l.account.startsWith('26'))?.account).toBe('6541')
    const dryRun = await categorizeTransaction(ledger(inactive).supabase as never, 'user-1', COMPANY_ID, TX_ID, booking, { onBooked: 'refuse', dryRun: true })
    expect(dryRun).toMatchObject({ ok: false, code: 'TX_CATEGORIZE_INVALID_ACCOUNT' })
  })

  it('places an account the chart lacks, dropping moms on a balance-sheet account as the booking does', async () => {
    const preview = await previewOf({ is_business: true, category: 'expense_other', account_override: '2893', vat_treatment: 'standard_25' }, {
      chart_of_accounts: { data: null, error: null },
    })
    expect(preview.ok && shape(preview.lines)).toEqual(rows([['debet', '2893', 1250], ['kredit', '1930', 1250, 's']]))
  })

  it('answers the booking’s refusals: an unknown row, an underlag moms above the maximum, a foreign row without kronor', async () => {
    expect(await previewOf({ is_business: true, category: 'expense_other' }, { transactions: { data: null, error: null } }))
      .toMatchObject({ ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' })
    expect(await previewOf({ is_business: true, category: 'expense_representation', vat_treatment: 'reduced_12', vat_amount: 600 }))
      .toMatchObject({ ok: false, code: 'TX_CATEGORIZE_INVALID_VAT_AMOUNT' })
    expect(await previewOf({ is_business: true, category: 'expense_other' }, undefined, row({ currency: 'EUR', amount: -100, amount_sek: null, exchange_rate: null })))
      .toMatchObject({ ok: false, code: 'TX_MISSING_SEK_VALUE' })
  })
})

describe('previewProposalLines for a typed total', () => {
  const totalOf = (request: Exclude<ProposalPreviewRequest, { transaction_id: string }>, tables?: Parameters<typeof ledger>[0]) =>
    previewProposalLines({ supabase: ledger(tables).supabase as never, companyId: COMPANY_ID, log }, request)

  it('books an expense template with its moms out of the total, an income template as money in, a transfer as its two legs', async () => {
    const travel = await totalOf({ amount: 376, template_id: 'travel_transport' })
    expect(travel.ok && shape(travel.lines)).toEqual(rows([['debet', '5810', 354.72], ['debet', '2641', 21.28], ['kredit', '1930', 376, 's']]))
    const sale = await totalOf({ amount: 1250, template_id: 'revenue_standard_25' })
    expect(sale.ok && shape(sale.lines)).toEqual(rows([['debet', '1930', 1250, 's'], ['kredit', '3001', 1000], ['kredit', '2611', 250]]))
    const transfer = await totalOf({ amount: 5000, template_id: 'financial_tax_account' })
    expect(transfer.ok && shape(transfer.lines)).toEqual(rows([['debet', '1630', 5000], ['kredit', '1930', 5000, 's']]))
  })

  it('settles a reverse-charge template with the company’s momskoder', async () => {
    const configured = { chart_of_accounts: { data: [{ account_number: '6540', default_vat_treatment: 'reverse_charge_non_eu_services', default_vat_rate: null }], error: null } }
    const services = await totalOf({ amount: 2000, template_id: 'it_services_foreign' }, configured)
    expect(services.ok && services.lines.map((l) => l.account).sort()).toEqual(['1930', '2614', '2645', '6540'])
  })

  it('books an utlägg pair under omvänd skattskyldighet: the basis on the supplier’s kind, against the claim’s liability', async () => {
    const lines = await totalOf({ amount: 1000, pair: { debit_account: '5420', credit_account: '2820', vat_treatment: 'reverse_charge', reverse_charge_supplier_type: 'non_eu_business' } })
    expect(lines.ok && shape(lines.lines)).toEqual(rows([
      ['debet', '5420', 1000], ['kredit', '2820', 1000, 's'], ['debet', '2645', 250], ['kredit', '2614', 250],
      ['debet', '4531', 1000], ['kredit', '4598', 1000],
    ]))
  })

  it('refuses a template the catalog does not have', async () => {
    expect(await totalOf({ amount: 100, template_id: 'no_such_template' })).toMatchObject({ ok: false, code: 'TX_CATEGORIZE_INVALID_TEMPLATE' })
  })
})
