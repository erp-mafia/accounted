import { describe, it, expect, vi } from 'vitest'
import { cancelOrphanedPaymentEntry } from '../cancel-orphaned-entry'

function createMockSupabase(opts: {
  orphan?: { fiscal_period_id: string; voucher_series: string | null; voucher_number: number } | null
  cancelError?: { message: string } | null
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
        return Promise.resolve({ error: null })
      }),
    })),
  }
  return { supabase, updates, inserts }
}

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
    expect(gaps[0]).toMatchObject({
      company_id: 'company-1',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      gap_number: 66,
      explanation: 'Automatiskt makulerad: test',
      created_by: 'user-1',
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
