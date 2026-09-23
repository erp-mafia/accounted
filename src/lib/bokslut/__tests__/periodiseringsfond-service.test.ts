import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  proposeAvsattning,
  proposeAteforing,
  listExistingPeriodiseringsfonder,
  getPeriodiseringsfondCohortAccount,
  getSchablonintaktRate,
  resolveSchablonintaktRate,
  SchablonintaktRateNotConfiguredError,
  PFOND_AB_RATE,
  PFOND_MAX_HOLD_YEARS,
  type ExistingFond,
} from '../reserves/periodiseringsfond-service'
import { fetchEntryLines } from '@/lib/bookkeeping/entry-lines'

vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: vi.fn(),
}))

describe('getPeriodiseringsfondCohortAccount', () => {
  it('maps fiscal year to BAS 212X account', () => {
    expect(getPeriodiseringsfondCohortAccount(2020)).toBe('2120')
    expect(getPeriodiseringsfondCohortAccount(2025)).toBe('2125')
    expect(getPeriodiseringsfondCohortAccount(2026)).toBe('2126')
    expect(getPeriodiseringsfondCohortAccount(2027)).toBe('2127')
  })

  it('returns 2129 for 2019 per BAS collision rule', () => {
    expect(getPeriodiseringsfondCohortAccount(2019)).toBe('2129')
  })
})

describe('getSchablonintaktRate', () => {
  it('returns the SLR for known closing years (IL 30 kap 6a §: SLR itself, not SLR + 1 pp)', () => {
    expect(getSchablonintaktRate(2025)).toBe(0.0196)
    expect(getSchablonintaktRate(2026)).toBe(0.0255)
  })

  it('covers every closing year since the 100 %-of-SLR rule (2020-2024), floored at 0.5 %', () => {
    // SLR 30 Nov of the preceding year per Riksgälden: 2019 -0.09 %,
    // 2020 -0.10 %, 2021 0.23 % (all floored), 2022 1.94 %, 2023 2.62 %.
    expect(getSchablonintaktRate(2020)).toBe(0.005)
    expect(getSchablonintaktRate(2021)).toBe(0.005)
    expect(getSchablonintaktRate(2022)).toBe(0.005)
    expect(getSchablonintaktRate(2023)).toBe(0.0194)
    expect(getSchablonintaktRate(2024)).toBe(0.0262)
  })

  it('fails closed for unmapped years with a typed, registry-coded error', () => {
    expect(() => getSchablonintaktRate(2030)).toThrow(/not configured/)
    expect(() => getSchablonintaktRate(2030)).toThrow(SchablonintaktRateNotConfiguredError)
    // 2019 closings can be brutet år under the old 72 %-of-SLR factor: kept unmapped.
    expect(() => getSchablonintaktRate(2019)).toThrow(SchablonintaktRateNotConfiguredError)
    try {
      getSchablonintaktRate(2030)
    } catch (err) {
      expect((err as SchablonintaktRateNotConfiguredError).code).toBe(
        'SCHABLONINTAKT_RATE_NOT_CONFIGURED',
      )
      expect((err as SchablonintaktRateNotConfiguredError).fiscalYear).toBe(2030)
    }
  })
})

describe('resolveSchablonintaktRate', () => {
  const fond = (opening_balance: number): ExistingFond => ({
    account_number: '2120',
    cohort_year: 2020,
    balance: opening_balance,
    opening_balance,
    must_return_this_year: false,
  })

  it('returns 0 without consulting the table when no fond has an opening balance', () => {
    // The common no-fond AB: an unmapped year must never break its bokslut.
    expect(resolveSchablonintaktRate(2019, [])).toBe(0)
    expect(resolveSchablonintaktRate(2030, [])).toBe(0)
    // A fond avsatt in THIS bokslut (opening 0) yields no schablonintäkt either.
    expect(resolveSchablonintaktRate(2030, [fond(0)])).toBe(0)
  })

  it('returns the table rate when a fond carried an opening balance', () => {
    expect(resolveSchablonintaktRate(2024, [fond(100_000)])).toBe(0.0262)
  })

  it('still fails closed for an unmapped year when fonder exist', () => {
    expect(() => resolveSchablonintaktRate(2030, [fond(100_000)])).toThrow(
      SchablonintaktRateNotConfiguredError,
    )
  })

  it('prefers a caller-supplied override regardless of the table', () => {
    expect(resolveSchablonintaktRate(2030, [fond(100_000)], 0.03)).toBe(0.03)
    expect(resolveSchablonintaktRate(2024, [], 0.03)).toBe(0.03)
  })
})

