import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  calculateSarskildLoneskatt,
  SLP_RATE,
} from '../tax-provision/sarskild-loneskatt-calculator'

function makeSupabaseWithPensionLines(
  rows: Array<{ account_number?: string; debit_amount: number; credit_amount: number }>,
) {
  // The calculator uses the two-step entry-lines fetch
  // (lib/bookkeeping/entry-lines.ts): call 1 reads journal_entries, call 2
  // reads journal_entry_lines for those entry ids. One line query covers both
  // 7410-7419 (the base) and 7533 (SLP already posted); rows default to a
  // pension account when the fixture omits account_number.
  const withAccounts = rows.map((row) => ({ account_number: '7410', ...row }))
  const responses: Array<{ data: unknown; error: unknown }> = [
    { data: [{ id: 'entry-1' }], error: null },
    { data: withAccounts, error: null },
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
})
