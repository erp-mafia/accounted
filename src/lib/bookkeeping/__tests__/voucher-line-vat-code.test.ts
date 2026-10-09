import { describe, it, expect } from 'vitest'
import {
  foldGeneratedVatLines,
  groupVoucherLinesWithVatCodes,
  vatCodeAfterAccountChange,
  vatCodeBasisBox,
  vatCodeConflictAccounts,
  vatCodeLinesForLine,
  vatCodeRuleForAccount,
  type FoldableVoucherLine,
  type VoucherLineVatCode,
  type VoucherVatCodeAccountRow,
  type VoucherVatCodeLine,
  type VoucherVatCodeRowLookup,
} from '../voucher-line-vat-code'
import { costAccountReportsRcBasis, generateReverseChargePurchaseLines } from '../vat-entries'
import { buildMappingResultFromCategory } from '../category-mapping'
import { buildTransactionEntryLines } from '../transaction-entries'
import { computeProposalLines, proposalLinesToFormLines } from '../proposal-lines'
import { rutorFromTotals } from '@/lib/reports/vat-declaration'
import { rcBasisTotalsByRate } from '@/lib/reports/vat-filing-gate'
import { resolveEffectiveVatRate } from '@/lib/reports/vat-revenue-accounts'
import { isAccountVatTreatment, resolveVatTreatmentRuta } from '@/lib/vat/account-vat-treatment'
import { makeTransaction } from '@/tests/helpers'

const NON_EU_25: VoucherLineVatCode = { kind: 'non_eu_services', rate: 0.25 }
const FREE = { mode: 'free' } as const

function line(
  account: string,
  debit: string,
  credit = '',
  vatCode?: VoucherLineVatCode | null,
): VoucherVatCodeLine & { line_description: string } {
  return { account_number: account, debit_amount: debit, credit_amount: credit, vat_code: vatCode, line_description: '' }
}

/** A chart where only the listed accounts carry a row. */
function chart(rows: Record<string, VoucherVatCodeAccountRow> = {}): VoucherVatCodeRowLookup {
  return (account) => rows[account]
}

const treatment = (t: string, rate: number | string | null = null): VoucherVatCodeAccountRow =>
  ({ default_vat_treatment: t, default_vat_rate: rate })

type AnyLine = { account_number: string; debit_amount: number | string; credit_amount: number | string }

const triples = (lines: AnyLine[]) => lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

/** Accounts and amounts as numbers, so '250', '250.00' and 250 compare equal. */
const amountsOf = (lines: AnyLine[]) =>
  lines.map((l) => [l.account_number, Number(l.debit_amount) || 0, Number(l.credit_amount) || 0])

/** Amounts as the Kopiera builder hands them to the form: two decimals. */
const asCopied = (amount: string | number) => (Number(amount) > 0 ? Number(amount).toFixed(2) : '')

/** A stored verifikat as Kopiera hands it to the form: no momskod, two-decimal amounts. */
function copyOf(lines: Array<AnyLine & { line_description?: string | null }>): FoldableVoucherLine[] {
  return lines.map((l) => ({
    account_number: l.account_number,
    debit_amount: asCopied(l.debit_amount),
    credit_amount: asCopied(l.credit_amount),
    line_description: l.line_description ?? '',
  }))
}

/** The verifikat the form posts: each line followed by what its momskod generates. */
function booked<T extends VoucherVatCodeLine>(lines: T[], rowOf: VoucherVatCodeRowLookup = chart()) {
  return groupVoucherLinesWithVatCodes(lines, rowOf).flatMap((group) => [group.line, ...group.generated])
}

/** Per-account totals of a booked verifikat: the shape the momsdeklaration sums. */
function totalsOf(lines: AnyLine[]): Map<string, { debit: number; credit: number }> {
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const t = totals.get(l.account_number) ?? { debit: 0, credit: 0 }
    t.debit += Number(l.debit_amount) || 0
    t.credit += Number(l.credit_amount) || 0
    totals.set(l.account_number, t)
  }
  return totals
}

