import { beforeEach, describe, it, expect, vi } from 'vitest'

const { reverseEntryMock } = vi.hoisted(() => ({
  reverseEntryMock: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: reverseEntryMock,
}))

import {
  cancelOrphanedPaymentEntry,
  recordVoucherGapExplanation,
  reverseOrphanedJournalEntry,
} from '../cancel-orphaned-entry'
import { withUnusedVoucherAllocation } from '../errors'

// The real voucher_gap_explanations column set (supabase/migrations/
// 20260402100100_voucher_gap_explanations.sql). company_id, user_id,
// fiscal_period_id, voucher_series, gap_start, gap_end and explanation are all
// NOT NULL; anything else is a phantom column that PostgREST rejects.
const REQUIRED_GAP_COLUMNS = [
  'company_id',
  'user_id',
  'fiscal_period_id',
  'voucher_series',
  'gap_start',
  'gap_end',
  'explanation',
].sort()

function createMockSupabase(opts: {
  orphan?: { fiscal_period_id: string; voucher_series: string | null; voucher_number: number } | null
  cancelError?: { message: string } | null
  insertError?: { message: string; code?: string } | null
}) {
  const updates: unknown[] = []
  const inserts: Record<string, unknown[]> = {}

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: opts.orphan ?? null,
              error: opts.orphan ? null : { message: 'not found' },
            }),
          }),
        }),
      }),
      update: vi.fn().mockImplementation((payload: unknown) => {
        updates.push(payload)
        return {
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: opts.cancelError ?? null }),
          }),
        }
      }),
      insert: vi.fn().mockImplementation((payload: unknown) => {
        ;(inserts[table] ??= []).push(payload)
        return Promise.resolve({ error: opts.insertError ?? null })
      }),
    })),
  }
  return { supabase, updates, inserts }
}

beforeEach(() => {
  reverseEntryMock.mockReset()
  reverseEntryMock.mockResolvedValue(undefined)
})

describe('recordVoucherGapExplanation', () => {
  it('writes exactly the real NOT NULL columns, with the single voucher as a closed gap range', async () => {
    const { supabase, inserts } = createMockSupabase({})

    const ok = await recordVoucherGapExplanation(supabase as never, {
      companyId: 'company-1',
      userId: 'user-1',
      fiscalPeriodId: 'fp-1',
      voucherSeries: 'B',
      voucherNumber: 66,
      explanation: 'Automatiskt makulerad: test',
    })

    expect(ok).toBe(true)
    const gaps = inserts['voucher_gap_explanations'] as Record<string, unknown>[]
    expect(gaps).toHaveLength(1)
    // toEqual, not toMatchObject: the mocked harness would happily accept a
    // phantom column, so the payload is asserted exhaustively.
    expect(gaps[0]).toEqual({
      company_id: 'company-1',
      user_id: 'user-1',
      fiscal_period_id: 'fp-1',
      voucher_series: 'B',
      gap_start: 66,
      gap_end: 66,
      explanation: 'Automatiskt makulerad: test',
    })
    expect(Object.keys(gaps[0]).sort()).toEqual(REQUIRED_GAP_COLUMNS)
    // The readers (voucher-gaps UI, gnubok_list_voucher_gaps, year-end
    // readiness) key on series:gap_start:gap_end, so both bounds are the
    // stranded number itself.
    expect(gaps[0].gap_start).toBe(gaps[0].gap_end)
  })

  it('reports failure when the insert errors (an undocumented gap must surface)', async () => {
    const { supabase } = createMockSupabase({
      insertError: { message: 'new row violates row-level security policy', code: '42501' },
    })

    const ok = await recordVoucherGapExplanation(supabase as never, {
      companyId: 'company-1',
      userId: 'user-1',
      fiscalPeriodId: 'fp-1',
      voucherSeries: 'A',
      voucherNumber: 9,
      explanation: 'x',
    })

    expect(ok).toBe(false)
  })

  it('treats a duplicate-key conflict as already documented', async () => {
    const { supabase } = createMockSupabase({
      insertError: { message: 'duplicate key value', code: '23505' },
    })

    const ok = await recordVoucherGapExplanation(supabase as never, {
      companyId: 'company-1',
      userId: 'user-1',
      fiscalPeriodId: 'fp-1',
      voucherSeries: 'A',
      voucherNumber: 9,
      explanation: 'x',
    })

    expect(ok).toBe(true)
  })

  it('never throws when the client rejects unexpectedly', async () => {
    const supabase = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('network blip')
      }),
    }

    await expect(
      recordVoucherGapExplanation(supabase as never, {
        companyId: 'company-1',
        userId: 'user-1',
        fiscalPeriodId: 'fp-1',
        voucherSeries: 'A',
        voucherNumber: 9,
        explanation: 'x',
      }),
    ).resolves.toBe(false)
  })
})

