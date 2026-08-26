import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: sequential result queue
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

/**
 * The company's own class 3 accounts, as fetchDynamicRuta05Accounts reads
 * them. Answered off a table-routed builder rather than the sequential queue:
 * every calculateVatDeclaration test would otherwise have to seed one, and a
 * missing seed would silently hand the chart query the ledger result.
 */
let chartAccounts: Array<{
  account_number: string
  account_name?: string
  account_class?: number
  default_vat_rate: number | null
  default_vat_treatment?: string | null
}>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'or', 'not', 'order', 'range', 'limit']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

/**
 * chart_of_accounts builder. The real query returns all active class 3 rows:
 * fetchDynamicRuta05Accounts applies configured-rate and narrow missing-rate
 * fallback rules in memory.
 */
function makeChartBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'not', 'order', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.then = (resolve: (v: unknown) => void) =>
    resolve({
      data: chartAccounts.map((account) => ({
        account_name: '',
        account_class: 3,
        default_vat_treatment: null,
        ...account,
      })),
      error: null,
    })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) =>
      table === 'chart_of_accounts' ? makeChartBuilder() : makeBuilder()
    ),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

/**
 * Seed one get_vat_declaration_totals RPC result from line-level fixtures.
 * The helper only SUMS the seeded lines per account (plain arithmetic on the
 * fixture, mirroring what SQL's GROUP BY returns); settlement-shape
 * detection and exclusion happen inside the RPC and are covered by
 * tests/pg/vat-declaration-totals-rpc.pg.test.ts against real Postgres.
 */
function seedLedger(
  lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>,
  sourceTypes: string[] = [],
) {
  const byAccount = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const t = byAccount.get(l.account_number) ?? { debit: 0, credit: 0 }
    t.debit += l.debit_amount
    t.credit += l.credit_amount
    byAccount.set(l.account_number, t)
  }
  const source_type_counts: Record<string, number> = {}
  for (const s of sourceTypes) source_type_counts[s] = (source_type_counts[s] ?? 0) + 1
  results.push({
    data: {
      totals: [...byAccount].map(([account_number, t]) => ({
        account_number,
        debit: t.debit,
        credit: t.credit,
      })),
      settlement_shaped_entries: [],
      source_type_counts,
    },
    error: null,
  })
}

import {
  calculatePeriodDates,
  formatPeriodLabel,
  getVatDeclarationSummary,
  calculateVatDeclaration,
  rcInputTotalsFromDeclaration,
  rutorFromTotals,
} from '../vat-declaration'
import { runVatDeclarationChecks } from '../vat-declaration-checks'
import type { VatDeclaration } from '@/types'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  chartAccounts = []
  supabase = makeClient()
})

// ============================================================
// Pure function tests: no mocks needed
// ============================================================

describe('rutorFromTotals: explicit account VAT treatments', () => {
  it('puts a custom sales account in ruta 05', () => {
    const totals = new Map([['3041', { debit: 0, credit: 1000 }]])
    const rutor = rutorFromTotals(totals, {
      mappingByAccount: new Map([['3041', { box: 'ruta05', side: 'credit' }]]),
      explicitAccounts: new Set(['3041']),
    })
    expect(rutor.ruta05).toBe(1000)
  })

  it('puts a custom EU purchase account in ruta 20', () => {
    const totals = new Map([['4056', { debit: 1000, credit: 0 }]])
    const rutor = rutorFromTotals(totals, {
      mappingByAccount: new Map([['4056', { box: 'ruta20', side: 'debit' }]]),
      explicitAccounts: new Set(['4056']),
    })
    expect(rutor.ruta20).toBe(1000)
  })

  it('lets an explicit treatment replace a static BAS mapping', () => {
    const totals = new Map([['3001', { debit: 0, credit: 1000 }]])
    const rutor = rutorFromTotals(totals, {
      mappingByAccount: new Map([['3001', { box: 'ruta42', side: 'credit' }]]),
      explicitAccounts: new Set(['3001']),
    })
    expect(rutor.ruta05).toBe(0)
    expect(rutor.ruta42).toBe(1000)
  })
})

describe('rutorFromTotals: ruta 41 (omvänd skattskyldighet, sales side)', () => {
  it('projects 3231/3232/3233 credit balances into ruta 41', () => {
    const totals = new Map([
      ['3231', { debit: 0, credit: 100_000 }],
      ['3232', { debit: 500, credit: 10_500 }],
      ['3233', { debit: 0, credit: 0 }],
    ])
    const rutor = rutorFromTotals(totals)
    expect(rutor.ruta41).toBe(110_000)
    // Buyer accounts for the VAT: an RC sale must not leak into the
    // taxable-sales pairing (rutor 05-08) nor into the net (ruta 49).
    expect(rutor.ruta05).toBe(0)
    expect(rutor.ruta49).toBe(0)
  })

  it('a pure ruta 41 declaration passes the sales/output pairing checks', () => {
    const totals = new Map([['3231', { debit: 0, credit: 50_000 }]])
    const rutor = rutorFromTotals(totals)
    const findings = runVatDeclarationChecks(rutor)
    expect(findings.map((f) => f.code)).not.toContain('TAXABLE_SALES_WITHOUT_OUTPUT')
    expect(findings.map((f) => f.code)).not.toContain('OUTPUT_VAT_WITHOUT_SALES_BASE')
  })
})

describe('calculatePeriodDates', () => {
  it('returns correct dates for monthly period', () => {
    const { start, end } = calculatePeriodDates('monthly', 2024, 1)
    expect(start).toBe('2024-01-01')
    expect(end).toBe('2024-01-31')
  })

  it('returns correct dates for monthly period 12 (December)', () => {
    const { start, end } = calculatePeriodDates('monthly', 2024, 12)
    expect(start).toBe('2024-12-01')
    expect(end).toBe('2024-12-31')
  })

  it('returns correct dates for quarterly period', () => {
    const q1 = calculatePeriodDates('quarterly', 2024, 1)
    expect(q1.start).toBe('2024-01-01')
    expect(q1.end).toBe('2024-03-31')

    const q4 = calculatePeriodDates('quarterly', 2024, 4)
    expect(q4.start).toBe('2024-10-01')
    expect(q4.end).toBe('2024-12-31')
  })

  it('returns full year for yearly period', () => {
    const { start, end } = calculatePeriodDates('yearly', 2024, 1)
    expect(start).toBe('2024-01-01')
    expect(end).toBe('2024-12-31')
  })
})

describe('formatPeriodLabel', () => {
  it('formats monthly period', () => {
    expect(formatPeriodLabel('monthly', 2024, 1)).toBe('Januari 2024')
    expect(formatPeriodLabel('monthly', 2024, 6)).toBe('Juni 2024')
    expect(formatPeriodLabel('monthly', 2024, 12)).toBe('December 2024')
  })

  it('formats quarterly period', () => {
    expect(formatPeriodLabel('quarterly', 2024, 3)).toBe('Kvartal 3 2024')
  })

  it('formats yearly period', () => {
    expect(formatPeriodLabel('yearly', 2024, 1)).toBe('Helår 2024')
  })
})

