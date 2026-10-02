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

// Hand-booked dispositions in the period (none unless a test says so).
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: vi.fn(),
}))

// The year-end previews look up the next period (none unless a test says so).
vi.mock('../period-service', () => ({
  findNextPeriod: vi.fn(),
}))

import { generateResultAppropriation, previewResultAppropriation } from '../result-appropriation-service'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { fetchEntryLines } from '@/lib/bookkeeping/entry-lines'
import { findNextPeriod } from '../period-service'
import { carryAfterDispositions } from '../prior-result-carry'

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
  vi.mocked(fetchEntryLines).mockResolvedValue([] as never)
  vi.mocked(findNextPeriod).mockResolvedValue(null)
})

/** Lines of one live entry in the period, as fetchEntryLines returns them. */
function entryLines(
  id: string,
  sourceType: string,
  voucher: number,
  lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
) {
  return lines.map((l) => ({
    journal_entry_id: id,
    ...l,
    journal_entries: { id, source_type: sourceType, voucher_series: 'A', voucher_number: voucher },
  }))
}

describe('generateResultAppropriation', () => {
  it('posts Dr 2069 / Cr 2068 for an ideell förening profit', async () => {
    results = [{ data: { entity_type: 'ideell_forening' }, error: null }, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2069', debit: 0, credit: 25000 }])

    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    expect(entry).toEqual(FAKE_ENTRY)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3] as {
      description: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.description).toContain('2069 → 2068')
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2069', debit_amount: 25000, credit_amount: 0 })
    )
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2068', debit_amount: 0, credit_amount: 25000 })
    )
  })

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

  it('idempotency filter is posted-only: a reversed omföring must not block re-planning', async () => {
    // After an administrative year-end undo, the period's omföring is
    // status='reversed' (storno-cancelled, net zero on 2099). The re-run has
    // to be able to post a fresh one, so the existence query must filter on
    // status='posted' and NOT use an .in(['posted','reversed']) filter.
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2099', debit: 0, credit: 470621.21 }])

    const builders: Array<Record<string, ReturnType<typeof vi.fn>>> = []
    const client = {
      from: vi.fn().mockImplementation(() => {
        const b = makeBuilder() as Record<string, ReturnType<typeof vi.fn>>
        builders.push(b)
        return b
      }),
    }

    const entry = await generateResultAppropriation(client as never, 'c1', 'u1', 'p1')

    expect(entry).toEqual(FAKE_ENTRY)
    // Builder 1 is the journal_entries existence query (builder 0 = settings).
    const existenceQuery = builders[1]
    expect(existenceQuery.eq).toHaveBeenCalledWith('status', 'posted')
    expect(existenceQuery.in).not.toHaveBeenCalled()
  })

  it('returns null when 2099 carries no IB balance', async () => {
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '1930', debit: 5000, credit: 0 }])

    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    expect(entry).toBeNull()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('falls back to companies.entity_type when company_settings is missing and posts', async () => {
    results = [NO_EXISTING /* settings missing */, AB /* companies fallback */, NO_EXISTING, PERIOD]
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

describe('generateResultAppropriation with a disposition booked by hand (PostHog PH 108)', () => {
  it('posts no omföring when the owner already moved the whole prior result', async () => {
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2099', debit: 0, credit: 30000 }])
    vi.mocked(fetchEntryLines).mockResolvedValue(
      entryLines('m1', 'manual', 12, [
        { account_number: '2099', debit_amount: 30000, credit_amount: 0 },
        { account_number: '2091', debit_amount: 0, credit_amount: 30000 },
      ]) as never
    )

    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    expect(entry).toBeNull()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('counts only the lines that move the carry, not this year\'s result re-homed in the same verifikat', async () => {
    // PostHog PH 108 shape: Dr 2069 30 000 moves last year's result to 2067;
    // Cr 2069 12 000 re-homes this year's result from 2099 in the same verifikat.
    // The query returns only the lines on 2069, 2068 and 2067.
    results = [{ data: { entity_type: 'ideell_forening' }, error: null }, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2069', debit: 0, credit: 30000 }])
    vi.mocked(fetchEntryLines).mockResolvedValue(
      entryLines('m1', 'manual', 12, [
        { account_number: '2067', debit_amount: 0, credit_amount: 30000 },
        { account_number: '2069', debit_amount: 30000, credit_amount: 0 },
        { account_number: '2069', debit_amount: 0, credit_amount: 12000 },
      ]) as never
    )

    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    expect(entry).toBeNull()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('carries only what a partial hand-booked disposition left on 2099', async () => {
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2099', debit: 0, credit: 30000 }])
    vi.mocked(fetchEntryLines).mockResolvedValue(
      entryLines('m1', 'manual', 12, [
        { account_number: '2099', debit_amount: 10000, credit_amount: 0 },
        { account_number: '2091', debit_amount: 0, credit_amount: 10000 },
      ]) as never
    )

    await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    const input = vi.mocked(createJournalEntry).mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2099', debit_amount: 20000, credit_amount: 0 })
    )
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2098', debit_amount: 0, credit_amount: 20000 })
    )
  })

  it('treats a voided disposition (its storno is a system entry) as none', async () => {
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2099', debit: 0, credit: 30000 }])
    // The reversed original is not fetched (status 'posted' only); only the storno is.
    vi.mocked(fetchEntryLines).mockResolvedValue(
      entryLines('s1', 'storno', 13, [
        { account_number: '2099', debit_amount: 0, credit_amount: 30000 },
        { account_number: '2091', debit_amount: 30000, credit_amount: 0 },
      ]) as never
    )

    await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    const input = vi.mocked(createJournalEntry).mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2099', debit_amount: 30000, credit_amount: 0 })
    )
  })

  it('does not count a manual 2099 booking without a disposition account as a disposition', async () => {
    results = [AB, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2099', debit: 0, credit: 30000 }])
    // A hand-booked closing (8999 / 2099) touches 2099 but moves nothing to 2098/2091.
    vi.mocked(fetchEntryLines).mockResolvedValue(
      entryLines('m2', 'manual', 14, [{ account_number: '2099', debit_amount: 0, credit_amount: 5000 }]) as never
    )

    await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p1')

    const input = vi.mocked(createJournalEntry).mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines).toContainEqual(
      expect.objectContaining({ account_number: '2099', debit_amount: 30000, credit_amount: 0 })
    )
  })
})

describe('previewResultAppropriation (feedback seq 707985)', () => {
  // The year-end previews disclose the omföring before the close: the carry
  // is the ingående balans the close will write (projectedIbNet), less what
  // is already disposed in the next period, by the rule the close uses.
  const closing = (entityType: string, projectedIbNet: number) => ({
    periodId: 'p-2024',
    periodEnd: '2024-12-31',
    entityType: entityType as never,
    projectedIbNet,
  })
  const NEXT = { id: 'p-2025', period_start: '2025-01-01' }

  it('discloses Dr 2099 / Cr 2098 for an aktiebolag profit, dated the day after the close', async () => {
    const preview = await previewResultAppropriation(makeClient() as never, 'c1', closing('aktiebolag', 150000))

    expect(preview).toEqual({
      from_account: '2099',
      to_account: '2098',
      amount: 150000,
      direction: 'profit',
      entry_date: '2025-01-01',
      skipped_reason: null,
      disposed_by: [],
    })
    // No next period yet: nothing in it can have moved the carry.
    expect(fetchEntryLines).not.toHaveBeenCalled()
  })

  it('discloses 2069 -> 2068 for an ideell förening, a loss as direction loss', async () => {
    const preview = await previewResultAppropriation(makeClient() as never, 'c1', closing('ideell_forening', -4000))

    expect(preview).toMatchObject({
      from_account: '2069',
      to_account: '2068',
      amount: 4000,
      direction: 'loss',
      skipped_reason: null,
    })
  })

  it('discloses the skip when the next period already disposes the result (feedback seq 707985, A1172)', async () => {
    vi.mocked(findNextPeriod).mockResolvedValue(NEXT as never)
    results = [NO_EXISTING] // no live omföring in the next period
    // The migrated history's own disposition, as prod holds it: Dr 2069 moves
    // the 2024 result to 2067, Cr 2069 re-homes 2025's result.
    vi.mocked(fetchEntryLines).mockResolvedValue(
      entryLines('a1172', 'manual', 1172, [
        { account_number: '2067', debit_amount: 0, credit_amount: 35059.47 },
        { account_number: '2069', debit_amount: 35059.47, credit_amount: 0 },
        { account_number: '2069', debit_amount: 0, credit_amount: 10612.53 },
      ]) as never
    )

    const preview = await previewResultAppropriation(makeClient() as never, 'c1', closing('ideell_forening', 35059.47))

    expect(preview).toEqual({
      from_account: '2069',
      to_account: '2068',
      amount: 0,
      direction: 'profit',
      entry_date: '2025-01-01',
      skipped_reason: 'already_disposed',
      disposed_by: ['A1172'],
    })
  })

  it('agrees with the close: what the preview skips, the omföring does not book', async () => {
    const a1172 = entryLines('a1172', 'manual', 1172, [
      { account_number: '2067', debit_amount: 0, credit_amount: 35059.47 },
      { account_number: '2069', debit_amount: 35059.47, credit_amount: 0 },
    ])
    vi.mocked(findNextPeriod).mockResolvedValue(NEXT as never)
    vi.mocked(fetchEntryLines).mockResolvedValue(a1172 as never)
    results = [NO_EXISTING]
    const preview = await previewResultAppropriation(makeClient() as never, 'c1', closing('ideell_forening', 35059.47))

    // After the close the next period's IB holds the projected amount.
    resultIdx = 0
    results = [{ data: { entity_type: 'ideell_forening' }, error: null }, NO_EXISTING, PERIOD]
    mockOpeningBalance([{ account_number: '2069', debit: 0, credit: 35059.47 }])
    const entry = await generateResultAppropriation(makeClient() as never, 'c1', 'u1', 'p-2025')

    expect(preview?.skipped_reason).toBe('already_disposed')
    expect(entry).toBeNull()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('discloses only what a partial disposition in the next period left', async () => {
    vi.mocked(findNextPeriod).mockResolvedValue(NEXT as never)
    results = [NO_EXISTING]
    vi.mocked(fetchEntryLines).mockResolvedValue(
      entryLines('m1', 'import', 12, [
        { account_number: '2099', debit_amount: 10000, credit_amount: 0 },
        { account_number: '2091', debit_amount: 0, credit_amount: 10000 },
      ]) as never
    )

    const preview = await previewResultAppropriation(makeClient() as never, 'c1', closing('aktiebolag', 30000))

    expect(preview).toMatchObject({ amount: 20000, skipped_reason: null, disposed_by: ['A12'] })
  })

  it('discloses the skip when a live omföring is already booked in the next period', async () => {
    vi.mocked(findNextPeriod).mockResolvedValue(NEXT as never)
    results = [{ data: { id: 'ra-existing' }, error: null }]

    const preview = await previewResultAppropriation(makeClient() as never, 'c1', closing('aktiebolag', 30000))

    expect(preview).toMatchObject({ amount: 0, skipped_reason: 'already_booked' })
    expect(fetchEntryLines).not.toHaveBeenCalled()
  })

  it('is null for an enskild firma and when there is nothing to move', async () => {
    expect(await previewResultAppropriation(makeClient() as never, 'c1', closing('enskild_firma', 50000))).toBeNull()
    expect(await previewResultAppropriation(makeClient() as never, 'c1', closing('aktiebolag', 0.004))).toBeNull()
    expect(findNextPeriod).not.toHaveBeenCalled()
  })
})

describe('carryAfterDispositions: a prior result moved off too often (a migrated aktiebolag)', () => {
  it('reports what went beyond the carry and leaves nothing for another omföring', async () => {
    // FY2022: the automatic omföring AND the previous system's imported
    // disposition both moved 2021's result off 2099.
    vi.mocked(fetchEntryLines).mockResolvedValue([
      ...entryLines('a181', 'result_appropriation', 181, [
        { account_number: '2099', debit_amount: 151986.05, credit_amount: 0 },
        { account_number: '2098', debit_amount: 0, credit_amount: 151986.05 },
      ]),
      ...entryLines('a176', 'import', 176, [
        { account_number: '2091', debit_amount: 0, credit_amount: 151178.05 },
        { account_number: '2099', debit_amount: 151178.05, credit_amount: 0 },
      ]),
    ] as never)

    const carry = await carryAfterDispositions(makeClient() as never, 'c1', 'p-2022', 'aktiebolag' as never, 151986.05)

    expect(carry).toMatchObject({ ibNet: 151986.05, remaining: 0, overMoved: -151178.05, movedBy: ['A181', 'A176'] })
  })

  it('reports no over-move for a carry disposed exactly once', async () => {
    vi.mocked(fetchEntryLines).mockResolvedValue(
      entryLines('a181', 'result_appropriation', 181, [
        { account_number: '2099', debit_amount: 151986.05, credit_amount: 0 },
        { account_number: '2098', debit_amount: 0, credit_amount: 151986.05 },
      ]) as never
    )

    const carry = await carryAfterDispositions(makeClient() as never, 'c1', 'p-2022', 'aktiebolag' as never, 151986.05)

    expect(carry).toMatchObject({ remaining: 0, overMoved: 0 })
  })
})
