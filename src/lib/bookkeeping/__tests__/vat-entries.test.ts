import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { rcBasisAccountRate } from '@/lib/reports/vat-filing-gate'
import {
  getVatRate,
  generateReverseChargePurchaseLines,
  costAccountRcBasisRate,
  chartVatTreatmentsOf,
  reverseChargeOnAccount,
  reverseChargePurchasesOn,
  reverseChargeKindForSupplierType,
  reverseChargeKindRuta,
  reverseChargeKindForBasisAccount,
  reverseChargeKindOnOwnAccount,
  REVERSE_CHARGE_KINDS,
  generateInputVatLine,
  bankRowVatLines,
  type ReverseChargeKind,
} from '../vat-entries'

describe('getVatRate', () => {
  it('returns 0.25 for standard_25', () => {
    expect(getVatRate('standard_25')).toBe(0.25)
  })

  it('returns 0.12 for reduced_12', () => {
    expect(getVatRate('reduced_12')).toBe(0.12)
  })

  it('returns 0.06 for reduced_6', () => {
    expect(getVatRate('reduced_6')).toBe(0.06)
  })

  it('returns 0 for reverse_charge', () => {
    expect(getVatRate('reverse_charge')).toBe(0)
  })

  it('returns 0 for export', () => {
    expect(getVatRate('export')).toBe(0)
  })

  it('returns 0 for exempt', () => {
    expect(getVatRate('exempt')).toBe(0)
  })
})

// The fiktiv pair is private: every producer gets it from the complete set,
// so it can never be posted without the basis pair (#2919). Its first two
// lines are the fiktiv pair, the last two the basis pair.
const rc = (base: number, rate: number, kind: ReverseChargeKind, basisBase?: number) =>
  generateReverseChargePurchaseLines({ base, rate, kind, basisBase })

describe('generateReverseChargePurchaseLines: fiktiv pair, EU/non-EU (2645)', () => {
  it('debits 2645 and credits 2614 at 25%', () => {
    const lines = rc(1000, 0.25, 'eu_services')
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[0].credit_amount).toBe(0)
    expect(lines[1].account_number).toBe('2614')
    expect(lines[1].debit_amount).toBe(0)
    expect(lines[1].credit_amount).toBe(250)
  })

  it('debits 2645 and credits 2624 at 12%', () => {
    const lines = rc(1000, 0.12, 'non_eu_services')
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(120)
    expect(lines[1].account_number).toBe('2624')
    expect(lines[1].credit_amount).toBe(120)
  })

  it('debits 2645 and credits 2634 at 6%', () => {
    const lines = rc(1000, 0.06, 'eu_goods')
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(60)
    expect(lines[1].account_number).toBe('2634')
    expect(lines[1].credit_amount).toBe(60)
  })
})

describe('generateReverseChargePurchaseLines: fiktiv pair, domestic (2647, ML 16 kap)', () => {
  it('debits 2647 (not 2645) and credits 2614 at 25%', () => {
    const lines = rc(1000, 0.25, 'domestic_services')
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[1].account_number).toBe('2614')
    expect(lines[1].credit_amount).toBe(250)
  })

  it('debits 2647 and credits 2624 at 12%', () => {
    const lines = rc(1000, 0.12, 'domestic_services')
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(120)
    expect(lines[1].account_number).toBe('2624')
    expect(lines[1].credit_amount).toBe(120)
  })

  it('debits 2647 and credits 2634 at 6%', () => {
    const lines = rc(1000, 0.06, 'domestic_services')
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(60)
    expect(lines[1].account_number).toBe('2634')
    expect(lines[1].credit_amount).toBe(60)
  })
})