describe('getVatDeclarationSummary', () => {
  const emptyRc = { ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0, ruta30: 0, ruta31: 0, ruta32: 0 }
  const zeroExtras = { ruta08: 0, ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0, ruta41: 0, ruta42: 0, ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0 }

  it('calculates totals and detects payment', () => {
    const declaration: VatDeclaration = {
      period: { type: 'monthly', year: 2024, period: 1, start: '2024-01-01', end: '2024-01-31' },
      rutor: {
        ruta05: 10000, ruta06: 0, ruta07: 0,
        ruta10: 2500, ruta11: 0, ruta12: 0,
        ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
        ruta30: 0, ruta31: 0, ruta32: 0,
        ruta39: 0, ruta40: 0,
        ruta48: 1000, ruta49: 1500,
        ...zeroExtras,
      },
      invoiceCount: 5,
      transactionCount: 10,
      breakdown: {
        invoices: { ruta05: 10000, ruta06: 0, ruta07: 0, ruta10: 2500, ruta11: 0, ruta12: 0, ruta39: 0, ruta40: 0, base25: 10000, base12: 0, base6: 0 },
        transactions: { ruta48: 1000 },
        receipts: { ruta48: 0 },
        reverseCharge: emptyRc,
      },
    }

    const summary = getVatDeclarationSummary(declaration)
    expect(summary.totalOutputVat).toBe(2500)
    expect(summary.totalInputVat).toBe(1000)
    expect(summary.vatToPay).toBe(1500)
    expect(summary.isRefund).toBe(false)
  })

  it('identifies refund when ruta49 is negative', () => {
    const declaration: VatDeclaration = {
      period: { type: 'monthly', year: 2024, period: 1, start: '2024-01-01', end: '2024-01-31' },
      rutor: {
        ruta05: 2000, ruta06: 0, ruta07: 0,
        ruta10: 500, ruta11: 0, ruta12: 0,
        ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
        ruta30: 0, ruta31: 0, ruta32: 0,
        ruta39: 0, ruta40: 0,
        ruta48: 3000, ruta49: -2500,
        ...zeroExtras,
      },
      invoiceCount: 1,
      transactionCount: 20,
      breakdown: {
        invoices: { ruta05: 2000, ruta06: 0, ruta07: 0, ruta10: 500, ruta11: 0, ruta12: 0, ruta39: 0, ruta40: 0, base25: 2000, base12: 0, base6: 0 },
        transactions: { ruta48: 3000 },
        receipts: { ruta48: 0 },
        reverseCharge: emptyRc,
      },
    }

    const summary = getVatDeclarationSummary(declaration)
    expect(summary.isRefund).toBe(true)
    expect(summary.vatToPay).toBe(-2500)
  })

  it('includes ruta30-32 in totalOutputVat', () => {
    const declaration: VatDeclaration = {
      period: { type: 'monthly', year: 2024, period: 1, start: '2024-01-01', end: '2024-01-31' },
      rutor: {
        ruta05: 10000, ruta06: 0, ruta07: 0,
        ruta10: 2500, ruta11: 0, ruta12: 0,
        ruta20: 0, ruta21: 5000, ruta22: 0, ruta23: 0, ruta24: 0,
        ruta30: 1250, ruta31: 0, ruta32: 0,
        ruta39: 0, ruta40: 0,
        ruta48: 2250, ruta49: 1500,
        ...zeroExtras,
      },
      invoiceCount: 2,
      transactionCount: 0,
      breakdown: {
        invoices: { ruta05: 10000, ruta06: 0, ruta07: 0, ruta10: 2500, ruta11: 0, ruta12: 0, ruta39: 0, ruta40: 0, base25: 10000, base12: 0, base6: 0 },
        transactions: { ruta48: 0 },
        receipts: { ruta48: 0 },
        reverseCharge: { ruta20: 0, ruta21: 5000, ruta22: 0, ruta23: 0, ruta24: 0, ruta30: 1250, ruta31: 0, ruta32: 0 },
      },
    }

    const summary = getVatDeclarationSummary(declaration)
    // totalOutputVat = ruta10 + ruta30 = 2500 + 1250 = 3750
    expect(summary.totalOutputVat).toBe(3750)
  })
})

// ============================================================
// Ledger-based VAT declaration tests
//
// The calculator makes ONE get_vat_declaration_totals RPC call per period
// (per-account totals + settlement-shaped entries + source_type counts in a
// single jsonb payload). Yearly periods with a fiscalPeriodId additionally
// look up fiscal_periods first. Settlement-shape exclusion (#984) lives in
// the RPC's SQL and is covered by the pg-real test
// (tests/pg/vat-declaration-totals-rpc.pg.test.ts).
// ============================================================

