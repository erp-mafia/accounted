import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { batchAllocationsFromParts, readTransactionParts } from '../parts-read'

describe('batchAllocationsFromParts', () => {
  it('turns a fully suggested split into one allocation per part, in the parts\' order, with the part amount as a magnitude', () => {
    expect(batchAllocationsFromParts([
      { amount: 500, suggested_invoice_id: 'inv-1', suggested_supplier_invoice_id: null },
      { amount: '1000.00' as unknown as number, suggested_invoice_id: 'inv-2', suggested_supplier_invoice_id: null },
    ])).toEqual([
      { kind: 'customer_invoice', invoice_id: 'inv-1', amount: 500 },
      { kind: 'customer_invoice', invoice_id: 'inv-2', amount: 1000 },
    ])
    expect(batchAllocationsFromParts([
      { amount: -1200, suggested_invoice_id: null, suggested_supplier_invoice_id: 'si-1' },
      { amount: -300, suggested_invoice_id: null, suggested_supplier_invoice_id: 'si-2' },
    ])).toEqual([
      { kind: 'supplier_invoice', supplier_invoice_id: 'si-1', amount: 1200 },
      { kind: 'supplier_invoice', supplier_invoice_id: 'si-2', amount: 300 },
    ])
  })

  it('offers nothing for an incomplete split, a mixed one, or no parts', () => {
    expect(batchAllocationsFromParts([
      { amount: 500, suggested_invoice_id: 'inv-1', suggested_supplier_invoice_id: null },
      { amount: 1000, suggested_invoice_id: null, suggested_supplier_invoice_id: null },
    ])).toBeNull()
    expect(batchAllocationsFromParts([
      { amount: 500, suggested_invoice_id: 'inv-1', suggested_supplier_invoice_id: null },
      { amount: 1000, suggested_invoice_id: null, suggested_supplier_invoice_id: 'si-1' },
    ])).toBeNull()
    expect(batchAllocationsFromParts([])).toBeNull()
  })
})

describe('readTransactionParts', () => {
  const stored = (seq: number, extra: Record<string, unknown> = {}) => ({
    id: `part-${seq}`, company_id: 'company-1', transaction_id: 'tx-1', seq, amount: '500.00', currency: 'SEK',
    counterparty_name: 'Kund AB', counterparty_org_number: null, counterparty_account: null, reference: null, invoice_numbers: [],
    message: null, provider_part_id: null, suggested_invoice_id: null, suggested_supplier_invoice_id: null, suggestion_reason: null,
    created_at: '2026-10-12T05:00:00Z', updated_at: '2026-10-12T05:00:00Z', ...extra,
  })

  it('reads nothing but the parts for a row whose parts carry no suggestion', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [stored(1), stored(2)] })
    const parts = await readTransactionParts(supabase as never, 'company-1', 'tx-1')
    expect(parts.map((p) => [p.seq, p.amount, p.suggested_invoice])).toEqual([[1, 500, null], [2, 500, null]])
    expect(findCalls('bank_transaction_parts', 'eq')).toEqual([['company_id', 'company-1'], ['transaction_id', 'tx-1']])
    expect(findCalls('bank_transaction_parts', 'order')).toEqual([['seq', { ascending: true }]])
    expect(findCalls('invoices', 'in')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'in')).toHaveLength(0)
  })

  it('throws on a refused read instead of answering "no split"', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'permission denied' } })
    await expect(readTransactionParts(supabase as never, 'company-1', 'tx-1')).rejects.toMatchObject({ message: 'permission denied' })
  })

  it('names the suggested invoice (number, counterparty, what is left) and drops one that is no longer open', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [
      stored(1, { suggested_invoice_id: 'inv-1', suggestion_reason: 'ocr_exact' }),
      stored(2, { suggested_invoice_id: 'inv-paid', suggestion_reason: 'amount_only' }),
      stored(3, { suggested_invoice_id: 'inv-gone', suggestion_reason: 'invoice_number' }),
    ] })
    enqueue({ data: [
      { id: 'inv-1', invoice_number: '1001', remaining_amount: '500.00', currency: 'SEK', status: 'partially_paid', customer: { name: 'Kund AB' } },
      { id: 'inv-paid', invoice_number: '1002', remaining_amount: 0, currency: 'SEK', status: 'paid', customer: { name: 'Kund AB' } },
    ] })
    const parts = await readTransactionParts(supabase as never, 'company-1', 'tx-1')
    expect(parts[0]!.suggested_invoice).toEqual({ kind: 'customer_invoice', invoice_id: 'inv-1', invoice_number: '1001', counterparty_name: 'Kund AB', remaining_amount: 500, currency: 'SEK' })
    expect(parts[0]!.suggestion_reason).toBe('ocr_exact')
    expect(parts[1]!.suggested_invoice).toBeNull()
    expect(parts[1]!.suggestion_reason).toBeNull()
    expect(parts[2]!.suggested_invoice).toBeNull()
  })

  it('labels a supplier invoice without its own number by its arrival number', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [stored(1, { amount: '-300.00', suggested_supplier_invoice_id: 'si-1', suggestion_reason: 'amount_only' })] })
    enqueue({ data: [{ id: 'si-1', supplier_invoice_number: null, arrival_number: 12, remaining_amount: 300, currency: 'SEK', status: 'registered', supplier: { name: 'Elbolaget AB' } }] })
    const [part] = await readTransactionParts(supabase as never, 'company-1', 'tx-1')
    expect(part!.amount).toBe(-300)
    expect(part!.suggested_invoice).toEqual({ kind: 'supplier_invoice', invoice_id: 'si-1', invoice_number: 'LF-12', counterparty_name: 'Elbolaget AB', remaining_amount: 300, currency: 'SEK' })
  })
})