describe('generateReverseChargePurchaseLines: basis pair and invariants', () => {
  it('defaults to 25 % and emits the basis pair on the whole base', () => {
    const lines = generateReverseChargePurchaseLines({ base: 1000, kind: 'eu_services' })
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2645', 250, 0],
      ['2614', 0, 250],
      ['4535', 1000, 0],
      ['4598', 0, 1000],
    ])
  })

  it.each([
    ['eu_goods', ['4515', '4516', '4517']],
    ['eu_services', ['4535', '4536', '4537']],
    ['non_eu_services', ['4531', '4532', '4533']],
    ['domestic_services', ['4425', '4426', '4427']],
  ] as const)('puts the %s basis on the per-rate account', (kind, accounts) => {
    ;[0.25, 0.12, 0.06].forEach((rate, i) => {
      expect(rc(1000, rate, kind)[2].account_number).toBe(accounts[i])
      expect(rc(1000, rate, kind)[3].account_number).toBe('4598')
    })
  })

  it('maps each kind to its momsdeklaration box', () => {
    expect(reverseChargeKindRuta('eu_goods')).toBe('ruta20')
    expect(reverseChargeKindRuta('eu_services')).toBe('ruta21')
    expect(reverseChargeKindRuta('non_eu_services')).toBe('ruta22')
    expect(reverseChargeKindRuta('domestic_services')).toBe('ruta24')
  })

  it('reads the kind and rate back off a basis account, the inverse of the account it books', () => {
    for (const kind of REVERSE_CHARGE_KINDS) {
      for (const rate of [0.25, 0.12, 0.06]) {
        const basis = rc(1000, rate, kind)[2].account_number
        expect(reverseChargeKindForBasisAccount(basis), basis).toEqual({ kind, rate })
      }
    }
    expect(reverseChargeKindForBasisAccount('4531')).toEqual({ kind: 'non_eu_services', rate: 0.25 })
    // The offset, a cost account and domestic goods (no kind) are not basis accounts of a kind.
    for (const account of ['4598', '5420', '4415']) {
      expect(reverseChargeKindForBasisAccount(account), account).toBeNull()
    }
  })

  it('emits the basis only for basisBase: none at 0, a share when part is already on a basis account', () => {
    expect(rc(1000, 0.25, 'eu_services', 0).map((l) => l.account_number)).toEqual(['2645', '2614'])
    const partial = rc(1000, 0.25, 'eu_services', 400)
    expect(partial[0].debit_amount).toBe(250) // fiktiv moms stays on the whole base
    expect(partial[2]).toMatchObject({ account_number: '4535', debit_amount: 400 })
    expect(partial[3]).toMatchObject({ account_number: '4598', credit_amount: 400 })
  })

  it('returns nothing for a zero or negative base', () => {
    expect(rc(0, 0.25, 'eu_services')).toEqual([])
    expect(rc(-10, 0.25, 'eu_services')).toEqual([])
  })

  it('balances for every rate and kind', () => {
    for (const rate of [0.25, 0.12, 0.06]) {
      for (const kind of REVERSE_CHARGE_KINDS) {
        const lines = rc(1234.56, rate, kind)
        expect(lines).toHaveLength(4)
        const debit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
        const credit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
        expect(Math.round(debit * 100) / 100).toBe(Math.round(credit * 100) / 100)
      }
    }
  })

  it('books the basis of each supplier type on its own box: 4535, 4531 and 4425 at 25 %', () => {
    const basisAccount = (supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business') =>
      generateReverseChargePurchaseLines({ base: 1000, kind: reverseChargeKindForSupplierType(supplierType) })[2].account_number
    expect(basisAccount('eu_business')).toBe('4535')
    expect(basisAccount('non_eu_business')).toBe('4531')
    expect(basisAccount('swedish_business')).toBe('4425')
    expect(reverseChargeKindForSupplierType('non_eu_business')).toBe('non_eu_services')
  })
})