/** The declaration's own view of a chart row (fetchDynamicVatAccounts, reduced to one account). */
function dynamicFor(account: string, row: VoucherVatCodeAccountRow) {
  const t = row.default_vat_treatment ?? null
  if (!isAccountVatTreatment(t)) return { mappingByAccount: new Map(), explicitAccounts: new Set<string>() }
  const mapping = resolveVatTreatmentRuta(t, Number(account.charAt(0)), account)
  return {
    mappingByAccount: new Map(mapping ? [[account, mapping]] : []),
    explicitAccounts: new Set([account]),
  }
}

describe('vatCodeLinesForLine on an ordinary cost account', () => {
  // crm#1096: 6540 with the momskod "tjänster från land utanför EU, 25 %".
  it('books the purchase exactly as the categorisation flow books it', () => {
    const generated = vatCodeLinesForLine(line('6540', '1000'), FREE, NON_EU_25)
    expect(triples(generated)).toEqual([
      ['2645', 250, 0],
      ['2614', 0, 250],
      ['4531', 1000, 0],
      ['4598', 0, 1000],
    ])

    const categorised = buildMappingResultFromCategory(
      'expense_software', makeTransaction({ amount: -1000 }), true, 'aktiebolag',
      'reverse_charge', null, null, 'non_eu_services',
    )
    expect(generated.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.line_description]))
      .toEqual(categorised.vat_lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.description]))
  })

  it('lands in rutor 22, 30 and 48 and leaves ruta 49 at zero', () => {
    const rutor = rutorFromTotals(totalsOf(booked([line('6540', '1000', '', NON_EU_25), line('1930', '', '1000')])))
    expect(rutor.ruta22).toBe(1000)
    expect(rutor.ruta30).toBe(250)
    expect(rutor.ruta48).toBe(250)
    expect(rutor.ruta49).toBe(0)
    expect(rutor.ruta21).toBe(0)
    expect(rutor.ruta10).toBe(0)
  })

  it.each([
    ['eu_goods', '4515', 'ruta20'],
    ['eu_services', '4535', 'ruta21'],
    ['non_eu_services', '4531', 'ruta22'],
    ['domestic_services', '4425', 'ruta24'],
  ] as const)('a %s code books its basis on %s (%s)', (kind, basisAccount, ruta) => {
    const code = { kind, rate: 0.25 } as const
    const generated = vatCodeLinesForLine(line('6540', '800'), FREE, code)
    expect(generated.find((l) => l.account_number === basisAccount)?.debit_amount).toBe(800)
    expect(generated.find((l) => l.account_number === '4598')?.credit_amount).toBe(800)
    expect(rutorFromTotals(totalsOf(generated))[ruta]).toBe(800)
    expect(vatCodeBasisBox(FREE, code)).toBe(ruta)
  })

  it('takes the 2647 input leg for domestic reverse charge and 2645 for the rest', () => {
    const domestic = vatCodeLinesForLine(line('6540', '1000'), FREE, { kind: 'domestic_services', rate: 0.25 })
    expect(domestic.map((l) => l.account_number)).toEqual(['2647', '2614', '4425', '4598'])
    const euGoods = vatCodeLinesForLine(line('4010', '1000'), FREE, { kind: 'eu_goods', rate: 0.25 })
    expect(euGoods.map((l) => l.account_number)).toEqual(['2645', '2614', '4515', '4598'])
  })

  it.each([
    [0.12, '2624', '4532', 120],
    [0.06, '2634', '4533', 60],
  ] as const)('self-assesses %s on its own output account and basis account', (rate, output, basis, vat) => {
    const generated = vatCodeLinesForLine(line('6540', '1000'), FREE, { kind: 'non_eu_services', rate })
    expect(triples(generated)).toEqual([
      ['2645', vat, 0],
      [output, 0, vat],
      [basis, 1000, 0],
      ['4598', 0, 1000],
    ])
  })

  it('mirrors every line for a credit note booked on the credit side', () => {
    const generated = vatCodeLinesForLine(line('6540', '', '400'), FREE, NON_EU_25)
    expect(triples(generated)).toEqual([
      ['2645', 0, 100],
      ['2614', 100, 0],
      ['4531', 0, 400],
      ['4598', 400, 0],
    ])
    expect(rutorFromTotals(totalsOf(generated)).ruta22).toBe(-400)
  })

  it('rounds the self-assessed VAT to öre', () => {
    const generated = vatCodeLinesForLine(line('6540', '333.33'), FREE, NON_EU_25)
    expect(generated.find((l) => l.account_number === '2645')?.debit_amount).toBe(83.33)
    expect(generated.find((l) => l.account_number === '2614')?.credit_amount).toBe(83.33)
    expect(generated.find((l) => l.account_number === '4531')?.debit_amount).toBe(333.33)
  })

  it('generates nothing without a positive amount or on an account that takes no momskod', () => {
    for (const amount of ['', '0', 'abc', '-50']) {
      expect(vatCodeLinesForLine(line('6540', amount), FREE, NON_EU_25)).toEqual([])
    }
    expect(vatCodeLinesForLine(line('3001', '1000'), { mode: 'none' }, NON_EU_25)).toEqual([])
  })
})

