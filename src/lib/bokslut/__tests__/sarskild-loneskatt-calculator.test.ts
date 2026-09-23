import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  calculateSarskildLoneskatt,
  SLP_RATE,
} from '../tax-provision/sarskild-loneskatt-calculator'

type LineFixture = { account_number: string; debit_amount: number; credit_amount: number }
type EntryFixture = {
  id: string
  status: 'posted' | 'reversed' | 'draft' | 'cancelled'
  company_id?: string
  fiscal_period_id?: string
  lines: LineFixture[]
}

function makeSupabaseWithEntries(entries: EntryFixture[]) {
  const tables: Record<string, Record<string, unknown>[]> = {
    journal_entries: entries.map(({ lines: _lines, ...entry }) => ({
      company_id: 'co', fiscal_period_id: 'fp', ...entry,
    })),
    journal_entry_lines: entries.flatMap((entry) => entry.lines.map((line, index) => ({
      id: `${entry.id}-${index}`, journal_entry_id: entry.id, ...line,
    }))),
  }
  // Apply the real query's filters to fixtures. Returning canned line rows
  // hid the bug by including reversed originals even when the query did not.
  const from = vi.fn((table: string) => {
    if (!(table in tables)) throw new Error(`Unexpected table: ${table}`)
    let rows = [...tables[table]]
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value)
        return builder
      }),
      in: vi.fn((column: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]))
        return builder
      }),
      order: vi.fn((column: string) => {
        rows.sort((a, b) => String(a[column]).localeCompare(String(b[column])))
        return builder
      }),
      range: vi.fn((start: number, end: number) => {
        rows = rows.slice(start, end + 1)
        return builder
      }),
      then: (resolve: (value: { data: typeof rows; error: null }) => void) =>
        resolve({ data: rows, error: null }),
    }
    return builder
  })
  return { from } as unknown as Parameters<
    typeof calculateSarskildLoneskatt
  >[0]
}

function makeSupabaseWithPensionLines(
  rows: Array<{ account_number?: string; debit_amount: number; credit_amount: number }>,
) {
  return makeSupabaseWithEntries([{
    id: 'entry-1',
    status: 'posted',
    lines: rows.map((row) => ({ account_number: '7410', ...row })),
  }])
}