describe('costAccountRcBasisRate', () => {
  const code = (treatment: string | null, rate: number | null = null) => ({
    default_vat_treatment: treatment,
    default_vat_rate: rate,
  })

  it('reads an account the chart holds no momskod for as unconfigured, never as a 44xx/45xx range (crm#1096)', () => {
    expect(costAccountRcBasisRate('4535', undefined)).toBe(0.25)
    expect(costAccountRcBasisRate('4536', undefined)).toBe(0.12)
    expect(costAccountRcBasisRate('4417', undefined)).toBe(0.06)
    expect(costAccountRcBasisRate('4538', undefined)).toBeNull()
    expect(costAccountRcBasisRate('4512', undefined)).toBeNull()
    expect(costAccountRcBasisRate('4545', undefined)).toBeNull()
    expect(costAccountRcBasisRate('4598', undefined)).toBeNull()
    expect(costAccountRcBasisRate('6540', undefined)).toBeNull()
  })

  it('with a momskod, follows the declaration: a reverse-charge purchase reports its own box at its momssats', () => {
    // Pattern B: a cost account configured to feed ruta 20-24 itself.
    expect(costAccountRcBasisRate('6540', code('reverse_charge_eu_services'))).toBe(0.25)
    expect(costAccountRcBasisRate('4400', code('reverse_charge_domestic'))).toBe(0.25)
    expect(costAccountRcBasisRate('4057', code('reverse_charge_eu_goods', 0.12))).toBe(0.12)
    expect(costAccountRcBasisRate('4043', code('reverse_charge_domestic', 0.06))).toBe(0.06)
    // Configured, but not to a basis box: the pair is still needed.
    expect(costAccountRcBasisRate('4535', code('standard_25'))).toBeNull()
    expect(costAccountRcBasisRate('6540', code('standard_25', 0.25))).toBeNull()
    expect(costAccountRcBasisRate('4056', code('import_goods'))).toBeNull()
    expect(costAccountRcBasisRate('4056', code('triangulation_eu_goods'))).toBeNull()
  })

  it('reports no basis at a sats the declaration buckets none at (0 %), so the pair books it', () => {
    expect(costAccountRcBasisRate('4538', code('reverse_charge_eu_services', 0))).toBeNull()
    expect(costAccountRcBasisRate('4518', code('reverse_charge_eu_goods', 0))).toBeNull()
  })

  it('with an unconfigured chart row, only the static BAS basis accounts report', () => {
    expect(costAccountRcBasisRate('4535', code(null))).toBe(0.25)
    expect(costAccountRcBasisRate('4531', code(null))).toBe(0.25)
    // A company-numbered 45xx without a treatment feeds no box at all.
    expect(costAccountRcBasisRate('4538', code(null))).toBeNull()
    expect(costAccountRcBasisRate('6540', code(null))).toBeNull()
  })

  it('agrees with the declaration for every reverse-charge purchase momskod on a cost account outside 44xx/45xx', () => {
    for (const treatment of [
      'reverse_charge_eu_goods', 'reverse_charge_eu_services',
      'reverse_charge_non_eu_services', 'reverse_charge_domestic',
    ]) {
      expect(costAccountRcBasisRate('4056', code(treatment))).toBe(0.25)
      expect(costAccountRcBasisRate('5420', code(treatment, 0.12))).toBe(0.12)
    }
  })

  it('is the per-rate bucketing of the momsdeklaration, account by account', async () => {
    const rows = [
      { account_number: '4057', account_name: 'Inköp varor EU 12%', account_class: 4, default_vat_rate: '0.12', default_vat_treatment: 'reverse_charge_eu_goods' },
      { account_number: '6540', account_name: 'IT-tjänster', account_class: 6, default_vat_rate: null, default_vat_treatment: 'reverse_charge_eu_services' },
      { account_number: '4538', account_name: 'Inköp tjänster EU momsfri', account_class: 4, default_vat_rate: 0, default_vat_treatment: 'reverse_charge_eu_services' },
      { account_number: '4535', account_name: 'Inköp tjänster EU', account_class: 4, default_vat_rate: null, default_vat_treatment: 'import_goods' },
      { account_number: '4043', account_name: 'Inköp bygg 6%', account_class: 4, default_vat_rate: 0.06, default_vat_treatment: 'reverse_charge_domestic' },
      { account_number: '5420', account_name: 'Programvaror', account_class: 5, default_vat_rate: 0.25, default_vat_treatment: 'standard_25' },
      { account_number: '4512', account_name: 'Trepartshandel', account_class: 4, default_vat_rate: 0, default_vat_treatment: 'triangulation_eu_goods' },
    ]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: rows })
    const declaration = await fetchDynamicVatAccounts(supabase as never, 'company-1')
    const chart = chartVatTreatmentsOf(rows)
    for (const account of [...rows.map((r) => r.account_number), '4531', '4536', '4416', '4598', '6990']) {
      const bucketed = declaration.explicitAccounts.has(account)
        ? declaration.rcBasisRateByAccount.get(account) ?? null
        : rcBasisAccountRate(account)
      expect(costAccountRcBasisRate(account, chart.get(account)), account).toBe(bucketed)
    }
  })
})