describe('proposeAvsattning', () => {
  it('caps avsättning at 25% of base', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      desiredAmount: 200_000, // user asks for 50%: should be capped
      fiscalYear: 2025,
    })
    expect(result).not.toBeNull()
    expect(result!.amount).toBe(100_000) // 25% of 400_000
    expect(result!.warnings).toHaveLength(1)
    expect(result!.warnings[0]).toContain('25 %')
    expect(result!.lines[0].account_number).toBe('8811')
    expect(result!.lines[1].account_number).toBe('2125')
  })

  it('defaults to maximum when desiredAmount is omitted', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      fiscalYear: 2025,
    })
    expect(result!.amount).toBe(100_000)
    expect(result!.warnings).toHaveLength(0)
  })

  it('honors a smaller desiredAmount', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      desiredAmount: 30_000,
      fiscalYear: 2025,
    })
    expect(result!.amount).toBe(30_000)
    expect(result!.warnings).toHaveLength(0)
  })

  it('returns null when base is negative (loss year)', () => {
    expect(
      proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: -100_000,
        fiscalYear: 2025,
      }),
    ).toBeNull()
  })

  it('returns null when desired is zero', () => {
    expect(
      proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: 400_000,
        desiredAmount: 0,
        fiscalYear: 2025,
      }),
    ).toBeNull()
  })

  it('emits balanced lines (debit 8811 = credit 21XX)', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      fiscalYear: 2026,
    })
    expect(result!.lines).toHaveLength(2)
    const totalDebit = result!.lines.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = result!.lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
    expect(result!.lines[1].account_number).toBe('2126')
  })

  it('uses fiscal year for cohort account number', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 100_000,
      fiscalYear: 2027,
    })
    expect(result!.lines[1].account_number).toBe('2127')
  })

  it('reduces headroom by an already-provisioned current-year fond', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      fiscalYear: 2025,
      alreadyProvisioned: 60_000,
    })
    // 25% of 400_000 = 100_000 cap; 60_000 already booked -> 40_000 left
    expect(result!.amount).toBe(40_000)
  })

  it('returns null when the year cap is already fully provisioned', () => {
    expect(
      proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: 400_000,
        fiscalYear: 2025,
        alreadyProvisioned: 100_000,
      }),
    ).toBeNull()
    // Over-provisioned (legacy double booking) must not propose more either
    expect(
      proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: 400_000,
        fiscalYear: 2025,
        alreadyProvisioned: 150_000,
      }),
    ).toBeNull()
  })

  it('caps an explicit desiredAmount to the remaining headroom with a warning', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      desiredAmount: 80_000,
      fiscalYear: 2025,
      alreadyProvisioned: 60_000,
    })
    expect(result!.amount).toBe(40_000)
    expect(result!.warnings).toHaveLength(1)
    expect(result!.warnings[0]).toContain('redan avsatt')
  })
})

