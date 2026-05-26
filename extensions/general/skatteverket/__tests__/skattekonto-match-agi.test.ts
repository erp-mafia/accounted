import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  findMatchCandidates,
  findMatchSuggestionsBulk,
  parseAgiPeriod,
} from '../lib/skattekonto-match'

const COMPANY = 'company-1'

describe('parseAgiPeriod', () => {
  it('extracts year and month from "Arbetsgivardeklaration YYYYMM"', () => {
    expect(parseAgiPeriod('Arbetsgivardeklaration 202605')).toEqual({
      year: 2026,
      month: 5,
    })
  })

  it('accepts the dash variant "YYYY-MM"', () => {
    expect(parseAgiPeriod('arbetsgivardeklaration 2026-05')).toEqual({
      year: 2026,
      month: 5,
    })
  })

  it('is case-insensitive and tolerates leading whitespace', () => {
    expect(parseAgiPeriod('   ARBETSGIVARDEKLARATION 202611')).toEqual({
      year: 2026,
      month: 11,
    })
  })

  it('falls back to a numeric YYYYMM after any AGI-adjacent keyword', () => {
    expect(parseAgiPeriod('AGI 202607 inbetalning')).toEqual({
      year: 2026,
      month: 7,
    })
    expect(parseAgiPeriod('Arbetsgivaravgift januari 202601')).toEqual({
      year: 2026,
      month: 1,
    })
  })

  it('returns null when the period token is missing', () => {
    // AGI keyword present, no period digits
    expect(parseAgiPeriod('Arbetsgivardeklaration')).toBeNull()
  })

  it('returns null when there is no AGI keyword at all', () => {
    expect(parseAgiPeriod('Inbetalning bokförd 240412')).toBeNull()
    // OCR-style numerics on a moms row should not match.
    expect(parseAgiPeriod('Moms 202605')).toBeNull()
  })

  it('rejects months outside 1-12', () => {
    expect(parseAgiPeriod('Arbetsgivardeklaration 202613')).toBeNull()
    expect(parseAgiPeriod('Arbetsgivardeklaration 202600')).toBeNull()
  })

  it('rejects implausible years', () => {
    expect(parseAgiPeriod('Arbetsgivardeklaration 199912')).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────
// AGI period disambiguation in findMatchSuggestionsBulk
// ──────────────────────────────────────────────────────────────────────

function lineRow(opts: {
  entryId: string
  debit?: number
  credit?: number
  voucherNumber?: number | null
  entryDate?: string
  description?: string
  status?: 'draft' | 'posted' | 'reversed'
}) {
  return {
    debit_amount: opts.debit ?? 0,
    credit_amount: opts.credit ?? 0,
    journal_entries: {
      id: opts.entryId,
      voucher_number: opts.voucherNumber ?? 12,
      voucher_series: 'A',
      entry_date: opts.entryDate ?? '2026-06-12',
      description: opts.description ?? 'AGI maj 2026',
      status: opts.status ?? 'posted',
      company_id: COMPANY,
    },
  }
}

describe('findMatchSuggestionsBulk — AGI period disambiguation', () => {
  it('picks the AGI-linked entry even when two amount-matches exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Two journal entries credit 1630 with the same amount — without period
    // disambiguation, this would be ambiguous and return no suggestion.
    enqueue({
      data: [
        lineRow({ entryId: 'je-other-month', credit: 12345, entryDate: '2026-06-10' }),
        lineRow({ entryId: 'je-agi-may', credit: 12345, entryDate: '2026-06-12' }),
      ],
    })
    enqueue({ data: [] }) // none already linked
    // AGI declarations lookup
    enqueue({
      data: [
        {
          period_year: 2026,
          period_month: 5,
          salary_run_id: 'sr-may-2026',
        },
      ],
    })
    // salary_runs lookup
    enqueue({
      data: [
        {
          id: 'sr-may-2026',
          salary_entry_id: null,
          avgifter_entry_id: 'je-agi-may',
          vacation_entry_id: null,
        },
      ],
    })

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-06-12',
        transaktionstext: 'Arbetsgivardeklaration 202605',
        belopp_skatteverket: -12345,
        journal_entry_id: null,
      },
    ])

    expect(suggestions.size).toBe(1)
    expect(suggestions.get('skv-1')).toMatchObject({
      journal_entry_id: 'je-agi-may',
      matched_via_agi_period: true,
    })
  })

  it('falls back to amount-only matching when no AGI declaration exists for the period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [lineRow({ entryId: 'je-unique', credit: 9999, entryDate: '2026-06-12' })],
    })
    enqueue({ data: [] })
    // No AGI declaration for 2026-05
    enqueue({ data: [] })
    // (no salary_runs lookup; agi_declarations was empty)

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-06-12',
        transaktionstext: 'Arbetsgivardeklaration 202605',
        belopp_skatteverket: -9999,
        journal_entry_id: null,
      },
    ])

    expect(suggestions.size).toBe(1)
    expect(suggestions.get('skv-1')).toMatchObject({
      journal_entry_id: 'je-unique',
      matched_via_agi_period: false,
    })
  })

  it('returns no suggestion when AGI-linked entries do not match the amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Two amount-matching entries, neither is the AGI-linked one.
    enqueue({
      data: [
        lineRow({ entryId: 'je-a', credit: 5000, entryDate: '2026-06-12' }),
        lineRow({ entryId: 'je-b', credit: 5000, entryDate: '2026-06-13' }),
      ],
    })
    enqueue({ data: [] })
    enqueue({
      data: [
        { period_year: 2026, period_month: 5, salary_run_id: 'sr-may-2026' },
      ],
    })
    enqueue({
      data: [
        {
          id: 'sr-may-2026',
          salary_entry_id: 'je-different-amount',
          avgifter_entry_id: null,
          vacation_entry_id: null,
        },
      ],
    })

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-06-12',
        transaktionstext: 'Arbetsgivardeklaration 202605',
        belopp_skatteverket: -5000,
        journal_entry_id: null,
      },
    ])

    expect(suggestions.size).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// AGI period boost in findMatchCandidates
// ──────────────────────────────────────────────────────────────────────

function txRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'skv-tx-1',
    company_id: COMPANY,
    transaktionsdatum: '2026-06-12',
    belopp_skatteverket: -12345,
    journal_entry_id: null,
    transaktionstext: 'Arbetsgivardeklaration 202605',
    status: 'booked',
    ...overrides,
  }
}

describe('findMatchCandidates — AGI period boost', () => {
  it('moves the AGI-linked entry to position 0 even when a closer-by-date entry exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({
      data: [
        // closer to SKV date but unrelated
        lineRow({ entryId: 'je-close', credit: 12345, entryDate: '2026-06-12' }),
        // further from SKV date but AGI-linked
        lineRow({ entryId: 'je-agi', credit: 12345, entryDate: '2026-06-05' }),
      ],
    })
    enqueue({ data: [] }) // none linked
    enqueue({
      data: [
        { period_year: 2026, period_month: 5, salary_run_id: 'sr-may-2026' },
      ],
    })
    enqueue({
      data: [
        {
          id: 'sr-may-2026',
          salary_entry_id: null,
          avgifter_entry_id: 'je-agi',
          vacation_entry_id: null,
        },
      ],
    })

    const result = await findMatchCandidates(supabase as never, COMPANY, 'skv-tx-1')
    expect(result.candidates.map(c => c.journal_entry_id)).toEqual([
      'je-agi',
      'je-close',
    ])
    expect(result.candidates[0].matched_via_agi_period).toBe(true)
    expect(result.candidates[1].matched_via_agi_period).toBe(false)
  })
})
