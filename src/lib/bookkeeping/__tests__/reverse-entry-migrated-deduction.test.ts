/**
 * reverseEntry's two hooks for a migrated invoice's deduction
 * reclassification (source_type rot_rut_reclassification): the begäran check
 * runs before a voucher number is drawn, the invoice revert after the storno
 * is posted. The hooks themselves are tested in
 * lib/invoices/__tests__/migrated-deduction-reversal.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MigratedDeductionHeldByRequestError } from '../errors'

const { order, assertReversible, syncAfterReversal, syncReclaim } = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    assertReversible: vi.fn(async () => {
      order.push('assert')
    }),
    syncAfterReversal: vi.fn(async () => {
      order.push('sync')
    }),
    syncReclaim: vi.fn(async () => {}),
  }
})

vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/lib/bookkeeping/account-backfill', () => ({ backfillStandardBASAccounts: vi.fn().mockResolvedValue([]) }))
// The storno's own date and open-year check (storno-target.ts) has its own
// tests; here it passes and keeps the original's date.
vi.mock('@/lib/core/bookkeeping/storno-target', () => ({
  assertStornoTarget: vi.fn(async (_s: unknown, _c: unknown, original: { entry_date: string }, date?: string) =>
    date ?? original.entry_date),
}))
vi.mock('@/lib/invoices/migrated-deduction-reversal', () => ({
  assertMigratedDeductionReversible: assertReversible,
  syncMigratedDeductionAfterReversal: syncAfterReversal,
}))
vi.mock('@/lib/invoices/rot-rut-reclaim-reversal', () => ({ syncRotRutReclaimAfterReversal: syncReclaim }))

import { reverseEntry } from '../engine'

function reclassification(overrides: Record<string, unknown> = {}) {
  const description = 'RUT-avdrag faktura 1042, omföring vid systembyte'
  return {
    id: 'entry-1',
    company_id: 'company-1',
    status: 'posted',
    fiscal_period_id: 'period-1',
    voucher_series: 'A',
    voucher_number: 12,
    entry_date: '2026-10-14',
    description,
    source_type: 'rot_rut_reclassification',
    source_id: 'inv-1',
    lines: [
      { account_number: '1513', debit_amount: 3750, credit_amount: 0, line_description: description },
      { account_number: '1510', debit_amount: 0, credit_amount: 3750, line_description: description },
    ],
    ...overrides,
  }
}

/**
 * A client that walks reverseEntry's happy path: fetch the original, insert
 * the storno, post it, flip the original to reversed, read the result. Every
 * write and RPC is appended to `order` next to the hooks' own entries.
 */
function supabaseFor(original: Record<string, unknown>) {
  const reversal = { id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }
  const jeResults = [
    { data: original, error: null }, // fetch original (.single)
    { data: reversal, error: null }, // insert storno (.single)
    { data: null, error: null }, // post storno (await)
    { data: [{ id: 'entry-1' }], error: null }, // CAS original -> reversed (await)
    { data: { ...reversal, lines: [] }, error: null }, // fetch the complete storno (.single)
  ]
  let jeCall = 0

  function chain(result: { data: unknown; error: unknown }) {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) b[m] = vi.fn().mockReturnValue(b)
    b.then = (resolve: (v: unknown) => void) => resolve(result)
    return b
  }

  function journalEntries() {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
    b.insert = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      order.push(`insert:${String(payload.source_type)}`)
      return b
    })
    b.update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      order.push(`update:${String(payload.status)}`)
      return b
    })
    b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
    b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
    return b
  }

  return {
    rpc: vi.fn().mockImplementation(async (name: string) => {
      order.push(`rpc:${name}`)
      return name === 'next_voucher_number' ? { data: 13, error: null } : { data: {}, error: null }
    }),
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'journal_entries') return journalEntries()
      if (table === 'chart_of_accounts') {
        return chain({
          data: [
            { id: 'acc-1513', account_number: '1513' },
            { id: 'acc-1510', account_number: '1510' },
          ],
          error: null,
        })
      }
      if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
      return chain({ data: [], error: null })
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  order.length = 0
})

describe('reverseEntry: rot_rut_reclassification', () => {
  it('checks the begäran before drawing a voucher number, and reverts the invoice after the storno is posted', async () => {
    const original = reclassification()
    const supabase = supabaseFor(original)

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(assertReversible).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', expect.objectContaining({ id: 'entry-1', source_id: 'inv-1' }))
    expect(syncAfterReversal).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', expect.objectContaining({ id: 'entry-1', source_id: 'inv-1' }))
    expect(syncReclaim).not.toHaveBeenCalled()

    const at = (step: string) => order.indexOf(step)
    expect(at('assert')).toBeGreaterThanOrEqual(0)
    expect(at('assert')).toBeLessThan(at('rpc:next_voucher_number'))
    expect(at('rpc:next_voucher_number')).toBeLessThan(at('insert:storno'))
    expect(at('insert:storno')).toBeLessThan(at('update:posted'))
    expect(at('update:posted')).toBeLessThan(at('update:reversed'))
    expect(at('update:reversed')).toBeLessThan(at('sync'))
  })

  it('does not reverse when a begäran holds the invoice: no voucher number, no storno, no revert', async () => {
    const supabase = supabaseFor(reclassification())
    assertReversible.mockRejectedValueOnce(new MigratedDeductionHeldByRequestError('inv-1'))

    await expect(reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')).rejects.toBeInstanceOf(
      MigratedDeductionHeldByRequestError,
    )

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(order.filter((step) => step.startsWith('insert:') || step.startsWith('update:'))).toEqual([])
    expect(syncAfterReversal).not.toHaveBeenCalled()
  })

  it('does not reverse when the check itself fails', async () => {
    const supabase = supabaseFor(reclassification())
    assertReversible.mockRejectedValueOnce({ message: 'connection reset' })

    await expect(reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')).rejects.toEqual({
      message: 'connection reset',
    })

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(syncAfterReversal).not.toHaveBeenCalled()
  })

  it('leaves other vouchers alone', async () => {
    const supabase = supabaseFor(reclassification({ source_type: 'manual', source_id: null }))

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(assertReversible).not.toHaveBeenCalled()
    expect(syncAfterReversal).not.toHaveBeenCalled()
  })
})