describe('proposeAteforing', () => {
  it('forces full reversal of 6+ year old fonder and marks them required', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2120',
        cohort_year: 2020,
        balance: 50_000,
        opening_balance: 50_000,
        must_return_this_year: true,
      },
    ]
    const result = proposeAteforing(fonder, { schablonintaktRate: 0.03 })
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].amount).toBe(50_000)
    expect(result.proposals[0].required).toBe(true)
    expect(result.proposals[0].warnings[0]).toContain('6-årsgränsen')
    // 50_000 × 0.03 = 1500
    expect(result.schablonintaktAmount).toBe(1_500)
  })

  it('skips non-mandatory fonder when no return amount requested', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2122',
        cohort_year: 2022,
        balance: 100_000,
        opening_balance: 100_000,
        must_return_this_year: false,
      },
    ]
    const result = proposeAteforing(fonder, { schablonintaktRate: 0.03 })
    expect(result.proposals).toHaveLength(0)
    // Schablonintäkt is computed regardless of return decision
    expect(result.schablonintaktAmount).toBe(3_000)
  })

  it('returns the requested optional amount when user opts in', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2123',
        cohort_year: 2023,
        balance: 80_000,
        opening_balance: 80_000,
        must_return_this_year: false,
      },
    ]
    const result = proposeAteforing(fonder, {
      returns: { '2123': 50_000 },
      schablonintaktRate: 0.03,
    })
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].amount).toBe(50_000)
    expect(result.proposals[0].required).toBeFalsy()
  })

  it('caps optional returns to the actual balance', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2124',
        cohort_year: 2024,
        balance: 30_000,
        opening_balance: 30_000,
        must_return_this_year: false,
      },
    ]
    const result = proposeAteforing(fonder, {
      returns: { '2124': 100_000 },
      schablonintaktRate: 0.03,
    })
    expect(result.proposals[0].amount).toBe(30_000) // capped to balance
  })

  it('emits balanced lines (debit 21XX = credit 8819)', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2120',
        cohort_year: 2020,
        balance: 50_000,
        opening_balance: 50_000,
        must_return_this_year: true,
      },
    ]
    const result = proposeAteforing(fonder, { schablonintaktRate: 0.03 })
    const lines = result.proposals[0].lines
    expect(lines).toHaveLength(2)
    expect(lines[0].account_number).toBe('2120')
    expect(lines[0].debit_amount).toBe(50_000)
    expect(lines[1].account_number).toBe('8819')
    expect(lines[1].credit_amount).toBe(50_000)
  })

  it('never proposes a return for zero or negative closing balances', () => {
    // A negative balance is a data anomaly (e.g. a debit-only view of a
    // storno pair): proposing a negative återföring would produce an
    // uncommittable entry.
    const fonder: ExistingFond[] = [
      {
        account_number: '2125',
        cohort_year: 2025,
        balance: -396_459,
        opening_balance: 0,
        must_return_this_year: false,
      },
      {
        account_number: '2120',
        cohort_year: 2020,
        balance: 0,
        opening_balance: 0,
        must_return_this_year: true,
      },
    ]
    const result = proposeAteforing(fonder, { schablonintaktRate: 0.03 })
    expect(result.proposals).toHaveLength(0)
    expect(result.schablonintaktAmount).toBe(0)
  })

  it('computes schablonintäkt on opening balances per IL 30 kap 6a §', () => {
    const fonder: ExistingFond[] = [
      // Avsatt in THIS bokslut: opening 0, no schablonintäkt
      {
        account_number: '2125',
        cohort_year: 2025,
        balance: 200_000,
        opening_balance: 0,
        must_return_this_year: false,
      },
      // Held all year: full schablonintäkt
      {
        account_number: '2123',
        cohort_year: 2023,
        balance: 100_000,
        opening_balance: 100_000,
        must_return_this_year: false,
      },
      // Fully återförd during the year: schablonintäkt still due
      {
        account_number: '2120',
        cohort_year: 2020,
        balance: 0,
        opening_balance: 50_000,
        must_return_this_year: true,
      },
    ]
    const result = proposeAteforing(fonder, { schablonintaktRate: 0.03 })
    // 0 + 100_000 × 0.03 + 50_000 × 0.03 = 4_500
    expect(result.schablonintaktAmount).toBe(4_500)
    // The 2125/2120 fonder yield no return proposal (2125 not requested,
    // 2120 balance already zero despite the mandatory flag)
    expect(result.proposals).toHaveLength(0)
  })

  it('exposes constants used by callers', () => {
    expect(PFOND_AB_RATE).toBe(0.25)
    expect(PFOND_MAX_HOLD_YEARS).toBe(6)
  })
})

