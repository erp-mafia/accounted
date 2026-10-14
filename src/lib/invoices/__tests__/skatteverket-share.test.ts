import { describe, it, expect, vi } from 'vitest'
import {
  fetchSkatteverketSettled,
  liveReceivableOutstanding,
  openSkatteverketShare,
  outstandingLessPayouts,
  skatteverketSettled,
} from '../skatteverket-share'

// RUT invoice: total 10 000, deduction 3 000 on 1513, customer share 7 000.
const rut = { deduction_total: 3000, deduction_reclaimed_total: 0 }

describe('skatteverketSettled', () => {
  it('is 0 without settled begäran items', () => {
    expect(skatteverketSettled(rut, [])).toBe(0)
  })

  it('counts the whole deduction for a begäran paid in full, öre included', () => {
    // The request asks for whole kronor (2 999), the payout also clears the
    // öre the invoice carried on 1513.
    const withOre = { deduction_total: 2999.6, deduction_reclaimed_total: 0 }
    expect(skatteverketSettled(withOre, [{ request_status: 'paid', decided_amount: 2999 }])).toBe(2999.6)
  })

  it('counts the decided amount of a partly paid begäran', () => {
    expect(skatteverketSettled(rut, [{ request_status: 'partially_paid', decided_amount: 2000 }])).toBe(2000)
  })

  it('reads a missing decided amount as nothing paid', () => {
    expect(skatteverketSettled(rut, [{ request_status: 'partially_paid', decided_amount: null }])).toBe(0)
  })

  it('counts a paid begäran as the deduction not reclaimed', () => {
    const reclaimed = { deduction_total: 3000, deduction_reclaimed_total: 1000 }
    expect(skatteverketSettled(reclaimed, [{ request_status: 'paid', decided_amount: 2000 }])).toBe(2000)
  })

  it('never exceeds the claim when a re-request after a partial payout is paid', () => {
    expect(
      skatteverketSettled(rut, [
        { request_status: 'partially_paid', decided_amount: 2000 },
        { request_status: 'paid', decided_amount: 1000 },
      ])
    ).toBe(3000)
  })

  it('is 0 for an invoice without a deduction', () => {
    expect(skatteverketSettled({ deduction_total: 0 }, [{ request_status: 'paid', decided_amount: 100 }])).toBe(0)
    expect(skatteverketSettled({ deduction_total: null }, [])).toBe(0)
  })
})

describe('openSkatteverketShare', () => {
  it('is the whole deduction while the begäran is unsettled', () => {
    expect(openSkatteverketShare(rut, 0)).toBe(3000)
  })

  it('is 0 once Skatteverket has paid it all', () => {
    expect(openSkatteverketShare(rut, 3000)).toBe(0)
  })

  it('is the refused remainder after a partial payout, until reclaimed', () => {
    expect(openSkatteverketShare(rut, 2000)).toBe(1000)
    expect(openSkatteverketShare({ deduction_total: 3000, deduction_reclaimed_total: 1000 }, 2000)).toBe(0)
  })

  it('leaves out the reclaimed part, which is the customer\'s again', () => {
    expect(openSkatteverketShare({ deduction_total: 3000, deduction_reclaimed_total: 500 }, 0)).toBe(2500)
  })

  it('accepts numeric strings and rounds to the öre', () => {
    expect(openSkatteverketShare({ deduction_total: '1234.56', deduction_reclaimed_total: '0.01' }, 0)).toBe(1234.55)
  })

  it('is 0 without a deduction, and never negative', () => {
    expect(openSkatteverketShare({ deduction_total: 0 }, 0)).toBe(0)
    expect(openSkatteverketShare({ deduction_total: Number.NaN }, 0)).toBe(0)
    expect(openSkatteverketShare(rut, 5000)).toBe(0)
  })
})

describe('outstandingLessPayouts', () => {
  it('returns the outstanding untouched when nothing was paid out', () => {
    expect(outstandingLessPayouts(100.1, undefined)).toBe(100.1)
    expect(outstandingLessPayouts(100.1, 0)).toBe(100.1)
  })

  it('subtracts the payouts', () => {
    expect(outstandingLessPayouts(3000, 2000)).toBe(1000)
  })
})

