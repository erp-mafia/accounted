import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  calculateSarskildLoneskatt,
  SLP_RATE,
} from '../tax-provision/sarskild-loneskatt-calculator'

function makeSupabaseWithPensionLines(rows: Array<{ debit_amount: number; credit_amount: number }>) {
  // The calculator uses the two-step entry-lines fetch
  // (lib/bookkeeping/entry-lines.ts): call 1 reads journal_entries, call 2
  // reads journal_entry_lines for those entry ids.
  const responses: Array<{ data: unknown; error: unknown }> = [
    { data: [{ id: 'entry-1' }], error: null },
    { data: rows, error: null },
  ]
  let call = 0
  const makeBuilder = () => {
    const result = responses[call++] ?? { data: null, error: null }
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'range']) {
      b[m] = vi.fn().mockReturnValue(b)
    }
    b.then = (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(result)
    return b
  }
  return { from: vi.fn().mockImplementation(() => makeBuilder()) } as unknown as Parameters<
    typeof calculateSarskildLoneskatt
  >[0]
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

  it('exposes the SLP rate constant', () => {
    expect(SLP_RATE).toBe(0.2426)
  })
})