describe('calculateVatDeclaration', () => {
  it('returns all zeros when no ledger lines exist', async () => {
    seedLedger([])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(0)
    expect(result.rutor.ruta10).toBe(0)
    expect(result.rutor.ruta11).toBe(0)
    expect(result.rutor.ruta12).toBe(0)
    expect(result.rutor.ruta30).toBe(0)
    expect(result.rutor.ruta31).toBe(0)
    expect(result.rutor.ruta32).toBe(0)
    expect(result.rutor.ruta48).toBe(0)
    expect(result.rutor.ruta49).toBe(0)
    expect(result.invoiceCount).toBe(0)
    expect(result.transactionCount).toBe(0)
  })

  it('does not report a refundable deposit credited to a liability account as turnover', async () => {
    seedLedger(
      [
        { account_number: '1510', debit_amount: 10000, credit_amount: 0 },
        { account_number: '2897', debit_amount: 0, credit_amount: 10000 },
      ],
      ['invoice_created'],
    )

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(0)
    expect(result.rutor.ruta42).toBe(0)
    expect(result.rutor.ruta49).toBe(0)
    expect(result.invoiceCount).toBe(1)
  })

  it('sums output VAT to ruta10/11/12 and revenue to ruta05', async () => {
    seedLedger(
      [
        { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
        { account_number: '2621', debit_amount: 0, credit_amount: 600 },
        { account_number: '2631', debit_amount: 0, credit_amount: 180 },
        { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
        { account_number: '3002', debit_amount: 0, credit_amount: 5000 },
        { account_number: '3003', debit_amount: 0, credit_amount: 3000 },
      ],
      ['invoice_created', 'invoice_created'],
    )

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta10).toBe(2500)
    expect(result.rutor.ruta11).toBe(600)
    expect(result.rutor.ruta12).toBe(180)
    expect(result.rutor.ruta05).toBe(18000)
    expect(result.breakdown.invoices.base25).toBe(10000)
    expect(result.breakdown.invoices.base12).toBe(5000)
    expect(result.breakdown.invoices.base6).toBe(3000)
    expect(result.invoiceCount).toBe(2)
  })

  it('sums input VAT from 2641 debit balance', async () => {
    seedLedger(
      [
        { account_number: '2641', debit_amount: 250, credit_amount: 0 },
        { account_number: '2641', debit_amount: 120, credit_amount: 0 },
      ],
      ['bank_transaction', 'bank_transaction'],
    )

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta48).toBe(370)
    expect(result.transactionCount).toBe(2)
  })

  it('includes calculated input VAT (2645) from EU reverse charge in ruta48', async () => {
    seedLedger([
      { account_number: '2645', debit_amount: 500, credit_amount: 0 },
      { account_number: '2641', debit_amount: 200, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta48).toBe(700)
  })

  it('maps EU/export revenue to ruta39/ruta40', async () => {
    seedLedger([
      { account_number: '3308', debit_amount: 0, credit_amount: 8000 },
      { account_number: '3305', debit_amount: 0, credit_amount: 12000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta39).toBe(8000)
    expect(result.rutor.ruta40).toBe(12000)
  })

  it('handles credit notes as net reduction on revenue/VAT accounts', async () => {
    seedLedger(
      [
        // Invoice: C2611 2500, C3001 10000
        { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
        { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
        // Credit note reversal: D2611 625, D3001 2500
        { account_number: '2611', debit_amount: 625, credit_amount: 0 },
        { account_number: '3001', debit_amount: 2500, credit_amount: 0 },
      ],
      ['invoice_created', 'credit_note'],
    )

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta10).toBe(1875)
    expect(result.rutor.ruta05).toBe(7500)
    expect(result.invoiceCount).toBe(2)
  })

  it('calculates ruta49 as output minus input VAT', async () => {
    seedLedger([
      { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
      { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
      { account_number: '2641', debit_amount: 350, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta10).toBe(2500)
    expect(result.rutor.ruta05).toBe(10000)
    expect(result.rutor.ruta48).toBe(350)
    expect(result.rutor.ruta49).toBe(2150) // 2500 - 350
  })

  it('detects refund when input VAT exceeds output VAT', async () => {
    seedLedger([
      { account_number: '2611', debit_amount: 0, credit_amount: 500 },
      { account_number: '2641', debit_amount: 3000, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta49).toBe(-2500) // 500 - 3000
  })


  it('throws a labelled error when the RPC fails', async () => {
    results = [{ data: null, error: { message: 'permission denied' } }]

    await expect(
      calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1),
    ).rejects.toThrow('get_vat_declaration_totals failed: permission denied')
  })

  it('handles all three VAT rates in a single period', async () => {
    seedLedger([
      { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
      { account_number: '3002', debit_amount: 0, credit_amount: 5000 },
      { account_number: '2621', debit_amount: 0, credit_amount: 600 },
      { account_number: '3003', debit_amount: 0, credit_amount: 3000 },
      { account_number: '2631', debit_amount: 0, credit_amount: 180 },
      { account_number: '2641', debit_amount: 1000, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'quarterly', 2024, 1)

    expect(result.rutor.ruta10).toBe(2500)
    expect(result.rutor.ruta11).toBe(600)
    expect(result.rutor.ruta12).toBe(180)
    expect(result.rutor.ruta05).toBe(18000)
    expect(result.rutor.ruta48).toBe(1000)
    expect(result.rutor.ruta49).toBe(2280)
  })
})

// ============================================================
// Reverse charge: purchase bases (ruta 20-24) sourced from cost accounts
// ============================================================

describe('calculateVatDeclaration: reverse charge', () => {
  it('maps 2614/2624/2634 credit balances to ruta30/31/32', async () => {
    seedLedger([
      { account_number: '2614', debit_amount: 0, credit_amount: 1250 },
      { account_number: '2624', debit_amount: 0, credit_amount: 120 },
      { account_number: '2634', debit_amount: 0, credit_amount: 60 },
      { account_number: '2645', debit_amount: 1430, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta30).toBe(1250)
    expect(result.rutor.ruta31).toBe(120)
    expect(result.rutor.ruta32).toBe(60)
    expect(result.rutor.ruta48).toBe(1430)
    // ruta49 = (0+0+0 + 1250+120+60) - 1430 = 0
    expect(result.rutor.ruta49).toBe(0)
  })

  it('includes ruta30-32 in ruta49 formula', async () => {
    seedLedger([
      { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
      { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
      { account_number: '2614', debit_amount: 0, credit_amount: 500 },
      { account_number: '2641', debit_amount: 300, credit_amount: 0 },
      { account_number: '2645', debit_amount: 500, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta10).toBe(2500)
    expect(result.rutor.ruta30).toBe(500)
    expect(result.rutor.ruta48).toBe(800)
    expect(result.rutor.ruta49).toBe(2200) // (2500 + 500) - 800
  })

  it('populates ruta20 from EU goods cost accounts (4515/4516/4517)', async () => {
    // EU goods purchase: D 4515 25000, D 2645 6250, C 2614 6250, C 2440 25000
    seedLedger([
      { account_number: '4515', debit_amount: 25000, credit_amount: 0 },
      { account_number: '2614', debit_amount: 0, credit_amount: 6250 },
      { account_number: '2645', debit_amount: 6250, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta20).toBe(25000)
    expect(result.rutor.ruta21).toBe(0)
    expect(result.rutor.ruta30).toBe(6250)
    expect(result.rutor.ruta48).toBe(6250)
    // Reverse charge is VAT-neutral: output VAT exactly offsets input VAT
    expect(result.rutor.ruta49).toBe(0)
  })

  it('populates ruta21 from EU services cost accounts (4535/4536/4537)', async () => {
    seedLedger([
      { account_number: '4535', debit_amount: 5000, credit_amount: 0 },
      { account_number: '2614', debit_amount: 0, credit_amount: 1250 },
      { account_number: '2645', debit_amount: 1250, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta21).toBe(5000)
    expect(result.rutor.ruta20).toBe(0)
    expect(result.rutor.ruta22).toBe(0)
    expect(result.rutor.ruta30).toBe(1250)
    expect(result.breakdown.reverseCharge.ruta21).toBe(5000)
    expect(result.breakdown.reverseCharge.ruta30).toBe(1250)
  })

  it('populates ruta22 from non-EU services cost accounts (4531/4532/4533)', async () => {
    // Anthropic-style: D 4531 3000, D 2645 750, C 2614 750, C 2440 3000
    seedLedger([
      { account_number: '4531', debit_amount: 3000, credit_amount: 0 },
      { account_number: '2614', debit_amount: 0, credit_amount: 750 },
      { account_number: '2645', debit_amount: 750, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta22).toBe(3000)
    expect(result.rutor.ruta21).toBe(0)
    expect(result.rutor.ruta20).toBe(0)
    expect(result.rutor.ruta30).toBe(750)
  })

  it('populates ruta23 from domestic goods reverse-charge cost accounts (4415/4416/4417)', async () => {
    // Domestic mobile reverse charge: D 4415 100000, D 2647 25000, C 2614 25000, C 2440 100000
    seedLedger([
      { account_number: '4415', debit_amount: 100000, credit_amount: 0 },
      { account_number: '2614', debit_amount: 0, credit_amount: 25000 },
      { account_number: '2647', debit_amount: 25000, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta23).toBe(100000)
    expect(result.rutor.ruta24).toBe(0)
    expect(result.rutor.ruta30).toBe(25000)
    expect(result.rutor.ruta48).toBe(25000)
    expect(result.rutor.ruta49).toBe(0) // VAT-neutral
  })

  it('populates ruta24 from domestic services reverse-charge cost accounts (4425/4426/4427)', async () => {
    seedLedger([
      { account_number: '4425', debit_amount: 8000, credit_amount: 0 },
      { account_number: '2614', debit_amount: 0, credit_amount: 2000 },
      { account_number: '2647', debit_amount: 2000, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta24).toBe(8000)
    expect(result.rutor.ruta23).toBe(0)
    expect(result.rutor.ruta30).toBe(2000)
  })

  it('returns zero ruta20-24 when no reverse-charge cost-account activity', async () => {
    seedLedger([
      { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
      { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta20).toBe(0)
    expect(result.rutor.ruta21).toBe(0)
    expect(result.rutor.ruta22).toBe(0)
    expect(result.rutor.ruta23).toBe(0)
    expect(result.rutor.ruta24).toBe(0)
  })

  it('reverse-charge credit notes net out the cost-account debit balance', async () => {
    // Original purchase: D 4535 5000; reversal (credit note): C 4535 1000
    seedLedger([
      { account_number: '4535', debit_amount: 5000, credit_amount: 0 },
      { account_number: '4535', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2614', debit_amount: 0, credit_amount: 1250 },
      { account_number: '2614', debit_amount: 250, credit_amount: 0 },
      { account_number: '2645', debit_amount: 1250, credit_amount: 0 },
      { account_number: '2645', debit_amount: 0, credit_amount: 250 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta21).toBe(4000) // 5000 - 1000
    expect(result.rutor.ruta30).toBe(1000) // 1250 - 250
    expect(result.rutor.ruta48).toBe(1000) // 1250 - 250
  })

  it('maps domestic reverse-charge input VAT (2647) to ruta48', async () => {
    seedLedger([
      { account_number: '2647', debit_amount: 500, credit_amount: 0 },
      { account_number: '2614', debit_amount: 0, credit_amount: 500 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta48).toBe(500)
    expect(result.rutor.ruta30).toBe(500)
    expect(result.rutor.ruta49).toBe(0)
  })
})

// ============================================================
// Import (ruta 50, 60-62) and Ruta 06 (uttag) and Ruta 42 (exempt)
// ============================================================

describe('calculateVatDeclaration: import, uttag, exempt', () => {
  it('maps import VAT accounts (2615/2625/2635) to ruta60/61/62', async () => {
    seedLedger([
      { account_number: '2615', debit_amount: 0, credit_amount: 2500 },
      { account_number: '2625', debit_amount: 0, credit_amount: 600 },
      { account_number: '2635', debit_amount: 0, credit_amount: 180 },
      { account_number: '2641', debit_amount: 3280, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta60).toBe(2500)
    expect(result.rutor.ruta61).toBe(600)
    expect(result.rutor.ruta62).toBe(180)
    expect(result.rutor.ruta49).toBe(0) // 3280 - 3280
  })

  it('populates ruta50 (import beskattningsunderlag) from 4545-4547', async () => {
    // Full import flow: D 4545 10000, C 2615 2500, D 2641 2500
    seedLedger([
      { account_number: '4545', debit_amount: 10000, credit_amount: 0 },
      { account_number: '2615', debit_amount: 0, credit_amount: 2500 },
      { account_number: '2641', debit_amount: 2500, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    // Ruta 50 (base) and Ruta 60 (output VAT) BOTH non-zero: required by SKV §4.1.1.4
    // ERROR rule "Det måste finnas ett belopp i fält 50, eftersom det finns ett belopp i 60-62"
    expect(result.rutor.ruta50).toBe(10000)
    expect(result.rutor.ruta60).toBe(2500)
    expect(result.rutor.ruta48).toBe(2500)
  })

  it('populates ruta06 from uttag accounts (3401/3402/3403)', async () => {
    // Uttag: D 2010 (private withdrawal); C 3401 1000 + C 2612 250 (25% rate uttag)
    seedLedger([
      { account_number: '3401', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2612', debit_amount: 0, credit_amount: 250 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta06).toBe(1000)
    expect(result.rutor.ruta10).toBe(250) // 2612 maps to ruta10 (25% output VAT including uttag)
  })

  it('expanded ruta42 covers 3004, 3100, 3404, 3994, 3980', async () => {
    seedLedger([
      { account_number: '3004', debit_amount: 0, credit_amount: 1000 },
      { account_number: '3100', debit_amount: 0, credit_amount: 2000 },
      { account_number: '3404', debit_amount: 0, credit_amount: 500 },
      { account_number: '3980', debit_amount: 0, credit_amount: 3000 },
      { account_number: '3994', debit_amount: 0, credit_amount: 1500 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta42).toBe(8000) // 1000+2000+500+3000+1500
  })

  it('maps EU/export revenue variants (3108/3105) to ruta35/36', async () => {
    seedLedger([
      { account_number: '3108', debit_amount: 0, credit_amount: 15000 },
      { account_number: '3105', debit_amount: 0, credit_amount: 8000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta35).toBe(15000)
    expect(result.rutor.ruta36).toBe(8000)
  })

  it('maps output VAT variant accounts (2612/2623/2636) to correct rutor', async () => {
    seedLedger([
      { account_number: '2612', debit_amount: 0, credit_amount: 1000 }, // egna uttag 25%
      { account_number: '2623', debit_amount: 0, credit_amount: 200 },  // uthyrning 12%
      { account_number: '2636', debit_amount: 0, credit_amount: 50 },   // VMB 6%
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta10).toBe(1000)
    expect(result.rutor.ruta11).toBe(200)
    expect(result.rutor.ruta12).toBe(50)
  })

  it('handles zero output VAT on some rates but non-zero on others', async () => {
    seedLedger(
      [
        { account_number: '2621', debit_amount: 0, credit_amount: 600 },
        { account_number: '3002', debit_amount: 0, credit_amount: 5000 },
        { account_number: '2641', debit_amount: 200, credit_amount: 0 },
      ],
      ['invoice_created'],
    )

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta10).toBe(0)
    expect(result.rutor.ruta11).toBe(600)
    expect(result.rutor.ruta12).toBe(0)
    expect(result.rutor.ruta48).toBe(200)
    expect(result.rutor.ruta49).toBe(400) // 600 - 200
  })

  it('rounds sub-öre amounts via Math.round * 100 / 100', async () => {
    seedLedger([
      { account_number: '2611', debit_amount: 0, credit_amount: 0.001 },
      { account_number: '3001', debit_amount: 0, credit_amount: 0.004 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta10).toBe(0)
    expect(result.rutor.ruta05).toBe(0)
  })
})

// ============================================================
// SKV §4.1.1.4 cross-field contract checks
//
// Skatteverket's kontrollera endpoint runs these checks server-side. Mirror
// them locally so we catch declaration drift in unit tests, before a network
// call. ERROR rules block submission; WARNING rules don't.
// ============================================================

describe('SKV §4.1.1.4 cross-field contracts', () => {
  it('ERROR: taxable sales base requires output VAT (rule 1)', async () => {
    // SKV: if any of momspliktigForsaljning/momspliktigaUttag/vinstmarginal/hyresInkomst > 0,
    //      at least one of momsForsaljningUtgaende{Hog,Medel,Lag} must be > 0.
    seedLedger([
      { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
      // No 2611/2621/2631 booked: would trigger SKV ERROR
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)
    const r = result.rutor

    const hasBase = r.ruta05 + r.ruta06 + r.ruta07 + r.ruta08 > 0
    const hasOutput = r.ruta10 + r.ruta11 + r.ruta12 > 0
    expect(hasBase).toBe(true)
    expect(hasOutput).toBe(false)
    // Local invariant: this combination would fail SKV kontrollera with ERROR.
    // The calculator does not auto-correct: the ledger must be fixed upstream.
  })

  it('ERROR: reverse-charge purchase base requires output VAT (rule 3)', async () => {
    // If any of inkopVarorEU/inkopTjansterEU/inkopTjansterUtanforEU/inkopVarorSE/inkopTjansterSE > 0,
    // at least one of momsInkopUtgaende{Hog,Medel,Lag} must be > 0.
    seedLedger([
      { account_number: '4535', debit_amount: 5000, credit_amount: 0 },
      // No 2614/2624/2634 booked: would trigger SKV ERROR
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)
    const r = result.rutor

    const hasRcBase = r.ruta20 + r.ruta21 + r.ruta22 + r.ruta23 + r.ruta24 > 0
    const hasRcOutput = r.ruta30 + r.ruta31 + r.ruta32 > 0
    expect(hasRcBase).toBe(true)
    expect(hasRcOutput).toBe(false)
  })

  it('ERROR: import base requires import output VAT (rule 5)', async () => {
    // If import (ruta50) > 0, at least one of momsImportUtgaende{Hog,Medel,Lag} must be > 0.
    seedLedger([
      { account_number: '4545', debit_amount: 10000, credit_amount: 0 },
      // No 2615/2625/2635 booked: would trigger SKV ERROR
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)
    const r = result.rutor

    expect(r.ruta50).toBe(10000)
    expect(r.ruta60 + r.ruta61 + r.ruta62).toBe(0)
  })

  it('ERROR: import output VAT requires import base (rule 6)', async () => {
    // If any of momsImportUtgaende{Hog,Medel,Lag} > 0, import (ruta50) must be > 0.
    // This is the BLOCKER scenario the Phase 1b refactor fixes: previously ruta50 was
    // never populated, so any import VAT booking would fail SKV's contract.
    seedLedger([
      { account_number: '2615', debit_amount: 0, credit_amount: 2500 },
      { account_number: '2641', debit_amount: 2500, credit_amount: 0 },
      { account_number: '4545', debit_amount: 10000, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)
    const r = result.rutor

    // Both populated: passes SKV's rule 6
    expect(r.ruta50).toBe(10000)
    expect(r.ruta60).toBe(2500)
  })

  it('ERROR: summaMoms must equal (ruta10+11+12+30+31+32+60+61+62) − ruta48 (rule 7)', async () => {
    // The calculator computes ruta49 from the formula directly, so this invariant
    // holds by construction. This test is the canary that catches drift if anyone
    // ever adds an extra term or rate to the form.
    seedLedger([
      { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
      { account_number: '2621', debit_amount: 0, credit_amount: 600 },
      { account_number: '2631', debit_amount: 0, credit_amount: 180 },
      { account_number: '2614', debit_amount: 0, credit_amount: 1250 },
      { account_number: '2615', debit_amount: 0, credit_amount: 500 },
      { account_number: '2641', debit_amount: 1000, credit_amount: 0 },
      { account_number: '2645', debit_amount: 1250, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)
    const r = result.rutor

    const expected = r.ruta10 + r.ruta11 + r.ruta12
                   + r.ruta30 + r.ruta31 + r.ruta32
                   + r.ruta60 + r.ruta61 + r.ruta62
                   - r.ruta48
    expect(r.ruta49).toBe(expected)
  })
})

// ============================================================
// Parent/summary BAS accounts: 2610/2620/2630 (output),
// 2618/2628/2638 (vilande), 2640 (input parent).
//
// Users who post directly to the group account (manual entries, SIE imports,
// alternate templates) had their balances silently dropped before this fix
// because only the leaf accounts were mapped.
// ============================================================

describe('calculateVatDeclaration: parent/summary accounts', () => {
  it('maps 2610 (parent) to ruta10 when posted directly', async () => {
    seedLedger([
      { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
      { account_number: '2610', debit_amount: 0, credit_amount: 2500 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(10000)
    expect(result.rutor.ruta10).toBe(2500)
    expect(result.rutor.ruta49).toBe(2500) // owed, not refund
  })

  it('maps 2620 (parent) to ruta11 and 2630 (parent) to ruta12', async () => {
    seedLedger([
      { account_number: '2620', debit_amount: 0, credit_amount: 600 },
      { account_number: '2630', debit_amount: 0, credit_amount: 180 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta11).toBe(600)
    expect(result.rutor.ruta12).toBe(180)
  })

  it('maps vilande output VAT (2618/2628/2638) to ruta10/11/12', async () => {
    // Vilande accounts hold output VAT for invoices that have been sent but not
    // yet paid, used by cash-method bookkeepers per BFNAR 2006:1.
    seedLedger([
      { account_number: '2618', debit_amount: 0, credit_amount: 500 },
      { account_number: '2628', debit_amount: 0, credit_amount: 120 },
      { account_number: '2638', debit_amount: 0, credit_amount: 60 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta10).toBe(500)
    expect(result.rutor.ruta11).toBe(120)
    expect(result.rutor.ruta12).toBe(60)
  })

  it('sums parent and sub-account balances on the same ruta', async () => {
    // If a ledger has activity on both the parent and the sub-accounts (mixed
    // bookkeeping practice, SIE imports, etc.), the ruta reflects the literal
    // ledger total: accounting truth wins.
    seedLedger([
      { account_number: '2610', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 500 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta10).toBe(1500)
  })

  it('maps 2640 (input VAT parent) to ruta48', async () => {
    seedLedger([
      { account_number: '2640', debit_amount: 200, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta48).toBe(200)
    expect(result.rutor.ruta49).toBe(-200) // refund
  })

  it('maps year-end input VAT on 2648 to ruta48', async () => {
    seedLedger([{ account_number: '2648', debit_amount: 250, credit_amount: 0 }])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta48).toBe(250)
  })

  it('reproduces the user-reported bug: 2610 balance now reaches ruta10', async () => {
    // Customer screenshot scenario (simplified): 3001 + 2610 booked with the
    // correct VAT amount on the parent account. Before the fix, ruta10 read 0
    // and ruta49 incorrectly showed a refund.
    // Yearly without fiscalPeriodId now looks up the räkenskapsår ending in
    // the year first; no fiscal period rows → calendar fallback.
    results = [{ data: null, error: null }]
    seedLedger([
      { account_number: '3001', debit_amount: 0, credit_amount: 21600 },
      { account_number: '2610', debit_amount: 0, credit_amount: 9768 },
      { account_number: '2641', debit_amount: 7048.45, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'yearly', 2025, 1)

    expect(result.rutor.ruta05).toBe(21600)
    expect(result.rutor.ruta10).toBe(9768)
    expect(result.rutor.ruta48).toBe(7048.45)
    expect(result.rutor.ruta49).toBe(2719.55) // 9768 − 7048.45, owed (was −7048.45 pre-fix)
  })
})

// ============================================================
// #1261: the company's OWN revenue accounts reach ruta 05.
//
// ACCOUNT_RUTA maps 3000-3003 only, and Accounted's BAS chart ships no
// varugrupp accounts at all, so a company selling on 3013 had that revenue
// dropped from the declaration entirely: the map's keys ARE the account filter
// sent to the aggregation RPC. Membership now comes from the konto's own
// "Standard moms" (chart_of_accounts.default_vat_rate).
// ============================================================

describe('calculateVatDeclaration: company-specific ruta 05 accounts', () => {
  it('infers a missing rate only from a matching domestic-sales number and label (#1289)', async () => {
    chartAccounts = [{
      account_number: '3011',
      account_name: 'Försäljning tjänster inom Sverige, 25 % moms',
      default_vat_rate: null,
    }]
    seedLedger([
      { account_number: '3011', debit_amount: 0, credit_amount: 9725 },
      { account_number: '2611', debit_amount: 0, credit_amount: 2431.25 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)
    const findings = runVatDeclarationChecks(result.rutor)

    expect(result.rutor.ruta05).toBe(9725)
    expect(result.rutor.ruta10).toBe(2431.25)
    expect(result.breakdown.invoices.base25).toBe(9725)
    expect(findings.map((f) => f.code)).not.toContain('OUTPUT_VAT_WITHOUT_SALES_BASE')
  })

  it('includes a user-added revenue account carrying a moms-sats', async () => {
    chartAccounts = [{ account_number: '3013', default_vat_rate: 0.06 }]
    seedLedger([
      { account_number: '3013', debit_amount: 0, credit_amount: 8000 },
      { account_number: '2631', debit_amount: 0, credit_amount: 480 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(8000)
    expect(result.rutor.ruta12).toBe(480)
  })

  it('books the account into the base bucket of its own sats', async () => {
    // Without this the ruta 05 total would have no matching base25/12/6, and
    // the proportional SALES_OUTPUT_VAT_SHORTFALL check reads an unaccounted
    // base as missing utgående moms.
    chartAccounts = [
      { account_number: '3011', default_vat_rate: 0.25 },
      { account_number: '3013', default_vat_rate: 0.06 },
    ]
    seedLedger([
      { account_number: '3011', debit_amount: 0, credit_amount: 4000 },
      { account_number: '3013', debit_amount: 0, credit_amount: 1000 },
      { account_number: '3001', debit_amount: 0, credit_amount: 2000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(7000)
    expect(result.breakdown.invoices.base25).toBe(6000)  // 3001 + 3011
    expect(result.breakdown.invoices.base6).toBe(1000)   // 3013
    expect(result.breakdown.invoices.base12).toBe(0)
  })

  it('counts a 3000 gruppkonto balance in ruta 05 exactly once', async () => {
    // 3000 is already summed into ruta 05 by the static map. Surfacing its
    // "Standard moms" must not also add it to the dynamic account list, which
    // would double the filed figure.
    chartAccounts = [{ account_number: '3000', default_vat_rate: 0.25 }]
    seedLedger([
      { account_number: '3000', debit_amount: 0, credit_amount: 5000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 1250 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(5000)
    expect(result.rutor.ruta10).toBe(1250)
  })

  it('books a rated 3000 into its base bucket so the split adds up to ruta 05', async () => {
    chartAccounts = [{ account_number: '3000', default_vat_rate: 0.25 }]
    seedLedger([
      { account_number: '3000', debit_amount: 0, credit_amount: 5000 },
      { account_number: '3001', debit_amount: 0, credit_amount: 2000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(7000)
    expect(result.breakdown.invoices.base25).toBe(7000)  // 3001 + 3000
    expect(result.breakdown.invoices.base12).toBe(0)
    expect(result.breakdown.invoices.base6).toBe(0)
  })

  it('leaves 3000 in ruta 05 with no base bucket when no sats is set', async () => {
    // The filed figure is unaffected: only the breakdown is incomplete, and
    // the checks derive their expected base from the output-VAT rutor.
    chartAccounts = []
    seedLedger([{ account_number: '3000', debit_amount: 0, credit_amount: 5000 }])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(5000)
    expect(result.breakdown.invoices.base25).toBe(0)
  })

  it('nets a credit note booked as a debit on the account', async () => {
    chartAccounts = [{ account_number: '3013', default_vat_rate: 0.06 }]
    seedLedger([
      { account_number: '3013', debit_amount: 0, credit_amount: 8000 },
      { account_number: '3013', debit_amount: 1000, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(7000)
    expect(result.breakdown.invoices.base6).toBe(7000)
  })

  it('does not double-count an account the static map already owns', async () => {
    // The BAS backfill sets 3001 = 25 %, so it comes back from the chart query
    // too. Counting it in both projections would double ruta 05.
    chartAccounts = [{ account_number: '3001', default_vat_rate: 0.25 }]
    seedLedger([
      { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(10000)
    expect(result.breakdown.invoices.base25).toBe(10000)
  })

  it('leaves accounts that belong to another ruta out of ruta 05', async () => {
    // VMB (3211) is ruta 07 and 3231 is ruta 41. Neither is mappable yet, so
    // they stay out of the declaration: filing an amount in the wrong box is
    // worse than omitting it.
    chartAccounts = [
      { account_number: '3211', default_vat_rate: 0.25 },
      { account_number: '3231', default_vat_rate: 0.25 },
    ]
    seedLedger([
      { account_number: '3211', debit_amount: 0, credit_amount: 5000 },
      { account_number: '3231', debit_amount: 0, credit_amount: 3000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(0)
  })

  it('keeps an account the ACCOUNT_TO_BOX mirror already maps in its own ruta', async () => {
    // 3108 is momsfri EU-leverans (ruta 35). A user who sets a sats on it must
    // not move it to ruta 05.
    chartAccounts = [{ account_number: '3108', default_vat_rate: 0.25 }]
    seedLedger([{ account_number: '3108', debit_amount: 0, credit_amount: 4000 }])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta35).toBe(4000)
    expect(result.rutor.ruta05).toBe(0)
  })

  it('routes momspliktig EU-försäljning (3106) to ruta 05', async () => {
    // 3106 carries Swedish moms (buyer not VAT-registered), so it is ordinary
    // momspliktig försäljning. Neither ACCOUNT_RUTA nor the mirror maps it; the
    // MCP report has widened ruta 05 with it by hand for the same reason.
    chartAccounts = [{ account_number: '3106', default_vat_rate: 0.25 }]
    seedLedger([
      { account_number: '3106', debit_amount: 0, credit_amount: 2000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 500 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(2000)
    expect(result.breakdown.invoices.base25).toBe(2000)
  })

  it('keeps accounts with the oss treatment out of every ruta, static 3001 included', async () => {
    // Unionsordningen: the sale is declared in the quarterly OSS declaration
    // and must not appear in the Swedish momsdeklaration at all. The explicit
    // treatment also overrides the static BAS mapping of a 3001-style number.
    chartAccounts = [
      { account_number: '3001', default_vat_rate: null, default_vat_treatment: 'oss' },
      {
        account_number: '3106',
        account_name: 'Försäljning enl. OSS (Tyskland 19%)',
        default_vat_rate: null,
        default_vat_treatment: 'oss',
      },
    ]
    seedLedger([
      { account_number: '3001', debit_amount: 0, credit_amount: 7000 },
      { account_number: '3106', debit_amount: 0, credit_amount: 2000 },
      { account_number: '2670', debit_amount: 0, credit_amount: 1710 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(0)
    expect(result.rutor.ruta10).toBe(0)
    expect(result.rutor.ruta35).toBe(0)
    expect(result.rutor.ruta42).toBe(0)
    expect(result.breakdown.invoices.base25).toBe(0)
  })

  it('ignores missing rates without matching evidence and keeps explicit 0 % authoritative', async () => {
    // A number or a free-text label alone is not enough, and an explicit
    // "Ingen moms" always wins over the fallback convention.
    chartAccounts = [
      { account_number: '3013', account_name: 'Varugrupp C', default_vat_rate: null },
      { account_number: '3011', account_name: 'Varugrupp A, 25 % moms', default_vat_rate: 0 },
      { account_number: '3098', account_name: 'Försäljning 25 % moms', default_vat_rate: null },
      { account_number: '3023', account_name: 'Försäljning 25 % moms', default_vat_rate: null },
    ]
    seedLedger([
      { account_number: '3013', debit_amount: 0, credit_amount: 8000 },
      { account_number: '3011', debit_amount: 0, credit_amount: 2000 },
      { account_number: '3098', debit_amount: 0, credit_amount: 1000 },
      { account_number: '3023', debit_amount: 0, credit_amount: 500 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(0)
  })

  it('requires the word "moms" after the percent and refuses an ambiguous label', async () => {
    // Two deliberate rules, pinned here so neither is loosened by accident:
    //   - a bare percent is not a moms-sats. "provision 25 %" and "konsult 25 %"
    //     are a margin and a rate of pay; reading either as a sats would file
    //     revenue into ruta 05 off a word the user never wrote.
    //   - a label naming two different sats resolves to nothing rather than to
    //     whichever it spells out first: neither figure is trustworthy, and
    //     picking one silently splits breakdown.invoices.base25/12/6 wrong.
    chartAccounts = [
      { account_number: '3011', account_name: 'Försäljning konsult 25 %', default_vat_rate: null },
      {
        account_number: '3021',
        account_name: 'Försäljning varugrupp 1, provision 25 %',
        default_vat_rate: null,
      },
      {
        account_number: '3031',
        account_name: 'Försäljning 25 % moms och 6 % moms',
        default_vat_rate: null,
      },
    ]
    seedLedger([
      { account_number: '3011', debit_amount: 0, credit_amount: 4000 },
      { account_number: '3021', debit_amount: 0, credit_amount: 3000 },
      { account_number: '3031', debit_amount: 0, credit_amount: 2000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(0)
  })

  it('lets a contradicting label veto the fallback even when number and sats agree', async () => {
    // The 30x1 suffix and the "25 % moms" label both point at domestic taxable
    // sales, but the rest of the name says the konto is something else: omvänd
    // betalningsskyldighet belongs in ruta 41, VMB in ruta 07, export in
    // ruta 36 and momsfritt in ruta 42. Ruta 05 is the wrong box for all four,
    // so the fallback stands down and the konto keeps its unresolved
    // behaviour (omission) rather than being filed somewhere it does not go.
    chartAccounts = [
      {
        account_number: '3011',
        account_name: 'Försäljning byggtjänster 25 % moms, omvänd betalningsskyldighet',
        default_vat_rate: null,
      },
      {
        account_number: '3021',
        account_name: 'Försäljning begagnat 25 % moms (VMB)',
        default_vat_rate: null,
      },
      {
        account_number: '3031',
        account_name: 'Export utanför EU, tidigare 25 % moms',
        default_vat_rate: null,
      },
      {
        account_number: '3041',
        account_name: 'Momsfri försäljning, tidigare 25 % moms',
        default_vat_rate: null,
      },
    ]
    seedLedger([
      { account_number: '3011', debit_amount: 0, credit_amount: 5000 },
      { account_number: '3021', debit_amount: 0, credit_amount: 4000 },
      { account_number: '3031', debit_amount: 0, credit_amount: 3000 },
      { account_number: '3041', debit_amount: 0, credit_amount: 2000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(0)
  })

  it('does not let a percentage ending in zero trip the 0 % veto', async () => {
    // The veto's "0 %" alternative needs a leading word boundary: without one it
    // also matches the trailing zero of "10/20/30/100 %", so an ordinary
    // domestic sales konto whose name happens to mention a discount or a share
    // would be dropped from ruta 05 and then raise a blocking
    // OUTPUT_VAT_WITHOUT_SALES_BASE. Both names below are momspliktig
    // försäljning inom Sverige: agreeing 30x1 suffix, agreeing "25 % moms".
    chartAccounts = [
      {
        account_number: '3011',
        account_name: 'Försäljning varor 25 % moms, rabatt 30 %',
        default_vat_rate: null,
      },
      {
        account_number: '3021',
        account_name: 'Försäljning varor 25 % moms, 100 % ägt dotterbolag',
        default_vat_rate: null,
      },
    ]
    seedLedger([
      { account_number: '3011', debit_amount: 0, credit_amount: 5000 },
      { account_number: '3021', debit_amount: 0, credit_amount: 3000 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(8000)
  })

  it('still vetoes a konto whose label states a genuine 0 % sats', async () => {
    // The other side of the boundary fix: a real "0 %" label must keep vetoing.
    chartAccounts = [
      {
        account_number: '3011',
        account_name: 'Försäljning 0 % moms',
        default_vat_rate: null,
      },
    ]
    seedLedger([{ account_number: '3011', debit_amount: 0, credit_amount: 5000 }])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    expect(result.rutor.ruta05).toBe(0)
  })

  it('adds the accounts to p_accounts but never to p_ruta_accounts', async () => {
    // p_ruta_accounts is the settlement SHAPE detector inside the RPC: an entry
    // touching it plus 2650/1650 is classified a momsredovisning and dropped
    // from the totals. A plain sale booked 1930 / 3013 / 2650 would then vanish
    // from its own declaration. This is invisible to an outcome assertion, so
    // assert the RPC arguments directly.
    chartAccounts = [{ account_number: '3013', default_vat_rate: 0.06 }]
    seedLedger([{ account_number: '3013', debit_amount: 0, credit_amount: 8000 }])

    await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)

    const [, args] = supabase.rpc.mock.calls[0]
    expect(args.p_accounts).toContain('3013')
    expect(args.p_ruta_accounts).not.toContain('3013')
    expect(args.p_ruta_accounts).toContain('3001') // static list still intact
  })

  it('clears the blocking OUTPUT_VAT_WITHOUT_SALES finding (#1261)', async () => {
    // The reported symptom was not just an understated ruta 05: with ruta05 = 0
    // and output VAT on 2611, runVatDeclarationChecks failed the declaration
    // with a blocking ERROR and the user could not file at all.
    chartAccounts = [{ account_number: '3013', default_vat_rate: 0.06 }]
    seedLedger([
      { account_number: '3013', debit_amount: 0, credit_amount: 8000 },
      { account_number: '2631', debit_amount: 0, credit_amount: 480 },
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1)
    const findings = runVatDeclarationChecks(result.rutor)

    expect(findings.map((f) => f.code)).not.toContain('OUTPUT_VAT_WITHOUT_SALES')
    expect(findings.map((f) => f.code)).not.toContain('SALES_OUTPUT_VAT_SHORTFALL')
  })
})

describe('calculateVatDeclaration: annual VAT spans the räkenskapsår', () => {
  it('uses the fiscal period bounds for yearly when a fiscalPeriodId is given', async () => {
    // Förlängt räkenskapsår (extended first year, 18 months): annual VAT
    // (helårsmoms) must cover the whole period, not the calendar year that
    // period_start falls in. The first queued result feeds the fiscal_periods
    // lookup; seedLedger then queues the RPC payload.
    results = [
      { data: { period_start: '2025-07-03', period_end: '2026-12-31' }, error: null },
    ]
    seedLedger([
      { account_number: '3001', debit_amount: 0, credit_amount: 21600 },
      { account_number: '2610', debit_amount: 0, credit_amount: 9768 },
      { account_number: '2641', debit_amount: 7048.45, credit_amount: 0 },
    ])

    const result = await calculateVatDeclaration(
      supabase, 'company-1', 'yearly', 2026, 1, 'accrual', { fiscalPeriodId: 'fp-1' },
    )

    expect(result.period.start).toBe('2025-07-03')
    expect(result.period.end).toBe('2026-12-31')
    expect(result.rutor.ruta05).toBe(21600)
    expect(result.rutor.ruta10).toBe(9768)
    expect(result.rutor.ruta48).toBe(7048.45)
  })

  it('falls back to the calendar year when the fiscal period cannot be resolved', async () => {
    results = [
      { data: null, error: null }, // fiscal_periods lookup → not found
    ]
    seedLedger([])

    const result = await calculateVatDeclaration(
      supabase, 'company-1', 'yearly', 2026, 1, 'accrual', { fiscalPeriodId: 'missing' },
    )

    expect(result.period.start).toBe('2026-01-01')
    expect(result.period.end).toBe('2026-12-31')
  })

  it('resolves the räkenskapsår ending in the year for yearly WITHOUT a fiscalPeriodId', async () => {
    // Broken FY 2025-07-01 → 2026-06-30: a yearly submission for 2026 with no
    // explicit fiscal period (e.g. before the FY selector populated) must
    // still target the actual räkenskapsår, not calendar 2026
    // (SFL 26 kap 10-11 §§).
    results = [
      { data: { period_start: '2025-07-01', period_end: '2026-06-30' }, error: null },
    ]
    seedLedger([])

    const result = await calculateVatDeclaration(
      supabase, 'company-1', 'yearly', 2026, 1, 'accrual',
    )

    expect(result.period.start).toBe('2025-07-01')
    expect(result.period.end).toBe('2026-06-30')
  })

  it('falls back to the calendar year for yearly without a fiscalPeriodId when no fiscal period exists', async () => {
    results = [
      { data: null, error: null }, // no fiscal period ending in 2026
    ]
    seedLedger([])

    const result = await calculateVatDeclaration(
      supabase, 'company-1', 'yearly', 2026, 1, 'accrual',
    )

    expect(result.period.start).toBe('2026-01-01')
    expect(result.period.end).toBe('2026-12-31')
  })

  it('ignores fiscalPeriodId for monthly periods (calendar month, no lookup)', async () => {
    seedLedger([])

    const result = await calculateVatDeclaration(
      supabase, 'company-1', 'monthly', 2026, 3, 'accrual', { fiscalPeriodId: 'fp-1' },
    )

    expect(result.period.start).toBe('2026-03-01')
    expect(result.period.end).toBe('2026-03-31')
    // The räkenskapsår path is yearly-only: monthly never touches
    // fiscal_periods. (chart_of_accounts is read on every period type, for the
    // company's own ruta 05 accounts.)
    expect(supabase.from).not.toHaveBeenCalledWith('fiscal_periods')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })
})

// ============================================================
// The reverse-charge input pair that travels with the declaration
// ============================================================
//
// Why the declaration carries 2645/2647 at all: runVatDeclarationChecks only
// runs the sharp RC_INPUT_VAT_MISMATCH comparison when a caller hands it
// per-account totals. The web UI reads the declaration over HTTP and has no
// ledger access of its own, so without this pair on the response it was stuck
// with the ruta 48 fallback, and ruta 48 aggregates 2640-2649: ordinary
// debiterad ingående moms on 2641 hid a completely missing RC input.

/**
 * Same per-account aggregation seedLedger feeds the RPC mock, as the FULL totals
 * map. Used to prove the 2-entry projection produces identical findings, which
 * is also what pins RC_INPUT_VAT_ACCOUNTS to the private RC_INPUT_ACCOUNTS list
 * inside vat-declaration-checks: the fixtures below carry a balance on every
 * OTHER ruta 48 account, so if one of them ever counted as reverse-charge input
 * the two maps would disagree here.
 */
function totalsFromLines(
  lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>,
): Map<string, { debit: number; credit: number }> {
  const byAccount = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const t = byAccount.get(l.account_number) ?? { debit: 0, credit: 0 }
    t.debit += l.debit_amount
    t.credit += l.credit_amount
    byAccount.set(l.account_number, t)
  }
  return byAccount
}

const debit = (account_number: string, debit_amount: number) =>
  ({ account_number, debit_amount, credit_amount: 0 })
const credit = (account_number: string, credit_amount: number) =>
  ({ account_number, debit_amount: 0, credit_amount })

/**
 * The masking case, as a ledger: 50 000 kr of fiktiv utgående moms (2614) with
 * its basbelopp correctly on 4535, no beräknad ingående moms at all, and 60 000
 * kr of ordinary 2641 alongside it. Every other ruta 48 account carries a
 * balance too, so ruta 48 (70 000) stays above the RC output and the aggregate
 * comparison is silent while 50 000 kr of deductible moms is missing.
 */
const MASKED_RC_LINES = [
  debit('4535', 200000),   // ruta 21 basis: 50 000 / 0.25, so no FK004 finding
  credit('2614', 50000),    // ruta 30 fiktiv utgående moms
  debit('2641', 60000),    // ordinary debiterad ingående moms: the mask
  debit('2640', 1000),
  debit('2642', 2000),
  debit('2646', 3000),
  debit('2649', 4000),     // blandad verksamhet: deliberately NOT reverse-charge input
]

describe('calculateVatDeclaration: rcInputAccountTotals', () => {
  it('exposes both RC input accounts, netting credits against debits', async () => {
    seedLedger([
      debit('2645', 12000),
      credit('2645', 2000),   // storno of one fiktiv-moms pair
      debit('2647', 500),
      debit('2641', 60000),  // not part of the pair
    ])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2026, 1)

    expect(result.rcInputAccountTotals).toEqual({
      '2645': { debit: 12000, credit: 2000 },
      '2647': { debit: 500, credit: 0 },
    })
    // Only the pair, never the rest of the period's account balances.
    expect(Object.keys(result.rcInputAccountTotals!)).toEqual(['2645', '2647'])
  })

  it('carries both keys as zeros when the period has no RC input', async () => {
    seedLedger([debit('2641', 60000)])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2026, 1)

    // Present-and-zero, not absent: absent has to keep meaning "this producer
    // does not carry the pair", which is what the HTTP fallback reads.
    expect(result.rcInputAccountTotals).toEqual({
      '2645': { debit: 0, credit: 0 },
      '2647': { debit: 0, credit: 0 },
    })
  })

  it('warns on the masked RC shortfall, which the ruta 48 fallback misses', async () => {
    seedLedger(MASKED_RC_LINES)

    const declaration = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2026, 1)

    expect(declaration.rutor.ruta30).toBe(50000)
    expect(declaration.rutor.ruta48).toBe(70000)

    // Unwired: no second argument, so the check compares against ruta 48 and
    // says nothing at all.
    expect(runVatDeclarationChecks(declaration.rutor)).toEqual([])

    // Wired the way the web UI now calls it.
    const findings = runVatDeclarationChecks(
      declaration.rutor,
      rcInputTotalsFromDeclaration(declaration),
    )
    const mismatch = findings.find((f) => f.code === 'RC_INPUT_VAT_MISMATCH')
    expect(mismatch?.status).toBe('WARNING')
    // \s, not a literal space: sv-SE groups thousands with a no-break space.
    expect(mismatch?.message).toMatch(/50\s000 kr saknas/)
  })

  it('behaves identically on the 2-entry projection and the full totals map', async () => {
    seedLedger(MASKED_RC_LINES)
    const declaration = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2026, 1)

    expect(
      runVatDeclarationChecks(declaration.rutor, rcInputTotalsFromDeclaration(declaration)),
    ).toEqual(
      runVatDeclarationChecks(declaration.rutor, totalsFromLines(MASKED_RC_LINES)),
    )
  })

  it('behaves identically on a partial shortfall too, values and not just zeros', async () => {
    const lines = [...MASKED_RC_LINES, debit('2645', 20000)] // 20 000 of the 50 000 booked
    seedLedger(lines)
    const declaration = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2026, 1)

    const projected = runVatDeclarationChecks(
      declaration.rutor,
      rcInputTotalsFromDeclaration(declaration),
    )
    expect(projected).toEqual(
      runVatDeclarationChecks(declaration.rutor, totalsFromLines(lines)),
    )
    expect(
      projected.find((f) => f.code === 'RC_INPUT_VAT_MISMATCH')?.message,
    ).toMatch(/30\s000 kr saknas/)
  })

  it('stays silent when 2645 mirrors the fiktiv utgående moms exactly', async () => {
    seedLedger([...MASKED_RC_LINES, debit('2645', 50000)])
    const declaration = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2026, 1)

    expect(
      runVatDeclarationChecks(declaration.rutor, rcInputTotalsFromDeclaration(declaration)),
    ).toEqual([])
  })

  it('leaves a company with no reverse charge at all untouched', async () => {
    // Plain domestic SEK trading: sales with output VAT and ordinary input VAT.
    seedLedger([
      credit('3001', 400000),
      credit('2611', 100000),
      debit('2641', 60000),
    ])
    const declaration = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2026, 1)

    expect(
      runVatDeclarationChecks(declaration.rutor, rcInputTotalsFromDeclaration(declaration)),
    ).toEqual([])
    expect(runVatDeclarationChecks(declaration.rutor)).toEqual([])
  })
})

describe('rcInputTotalsFromDeclaration', () => {
  it('rebuilds the map the checks consume, keyed by account number', () => {
    const map = rcInputTotalsFromDeclaration({
      rcInputAccountTotals: { '2645': { debit: 1250, credit: 0 }, '2647': { debit: 0, credit: 0 } },
    })
    expect(map?.get('2645')).toEqual({ debit: 1250, credit: 0 })
    expect(map?.size).toBe(2)
  })

  it('returns undefined, not an empty map, when the pair is absent', () => {
    // A response from a deploy that predates the field. undefined makes the
    // check fall back to ruta 48; an empty map would read as "0 kr beräknad
    // ingående moms" and turn a correct declaration into a false warning.
    expect(rcInputTotalsFromDeclaration({})).toBeUndefined()
  })
})

// #984 (settlement-shaped entries never zero the report) moved to
// tests/pg/vat-declaration-totals-rpc.pg.test.ts: the shape detection and
// exclusion now live inside the get_vat_declaration_totals RPC, so the
// behavior is verified against real Postgres rather than a mocked client.
