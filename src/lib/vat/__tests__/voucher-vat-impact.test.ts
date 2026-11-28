import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCurrency } from '@/lib/utils'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  momsredovisningShapeOfLines,
  previewVoucherVatDeclaration,
  rutorChangeOfLines,
  voucherVatDeclarationImpact,
  type VoucherImpactLine,
  type VoucherVatPeriod,
} from '../voucher-vat-impact'

type Line = [account: string, debit: number, credit: number]

const toLines = (lines: Line[]): VoucherImpactLine[] =>
  lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount }))

const AB = ['1630']
const EF = ['1630', '2012']

const OCTOBER: VoucherVatPeriod = {
  type: 'monthly', year: 2026, period: 10, start: '2026-10-01', end: '2026-10-31', label: 'Oktober 2026', filed_on: null,
}

// The correction crm#1447 staged: input VAT taken on an earlier year's
// verifikat that was never declared moves to cost, and the reverse-charge
// output VAT moves to 2650 for the omprövning of that period, with öres-
// avrundning. Amounts are illustrative.
const HISTORICAL_CORRECTION: Line[] = [
  ['5420', 1000.4, 0],
  ['2645', 0, 1000.4],
  ['2614', 1000.4, 0],
  ['2650', 0, 1000],
  ['3740', 0, 0.4],
]

// The reported case: an ordinary domestic sale with VAT of another scheme
// booked straight to 2650 next to it, every line in credit against the bank.
// Amounts are illustrative.
const SALE_WITH_2650_LINE: Line[] = [
  ['1930', 1350, 0],
  ['3001', 0, 1000],
  ['2611', 0, 250],
  ['2650', 0, 100],
]
const flipped = (lines: Line[]): Line[] => lines.map(([account, debit, credit]): Line => [account, credit, debit])