describe('vatCodeRuleForAccount', () => {
  it('lets an ordinary cost account take any momskod', () => {
    for (const account of ['4010', '5410', '6540', '6991']) {
      expect(vatCodeRuleForAccount(account, undefined)).toEqual(FREE)
    }
    expect(vatCodeRuleForAccount('6540', treatment('standard_25', 0.25))).toEqual(FREE)
  })

  it.each([
    ['4531', 'non_eu_services', 0.25, 'ruta22'],
    ['4536', 'eu_services', 0.12, 'ruta21'],
    ['4517', 'eu_goods', 0.06, 'ruta20'],
    ['4425', 'domestic_services', 0.25, 'ruta24'],
    ['4416', 'domestic_services', 0.12, 'ruta23'],
  ] as const)('fixes an unconfigured BAS basis account: %s is %s at %s in %s', (account, kind, rate, box) => {
    expect(vatCodeRuleForAccount(account, null)).toEqual({ mode: 'fixed', code: { kind, rate }, box })
  })

  it.each([
    ['reverse_charge_eu_goods', 'eu_goods', 'ruta20'],
    ['reverse_charge_eu_services', 'eu_services', 'ruta21'],
    ['reverse_charge_non_eu_services', 'non_eu_services', 'ruta22'],
    ['reverse_charge_domestic', 'domestic_services', 'ruta24'],
  ] as const)('fixes an account whose momskod is %s', (momskod, kind, box) => {
    expect(vatCodeRuleForAccount('6540', treatment(momskod)))
      .toEqual({ mode: 'fixed', code: { kind, rate: 0.25 }, box })
  })

  it('reads a domestic reverse-charge goods account as ruta 23 with the 2647 input leg', () => {
    const rule = vatCodeRuleForAccount('4010', treatment('reverse_charge_domestic'))
    expect(rule).toEqual({ mode: 'fixed', code: { kind: 'domestic_services', rate: 0.25 }, box: 'ruta23' })
    const generated = vatCodeLinesForLine(line('4010', '1000'), rule, { kind: 'domestic_services', rate: 0.25 })
    expect(triples(generated)).toEqual([['2647', 250, 0], ['2614', 0, 250]])
  })

  it('takes the rate the declaration buckets the account\'s basis at', () => {
    const row = {
      account_number: '4516',
      account_name: 'Inköp av varor från annat EU-land, 12 %',
      account_class: 4,
      default_vat_treatment: 'reverse_charge_eu_goods',
      default_vat_rate: 0.12 as number | string | null,
    }
    for (const variant of [row, { ...row, default_vat_rate: null }, { ...row, default_vat_rate: '0.06' }]) {
      const rule = vatCodeRuleForAccount('4516', variant)
      expect(rule.mode === 'fixed' ? rule.code.rate : null).toBe(resolveEffectiveVatRate(variant))
    }
  })

  it.each([
    ['3001', undefined],
    ['1930', undefined],
    ['2645', undefined],
    ['7010', undefined],
    ['4598', undefined],
    ['4512', undefined],
    ['4545', undefined],
    ['4547', undefined],
    ['6540', treatment('triangulation_eu_goods')],
    ['4535', treatment('import_goods')],
    ['4535', treatment('reverse_charge_eu_services', 0)],
  ] as const)('gives %s no momskod (%o)', (account, row) => {
    expect(vatCodeRuleForAccount(account, row)).toEqual({ mode: 'none' })
  })

  it('agrees with the producers\' basis rule and with the box the declaration fills', () => {
    const cases: Array<[string, VoucherVatCodeAccountRow | undefined]> = [
      ['6540', undefined], ['4010', undefined], ['4531', undefined], ['4416', undefined], ['4425', undefined],
      ['6540', treatment('reverse_charge_eu_services')], ['4010', treatment('reverse_charge_domestic')],
      ['5420', treatment('reverse_charge_non_eu_services', 0.12)], ['4535', treatment('standard_25')],
    ]
    for (const [account, row] of cases) {
      const rule = vatCodeRuleForAccount(account, row)
      expect(rule.mode === 'fixed').toBe(costAccountReportsRcBasis(account, row?.default_vat_treatment ?? null))
      if (rule.mode !== 'fixed') continue
      const rutor = rutorFromTotals(
        totalsOf([{ account_number: account, debit_amount: 1000, credit_amount: 0 }]),
        dynamicFor(account, row ?? {}),
      )
      expect(rutor[rule.box]).toBe(1000)
    }
  })
})

