import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: client.from() returns a fresh chainable builder whose
// terminal maybeSingle()/single() draw from a per-test results array
// (same pattern as year-end-service.test.ts).
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'limit', 'order']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return { from: vi.fn().mockImplementation(() => makeBuilder()) }
}

vi.mock('@/lib/reports/opening-balances', () => ({
  getOpeningBalances: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
}))

import { generateResultAppropriation } from '../result-appropriation-service'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import { createJournalEntry } from '@/lib/bookkeeping/engine'

const FAKE_ENTRY = { id: 'ra-1', voucher_series: 'A', voucher_number: 2 }

/**
 * Stub the period's ingående balans (IB) with the given per-account debit/credit
 * balances. The omföring reads 2099 from here, NOT the full trial balance, so
 * current-year period activity on 2099 can never skew the reclassified amount.
 */
function mockOpeningBalance(
  rows: Array<{ account_number: string; debit: number; credit: number }>
) {
  vi.mocked(getOpeningBalances).mockResolvedValue({
    balances: new Map(rows.map((r) => [r.account_number, { debit: r.debit, credit: r.credit }])),
    obEntryId: 'ob-1',
  } as never)
}

const AB = { data: { entity_type: 'aktiebolag' }, error: null }
const NO_EXISTING = { data: null, error: null }
const PERIOD = {
  data: { period_start: '2025-01-01', name: 'FY 2025', opening_balance_entry_id: 'ob-1' },
  error: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  vi.mocked(createJournalEntry).mockResolvedValue(FAKE_ENTRY as never)
})

describe('generateResultAppropriation', () => {
  it('posts Dr 2099 / Cr 2098 for a profit (AB)', async () => {
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2099', debit: 0, credit: 100000 }])

    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    expect(entry).toEqual(FAKE_ENTRY)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3] as {
      source_type: string
      entry_date: string
      voucher_series: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.source_type).toBe('result_appropriation')
    expect(input.entry_date).toBe('2025-01-01')
    expect(input.voucher_series).toBe('A')
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2099', debit_amount: 100000, credit_amount: 0 })
    )
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2098', debit_amount: 0, credit_amount: 100000 })
    )
  })

  it('posts Dr 2098 / Cr 2099 for a loss (AB)', async () => {
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2099', debit: 40000, credit: 0 }])

    await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    const input = vi.mocked(createJournalEntry).mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2098', debit_amount: 40000, credit_amount: 0 })
    )
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2099', debit_amount: 0, credit_amount: 40000 })
    )
  })

  it('returns null for a non-aktiebolag (enskild firma) without posting', async () => {
    results = [{ data: { entity_type: 'enskild_firma' }, error: null }]

    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    expect(entry).toBeNull()
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(getOpeningBalances).not.toHaveBeenCalled()
  })

  it('is idempotent: returns null when an appropriation entry already exists', async () => {
    results = [AB, { data: { id: 'ra-existing' }, error: null }]

    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    expect(entry).toBeNull()
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(getOpeningBalances).not.toHaveBeenCalled()
  })

  it('returns null when 2099 carries no IB balance', async () => {
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '1930', debit: 5000, credit: 0 }])

    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    expect(entry).toBeNull()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('defaults missing company_settings to aktiebolag and posts', async () => {
    results = [NO_EXISTING /* settings missing */, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2099', debit: 0, credit: 5000 }])

    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    expect(entry).toEqual(FAKE_ENTRY)
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('reclassifies the IB 2099 amount only: current-year 2099 activity is excluded', async () => {
    // getOpeningBalances reads the IB entry (the carried-forward prior result),
    // not the trial balance, so any current-year postings to 2099 in this period
    // (e.g. when the catch-up script runs mid-year) cannot inflate the omföring.
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2099', debit: 0, credit: 80000 }])

    await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    const input = vi.mocked(createJournalEntry).mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    // Exactly the IB amount (80000), regardless of any later 2099 activity.
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2099', debit_amount: 80000, credit_amount: 0 })
    )
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2098', debit_amount: 0, credit_amount: 80000 })
    )
  })
})