describe('momsredovisningShapeOfLines: the SQL shape_flags over one verifikat', () => {
  // Expectations are the SQL's, as the pg tests pin them on
  // vat_declaration_special_entries (tests/pg/vat-skattekonto-counter-entries
  // .pg.test.ts cases a-f, tests/pg/vat-totals-shape-pass.pg.test.ts KINDS).
  it.each<[string, Line[], 'net_account_shape' | 'tax_account_shape' | null]>([
    ['the crm#1447 historical correction (a declaration account and 2650)', HISTORICAL_CORRECTION, 'net_account_shape'],
    ['a classic settlement', [['2611', 250, 0], ['2641', 0, 80], ['2650', 0, 170]], 'net_account_shape'],
    ['a settlement with a cost line', [['2611', 100, 0], ['2650', 0, 90], ['6570', 0, 10]], 'net_account_shape'],
    ['2641 against 1650', [['2641', 0, 80], ['1650', 80, 0]], 'net_account_shape'],
    ['(b) 2610 D / 1650 K', [['2610', 86217, 0], ['1650', 0, 86217]], 'net_account_shape'],
    ['(a) 1630 D / 2610 K', [['1630', 86217, 0], ['2610', 0, 86217]], 'tax_account_shape'],
    ['(a) VAT settled against 1630 with öresutjämning', [['2611', 249.6, 0], ['2641', 0, 99.2], ['3740', 0, 0.4], ['1630', 0, 150]], 'tax_account_shape'],
    ['(d) a bidrag received on the skattekonto', [['1630', 25136, 0], ['3980', 0, 25136]], null],
    ['(e) a business verifikat paid from the skattekonto', [['5410', 400, 0], ['2641', 100, 0], ['1630', 0, 500]], null],
    ['2650 paid from 1630', [['2650', 150, 0], ['1630', 0, 150]], null],
    ['a sale', [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], null],
    ['a reverse-charge purchase', [['2645', 25, 0], ['2614', 0, 25], ['4535', 100, 0], ['2440', 0, 100]], null],
    ['the correction without its 2650 leg', [['5420', 1000, 0], ['2645', 0, 1000]], null],
  ])('%s', (_label, lines, expected) => {
    expect(momsredovisningShapeOfLines(toLines(lines), AB)).toBe(expected)
  })

  it('reads 2012 as the skattekonto only where the SQL does (enskild firma)', () => {
    const lines: Line[] = [['2611', 300, 0], ['2012', 0, 300]]
    expect(momsredovisningShapeOfLines(toLines(lines), EF)).toBe('tax_account_shape')
    expect(momsredovisningShapeOfLines(toLines(lines), AB)).toBeNull()
  })

  // Shape 1 leaves a sale or a purchase with a same-side 2650/1650 line to the
  // rutor: no declaration-account line against a 2650/1650 line, and a
  // declaration line outside 26xx (a sales or purchase base). The cases
  // tests/pg/vat-net-shape-sales-base.pg.test.ts pins on the SQL.
  describe('a sale or a purchase with a same-side 2650/1650 line', () => {
    it.each<[string, Line[]]>([
      ['a sale with a 2650 line next to it, all in credit', SALE_WITH_2650_LINE],
      ['its storno, all in debit', flipped(SALE_WITH_2650_LINE)],
      ['a sale whose output VAT was booked on 2650', [['1510', 1250, 0], ['3001', 0, 1000], ['2650', 0, 250]]],
      ['a sale whose only 2650 line is a zero line', [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250], ['2650', 0, 0]]],
      ['a grant on 3980 next to a VAT refund on the skattekonto', [['1630', 30000, 0], ['3980', 0, 24000], ['1650', 0, 6000]]],
    ])('reads %s as an ordinary verifikat', (_label, lines) => {
      expect(momsredovisningShapeOfLines(toLines(lines), AB)).toBeNull()
    })

    it.each<[string, Line[]]>([
      ['a write-off of VAT balances to a cost', [['2641', 0, 488], ['2650', 0, 891], ['6992', 1379, 0]]],
      ['VAT balances moved to the owner', [['2641', 0, 475], ['1650', 0, 6369], ['2012', 6844, 0]]],
      ['a purchase whose only declaration line is 2641, next to a 1650 line', [['6110', 400, 0], ['2641', 100, 0], ['1650', 50, 0], ['1930', 0, 550]]],
      ['a sale whose only base line is a zero line', [['1930', 250, 0], ['3001', 0, 0], ['2611', 0, 150], ['2650', 0, 100]]],
    ])('still takes %s for a momsredovisning', (_label, lines) => {
      expect(momsredovisningShapeOfLines(toLines(lines), AB)).toBe('net_account_shape')
    })

    it.each<[string, Line[]]>([
      ['a settle-and-pay voucher that debits last period\'s 2650', [['2611', 1000, 0], ['2641', 0, 400], ['2650', 0, 600], ['2650', 500, 0], ['1930', 0, 500]]],
      ['a year-end voucher that clears the VAT next to a sales line', [['1510', 1000, 0], ['3001', 0, 1000], ['2611', 250, 0], ['2650', 0, 250]]],
      ['a correction that moves output VAT to 1650 next to a sales correction', [['2611', 300, 0], ['3001', 300, 0], ['3988', 0, 300], ['1650', 0, 300]]],
      ['a sale mixed with a refund whose VAT stands against the 2650 line', [...SALE_WITH_2650_LINE, ['3001', 100, 0], ['2611', 25, 0], ['1930', 0, 125]]],
    ])('keeps %s, with a line against 2650/1650, a momsredovisning', (_label, lines) => {
      expect(momsredovisningShapeOfLines(toLines(lines), AB)).toBe('net_account_shape')
    })

    it('reads a line stored with both sides by its net', () => {
      // A row from before the single-side constraint: 2650 nets to credit.
      const lines: VoucherImpactLine[] = [
        { account_number: '2611', debit_amount: 250, credit_amount: 0 },
        { account_number: '2650', debit_amount: 40, credit_amount: 290 },
      ]
      expect(momsredovisningShapeOfLines(lines, AB)).toBe('net_account_shape')
    })
  })
})