describe('liveReceivableOutstanding', () => {
  it('reads a paid invoice with a deduction as its open Skatteverket share', () => {
    expect(liveReceivableOutstanding({ ...rut, status: 'paid' }, 3000, undefined)).toBe(3000)
    expect(liveReceivableOutstanding({ ...rut, status: 'paid' }, 3000, 2000)).toBe(1000)
    expect(liveReceivableOutstanding({ ...rut, status: 'paid' }, 3000, 3000)).toBe(0)
  })

  it('ignores paid_amount on a paid invoice with a deduction', () => {
    // total - paid_amount says 0 (paid_amount = total), the claim is still open.
    expect(liveReceivableOutstanding({ ...rut, status: 'paid' }, 0, undefined)).toBe(3000)
  })

  it('subtracts the payouts from an open invoice', () => {
    const reclaimed = { deduction_total: 3000, deduction_reclaimed_total: 1000, status: 'partially_paid' }
    expect(liveReceivableOutstanding(reclaimed, 3000, 2000)).toBe(1000)
  })

  it('leaves an invoice without a deduction exactly as it was', () => {
    expect(liveReceivableOutstanding({ status: 'sent', deduction_total: 0 }, 1234.5, undefined)).toBe(1234.5)
    expect(liveReceivableOutstanding({ status: 'paid', deduction_total: null }, 0, undefined)).toBe(0)
  })
})

describe('fetchSkatteverketSettled', () => {
  function client(pages: Array<{ data: unknown; error: unknown }>) {
    const calls: Array<{ method: string; args: unknown[] }> = []
    let page = 0
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'in', 'eq', 'not', 'order', 'range']) {
      builder[m] = vi.fn((...args: unknown[]) => {
        calls.push({ method: m, args })
        return builder
      })
    }
    builder.then = (resolve: (v: unknown) => void) => resolve(pages[page++] ?? { data: [], error: null })
    const from = vi.fn(() => builder)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { supabase: { from } as any, calls, from }
  }

  const item = (invoiceId: string, status: string, decided: number | null, entryDate: string) => ({
    id: `item-${invoiceId}-${status}`,
    invoice_id: invoiceId,
    decided_amount: decided,
    request: { status, settlement: { entry_date: entryDate } },
  })

  it('makes no query when no invoice has a deduction', async () => {
    const { supabase, from } = client([])
    const settled = await fetchSkatteverketSettled(supabase, 'company-1', [
      { id: 'plain', deduction_total: 0 },
      { id: 'null', deduction_total: null },
    ])
    expect(settled.size).toBe(0)
    expect(from).not.toHaveBeenCalled()
  })

  it('reads the settled items of the company and sums them per invoice', async () => {
    const { supabase, calls, from } = client([
      {
        data: [
          item('inv-paid', 'paid', 3000, '2025-05-10'),
          item('inv-part', 'partially_paid', 2000, '2025-05-10'),
        ],
        error: null,
      },
    ])
    const settled = await fetchSkatteverketSettled(supabase, 'company-1', [
      { id: 'inv-paid', ...rut },
      { id: 'inv-part', ...rut },
      { id: 'inv-open', ...rut },
      { id: 'plain', deduction_total: 0 },
    ])

    expect(from).toHaveBeenCalledWith('rot_rut_payout_request_items')
    expect(calls).toContainEqual({ method: 'in', args: ['invoice_id', ['inv-paid', 'inv-part', 'inv-open']] })
    expect(calls).toContainEqual({ method: 'eq', args: ['request.company_id', 'company-1'] })
    expect(calls).toContainEqual({ method: 'not', args: ['request.settlement_journal_entry_id', 'is', null] })
    expect(settled.get('inv-paid')).toBe(3000)
    expect(settled.get('inv-part')).toBe(2000)
    expect(settled.has('inv-open')).toBe(false)
  })

  it('counts only payouts dated on or before the as-of date', async () => {
    const rows = { data: [item('inv-1', 'paid', 3000, '2025-05-10')], error: null }

    const before = client([rows])
    expect((await fetchSkatteverketSettled(before.supabase, 'company-1', [{ id: 'inv-1', ...rut }], '2025-05-09')).has('inv-1')).toBe(false)

    const on = client([rows])
    expect((await fetchSkatteverketSettled(on.supabase, 'company-1', [{ id: 'inv-1', ...rut }], '2025-05-10')).get('inv-1')).toBe(3000)
  })

  it('reads the ids in chunks', async () => {
    const { supabase, calls } = client([])
    const invoices = Array.from({ length: 250 }, (_, i) => ({ id: `inv-${i}`, ...rut }))
    await fetchSkatteverketSettled(supabase, 'company-1', invoices)
    const idReads = calls.filter((c) => c.method === 'in' && c.args[0] === 'invoice_id')
    expect(idReads.map((c) => (c.args[1] as string[]).length)).toEqual([200, 50])
  })

  it('throws when the items cannot be read', async () => {
    const { supabase } = client([{ data: null, error: { message: 'boom' } }])
    await expect(fetchSkatteverketSettled(supabase, 'company-1', [{ id: 'inv-1', ...rut }])).rejects.toThrow()
  })
})