describe('reverseChargeKindOnOwnAccount', () => {
  const domestic = { default_vat_treatment: 'reverse_charge_domestic', default_vat_rate: null }

  it('names the box BAS gives a domestic reverse-charge account with that momskod (crm#1754)', () => {
    // 4420 is tjänster without a stated sats: ruta 24, like 4425-4427, and the
    // categorize preview shows this box. 4410 is its varor twin, ruta 23.
    expect(reverseChargeKindOnOwnAccount('4420', domestic)).toEqual({ kind: 'domestic_services', ruta: 'ruta24' })
    expect(reverseChargeKindOnOwnAccount('4425', domestic)).toEqual({ kind: 'domestic_services', ruta: 'ruta24' })
    expect(reverseChargeKindOnOwnAccount('4410', domestic)).toEqual({ kind: 'domestic_services', ruta: 'ruta23' })
    expect(reverseChargeKindOnOwnAccount('4415', domestic)).toEqual({ kind: 'domestic_services', ruta: 'ruta23' })
  })
})

describe('chartVatTreatmentsOf', () => {
  it('keys each account to its momskod and momssats, null when it has none', () => {
    const chart = chartVatTreatmentsOf([
      { account_number: '4056', default_vat_treatment: 'reverse_charge_eu_goods', default_vat_rate: '0.12' },
      { account_number: '6540', default_vat_treatment: null, default_vat_rate: null },
      { account_number: '5420' },
    ])
    expect(chart.get('4056')).toEqual({ default_vat_treatment: 'reverse_charge_eu_goods', default_vat_rate: 0.12 })
    expect(chart.get('6540')).toEqual({ default_vat_treatment: null, default_vat_rate: null })
    expect(chart.get('5420')).toEqual({ default_vat_treatment: null, default_vat_rate: null })
    expect(chart.get('6991')).toBeUndefined()
  })
})

describe('reverseChargeOnAccount / reverseChargePurchasesOn', () => {
  const chart = chartVatTreatmentsOf([
    { account_number: '4056', default_vat_treatment: 'reverse_charge_eu_goods', default_vat_rate: 0.25 },
    { account_number: '4057', default_vat_treatment: 'reverse_charge_eu_goods', default_vat_rate: 0.12 },
    { account_number: '4538', default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0 },
  ])
  const purchase = { base: 1000, rate: 0.25, kind: 'eu_services' as const }

  it('self-assesses on an account that reports ruta 20-24 itself at its momssats, without the pair', () => {
    expect(reverseChargeOnAccount('6540', 0.25, chart)).toEqual({ rate: 0.25, basisPair: true })
    expect(reverseChargeOnAccount('4056', 0.25, chart)).toEqual({ rate: 0.25, basisPair: false })
    expect(reverseChargeOnAccount('4057', 0.25, chart)).toEqual({ rate: 0.12, basisPair: false })
    expect(reverseChargeOnAccount('4535', 0.12, chart)).toEqual({ rate: 0.25, basisPair: false })
    expect(reverseChargeOnAccount('4538', 0.25, chart)).toEqual({ rate: 0.25, basisPair: true })
  })

  it('gives back the purchase with its whole pair when no cost line reports the basis', () => {
    expect(reverseChargePurchasesOn(purchase, [{ account: '6540', amount: 1000 }], chart))
      .toEqual([{ ...purchase, basisBase: 1000 }])
    expect(reverseChargePurchasesOn(purchase, [{ account: '4538', amount: 1000 }], chart))
      .toEqual([{ ...purchase, basisBase: 1000 }])
  })

  it('drops the pair for a cost line that reports at the purchase rate, and re-rates one at another', () => {
    expect(reverseChargePurchasesOn(purchase, [{ account: '4056', amount: 1000 }], chart))
      .toEqual([{ ...purchase, basisBase: 0 }])
    expect(reverseChargePurchasesOn(purchase, [{ account: '4057', amount: 1000 }], chart))
      .toEqual([{ base: 1000, rate: 0.12, kind: 'eu_services', basisBase: 0 }])
  })

  it('splits a purchase over cost lines by what each one reports', () => {
    expect(reverseChargePurchasesOn(purchase, [
      { account: '6540', amount: 500.4 },
      { account: '4056', amount: 99.6 },
      { account: '4057', amount: 400 },
    ], chart)).toEqual([
      { ...purchase, base: 600, basisBase: 500.4 },
      { base: 400, rate: 0.12, kind: 'eu_services', basisBase: 0 },
    ])
  })

  it('never goes below zero', () => {
    expect(reverseChargePurchasesOn({ ...purchase, base: 100 }, [{ account: '4056', amount: 150 }], chart))
      .toEqual([{ ...purchase, base: 100, basisBase: 0 }])
  })
})

