import { describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  findMatchCandidates,
  findMatchSuggestionsBulk,
  matchSkattekontoToEntry,
  SkattekontoMatchError,
} from '../lib/skattekonto-match'

const COMPANY = 'company-1'
const TX_ID = 'skv-tx-1'

function txRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    company_id: COMPANY,
    transaktionsdatum: '2026-03-17',
    belopp_skatteverket: 5000,
    journal_entry_id: null,
    transaktionstext: 'Inbetalning bokförd',
    status: 'booked',
    ...overrides,
  }
}

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
      entry_date: opts.entryDate ?? '2026-03-16',
      description: opts.description ?? 'Test verifikat',
      status: opts.status ?? 'posted',
      company_id: COMPANY,
    },
  }
}

// ──────────────────────────────────────────────────────────────────────
// findMatchCandidates
// ──────────────────────────────────────────────────────────────────────

describe('findMatchCandidates', () => {
  it('returns candidate verifikat that debits 1630 with matching amount (positive SKV → looks for debit on 1630)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: [lineRow({ entryId: 'je-1', debit: 5000, credit: 0 })] })
    enqueue({ data: [] }) // no already-linked

    const result = await findMatchCandidates(supabase as never, COMPANY, TX_ID)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      journal_entry_id: 'je-1',
      matched_amount: 5000,
      matched_side: 'debit',
    })
  })

  it('uses credit 1630 lookup when SKV amount is negative (money leaving skattekontot)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow({ belopp_skatteverket: -8333, transaktionstext: 'Debiterad F-skatt' }) })
    enqueue({ data: [lineRow({ entryId: 'je-7', debit: 0, credit: 8333 })] })
    enqueue({ data: [] })

    const result = await findMatchCandidates(supabase as never, COMPANY, TX_ID)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].matched_side).toBe('credit')
    expect(result.candidates[0].matched_amount).toBe(8333)
  })

  it('throws TRANSACTION_NOT_FOUND when the SKV row does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'not found' } })

    await expect(findMatchCandidates(supabase as never, COMPANY, TX_ID)).rejects.toMatchObject({
      code: 'TRANSACTION_NOT_FOUND',
    })
  })

  it('throws ALREADY_BOOKED when the SKV row is already linked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow({ journal_entry_id: 'je-existing' }) })

    await expect(findMatchCandidates(supabase as never, COMPANY, TX_ID)).rejects.toMatchObject({
      code: 'ALREADY_BOOKED',
    })
  })

  it('filters out entries already linked to another SKV row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({
      data: [
        lineRow({ entryId: 'je-1', debit: 5000, credit: 0 }),
        lineRow({ entryId: 'je-2', debit: 5000, credit: 0 }),
      ],
    })
    enqueue({ data: [{ journal_entry_id: 'je-1' }] }) // je-1 already linked

    const result = await findMatchCandidates(supabase as never, COMPANY, TX_ID)
    expect(result.candidates.map(c => c.journal_entry_id)).toEqual(['je-2'])
  })

  it('returns an empty list when no candidate lines match', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: [] }) // no candidate lines

    const result = await findMatchCandidates(supabase as never, COMPANY, TX_ID)
    expect(result.candidates).toEqual([])
  })

  it('throws a SkattekontoMatchError (not a plain Error) so callers can switch on code', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow({ journal_entry_id: 'je-existing' }) })

    await expect(findMatchCandidates(supabase as never, COMPANY, TX_ID)).rejects.toBeInstanceOf(
      SkattekontoMatchError,
    )
  })

  it('orders candidates by date proximity to the SKV row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow({ transaktionsdatum: '2026-03-17' }) })
    enqueue({
      data: [
        lineRow({ entryId: 'je-far', debit: 5000, entryDate: '2026-03-08' }), // 9 days
        lineRow({ entryId: 'je-close', debit: 5000, entryDate: '2026-03-16' }), // 1 day
        lineRow({ entryId: 'je-mid', debit: 5000, entryDate: '2026-03-12' }), // 5 days
      ],
    })
    enqueue({ data: [] })

    const result = await findMatchCandidates(supabase as never, COMPANY, TX_ID)
    expect(result.candidates.map(c => c.journal_entry_id)).toEqual([
      'je-close',
      'je-mid',
      'je-far',
    ])
  })
})

// ──────────────────────────────────────────────────────────────────────
// matchSkattekontoToEntry
// ──────────────────────────────────────────────────────────────────────

