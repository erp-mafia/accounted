import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { loadSuggestedMatches } from '../match-suggestions'

// crm#1510: Accounted's own match on an unbooked bank row, read for agents.
describe('loadSuggestedMatches', () => {
  it('reads nothing when no row carries a pointer', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    const out = await loadSuggestedMatches(supabase as never, 'company-1', [{ id: 't-1' }])
    expect(out.size).toBe(0)
    expect(findCalls('supplier_invoices', 'in')).toHaveLength(0)
    expect(findCalls('invoices', 'in')).toHaveLength(0)
    expect(findCalls('journal_entries', 'in')).toHaveLength(0)
  })

  it('suggests an open customer invoice and leaves out a credited one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'inv-open', invoice_number: '231', remaining_amount: 6000, status: 'sent' },
        { id: 'inv-credited', invoice_number: '232', remaining_amount: 0, status: 'credited' },
      ],
      error: null,
    })
    const out = await loadSuggestedMatches(supabase as never, 'company-1', [
      { id: 't-1', potential_invoice_id: 'inv-open' },
      { id: 't-2', potential_invoice_id: 'inv-credited' },
    ])
    expect(out.get('t-1')).toEqual({ kind: 'customer_invoice', invoice_id: 'inv-open', invoice_number: '231', remaining_amount: 6000 })
    expect(out.has('t-2')).toBe(false)
  })

  it('prefers the invoice over a verifikat on the same row, as Att göra does', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'si-1', supplier_invoice_number: null, remaining_amount: null, status: 'approved' }], error: null })
    enqueue({ data: [{ id: 'je-1', voucher_series: 'A', voucher_number: 3, status: 'posted' }], error: null })
    const out = await loadSuggestedMatches(supabase as never, 'company-1', [
      { id: 't-1', potential_supplier_invoice_id: 'si-1', potential_journal_entry_id: 'je-1' },
    ])
    expect(out.get('t-1')).toEqual({ kind: 'supplier_invoice', supplier_invoice_id: 'si-1', invoice_number: null, remaining_amount: null })
  })

  it('fails loudly on a failed read instead of dropping the suggestion', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'statement timeout', code: '57014' } })
    await expect(
      loadSuggestedMatches(supabase as never, 'company-1', [{ id: 't-1', potential_supplier_invoice_id: 'si-1' }]),
    ).rejects.toThrow()
  })
})