describe('generateInputVatLine', () => {
  it('debits 2641 with VAT extracted from gross at 25% (1250 → 250)', () => {
    const line = generateInputVatLine(1250, 0.25)
    expect(line).not.toBeNull()
    expect(line!.account_number).toBe('2641')
    expect(line!.debit_amount).toBe(250)
    expect(line!.credit_amount).toBe(0)
  })

  it('debits 2641 at 12% (1120 → 120)', () => {
    const line = generateInputVatLine(1120, 0.12)
    expect(line!.account_number).toBe('2641')
    expect(line!.debit_amount).toBe(120)
  })

  it('debits 2641 at 6% (1060 → 60)', () => {
    const line = generateInputVatLine(1060, 0.06)
    expect(line!.account_number).toBe('2641')
    expect(line!.debit_amount).toBe(60)
  })

  it('returns null at zero rate (export/exempt/reverse_charge purchases)', () => {
    expect(generateInputVatLine(1000, 0)).toBeNull()
  })

  it('defaults to vatRate=0.25 when omitted', () => {
    const line = generateInputVatLine(1250)
    expect(line!.debit_amount).toBe(250)
  })
})

describe('bankRowVatLines', () => {
  const lines = (over: Partial<Parameters<typeof bankRowVatLines>[0]>) =>
    bankRowVatLines({ treatment: 'standard_25', absSek: 1250, nature: 'expense', reversal: false, ...over })
  const leg = (account: string, debit: number, credit: number, description: string) => [
    { account_number: account, debit_amount: debit, credit_amount: credit, description },
  ]

  it.each([
    ['standard_25', 1250, 250, '2611', '25%'],
    ['reduced_12', 1120, 120, '2621', '12%'],
    ['reduced_6', 1060, 60, '2631', '6%'],
  ] as const)('%s: the moms inside the gross, on its side', (treatment, absSek, vat, output, rate) => {
    const base = { treatment, absSek }
    expect(lines({ ...base, nature: 'expense' })).toEqual(leg('2641', vat, 0, `Ingående moms ${rate}`))
    expect(lines({ ...base, nature: 'expense', reversal: true })).toEqual(leg('2641', 0, vat, `Återföring ingående moms ${rate}`))
    expect(lines({ ...base, nature: 'income' })).toEqual(leg(output, 0, vat, `Utgående moms ${rate}`))
    expect(lines({ ...base, nature: 'income', reversal: true })).toEqual(leg(output, vat, 0, `Återföring utgående moms ${rate}`))
  })

  it('reverse charge: the whole set on a purchase, reversed on its refund, none on a sale', () => {
    const purchase = lines({ treatment: 'reverse_charge', absSek: 1000 })
    expect(purchase.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2645', 250, 0], ['2614', 0, 250], ['4535', 1000, 0], ['4598', 0, 1000],
    ])
    const refund = lines({ treatment: 'reverse_charge', absSek: 1000, reversal: true })
    expect(refund.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2645', 0, 250], ['2614', 250, 0], ['4535', 0, 1000], ['4598', 1000, 0],
    ])
    expect(lines({ treatment: 'reverse_charge', nature: 'income' })).toEqual([])
    expect(lines({ treatment: 'reverse_charge', nature: 'income', reversal: true })).toEqual([])
  })

  it('reverse charge reports the box of the kind it is told', () => {
    const accounts = lines({ treatment: 'reverse_charge', absSek: 1000, reverseChargeKind: 'non_eu_services' }).map((l) => l.account_number)
    expect(accounts).toContain('4531')
    expect(accounts).toContain('2645')
  })

  it('books no moms on a treatment without one, or none, and never reads an unknown one as 25 %', () => {
    for (const treatment of ['exempt', 'export', 'reverse_charge_domestic', 'import_outside_eu', null, undefined]) {
      for (const nature of ['expense', 'income'] as const) {
        expect(lines({ treatment, nature })).toEqual([])
      }
    }
  })

  it('a gross too small to carry moms books none', () => {
    expect(lines({ absSek: 0 })).toEqual([])
  })

  it('takes the underlag\'s moms over the rate\'s, and says so', () => {
    expect(lines({ vatAmount: 200 })).toEqual(leg('2641', 200, 0, 'Ingående moms (enligt underlag)'))
    expect(lines({ vatAmount: 200, nature: 'income', reversal: true })).toEqual(
      leg('2611', 200, 0, 'Återföring utgående moms (enligt underlag)'),
    )
  })
})