describe('an account with its own box decides the momskod', () => {
  it('books 4531 at its own 25 % whatever rate was chosen, keeping the per-rate identity', () => {
    const lines = [line('4531', '1000', '', { kind: 'eu_services', rate: 0.12 }), line('1930', '', '1000')]
    const groups = groupVoucherLinesWithVatCodes(lines, chart())
    expect(groups[0].code).toEqual(NON_EU_25)
    expect(triples(groups[0].generated)).toEqual([['2645', '250', ''], ['2614', '', '250']])

    const totals = totalsOf(booked(lines))
    const rutor = rutorFromTotals(totals)
    expect(rutor.ruta22).toBe(1000)
    expect(rutor.ruta21).toBe(0)
    expect(rutor.ruta30).toBe(250)
    expect(rutor.ruta31).toBe(0)
    expect(rcBasisTotalsByRate(totals)).toEqual({ r25: 1000, r12: 0, r6: 0 })
  })

  it('keeps the base of an account set to EU services in ruta 21 when another kind was chosen', () => {
    const rows = { '6540': treatment('reverse_charge_eu_services') }
    const lines = [line('6540', '1000', '', NON_EU_25), line('1930', '', '1000')]
    const [group] = groupVoucherLinesWithVatCodes(lines, chart(rows))
    expect(group.code).toEqual({ kind: 'eu_services', rate: 0.25 })
    expect(vatCodeBasisBox(group.rule, group.code!)).toBe('ruta21')

    const rutor = rutorFromTotals(totalsOf(booked(lines, chart(rows))), dynamicFor('6540', rows['6540']))
    expect(rutor.ruta21).toBe(1000)
    expect(rutor.ruta22).toBe(0)
    expect(rutor.ruta30).toBe(250)
    expect(rutor.ruta48).toBe(250)
  })

  it('switches itself on for a debit: picking 4531, or an account set to reverse charge, adds its fiktiv moms', () => {
    // Also a line that arrives with the account already on it (the bank picker).
    const picked = groupVoucherLinesWithVatCodes([line('1930', '', '1000'), line('4531', '1000')], chart())
    expect(picked[1].code).toEqual(NON_EU_25)
    expect(triples(picked[1].generated)).toEqual([['2645', '250', ''], ['2614', '', '250']])

    const configured = groupVoucherLinesWithVatCodes(
      [line('6540', '1000'), line('1930', '', '1000')],
      chart({ '6540': treatment('reverse_charge_non_eu_services') }),
    )
    expect(triples(configured[0].generated)).toEqual([['2645', '250', ''], ['2614', '', '250']])
  })

  it('shows the account\'s own code from the moment the account is picked on a purchase, before any amount', () => {
    const [, picked] = groupVoucherLinesWithVatCodes([line('1930', '', '1000'), line('4531', '')], chart())
    expect(picked.code).toEqual(NON_EU_25)
    expect(picked.generated).toEqual([])

    // Until a line books the payment, nothing says the verifikat is a purchase.
    const [alone] = groupVoucherLinesWithVatCodes([line('4531', '1000')], chart())
    expect(alone.code).toBeNull()
  })

  it('does not switch itself on for a credit: an accrual changes no VAT', () => {
    const [, accrual] = groupVoucherLinesWithVatCodes([line('1790', '11000'), line('4531', '', '11000')], chart())
    expect(accrual.code).toBeNull()
    expect(accrual.generated).toEqual([])
  })

  it('reverses on a credit when switched on, as a credit note', () => {
    const [, creditNote] = groupVoucherLinesWithVatCodes(
      [line('2440', '400'), line('4531', '', '400', NON_EU_25)],
      chart(),
    )
    expect(triples(creditNote.generated)).toEqual([['2645', '', '100'], ['2614', '100', '']])
  })

  it('stays off once switched off', () => {
    const [group] = groupVoucherLinesWithVatCodes([line('4531', '1000', '', null)], chart())
    expect(group.code).toBeNull()
    expect(group.generated).toEqual([])
  })

  it('yields to fiktiv moms booked by hand instead of counting it twice', () => {
    const groups = groupVoucherLinesWithVatCodes([
      line('4531', '1000'),
      line('2645', '250'),
      line('2614', '', '250'),
      line('1930', '', '1000'),
    ], chart())
    expect(groups[0].code).toBeNull()
    expect(groups[0].generated).toEqual([])
    expect(vatCodeConflictAccounts(groups)).toEqual([])
  })
})

