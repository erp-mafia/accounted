import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { routeClassifiedDocument } from '../route-from-arkiv'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCall, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient

const doc = { id: 'doc-1', user_id: 'user-1', journal_entry_id: null, extracted_data: { lineItems: [] } }
const item = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  routed_to_arkiv_at: null,
  created_supplier_invoice_id: null,
  created_journal_entry_id: null,
  matched_transaction_id: null,
  ...over,
})
const classified = (docType: string, admission: 'admitted' | 'held' = 'admitted') =>
  routeClassifiedDocument(supabase, { documentId: 'doc-1', companyId: 'co-1', userId: 'user-1', docType, admission })

beforeEach(() => reset())

describe('routeClassifiedDocument', () => {
  it("queues a receipt that arrived any other way, with the Underlag reader's read when it ran", async () => {
    enqueue({ data: doc })
    enqueue({ data: [] })
    enqueue({})
    expect(await classified('receipt')).toBe('queued')
    expect(findCall('invoice_inbox_items', 'insert')?.[0]).toEqual({
      company_id: 'co-1',
      user_id: 'user-1',
      status: 'received',
      source: 'upload',
      document_id: 'doc-1',
      kind_hint: 'receipt',
      extracted_data: { lineItems: [] },
      extraction_skipped: false,
    })
  })

  it('leaves a receipt alone when it is already queued, booked, or attached to a voucher', async () => {
    enqueue({ data: doc })
    enqueue({ data: [item()] })
    expect(await classified('supplier_invoice')).toBe('already_queued')
    enqueue({ data: doc })
    enqueue({ data: [item({ matched_transaction_id: 'tx-1' })] })
    expect(await classified('supplier_invoice')).toBe('booked')
    enqueue({ data: { ...doc, journal_entry_id: 'je-1' } })
    enqueue({ data: [] })
    expect(await classified('receipt')).toBe('booked')
    expect(findCalls('invoice_inbox_items', 'insert')).toEqual([])
  })

  it('takes an agreement that came through the inbox out of the queue, and puts it back when a person retypes it', async () => {
    enqueue({ data: doc })
    enqueue({ data: [item(), item({ id: 'item-2', matched_transaction_id: 'tx-9' })] })
    enqueue({})
    expect(await classified('agreement.loan')).toBe('routed_to_arkiv')
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ routed_to_arkiv_at: expect.any(String), routed_doc_type: 'agreement.loan' })
    expect(findCall('invoice_inbox_items', 'in')).toEqual(['id', ['item-1']])

    reset()
    enqueue({ data: doc })
    enqueue({ data: [item({ routed_to_arkiv_at: '2026-09-16T05:00:00Z' })] })
    enqueue({})
    expect(await classified('receipt')).toBe('requeued')
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ routed_to_arkiv_at: null, routed_doc_type: null })
  })

  it("does nothing for a held document, an unknown one, or a document that is not the company's", async () => {
    enqueue({ data: doc })
    enqueue({ data: [] })
    expect(await classified('receipt', 'held')).toBe('left')
    enqueue({ data: doc })
    enqueue({ data: [item({ routed_to_arkiv_at: '2026-09-16T05:00:00Z' })] })
    expect(await classified('other')).toBe('left')
    enqueue({ data: null })
    expect(await classified('receipt')).toBe('not_found')
  })
})