describe('rutorChangeOfLines', () => {
  it('folds the lines through the declared account-to-ruta map, signed as filed', () => {
    expect(rutorChangeOfLines(toLines([['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]]))).toEqual({
      ruta05: 1000, ruta10: 250, ruta49: 250,
    })
  })

  it('leaves out a ruta 49 that nets to zero', () => {
    expect(rutorChangeOfLines(toLines([['2645', 25, 0], ['2614', 0, 25], ['4535', 100, 0], ['2440', 0, 100]]))).toEqual({
      ruta21: 100, ruta30: 25, ruta48: 25,
    })
  })

  it('is empty for a voucher on no ruta account', () => {
    expect(rutorChangeOfLines(toLines([['6110', 400, 0], ['1930', 0, 400]]))).toEqual({})
  })

  it('reads the company\'s own classification', () => {
    const dynamic = {
      mappingByAccount: new Map([['3011', { box: 'ruta05' as const, side: 'credit' as const }]]),
      explicitAccounts: new Set(['3011']),
    }
    expect(rutorChangeOfLines(toLines([['1930', 100, 0], ['3011', 0, 100]]), dynamic)).toEqual({ ruta05: 100 })
    expect(rutorChangeOfLines(toLines([['1930', 100, 0], ['3011', 0, 100]]))).toEqual({})
  })
})

describe('voucherVatDeclarationImpact', () => {
  const impact = (lines: Line[], overrides: Partial<Parameters<typeof voucherVatDeclarationImpact>[0]> = {}) =>
    voucherVatDeclarationImpact({
      lines: toLines(lines),
      entryDate: '2026-10-25',
      isOpeningBalance: false,
      vatPeriod: OCTOBER,
      taxAccounts: AB,
      ...overrides,
    })

  it('says the crm#1447 correction stays out of the period\'s rutor, and why', () => {
    const result = impact(HISTORICAL_CORRECTION)
    expect(result).toMatchObject({
      status: 'ok',
      vat_period: OCTOBER,
      counted: false,
      excluded_as: 'net_account_shape',
      rutor_change: {},
    })
    expect(result.summary).toContain('Ingår inte i momsdeklarationen för Oktober 2026')
  })

  it('shows the rutor the same correction would move without its 2650 leg', () => {
    const result = impact([['5420', 1000, 0], ['2645', 0, 1000]])
    expect(result).toMatchObject({ counted: true, excluded_as: null, rutor_change: { ruta48: -1000, ruta49: 1000 } })
    expect(result.summary).toBe(`Ändrar momsdeklarationen för Oktober 2026: ruta 48 -${formatCurrency(1000)}, ruta 49 +${formatCurrency(1000)}.`)
  })

  it('says when the period it moves is already filed', () => {
    const filed = { ...OCTOBER, filed_on: '2026-11-12' }
    expect(impact([['5420', 1000, 0], ['2645', 0, 1000]], { vatPeriod: filed }).summary)
      .toContain('Momsperioden är redan deklarerad (inlämnad 2026-11-12)')
    // Nothing to say about a filed period when no ruta moves.
    expect(impact(HISTORICAL_CORRECTION, { vatPeriod: filed }).summary).not.toContain('redan deklarerad')
  })

  it('reads a sale with a 2650 line next to it: the rutor move by the sale', () => {
    const result = impact(SALE_WITH_2650_LINE)
    expect(result).toMatchObject({
      counted: true, excluded_as: null, rutor_change: { ruta05: 1000, ruta10: 250, ruta49: 250 },
    })
    expect(result.summary).toBe(
      `Ändrar momsdeklarationen för Oktober 2026: ruta 05 +${formatCurrency(1000)}, ruta 10 +${formatCurrency(250)}, ruta 49 +${formatCurrency(250)}.`,
    )
  })

  it('names the skattekonto shape', () => {
    expect(impact([['1630', 300, 0], ['2610', 0, 300]])).toMatchObject({
      counted: false, excluded_as: 'tax_account_shape', rutor_change: {},
    })
  })

  it('says when a counted voucher moves no ruta', () => {
    const result = impact([['6110', 400, 0], ['1930', 0, 400]])
    expect(result).toMatchObject({ counted: true, rutor_change: {} })
    expect(result.summary).toBe('Påverkar ingen ruta i momsdeklarationen.')
  })

  it('shows moving vilande moms from 2648 to 2641 as a ruta 48 deduction (crm#1562)', () => {
    const result = impact([['2641', 321.75, 0], ['2648', 0, 321.75]])
    expect(result).toMatchObject({ counted: true, excluded_as: null, rutor_change: { ruta48: 321.75, ruta49: -321.75 } })
    expect(result.summary).toBe(`Ändrar momsdeklarationen för Oktober 2026: ruta 48 +${formatCurrency(321.75)}, ruta 49 -${formatCurrency(321.75)}.`)
  })

  it('moves no ruta while moms rests on 2648', () => {
    const result = impact([['6210', 1287.25, 0], ['2648', 321.75, 0], ['1930', 0, 1609]])
    expect(result).toMatchObject({ counted: true, rutor_change: {} })
  })

  it('keeps an opening balance on the VAT period\'s first day out, and is never a shape', () => {
    const lines: Line[] = [['2641', 300, 0], ['2650', 0, 300]]
    expect(impact(lines, { isOpeningBalance: true, entryDate: '2026-10-01' })).toMatchObject({
      counted: false, excluded_as: 'opening_balance', rutor_change: {},
    })
  })

  it('leaves an opening balance later in the period undecided until posting', () => {
    const result = impact([['1630', 300, 0], ['2611', 0, 300]], { isOpeningBalance: true, entryDate: '2026-10-03' })
    expect(result).toMatchObject({ counted: null, excluded_as: null, rutor_change: { ruta10: 300, ruta49: 300 } })
    expect(result.summary).toContain('bara om inget annat verifikat i perioden är daterat före den')
  })

  it('works without a momsperiod setting', () => {
    const result = impact(HISTORICAL_CORRECTION, { vatPeriod: null })
    expect(result).toMatchObject({ vat_period: null, counted: false, excluded_as: 'net_account_shape' })
    expect(result.summary).toMatch(/^Ingår inte i momsdeklarationen: /)
  })
})

describe('previewVoucherVatDeclaration', () => {
  /** A client answering each table and RPC with a fixed result. */
  function fakeClient(answers: {
    settings?: { data: unknown; error?: unknown }
    taxAccounts?: { data: unknown; error?: unknown }
    chart?: unknown[]
    fiscalPeriod?: unknown
    deadlines?: unknown[]
  }) {
    const { supabase, calls } = createTableMockSupabase({
      company_settings: { data: answers.settings?.data ?? null, error: answers.settings?.error ?? null },
      chart_of_accounts: { data: answers.chart ?? [] },
      // The year that holds the date, or the company's years for the filing records.
      fiscal_periods: (chain) => ({
        data: chain.some((call) => call.method === 'maybeSingle' || call.method === 'single')
          ? (answers.fiscalPeriod ?? null)
          : answers.fiscalPeriod
            ? [answers.fiscalPeriod]
            : [],
      }),
      deadlines: { data: answers.deadlines ?? [] },
      'rpc:skattekonto_shape_accounts': {
        data: answers.taxAccounts?.data ?? null,
        error: answers.taxAccounts?.error ?? null,
      },
    })
    return {
      client: supabase as unknown as SupabaseClient,
      rpcs: () => calls.filter((c) => c.method === 'rpc').map((c) => c.table.slice('rpc:'.length)),
    }
  }

  const input = {
    entryDate: '2026-10-25',
    lines: toLines(HISTORICAL_CORRECTION),
    isOpeningBalance: false,
  }

  it('resolves the monthly period and reads the skattekonto accounts from the SQL', async () => {
    const { client, rpcs } = fakeClient({
      settings: { data: { vat_registered: true, moms_period: 'monthly' } },
      taxAccounts: { data: ['1630'] },
    })
    const result = await previewVoucherVatDeclaration(client, 'company-1', input)
    expect(rpcs()).toEqual(['skattekonto_shape_accounts'])
    expect(result).toMatchObject({ status: 'ok', vat_period: OCTOBER, counted: false, excluded_as: 'net_account_shape' })
  })

  it('carries the filing record of the period that holds the date', async () => {
    const { client } = fakeClient({
      settings: { data: { vat_registered: true, moms_period: 'monthly' } },
      taxAccounts: { data: ['1630'] },
      deadlines: [
        {
          id: 'd-1', tax_deadline_type: 'moms_monthly', tax_period: '2026-09', is_completed: true,
          completed_at: '2026-10-12T08:00:00Z', status: 'confirmed', notes: null, due_date: '2026-11-12',
        },
        {
          id: 'd-2', tax_deadline_type: 'moms_monthly', tax_period: '2026-10', is_completed: true,
          completed_at: '2026-11-10T08:00:00Z', status: 'confirmed', notes: null, due_date: '2026-12-14',
        },
      ],
    })
    const result = await previewVoucherVatDeclaration(client, 'company-1', input)
    expect(result.vat_period).toMatchObject({ label: 'Oktober 2026', filed_on: '2026-11-10' })
  })

  it('resolves a quarter', async () => {
    const { client } = fakeClient({
      settings: { data: { vat_registered: true, moms_period: 'quarterly' } },
      taxAccounts: { data: ['1630'] },
    })
    const result = await previewVoucherVatDeclaration(client, 'company-1', input)
    expect(result.vat_period).toEqual({
      type: 'quarterly', year: 2026, period: 4, start: '2026-10-01', end: '2026-12-31', label: 'Kvartal 4 2026', filed_on: null,
    })
  })

  it('takes helårsmoms from the räkenskapsår, named by the year it ends', async () => {
    const { client } = fakeClient({
      settings: { data: { vat_registered: true, moms_period: 'yearly' } },
      taxAccounts: { data: ['1630'] },
      fiscalPeriod: { period_start: '2026-07-01', period_end: '2027-06-30' },
    })
    const result = await previewVoucherVatDeclaration(client, 'company-1', input)
    expect(result.vat_period).toMatchObject({ type: 'yearly', year: 2027, period: 1, start: '2026-07-01', end: '2027-06-30' })
  })

  describe('helårsmoms on a broken räkenskapsår, read from the date alone (crm#2168)', () => {
    const years = [
      { period_start: '2024-07-01', period_end: '2025-06-30' },
      { period_start: '2025-07-01', period_end: '2026-06-30' },
    ]
    /** fiscal_periods answered by the range filters the query puts on it. */
    function brokenYearClient() {
      const { supabase } = createTableMockSupabase({
        company_settings: { data: { vat_registered: true, moms_period: 'yearly' } },
        chart_of_accounts: { data: [] },
        fiscal_periods: (chain) => {
          let rows = years
          for (const { method, args } of chain) {
            const [column, value] = args as ['period_start' | 'period_end', string]
            if (method === 'gte') rows = rows.filter((row) => row[column] >= value)
            if (method === 'lte') rows = rows.filter((row) => row[column] <= value)
          }
          const single = chain.some((call) => call.method === 'maybeSingle' || call.method === 'single')
          return { data: single ? (rows[0] ?? null) : rows }
        },
        deadlines: { data: [] },
        'rpc:skattekonto_shape_accounts': { data: ['1630'] },
      })
      return supabase as unknown as SupabaseClient
    }

    it('names the räkenskapsår that holds the date, not the one ending in its calendar year', async () => {
      const result = await previewVoucherVatDeclaration(brokenYearClient(), 'company-1', {
        entryDate: '2025-09-15',
        lines: toLines([['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]]),
        isOpeningBalance: false,
      })
      expect(result.vat_period).toMatchObject({ year: 2026, start: '2025-07-01', end: '2026-06-30', label: 'Helår 2026' })
      expect(result.summary).toContain('för Helår 2026')
    })

    it('reads an opening balance on the first day of that year as the year\'s first day', async () => {
      const result = await previewVoucherVatDeclaration(brokenYearClient(), 'company-1', {
        entryDate: '2025-07-01',
        lines: toLines([['1930', 1000, 0], ['2081', 0, 1000]]),
        isOpeningBalance: true,
      })
      expect(result).toMatchObject({ counted: false, excluded_as: 'opening_balance' })
    })
  })

  it('answers not_vat_registered without reading further', async () => {
    const { client, rpcs } = fakeClient({ settings: { data: { vat_registered: false, moms_period: null } } })
    const result = await previewVoucherVatDeclaration(client, 'company-1', input)
    expect(result).toMatchObject({ status: 'not_vat_registered', counted: null, rutor_change: {} })
    expect(rpcs()).toEqual([])
  })

  it('answers unavailable instead of throwing or claiming no change when a read fails', async () => {
    const { client } = fakeClient({
      settings: { data: { vat_registered: true, moms_period: 'monthly' } },
      taxAccounts: { data: null, error: { message: 'boom' } },
    })
    const result = await previewVoucherVatDeclaration(client, 'company-1', input)
    expect(result).toMatchObject({ status: 'unavailable', counted: null, excluded_as: null, rutor_change: {} })
  })
})