describe('an account\'s own code switches itself on only where the verifikat books the purchase', () => {
  type Line = ReturnType<typeof line>
  // None of these books a purchase: the purchase and its fiktiv moms sit in
  // another verifikat, and the account's own code here would declare rutor 30
  // and 48 a second time.
  const NOT_PURCHASES: Array<[string, Line[]]> = [
    ['a basis-only correction', [line('4535', '1000'), line('4598', '', '1000')]],
    ['an omföring between boxes', [line('4535', '1000'), line('4531', '', '1000')]],
    ['an omföring to another cost account', [line('4531', '1000'), line('5420', '', '1000')]],
    ['an accrual release', [line('4531', '1000'), line('1790', '', '1000')]],
  ]

  it.each(NOT_PURCHASES)('leaves %s without generated lines', (_shape, lines) => {
    const groups = groupVoucherLinesWithVatCodes(lines, chart())
    expect(groups.every((group) => group.code === null && group.generated.length === 0)).toBe(true)
    expect(booked(lines)).toHaveLength(lines.length)
  })

  it.each(NOT_PURCHASES)('leaves a Kopiera copy of %s without generated lines', (_shape, lines) => {
    const copy = copyOf(lines)
    const folded = foldGeneratedVatLines(copy, chart())
    expect(folded).toBe(copy)
    expect(amountsOf(booked(folded))).toEqual(amountsOf(copy))
  })

  it.each(['1930', '2440', '2018', '2893'])('switches on for a purchase on 4531 against %s', (counter) => {
    const lines = [line('4531', '1000'), line(counter, '', '1000')]
    const [group] = groupVoucherLinesWithVatCodes(lines, chart())
    expect(group.code).toEqual(NON_EU_25)
    expect(triples(group.generated)).toEqual([['2645', '250', ''], ['2614', '', '250']])
    const rutor = rutorFromTotals(totalsOf(booked(lines)))
    expect([rutor.ruta22, rutor.ruta30, rutor.ruta48]).toEqual([1000, 250, 250])
  })

  it('applies a code chosen in the menu whatever the verifikat books', () => {
    // A 6540 line with a chosen code, on a purchase and beside an accrual release.
    for (const counter of [line('1930', '', '1000'), line('1790', '', '1000')]) {
      const [group] = groupVoucherLinesWithVatCodes([line('6540', '1000', '', NON_EU_25), counter], chart())
      expect(triples(group.generated)).toEqual([
        ['2645', '250', ''], ['2614', '', '250'], ['4531', '1000', ''], ['4598', '', '1000'],
      ])
    }
    // An account's own code where it stays off by itself is switched on from the menu.
    const [switchedOn] = groupVoucherLinesWithVatCodes(
      [line('4531', '1000', '', NON_EU_25), line('1790', '', '1000')],
      chart(),
    )
    expect(triples(switchedOn.generated)).toEqual([['2645', '250', ''], ['2614', '', '250']])
  })

  it('copies a supplier invoice with a reverse-charge cost line and a basis pair as it was posted', () => {
    // 4056 is set to EU goods in the kontoplan, and the supplier-invoice
    // producer still adds a 4515 / 4598 pair beside it. The fold gives the
    // fiktiv pair to 4056's code; the typed 4598 credit keeps 4515's own code
    // off, so the copy books the fiktiv moms once, as the original did.
    const rows = chart({ '4056': treatment('reverse_charge_eu_goods') })
    const copy = copyOf([
      { account_number: '4056', debit_amount: 1000, credit_amount: 0, line_description: 'Leverantörsfaktura' },
      ...generateReverseChargePurchaseLines({ base: 1000, rate: 0.25, kind: 'eu_goods' }),
      { account_number: '2440', debit_amount: 0, credit_amount: 1000, line_description: 'Leverantörsfaktura' },
    ])
    expect(copy.map((l) => l.account_number)).toEqual(['4056', '2645', '2614', '4515', '4598', '2440'])

    const folded = foldGeneratedVatLines(copy, rows)
    expect(folded.map((l) => [l.account_number, l.vat_code])).toEqual([
      ['4056', { kind: 'eu_goods', rate: 0.25 }],
      ['4515', undefined],
      ['4598', undefined],
      ['2440', undefined],
    ])
    const groups = groupVoucherLinesWithVatCodes(folded, rows)
    expect(groups[1].code).toBeNull()
    expect(vatCodeConflictAccounts(groups)).toEqual([])
    expect(amountsOf(booked(folded, rows))).toEqual(amountsOf(copy))
  })
})