describe('listExistingPeriodiseringsfonder', () => {
  const supabase = {} as SupabaseClient
  const mockFetchEntryLines = vi.mocked(fetchEntryLines)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** Chainable query spy that records every filter call in order. */
  function makeChainableQuery() {
    const calls: Array<[string, ...unknown[]]> = []
    const q: Record<string, unknown> = {}
    for (const m of ['eq', 'in', 'gte', 'lte'] as const) {
      q[m] = vi.fn((...args: unknown[]) => {
        calls.push([m, ...args])
        return q
      })
    }
    return { q, calls }
  }

  it('calls fetchEntryLines with entry dates attached for the opening-balance split', async () => {
    mockFetchEntryLines.mockResolvedValue([])

    const result = await listExistingPeriodiseringsfonder(
      supabase, 'company-1', '2025-12-31', '2025-01-01',
    )

    expect(result).toEqual([])
    expect(mockFetchEntryLines).toHaveBeenCalledTimes(1)
    expect(mockFetchEntryLines).toHaveBeenCalledWith(
      expect.objectContaining({
        supabase,
        entryColumns: 'id, entry_date',
        lineColumns: 'account_number, debit_amount, credit_amount',
      }),
    )
  })

  it('scopes entries to company/posted+reversed/closing date and lines to the 21xx range', async () => {
    mockFetchEntryLines.mockResolvedValue([])

    await listExistingPeriodiseringsfonder(supabase, 'company-1', '2025-12-31', '2025-01-01')

    const options = mockFetchEntryLines.mock.calls[0][0]

    const entries = makeChainableQuery()
    options.filterEntries(entries.q)
    // Both statuses: a reversed original and its storno must cancel; a
    // posted-only view would show the storno's debit as a phantom negative
    // fond balance.
    expect(entries.calls).toEqual([
      ['eq', 'company_id', 'company-1'],
      ['in', 'status', ['posted', 'reversed']],
      ['lte', 'entry_date', '2025-12-31'],
    ])

    expect(options.filterLines).toBeDefined()
    const lines = makeChainableQuery()
    options.filterLines?.(lines.q)
    expect(lines.calls).toEqual([
      ['gte', 'account_number', '2110'],
      ['lte', 'account_number', '2199'],
    ])
  })

  it('sums per-account balances (credit minus debit), splits opening vs closing, and maps cohort years', async () => {
    mockFetchEntryLines.mockResolvedValue([
      // 2125 avsatt during the period: closing 80_000, opening 0
      {
        account_number: '2125', debit_amount: 0, credit_amount: 100_000,
        journal_entries: { entry_date: '2026-12-31' },
      },
      {
        account_number: '2125', debit_amount: 20_000, credit_amount: 0,
        journal_entries: { entry_date: '2026-12-31' },
      },
      // Numeric strings and nulls coerce like the embed rows did; booked in
      // a prior period so it is part of the opening balance
      {
        account_number: '2120', debit_amount: null, credit_amount: '50000',
        journal_entries: { entry_date: '2020-12-31' },
      },
      // 2129 is the 2019 collision account per the BAS 2020 seed
      {
        account_number: '2129', debit_amount: 0, credit_amount: 10_000,
        journal_entries: { entry_date: '2019-12-31' },
      },
      // 2110 is a grouping account with no cohort: skipped
      {
        account_number: '2110', debit_amount: 0, credit_amount: 5_000,
        journal_entries: { entry_date: '2020-12-31' },
      },
    ])

    const result = await listExistingPeriodiseringsfonder(
      supabase, 'company-1', '2026-12-31', '2026-01-01',
    )

    // Sorted by cohort_year ascending
    expect(result).toEqual([
      {
        account_number: '2129',
        cohort_year: 2019,
        balance: 10_000,
        opening_balance: 10_000,
        must_return_this_year: true, // 2019 + 6 = 2025 <= 2026
      },
      {
        account_number: '2120',
        cohort_year: 2020,
        balance: 50_000,
        opening_balance: 50_000,
        must_return_this_year: true, // 2020 + 6 = 2026 <= 2026
      },
      {
        account_number: '2125',
        cohort_year: 2025,
        balance: 80_000,
        opening_balance: 0,
        must_return_this_year: false, // 2025 + 6 = 2031 > 2026
      },
    ])
  })

  it('does not double-count a fond carried via an opening-balance entry', async () => {
    // Year-end closing of the previous period books an OB entry (dated at
    // period_start) that carries the accumulated 21xx balances. Summing the
    // OB entry together with the pre-period history would double the fond.
    mockFetchEntryLines.mockResolvedValue([
      // Prior-period avsättning: already carried inside the OB entry
      {
        account_number: '2124', debit_amount: 0, credit_amount: 60_000,
        journal_entry_id: 'prior-1',
        journal_entries: { entry_date: '2024-12-31' },
      },
      // The OB entry itself, dated exactly at period_start
      {
        account_number: '2124', debit_amount: 0, credit_amount: 60_000,
        journal_entry_id: 'ob-1',
        journal_entries: { entry_date: '2025-01-01' },
      },
      // Current-period partial återföring
      {
        account_number: '2124', debit_amount: 10_000, credit_amount: 0,
        journal_entry_id: 'cur-1',
        journal_entries: { entry_date: '2025-12-31' },
      },
    ])

    const result = await listExistingPeriodiseringsfonder(
      supabase, 'company-1', '2025-12-31', '2025-01-01', 'ob-1',
    )

    expect(result).toEqual([
      {
        account_number: '2124',
        cohort_year: 2024,
        balance: 50_000,        // 60_000 carried - 10_000 returned, NOT 110_000
        opening_balance: 60_000, // the OB entry, despite being dated at period_start
        must_return_this_year: false,
      },
    ])
  })

  it('rejects a well-shaped but impossible period start date', async () => {
    await expect(
      listExistingPeriodiseringsfonder(supabase, 'company-1', '2025-12-31', '2025-02-31'),
    ).rejects.toThrow('Invalid period start: 2025-02-31')
    expect(mockFetchEntryLines).not.toHaveBeenCalled()
  })

  it('keeps a fond fully återförd during the period (closing 0, opening > 0)', async () => {
    mockFetchEntryLines.mockResolvedValue([
      {
        account_number: '2121', debit_amount: 0, credit_amount: 40_000,
        journal_entries: { entry_date: '2021-12-31' },
      },
      {
        account_number: '2121', debit_amount: 40_000, credit_amount: 0,
        journal_entries: { entry_date: '2026-12-31' },
      },
    ])

    const result = await listExistingPeriodiseringsfonder(
      supabase, 'company-1', '2026-12-31', '2026-01-01',
    )

    expect(result).toEqual([
      {
        account_number: '2121',
        cohort_year: 2021,
        balance: 0,
        opening_balance: 40_000,
        must_return_this_year: false, // 2021 + 6 = 2027 > 2026
      },
    ])
  })

  it('drops near-zero balances below the 0.005 threshold', async () => {
    mockFetchEntryLines.mockResolvedValue([
      { account_number: '2123', debit_amount: 1_000, credit_amount: 1_000.004 },
      { account_number: '2124', debit_amount: 0, credit_amount: 30_000 },
    ])

    const result = await listExistingPeriodiseringsfonder(
      supabase, 'company-1', '2026-12-31', '2026-01-01',
    )

    expect(result).toHaveLength(1)
    expect(result[0].account_number).toBe('2124')
  })

  it('wraps helper failures in the periodiseringsfond error contract', async () => {
    mockFetchEntryLines.mockRejectedValue(new Error('boom'))

    await expect(
      listExistingPeriodiseringsfonder(supabase, 'company-1', '2025-12-31', '2025-01-01'),
    ).rejects.toThrow('Failed to fetch periodiseringsfond balances: boom')
  })

  it('rejects an unparseable closing date before querying', async () => {
    await expect(
      listExistingPeriodiseringsfonder(supabase, 'company-1', 'not-a-date', '2025-01-01'),
    ).rejects.toThrow('Invalid closing date: not-a-date')
    expect(mockFetchEntryLines).not.toHaveBeenCalled()
  })

  it('rejects an unparseable period start before querying', async () => {
    await expect(
      listExistingPeriodiseringsfonder(supabase, 'company-1', '2025-12-31', 'not-a-date'),
    ).rejects.toThrow('Invalid period start: not-a-date')
    expect(mockFetchEntryLines).not.toHaveBeenCalled()
  })
})