describe('matchSkattekontoToEntry', () => {
  it('writes the journal_entry_id when the candidate has a valid 1630 line', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({
      data: {
        id: 'je-1',
        status: 'posted',
        lines: [
          { account_number: '1630', debit_amount: 5000, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 5000 },
        ],
      },
    })
    enqueue({ data: null }) // not already linked
    enqueue({ data: null }) // update result

    await expect(
      matchSkattekontoToEntry(supabase as never, COMPANY, TX_ID, 'je-1'),
    ).resolves.toBeUndefined()
  })

  it('throws TRANSACTION_NOT_FOUND when the SKV row is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'not found' } })

    await expect(
      matchSkattekontoToEntry(supabase as never, COMPANY, TX_ID, 'je-1'),
    ).rejects.toMatchObject({ code: 'TRANSACTION_NOT_FOUND' })
  })

  it('throws ALREADY_BOOKED when the SKV row already has a journal_entry_id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow({ journal_entry_id: 'je-other' }) })

    await expect(
      matchSkattekontoToEntry(supabase as never, COMPANY, TX_ID, 'je-1'),
    ).rejects.toMatchObject({ code: 'ALREADY_BOOKED' })
  })

  it('throws ENTRY_NOT_FOUND when the candidate verifikat does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({ data: null, error: { message: 'not found' } })

    await expect(
      matchSkattekontoToEntry(supabase as never, COMPANY, TX_ID, 'je-missing'),
    ).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' })
  })

  it('throws INVALID_CANDIDATE when the verifikat has no 1630 line matching amount + side', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() }) // expects debit 5000 on 1630
    enqueue({
      data: {
        id: 'je-1',
        status: 'posted',
        lines: [
          // Wrong side: credit 5000 on 1630 (doesn't match a positive SKV)
          { account_number: '1630', debit_amount: 0, credit_amount: 5000 },
        ],
      },
    })

    await expect(
      matchSkattekontoToEntry(supabase as never, COMPANY, TX_ID, 'je-1'),
    ).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' })
  })

  it('throws INVALID_CANDIDATE when the verifikat is reversed (makulerat)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({
      data: {
        id: 'je-1',
        status: 'reversed',
        lines: [{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }],
      },
    })

    await expect(
      matchSkattekontoToEntry(supabase as never, COMPANY, TX_ID, 'je-1'),
    ).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' })
  })

  it('throws ENTRY_ALREADY_LINKED when another SKV row is already linked to this verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow() })
    enqueue({
      data: {
        id: 'je-1',
        status: 'posted',
        lines: [{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }],
      },
    })
    enqueue({ data: { id: 'skv-other' } }) // already linked

    await expect(
      matchSkattekontoToEntry(supabase as never, COMPANY, TX_ID, 'je-1'),
    ).rejects.toMatchObject({ code: 'ENTRY_ALREADY_LINKED' })
  })
})

// ──────────────────────────────────────────────────────────────────────
// findMatchSuggestionsBulk
// ──────────────────────────────────────────────────────────────────────

describe('findMatchSuggestionsBulk', () => {
  it('returns a suggestion only when exactly one candidate matches per row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        lineRow({ entryId: 'je-unique', debit: 5000, entryDate: '2026-03-16' }),
        // unrelated different-amount line that should not match
        lineRow({ entryId: 'je-other', debit: 9999, entryDate: '2026-03-16' }),
      ],
    })
    enqueue({ data: [] }) // none linked

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-03-17',
        belopp_skatteverket: 5000,
        journal_entry_id: null,
      },
    ])

    expect(suggestions.size).toBe(1)
    expect(suggestions.get('skv-1')).toMatchObject({ journal_entry_id: 'je-unique' })
  })

  it('returns no suggestion when there are TWO candidates (ambiguous)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        lineRow({ entryId: 'je-a', debit: 5000, entryDate: '2026-03-15' }),
        lineRow({ entryId: 'je-b', debit: 5000, entryDate: '2026-03-16' }),
      ],
    })
    enqueue({ data: [] })

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-03-17',
        belopp_skatteverket: 5000,
        journal_entry_id: null,
      },
    ])
    expect(suggestions.size).toBe(0)
  })

  it('returns no suggestion when zero candidates match', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-03-17',
        belopp_skatteverket: 5000,
        journal_entry_id: null,
      },
    ])
    expect(suggestions.size).toBe(0)
  })

  it('skips rows that are already linked to a verifikat', async () => {
    // already-linked rows shouldn't even reach the candidate query: but
    // verify by passing no other unmatched rows; the queue stays empty.
    const { supabase } = createQueuedMockSupabase()

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-03-17',
        belopp_skatteverket: 5000,
        journal_entry_id: 'je-existing',
      },
    ])
    expect(suggestions.size).toBe(0)
  })

  it('skips candidates whose entry_date is outside the per-row ±14 day window', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        // 20 days before the SKV row: too far
        lineRow({ entryId: 'je-far', debit: 5000, entryDate: '2026-02-25' }),
      ],
    })
    enqueue({ data: [] })

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-03-17',
        belopp_skatteverket: 5000,
        journal_entry_id: null,
      },
    ])
    expect(suggestions.size).toBe(0)
  })

  it('excludes entries that are already linked to a different SKV row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [lineRow({ entryId: 'je-linked', debit: 5000, entryDate: '2026-03-16' })],
    })
    enqueue({ data: [{ journal_entry_id: 'je-linked' }] })

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-03-17',
        belopp_skatteverket: 5000,
        journal_entry_id: null,
      },
    ])
    expect(suggestions.size).toBe(0)
  })

  it('respects sign convention per row: negative SKV needs a credit on 1630', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        // Debit-side line: wrong side for a -8333 SKV row
        lineRow({ entryId: 'je-wrong-side', debit: 8333, entryDate: '2026-03-16' }),
      ],
    })
    enqueue({ data: [] })

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [
      {
        id: 'skv-1',
        transaktionsdatum: '2026-03-17',
        belopp_skatteverket: -8333,
        journal_entry_id: null,
      },
    ])
    expect(suggestions.size).toBe(0)
  })

  it('returns empty map immediately when no unmatched rows are provided', async () => {
    // No queue interaction expected: function should short-circuit.
    const { supabase } = createQueuedMockSupabase()
    const fromSpy = vi.spyOn(supabase, 'from')

    const suggestions = await findMatchSuggestionsBulk(supabase as never, COMPANY, [])

    expect(suggestions.size).toBe(0)
    expect(fromSpy).not.toHaveBeenCalled()
  })
})