describe('never count the purchase twice', () => {
  it('flags a chosen momskod beside hand-typed lines on the accounts it generates', () => {
    const fiktiv = groupVoucherLinesWithVatCodes([
      line('6540', '1000', '', NON_EU_25),
      line('2645', '250'),
      line('2614', '', '250'),
      line('1930', '', '1000'),
    ], chart())
    expect(vatCodeConflictAccounts(fiktiv)).toEqual(['2614', '2645'])

    const offset = groupVoucherLinesWithVatCodes(
      [line('6540', '1000', '', NON_EU_25), line('4598', '', '1000')],
      chart(),
    )
    expect(vatCodeConflictAccounts(offset)).toEqual(['4598'])

    const switchedOn = groupVoucherLinesWithVatCodes(
      [line('4531', '1000', '', NON_EU_25), line('2645', '250'), line('2614', '', '250')],
      chart(),
    )
    expect(vatCodeConflictAccounts(switchedOn)).toEqual(['2614', '2645'])
  })

  it('accepts the BAS shape: cost on 6540, a typed 4531 / 4598 statistic pair and 4531\'s own code switched on', () => {
    const lines = [
      line('6540', '1000'),
      line('1930', '', '1000'),
      line('4531', '1000', '', NON_EU_25),
      line('4598', '', '1000'),
    ]
    const groups = groupVoucherLinesWithVatCodes(lines, chart())
    expect(groups[2].generated.map((l) => l.account_number)).toEqual(['2645', '2614'])
    expect(vatCodeConflictAccounts(groups)).toEqual([])
    const rutor = rutorFromTotals(totalsOf(booked(lines)))
    expect([rutor.ruta22, rutor.ruta30, rutor.ruta48]).toEqual([1000, 250, 250])

    // Not by itself: a typed 4598 credit is also the shape of a basis-only
    // correction, whose fiktiv moms sits in another verifikat.
    const unchosen = groupVoucherLinesWithVatCodes(lines.map((l) => ({ ...l, vat_code: undefined })), chart())
    expect(unchosen[2].code).toBeNull()
    expect(unchosen[2].generated).toEqual([])
  })

  it('does not flag hand-built lines without a momskod', () => {
    const groups = groupVoucherLinesWithVatCodes([
      line('6540', '1000'),
      line('2645', '250'),
      line('2614', '', '250'),
      line('4531', '1000'),
      line('4598', '', '1000'),
      line('1930', '', '1000'),
    ], chart())
    expect(vatCodeConflictAccounts(groups)).toEqual([])
    expect(groups.every((group) => group.generated.length === 0)).toBe(true)
  })

  it('generates nothing while the chart is unknown', () => {
    const groups = groupVoucherLinesWithVatCodes([line('6540', '1000', '', NON_EU_25), line('4531', '1000')], null)
    expect(groups.every((group) => group.rule.mode === 'none' && group.generated.length === 0)).toBe(true)
  })
})

