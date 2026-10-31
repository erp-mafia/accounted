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
const accounts = (lines: Line[]) => lines.map(([account]) => account)

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
    expect(momsredovisningShapeOfLines(accounts(lines), AB)).toBe(expected)
  })

  it('reads 2012 as the skattekonto only where the SQL does (enskild firma)', () => {
    const lines: Line[] = [['2611', 300, 0], ['2012', 0, 300]]
    expect(momsredovisningShapeOfLines(accounts(lines), EF)).toBe('tax_account_shape')
    expect(momsredovisningShapeOfLines(accounts(lines), AB)).toBeNull()
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
      fiscal_periods: { data: answers.fiscalPeriod ?? null },
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
    fiscalPeriodId: 'fp-1',
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
