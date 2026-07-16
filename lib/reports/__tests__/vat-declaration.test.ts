import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: sequential result queue
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'or', 'not', 'order', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
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
} from '../vat-declaration'
import type { VatDeclaration } from '@/types'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  supabase = makeClient()
})

// ============================================================
// Pure function tests: no mocks needed
// ============================================================

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

  it('accepts accountingMethod parameter for backward compatibility', async () => {
    seedLedger([])

    const result = await calculateVatDeclaration(supabase, 'company-1', 'monthly', 2024, 1, 'cash')
    expect(result.rutor.ruta49).toBe(0)
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

  it('reproduces the user-reported bug: 2610 balance now reaches ruta10', async () => {
    // Customer screenshot scenario (simplified): 3001 + 2610 booked with the
    // correct VAT amount on the parent account. Before the fix, ruta10 read 0
    // and ruta49 incorrectly showed a refund.
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

  it('ignores fiscalPeriodId for monthly periods (calendar month, no lookup)', async () => {
    seedLedger([])

    const result = await calculateVatDeclaration(
      supabase, 'company-1', 'monthly', 2026, 3, 'accrual', { fiscalPeriodId: 'fp-1' },
    )

    expect(result.period.start).toBe('2026-03-01')
    expect(result.period.end).toBe('2026-03-31')
    // The räkenskapsår path is yearly-only: monthly makes no table query at
    // all, just the single totals RPC.
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })
})

// #984 (settlement-shaped entries never zero the report) moved to
// tests/pg/vat-declaration-totals-rpc.pg.test.ts: the shape detection and
// exclusion now live inside the get_vat_declaration_totals RPC, so the
// behavior is verified against real Postgres rather than a mocked client.