describe('groupVoucherLinesWithVatCodes', () => {
  it('puts each generated set under its own line, in the form shape, and the verifikat balances', () => {
    const lines = [
      line('6540', '1000', '', NON_EU_25),
      line('5410', '200', '', { kind: 'eu_goods', rate: 0.12 }),
      line('1930', '', '1200'),
    ]
    const groups = groupVoucherLinesWithVatCodes(lines, chart())

    expect(groups.map((group) => group.line)).toEqual(lines)
    expect(triples(groups[0].generated)).toEqual([
      ['2645', '250', ''],
      ['2614', '', '250'],
      ['4531', '1000', ''],
      ['4598', '', '1000'],
    ])
    expect(triples(groups[1].generated)).toEqual([
      ['2645', '24', ''],
      ['2624', '', '24'],
      ['4516', '200', ''],
      ['4598', '', '200'],
    ])
    expect(groups[2].generated).toEqual([])
    expect(groups[0].generated.every((l) => l.line_description.length > 0)).toBe(true)
    // Two purchases, each with its own generated set: no hand-typed duplicate.
    expect(vatCodeConflictAccounts(groups)).toEqual([])

    const all = booked(lines)
    const debit = all.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
    const credit = all.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
  })
})

describe('vatCodeAfterAccountChange', () => {
  it('keeps a code chosen on a cost account when the new account is an ordinary one too', () => {
    expect(vatCodeAfterAccountChange(NON_EU_25, vatCodeRuleForAccount('6541', undefined))).toEqual(NON_EU_25)
    expect(vatCodeAfterAccountChange(NON_EU_25, vatCodeRuleForAccount('5420', null))).toEqual(NON_EU_25)
  })

  it('lets an account with its own box, or one without a momskod, decide again', () => {
    expect(vatCodeAfterAccountChange(NON_EU_25, vatCodeRuleForAccount('4535', undefined))).toBeUndefined()
    expect(vatCodeAfterAccountChange(NON_EU_25, vatCodeRuleForAccount('1930', undefined))).toBeUndefined()
    expect(vatCodeAfterAccountChange(null, vatCodeRuleForAccount('4531', undefined))).toBeUndefined()
    expect(vatCodeAfterAccountChange(null, vatCodeRuleForAccount('6540', undefined))).toBeUndefined()
  })
})