/** Balanced vouchers, with negative amounts representing storno credits. */
function pensionEntry(
  id: string,
  status: EntryFixture['status'],
  pension: number,
  slp = 0,
  scope: Pick<EntryFixture, 'company_id' | 'fiscal_period_id'> = {},
): EntryFixture {
  return {
    id, status, ...scope,
    lines: ([['7412', pension], ['1930', -pension], ['7533', slp], ['2514', -slp]] as const)
      .filter(([, amount]) => amount !== 0)
      .map(([account_number, amount]) => ({
        account_number, debit_amount: Math.max(amount, 0), credit_amount: Math.max(-amount, 0),
      })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('calculateSarskildLoneskatt', () => {
  it('applies 24.26% to pension costs and posts 7533/2514', async () => {
    const supabase = makeSupabaseWithPensionLines([
      { debit_amount: 50_000, credit_amount: 0 },
      { debit_amount: 30_000, credit_amount: 0 },
    ])

    const result = await calculateSarskildLoneskatt(supabase, 'co', 'fp')

    expect(result).not.toBeNull()
    // base = 80_000, × 0.2426 = 19_408
    expect(result!.amount).toBe(19_408)
    expect(result!.lines[0].account_number).toBe('7533')
    expect(result!.lines[1].account_number).toBe('2514')
  })

  it('returns null when there are no pension costs', async () => {
    const supabase = makeSupabaseWithPensionLines([])
    const result = await calculateSarskildLoneskatt(supabase, 'co', 'fp')
    expect(result).toBeNull()
  })

  it('honors manual adjustment for pensionsavsättning on 2210', async () => {
    const supabase = makeSupabaseWithPensionLines([])
    const result = await calculateSarskildLoneskatt(supabase, 'co', 'fp', {
      manualAdjustment: 100_000,
    })
    expect(result).not.toBeNull()
    // 100_000 × 0.2426 = 24_260
    expect(result!.amount).toBe(24_260)
  })

  it('nets debits against credits (refund of pension premium reduces base)', async () => {
    const supabase = makeSupabaseWithPensionLines([
      { debit_amount: 50_000, credit_amount: 0 },
      { debit_amount: 0, credit_amount: 10_000 },
    ])
    const result = await calculateSarskildLoneskatt(supabase, 'co', 'fp')
    expect(result).not.toBeNull()
    // base = 40_000, × 0.2426 = 9_704
    expect(result!.amount).toBe(9_704)
  })

  it('subtracts SLP already posted to 7533 during the year (apply_slp on supplier invoices)', async () => {
    // 100 000 kr premies booked during the year: 40 000 kr of them were
    // flagged apply_slp, so 40 000 × 0.2426 = 9 704 kr already sits on 7533.
    // The year-end proposal must cover ONLY the remaining 60 000 kr.
    const supabase = makeSupabaseWithPensionLines([
      { account_number: '7412', debit_amount: 100_000, credit_amount: 0 },
      { account_number: '7533', debit_amount: 9_704, credit_amount: 0 },
    ])
    const result = await calculateSarskildLoneskatt(supabase, 'co', 'fp')
    expect(result).not.toBeNull()
    // 100_000 × 0.2426 − 9_704 = 24_260 − 9_704 = 14_556
    expect(result!.amount).toBe(14_556)
    const computation = result!.computation as { slpAlreadyPosted: number; base: number }
    expect(computation.slpAlreadyPosted).toBe(9_704)
    // Posted 7533 never shrinks the SLP BASE, only the proposal.
    expect(computation.base).toBe(100_000)
  })

  it('returns null when the year is already fully provisioned', async () => {
    const supabase = makeSupabaseWithPensionLines([
      { account_number: '7412', debit_amount: 10_000, credit_amount: 0 },
      { account_number: '7533', debit_amount: 2_426, credit_amount: 0 },
    ])
    const result = await calculateSarskildLoneskatt(supabase, 'co', 'fp')
    expect(result).toBeNull()
  })

  it('floors at zero when 7533 exceeds the computed SLP (never a negative disposition)', async () => {
    const supabase = makeSupabaseWithPensionLines([
      { account_number: '7412', debit_amount: 10_000, credit_amount: 0 },
      { account_number: '7533', debit_amount: 5_000, credit_amount: 0 },
    ])
    const result = await calculateSarskildLoneskatt(supabase, 'co', 'fp')
    expect(result).toBeNull()
  })

  it('nets 7533 credits (a stornoed SLP pair does not count as provisioned)', async () => {
    const supabase = makeSupabaseWithPensionLines([
      { account_number: '7412', debit_amount: 10_000, credit_amount: 0 },
      { account_number: '7533', debit_amount: 2_426, credit_amount: 0 },
      { account_number: '7533', debit_amount: 0, credit_amount: 2_426 },
    ])
    const result = await calculateSarskildLoneskatt(supabase, 'co', 'fp')
    expect(result).not.toBeNull()
    expect(result!.amount).toBe(2_426)
  })

  it('exposes the SLP rate constant', () => {
    expect(SLP_RATE).toBe(0.2426)
  })

  it.each([
    {
      name: 'a reversal does not erase a separate pension expense',
      entries: [
        pensionEntry('valid', 'posted', 10_000),
        pensionEntry('original', 'reversed', 20_000),
        pensionEntry('storno', 'posted', -20_000),
      ],
      expected: 2_426,
      pensionCostsBooked: 10_000,
    },
    {
      name: 'a correction uses the replacement pension expense',
      entries: [
        pensionEntry('original', 'reversed', 10_000),
        pensionEntry('storno', 'posted', -10_000),
        pensionEntry('replacement', 'posted', 15_000),
      ],
      expected: 3_639,
      pensionCostsBooked: 15_000,
    },
    {
      name: 'reversing an SLP provision does not double the next proposal',
      entries: [
        pensionEntry('expense', 'posted', 10_000),
        pensionEntry('provision', 'reversed', 0, 2_426),
        pensionEntry('storno', 'posted', 0, -2_426),
      ],
      expected: 2_426,
      pensionCostsBooked: 10_000,
    },
    {
      name: 'an imported pair with both entries posted still nets to zero',
      entries: [
        pensionEntry('valid', 'posted', 10_000),
        pensionEntry('original', 'posted', 20_000),
        pensionEntry('reversal', 'posted', -20_000),
      ],
      expected: 2_426,
      pensionCostsBooked: 10_000,
    },
    {
      name: 'a full reversal with no remaining pension costs proposes nothing',
      entries: [
        pensionEntry('original', 'reversed', 10_000),
        pensionEntry('storno', 'posted', -10_000),
      ],
      expected: 0,
    },
    {
      name: 'a corrected and fully provisioned expense proposes nothing',
      entries: [
        pensionEntry('original', 'reversed', 10_000, 2_426),
        pensionEntry('storno', 'posted', -10_000, -2_426),
        pensionEntry('replacement', 'posted', 15_000, 3_639),
      ],
      expected: 0,
    },
    {
      name: 'company, fiscal period, draft and cancelled exclusions remain intact',
      entries: [
        pensionEntry('valid', 'posted', 10_000),
        pensionEntry('other-company', 'posted', 20_000, 0, { company_id: 'other' }),
        pensionEntry('other-company-reversed', 'reversed', 30_000, 0, { company_id: 'other' }),
        pensionEntry('other-period', 'posted', 40_000, 0, { fiscal_period_id: 'other' }),
        pensionEntry('other-period-reversed', 'reversed', 50_000, 0, { fiscal_period_id: 'other' }),
        pensionEntry('draft', 'draft', 60_000),
        pensionEntry('cancelled', 'cancelled', 70_000),
      ],
      expected: 2_426,
      pensionCostsBooked: 10_000,
    },
  ])('$name', async ({ entries, expected, pensionCostsBooked }) => {
    const result = await calculateSarskildLoneskatt(makeSupabaseWithEntries(entries), 'co', 'fp')

    if (expected === 0) {
      expect(result).toBeNull()
    } else {
      expect(result).toMatchObject({
        amount: expected,
        computation: { pensionCostsBooked, slpAlreadyPosted: 0 },
        lines: [
          { account_number: '7533', debit_amount: expected, credit_amount: 0 },
          { account_number: '2514', debit_amount: 0, credit_amount: expected },
        ],
      })
    }
  })
})
