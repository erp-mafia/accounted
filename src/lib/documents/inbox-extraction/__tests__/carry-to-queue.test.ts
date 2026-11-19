import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { carryReadingToQueuedItems } from '../carry-to-queue'

const mock = createQueuedMockSupabase()
const { enqueue, reset, calls, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient

const reading = { supplier: { name: 'Elgiganten' }, totals: { total: 120 } }
const carry = (supplierFor?: () => Promise<string | null>) =>
  carryReadingToQueuedItems(supabase, { companyId: 'co-1', documentId: 'doc-1', reading }, { supplierFor })

/** The filters of the first inbox-item read, as [method, args] pairs. */
function waitingFilters(): Array<[string, unknown[]]> {
  const start = calls.findIndex((c) => c.table === 'invoice_inbox_items' && c.method === 'select')
  const out: Array<[string, unknown[]]> = []
  for (const c of calls.slice(start + 1)) {
    if (c.table !== 'invoice_inbox_items' || c.method === 'select' || c.method === 'update') break
    out.push([c.method, c.args])
  }
  return out
}

beforeEach(() => {
  reset()
})

describe('carryReadingToQueuedItems (PH 101: a receipt from Dokument queued before its reading landed)', () => {
  it('fills the queued item with the reading and marks it read', async () => {
    enqueue({ data: [{ id: 'item-1' }] }) // waiting
    enqueue({ data: { doc_type: 'receipt' } }) // the document's type
    enqueue({ data: [{ id: 'item-1', matched_supplier_id: null }] }) // the fill
    expect(await carry()).toEqual(['item-1'])
    expect(findCalls('invoice_inbox_items', 'update')[0][0]).toEqual({ extracted_data: reading, extraction_skipped: false })
  })

  it('looks only for an untouched item: received, unread, not booked, registered or linked', async () => {
    enqueue({ data: [] })
    expect(await carry()).toEqual([])
    expect(waitingFilters()).toEqual([
      ['eq', ['company_id', 'co-1']],
      ['eq', ['document_id', 'doc-1']],
      ['eq', ['status', 'received']],
      ['is', ['extracted_data', null]],
      ['is', ['created_supplier_invoice_id', null]],
      ['is', ['created_journal_entry_id', null]],
      ['is', ['matched_transaction_id', null]],
    ])
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
  })

  it('writes under the same guards, so an item a person or a retry filled meanwhile keeps what it has', async () => {
    enqueue({ data: [{ id: 'item-1' }] })
    enqueue({ data: { doc_type: 'receipt' } })
    enqueue({ data: [] })
    expect(await carry()).toEqual([])
    const is = findCalls('invoice_inbox_items', 'is')
    expect(is.filter(([column]) => column === 'extracted_data')).toHaveLength(2)
    expect(findCalls('invoice_inbox_items', 'in')).toContainEqual(['id', ['item-1']])
  })

  it('keeps a credit note Arkiv typed as one, as the queue does when it copies a reading (issue #2980)', async () => {
    enqueue({ data: [{ id: 'item-1' }] })
    enqueue({ data: { doc_type: 'credit_note' } })
    enqueue({ data: [{ id: 'item-1', matched_supplier_id: null }] })
    await carry()
    expect(findCalls('invoice_inbox_items', 'update')[0][0]).toEqual({
      extracted_data: { ...reading, documentKind: 'credit_note' },
      extraction_skipped: false,
    })
  })

  it('looks the supplier up only when there was an item to fill', async () => {
    const supplierFor = vi.fn().mockResolvedValue('sup-1')
    enqueue({ data: [] })
    expect(await carry(supplierFor)).toEqual([])
    expect(supplierFor).not.toHaveBeenCalled()
  })

  it('writes the matched supplier on filled items that have none, never over a picked one', async () => {
    const supplierFor = vi.fn().mockResolvedValue('sup-1')
    enqueue({ data: [{ id: 'item-1' }, { id: 'item-2' }] })
    enqueue({ data: { doc_type: 'receipt' } })
    enqueue({ data: [{ id: 'item-1', matched_supplier_id: null }, { id: 'item-2', matched_supplier_id: 'picked' }] })
    enqueue({ data: null })
    expect(await carry(supplierFor)).toEqual(['item-1', 'item-2'])
    const updates = findCalls('invoice_inbox_items', 'update')
    expect(updates[1][0]).toEqual({ matched_supplier_id: 'sup-1' })
    expect(findCalls('invoice_inbox_items', 'in')).toContainEqual(['id', ['item-1']])
    expect(findCalls('invoice_inbox_items', 'is')).toContainEqual(['matched_supplier_id', null])
  })

  it('writes no supplier when none matched', async () => {
    enqueue({ data: [{ id: 'item-1' }] })
    enqueue({ data: { doc_type: 'receipt' } })
    enqueue({ data: [{ id: 'item-1', matched_supplier_id: null }] })
    expect(await carry(async () => null)).toEqual(['item-1'])
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(1)
  })

  it('throws on a failed read or write so the caller can log it', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(carry()).rejects.toThrow('queued item select failed: boom')
    reset()
    enqueue({ data: [{ id: 'item-1' }] })
    enqueue({ data: { doc_type: 'receipt' } })
    enqueue({ error: { message: 'bang' } })
    await expect(carry()).rejects.toThrow('queued item fill failed: bang')
  })
})
