import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getPayoutOreRounding, getRequestReceivable } from '../rot-rut-receivable'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient

const live = (id: string) => ({ id, status: 'posted', reversed_by_id: null })
const debit1513 = (entryId: string, amount: number) => ({
  journal_entry_id: entryId,
  debit_amount: amount,
  credit_amount: 0,
})

/** Queue the four lookups in the order the helper issues them. */
function enqueueLookup(params: {
  items: Array<{ invoice_id: string; requested_amount: number }>
  invoices: Array<{ id: string; journal_entry_id: string | null }>
  payments?: Array<{ invoice_id: string; journal_entry_id: string }>
  entries: Array<{ id: string; status: string; reversed_by_id: string | null }>
  lines?: Array<{ journal_entry_id: string; debit_amount: number; credit_amount: number }>
}) {
  enqueue({ data: params.items })
  enqueue({ data: params.invoices })
  enqueue({ data: params.payments ?? [] })
  enqueue({ data: params.entries })
  if (params.lines) enqueue({ data: params.lines })
}

beforeEach(() => {
  reset()
})

describe('getRequestReceivable', () => {
  it('fakturametod: reads the 1513 debit on the invoice voucher', async () => {
    enqueueLookup({
      items: [{ invoice_id: 'inv-1', requested_amount: 671 }],
      invoices: [{ id: 'inv-1', journal_entry_id: 'je-inv' }],
      entries: [live('je-inv')],
      lines: [debit1513('je-inv', 671.25)],
    })
    const result = await getRequestReceivable(supabase, 'company-1', 'req-1')
    expect(result).toEqual({
      attributable: true,
      invoices: [{ invoiceId: 'inv-1', requested: 671, receivable: 671.25, rounding: 0.25 }],
      receivable: 671.25,
      rounding: 0.25,
    })
    expect(findCall('journal_entry_lines', 'eq')).toEqual(['account_number', '1513'])
    expect(findCall('invoices', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('kontantmetod: reads the 1513 debits on the payment vouchers', async () => {
    enqueueLookup({
      items: [{ invoice_id: 'inv-1', requested_amount: 1500 }],
      invoices: [{ id: 'inv-1', journal_entry_id: null }],
      payments: [
        { invoice_id: 'inv-1', journal_entry_id: 'je-pay-1' },
        { invoice_id: 'inv-1', journal_entry_id: 'je-pay-2' },
      ],
      entries: [live('je-pay-1'), live('je-pay-2')],
      lines: [debit1513('je-pay-1', 750.3), debit1513('je-pay-2', 750.3)],
    })
    const result = await getRequestReceivable(supabase, 'company-1', 'req-1')
    expect(result).toMatchObject({ attributable: true, receivable: 1500.6, rounding: 0.6 })
  })

  it('sums the remainder over several invoices', async () => {
    enqueueLookup({
      items: [
        { invoice_id: 'inv-1', requested_amount: 671 },
        { invoice_id: 'inv-2', requested_amount: 1200 },
      ],
      invoices: [
        { id: 'inv-1', journal_entry_id: 'je-1' },
        { id: 'inv-2', journal_entry_id: 'je-2' },
      ],
      entries: [live('je-1'), live('je-2')],
      lines: [debit1513('je-1', 671.75), debit1513('je-2', 1200.5)],
    })
    const result = await getRequestReceivable(supabase, 'company-1', 'req-1')
    expect(result).toMatchObject({ attributable: true, receivable: 1872.25, rounding: 1.25 })
  })

  it('whole-kronor receivable: attributable with zero rounding', async () => {
    enqueueLookup({
      items: [{ invoice_id: 'inv-1', requested_amount: 3000 }],
      invoices: [{ id: 'inv-1', journal_entry_id: 'je-1' }],
      entries: [live('je-1')],
      lines: [debit1513('je-1', 3000)],
    })
    const result = await getRequestReceivable(supabase, 'company-1', 'req-1')
    expect(result).toMatchObject({ attributable: true, rounding: 0 })
  })

  it('a reversed invoice voucher carries no receivable: not attributable', async () => {
    enqueueLookup({
      items: [{ invoice_id: 'inv-1', requested_amount: 671 }],
      invoices: [{ id: 'inv-1', journal_entry_id: 'je-1' }],
      entries: [{ id: 'je-1', status: 'posted', reversed_by_id: 'je-storno' }],
    })
    const result = await getRequestReceivable(supabase, 'company-1', 'req-1')
    expect(result.attributable).toBe(false)
  })

  it('a remainder of a krona or more is not rounding', async () => {
    enqueueLookup({
      items: [{ invoice_id: 'inv-1', requested_amount: 671 }],
      invoices: [{ id: 'inv-1', journal_entry_id: 'je-1' }],
      entries: [live('je-1')],
      lines: [debit1513('je-1', 672)],
    })
    expect((await getRequestReceivable(supabase, 'company-1', 'req-1')).attributable).toBe(false)
  })

  it('one unattributable invoice makes the whole begäran unattributable', async () => {
    enqueueLookup({
      items: [
        { invoice_id: 'inv-1', requested_amount: 671 },
        { invoice_id: 'inv-2', requested_amount: 500 },
      ],
      invoices: [
        { id: 'inv-1', journal_entry_id: 'je-1' },
        { id: 'inv-2', journal_entry_id: 'je-2' },
      ],
      entries: [live('je-1'), live('je-2')],
      lines: [debit1513('je-1', 671.25), debit1513('je-2', 450)],
    })
    expect((await getRequestReceivable(supabase, 'company-1', 'req-1')).attributable).toBe(false)
  })

  it('a voucher shared by two invoices cannot be split: not attributable', async () => {
    enqueueLookup({
      items: [
        { invoice_id: 'inv-1', requested_amount: 671 },
        { invoice_id: 'inv-2', requested_amount: 500 },
      ],
      invoices: [
        { id: 'inv-1', journal_entry_id: null },
        { id: 'inv-2', journal_entry_id: null },
      ],
      payments: [
        { invoice_id: 'inv-1', journal_entry_id: 'je-batch' },
        { invoice_id: 'inv-2', journal_entry_id: 'je-batch' },
      ],
      entries: [],
    })
    expect((await getRequestReceivable(supabase, 'company-1', 'req-1')).attributable).toBe(false)
  })

  it('an invoice outside the company is not found: not attributable', async () => {
    enqueueLookup({
      items: [{ invoice_id: 'inv-1', requested_amount: 671 }],
      invoices: [],
      entries: [],
    })
    expect((await getRequestReceivable(supabase, 'company-1', 'req-1')).attributable).toBe(false)
  })
})

describe('getPayoutOreRounding', () => {
  it('returns the remainder when the payout equals the requested kronor', async () => {
    enqueueLookup({
      items: [{ invoice_id: 'inv-1', requested_amount: 671 }],
      invoices: [{ id: 'inv-1', journal_entry_id: 'je-1' }],
      entries: [live('je-1')],
      lines: [debit1513('je-1', 671.25)],
    })
    expect(await getPayoutOreRounding(supabase, 'company-1', { id: 'req-1', requested_total: 671 }, 671)).toEqual({ rounding: 0.25, invoiceCount: 1 })
  })

  it('returns 0 without querying when the payout is not the requested total', async () => {
    expect(await getPayoutOreRounding(supabase, 'company-1', { id: 'req-1', requested_total: 671 }, 600)).toEqual({ rounding: 0, invoiceCount: 0 })
    expect(findCall('rot_rut_payout_request_items', 'select')).toBeUndefined()
  })

  it('returns 0 when the items do not add up to the header', async () => {
    enqueueLookup({
      items: [{ invoice_id: 'inv-1', requested_amount: 600 }],
      invoices: [{ id: 'inv-1', journal_entry_id: 'je-1' }],
      entries: [live('je-1')],
      lines: [debit1513('je-1', 600.5)],
    })
    expect(await getPayoutOreRounding(supabase, 'company-1', { id: 'req-1', requested_total: 671 }, 671)).toEqual({ rounding: 0, invoiceCount: 0 })
  })

  it('returns 0 when the begäran is not attributable', async () => {
    enqueueLookup({
      items: [{ invoice_id: 'inv-1', requested_amount: 671 }],
      invoices: [{ id: 'inv-1', journal_entry_id: 'je-1' }],
      entries: [{ id: 'je-1', status: 'reversed', reversed_by_id: null }],
    })
    expect(await getPayoutOreRounding(supabase, 'company-1', { id: 'req-1', requested_total: 671 }, 671)).toEqual({ rounding: 0, invoiceCount: 0 })
  })
})