describe('foldGeneratedVatLines', () => {
  /** What a save stores: the posted lines, without the momskod itself. */
  const saved = (lines: Array<ReturnType<typeof line>>): FoldableVoucherLine[] =>
    booked(lines).map((l) => ({
      account_number: l.account_number,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
      line_description: l.line_description,
    }))

  it('folds a saved draft back into its momskod, so the lines follow the amount again', () => {
    const draft = saved([line('6540', '1000', '', NON_EU_25), line('1930', '', '1000')])
    expect(draft).toHaveLength(6)

    const folded = foldGeneratedVatLines(draft, chart(), { stored: true })
    expect(folded.map((l) => [l.account_number, l.vat_code])).toEqual([['6540', NON_EU_25], ['1930', undefined]])
    expect(triples(booked(folded))).toEqual(triples(draft))

    const edited = [{ ...folded[0], debit_amount: '1200' }, { ...folded[1], credit_amount: '1200' }]
    expect(triples(booked(edited)).slice(1, 5)).toEqual([
      ['2645', '300', ''], ['2614', '', '300'], ['4531', '1200', ''], ['4598', '', '1200'],
    ])
  })

  it('folds a Kopiera copy of a verifikat this form posted, whose amounts carry two decimals', () => {
    const copy = copyOf(saved([line('1930', '', '1000'), line('4531', '1000', '', NON_EU_25)]))
    const folded = foldGeneratedVatLines(copy, chart())
    expect(folded.map((l) => [l.account_number, l.vat_code])).toEqual([['1930', undefined], ['4531', NON_EU_25]])
  })

  it('leaves a categorised verifikat as typed lines and counts its purchase once', () => {
    // buildTransactionEntryLines stores the producer's set above the cost line,
    // so a copy has no line followed by its own generated set.
    const tx = makeTransaction({ amount: -1000 })
    const mapping = buildMappingResultFromCategory(
      'expense_software', tx, true, 'aktiebolag', 'reverse_charge', null, null, 'non_eu_services',
    )
    const copy = copyOf(buildTransactionEntryLines(tx, mapping))
    expect(copy.map((l) => l.account_number)).toEqual(['2645', '2614', '4531', '4598', '5420', '1930'])

    const folded = foldGeneratedVatLines(copy, chart())
    expect(folded).toBe(copy)
    expect(amountsOf(booked(folded))).toEqual(amountsOf(copy))
    const rutor = rutorFromTotals(totalsOf(booked(folded)))
    expect([rutor.ruta22, rutor.ruta30, rutor.ruta48]).toEqual([1000, 250, 250])
  })

  it.each([undefined, '4531'])('leaves a bank proposal (cost account %s) as typed lines and counts its purchase once', (accountOverride) => {
    // The proposal puts the reverse-charge lines after the bank leg, without
    // descriptions; on 4531 itself its fiktiv pair is typed, so 4531's own
    // code yields to it.
    const proposal = proposalLinesToFormLines(computeProposalLines({
      amount: -1000,
      category: 'expense_software',
      vatTreatment: 'reverse_charge',
      reverseChargeKind: 'non_eu_services',
      entityType: 'aktiebolag',
      accountOverride,
    }), { settlementAccount: '1930' })
    expect(proposal[1].account_number).toBe('1930')

    const folded = foldGeneratedVatLines(proposal, chart())
    expect(folded).toBe(proposal)
    expect(amountsOf(booked(folded))).toEqual(amountsOf(proposal))
    const rutor = rutorFromTotals(totalsOf(booked(folded)))
    expect([rutor.ruta22, rutor.ruta30, rutor.ruta48]).toEqual([1000, 250, 250])
  })

  it('leaves hand-typed lines alone: other descriptions, dimensions or amounts', () => {
    const draft = saved([line('6540', '1000', '', NON_EU_25), line('1930', '', '1000')])
    const renamed = draft.map((l) => (l.account_number === '2645' ? { ...l, line_description: 'Moms' } : l))
    const tagged = draft.map((l) => (l.account_number === '4531' ? { ...l, dimensions: { '1': 'KS01' } } : l))
    const changed = draft.map((l) => (l.account_number === '2614' ? { ...l, credit_amount: '249' } : l))
    for (const lines of [renamed, tagged, changed]) {
      expect(foldGeneratedVatLines(lines, chart())).toBe(lines)
    }
  })

  it('keeps a draft\'s shape: a basis account it booked without fiktiv moms stays without it', () => {
    const draft: FoldableVoucherLine[] = [line('4531', '1000'), line('1930', '', '1000')]
    const folded = foldGeneratedVatLines(draft, chart(), { stored: true })
    expect(folded[0].vat_code).toBeNull()
    expect(booked(folded)).toHaveLength(2)

    // A copy is a new verifikat: on a purchase, the account switches itself on.
    expect(foldGeneratedVatLines(draft, chart())).toBe(draft)
    expect(booked(draft)).toHaveLength(4)
  })

  it('folds the fiktiv pair under an account with its own box', () => {
    const draft = saved([line('4531', '1000', '', NON_EU_25), line('1930', '', '1000')])
    expect(draft.map((l) => l.account_number)).toEqual(['4531', '2645', '2614', '1930'])
    const folded = foldGeneratedVatLines(draft, chart(), { stored: true })
    expect(folded.map((l) => [l.account_number, l.vat_code])).toEqual([['4531', NON_EU_25], ['1930', undefined]])
  })
})