describe('reverseOrphanedJournalEntry', () => {
  it('routes posted-orphan compensation through engine storno', async () => {
    const { supabase, inserts, updates } = createMockSupabase({})

    await reverseOrphanedJournalEntry(
      supabase as never,
      'company-1',
      'user-1',
      'je-1',
      'Manuell avstämning krävs.',
    )

    expect(reverseEntryMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'je-1',
    )
    expect(updates).toEqual([])
    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })

  it('documents only the exact unused reversal voucher exposed by the engine', async () => {
    const { supabase, inserts } = createMockSupabase({})
    reverseEntryMock.mockRejectedValueOnce(
      withUnusedVoucherAllocation(new Error('account lookup failed'), {
        fiscalPeriodId: 'fp-1',
        voucherSeries: 'B',
        voucherNumber: 67,
      }),
    )

    await reverseOrphanedJournalEntry(
      supabase as never,
      'company-1',
      'user-1',
      'je-1',
      'Manuell avstämning krävs.',
    )

    expect(inserts['voucher_gap_explanations']).toEqual([
      {
        company_id: 'company-1',
        user_id: 'user-1',
        fiscal_period_id: 'fp-1',
        voucher_series: 'B',
        gap_start: 67,
        gap_end: 67,
        explanation: 'Manuell avstämning krävs.',
      },
    ])
  })

  it('does not mislabel the original posted voucher when storno failure has no unused allocation', async () => {
    const { supabase, inserts } = createMockSupabase({
      orphan: { fiscal_period_id: 'fp-1', voucher_series: 'B', voucher_number: 66 },
    })
    reverseEntryMock.mockRejectedValueOnce(new Error('period locked'))

    await reverseOrphanedJournalEntry(
      supabase as never,
      'company-1',
      'user-1',
      'je-1',
      'Manuell avstämning krävs.',
    )

    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })
})

describe('cancelOrphanedPaymentEntry', () => {
  it('cancels the voucher and records a gap explanation', async () => {
    const { supabase, updates, inserts } = createMockSupabase({
      orphan: { fiscal_period_id: 'fp-1', voucher_series: 'A', voucher_number: 66 },
    })

    await cancelOrphanedPaymentEntry(
      supabase as never, 'company-1', 'user-1', 'je-1', 'Automatiskt makulerad: test',
    )

    expect(updates).toEqual([{ status: 'cancelled' }])
    const gaps = inserts['voucher_gap_explanations'] as Record<string, unknown>[]
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toEqual({
      company_id: 'company-1',
      user_id: 'user-1',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      gap_start: 66,
      gap_end: 66,
      explanation: 'Automatiskt makulerad: test',
    })
  })

  it('defaults the gap series to A when the voucher has none', async () => {
    const { supabase, inserts } = createMockSupabase({
      orphan: { fiscal_period_id: 'fp-1', voucher_series: null, voucher_number: 12 },
    })

    await cancelOrphanedPaymentEntry(
      supabase as never, 'company-1', 'user-1', 'je-1', 'x',
    )

    const gaps = inserts['voucher_gap_explanations'] as Record<string, unknown>[]
    expect(gaps[0]).toMatchObject({ voucher_series: 'A' })
  })

  it('still cancels when the orphan lookup fails, but records no gap', async () => {
    const { supabase, updates, inserts } = createMockSupabase({ orphan: null })

    await cancelOrphanedPaymentEntry(
      supabase as never, 'company-1', 'user-1', 'je-1', 'x',
    )

    expect(updates).toEqual([{ status: 'cancelled' }])
    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })

  it('never throws, even when the client rejects unexpectedly', async () => {
    const supabase = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('network blip')
      }),
    }

    await expect(
      cancelOrphanedPaymentEntry(supabase as never, 'company-1', 'user-1', 'je-1', 'x'),
    ).resolves.toBeUndefined()
  })

  it('never throws when the gap insert itself fails (the CAS response must survive)', async () => {
    const { supabase, updates } = createMockSupabase({
      orphan: { fiscal_period_id: 'fp-1', voucher_series: 'A', voucher_number: 66 },
      insertError: { message: 'permission denied', code: '42501' },
    })

    await expect(
      cancelOrphanedPaymentEntry(supabase as never, 'company-1', 'user-1', 'je-1', 'x'),
    ).resolves.toBeUndefined()
    expect(updates).toEqual([{ status: 'cancelled' }])
  })

  it('does not record a gap when the cancel itself fails', async () => {
    const { supabase, inserts } = createMockSupabase({
      orphan: { fiscal_period_id: 'fp-1', voucher_series: 'A', voucher_number: 9 },
      cancelError: { message: 'period locked' },
    })

    await cancelOrphanedPaymentEntry(
      supabase as never, 'company-1', 'user-1', 'je-1', 'x',
    )

    // The voucher is still live: a gap explanation would be a lie.
    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })
})
