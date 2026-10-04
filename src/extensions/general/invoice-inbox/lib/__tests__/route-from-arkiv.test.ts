import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolveInboxKind, type InboxKindSource } from '@/lib/documents/inbox-kind'
import { inboxSawABill, requeueHiddenRoutedItems, routeClassifiedDocument, routeStaleQueueItems } from '../route-from-arkiv'

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
const classified = (docType: string, admission: 'admitted' | 'held' = 'admitted', decidedBy?: 'model' | 'human') =>
  routeClassifiedDocument(supabase, { documentId: 'doc-1', companyId: 'co-1', userId: 'user-1', docType, admission, decidedBy })
const retypedByPerson = (docType: string) => classified(docType, 'admitted', 'human')
/** What Underlag shows for the item once the update is applied; supabase-js drops undefined keys from the body. */
const shownAfterUpdate = (before: Record<string, unknown>) => {
  const written = Object.entries(findCall('invoice_inbox_items', 'update')?.[0] as Record<string, unknown>).filter(([, v]) => v !== undefined)
  return resolveInboxKind({ ...before, ...Object.fromEntries(written) } as InboxKindSource)
}

const savedSection = process.env.ARKIV_COMPANY_IDS

beforeEach(() => {
  reset()
  // co-1 sees the Dokument section unless a test says otherwise.
  process.env.ARKIV_COMPANY_IDS = 'co-1'
})

afterEach(() => {
  if (savedSection === undefined) delete process.env.ARKIV_COMPANY_IDS
  else process.env.ARKIV_COMPANY_IDS = savedSection
})

describe('routeClassifiedDocument', () => {
  it('never queues a document that arrived more than a day before it was classified: the backfill types old uploads', async () => {
    enqueue({ data: { ...doc, created_at: new Date(Date.now() - 8 * 86_400_000).toISOString() } })
    enqueue({ data: [] })
    expect(await classified('supplier_invoice')).toBe('left')
    expect(findCall('invoice_inbox_items', 'insert')).toBeUndefined()
  })

  it('queues one classified within the day it arrived', async () => {
    enqueue({ data: { ...doc, created_at: new Date(Date.now() - 3_600_000).toISOString() } })
    enqueue({ data: [] })
    enqueue({})
    expect(await classified('supplier_invoice')).toBe('queued')
  })

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

  it('queues a credit note as a supplier document whose reading says credit note (issue #2980)', async () => {
    enqueue({ data: { ...doc, extracted_data: { documentKind: 'supplier_invoice', lineItems: [] } } })
    enqueue({ data: [] })
    enqueue({})
    expect(await classified('credit_note')).toBe('queued')
    expect(findCall('invoice_inbox_items', 'insert')?.[0]).toMatchObject({
      kind_hint: 'supplier_invoice',
      extracted_data: { documentKind: 'credit_note', lineItems: [] },
    })
  })

  it('queues a credit note the inbox never read without inventing a reading', async () => {
    enqueue({ data: { ...doc, extracted_data: null } })
    enqueue({ data: [] })
    enqueue({})
    expect(await classified('credit_note')).toBe('queued')
    expect(findCall('invoice_inbox_items', 'insert')?.[0]).toMatchObject({ extracted_data: null, extraction_skipped: true })
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
    enqueue({ data: [{ id: 'item-1' }] })
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

  describe("a person's type in Dokument reaches the item already in Underlag", () => {
    const readAsInvoice = { documentKind: 'supplier_invoice', totals: { subtotal: 80, vatAmount: 20, total: 100 } }
    const inUnderlag = { routed_to_arkiv_at: null, routed_doc_type: null }

    it('shows a receipt the inbox read as a supplier invoice as a receipt once a person says so (reported case)', async () => {
      const queued = item({ kind_hint: null, extracted_data: readAsInvoice })
      expect(resolveInboxKind(queued as InboxKindSource)).toBe('supplier_invoice')
      enqueue({ data: doc })
      enqueue({ data: [queued] })
      enqueue({ data: [{ id: 'item-1' }] })
      expect(await retypedByPerson('receipt')).toBe('retyped')
      expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ ...inUnderlag, kind_hint: 'receipt' })
      expect(shownAfterUpdate(queued)).toBe('receipt')
      // Only while the item is open: the guard is on the write itself, not only on the read before it.
      expect(findCalls('invoice_inbox_items', 'eq')).toEqual(
        expect.arrayContaining([
          ['id', 'item-1'],
          ['company_id', 'co-1'],
        ]),
      )
      expect(findCalls('invoice_inbox_items', 'is')).toEqual([
        ['created_supplier_invoice_id', null],
        ['created_journal_entry_id', null],
        ['matched_transaction_id', null],
      ])
    })

    it("leaves the inbox reader's kind alone when the type came from the model", async () => {
      enqueue({ data: doc })
      enqueue({ data: [item({ kind_hint: null, extracted_data: readAsInvoice })] })
      expect(await classified('receipt', 'admitted', 'model')).toBe('already_queued')
      enqueue({ data: doc })
      enqueue({ data: [item({ kind_hint: null, extracted_data: readAsInvoice })] })
      expect(await classified('receipt')).toBe('already_queued')
      expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
    })

    it('writes nothing when the item already shows what the person said', async () => {
      enqueue({ data: doc })
      enqueue({ data: [item({ kind_hint: 'supplier_invoice', extracted_data: readAsInvoice })] })
      expect(await retypedByPerson('supplier_invoice')).toBe('already_queued')
      enqueue({ data: doc })
      enqueue({ data: [item({ kind_hint: 'receipt', extracted_data: readAsInvoice })] })
      expect(await retypedByPerson('receipt')).toBe('already_queued')
      expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
    })

    it("shows a supplier invoice the inbox read as a receipt as a supplier invoice, through the hint alone", async () => {
      const queued = item({ kind_hint: null, extracted_data: { documentKind: 'receipt', totals: { total: 100 } } })
      enqueue({ data: doc })
      enqueue({ data: [queued] })
      enqueue({ data: [{ id: 'item-1' }] })
      expect(await retypedByPerson('supplier_invoice')).toBe('retyped')
      expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ ...inUnderlag, kind_hint: 'supplier_invoice' })
      expect(shownAfterUpdate(queued)).toBe('supplier_invoice')
    })

    it('makes a credit note of a supplier invoice the inbox read: the hint says supplier, the reading says credit (#2980)', async () => {
      const queued = item({ kind_hint: null, extracted_data: readAsInvoice })
      enqueue({ data: doc })
      enqueue({ data: [queued] })
      enqueue({ data: [{ id: 'item-1' }] })
      expect(await retypedByPerson('credit_note')).toBe('retyped')
      expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({
        ...inUnderlag,
        kind_hint: 'supplier_invoice',
        extracted_data: { ...readAsInvoice, documentKind: 'credit_note' },
      })
      expect(shownAfterUpdate(queued)).toBe('credit_note')
    })

    it('makes a supplier invoice of one the inbox read as a credit note', async () => {
      const queued = item({ kind_hint: 'supplier_invoice', extracted_data: { ...readAsInvoice, documentKind: 'credit_note' } })
      enqueue({ data: doc })
      enqueue({ data: [queued] })
      enqueue({ data: [{ id: 'item-1' }] })
      expect(await retypedByPerson('supplier_invoice')).toBe('retyped')
      expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ ...inUnderlag, extracted_data: readAsInvoice })
      expect(shownAfterUpdate(queued)).toBe('supplier_invoice')
    })

    it('never relabels negative amounts as a payable: a payable below zero does not exist, whoever typed it', async () => {
      const credit = { documentKind: 'supplier_invoice', totals: { subtotal: -80, vatAmount: -20, total: -100 } }
      const queued = item({ kind_hint: null, extracted_data: credit })
      enqueue({ data: doc })
      enqueue({ data: [queued] })
      enqueue({ data: [{ id: 'item-1' }] })
      expect(await retypedByPerson('supplier_invoice')).toBe('retyped')
      expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ ...inUnderlag, kind_hint: 'supplier_invoice' })
      expect(shownAfterUpdate(queued)).toBe('credit_note')
    })

    it("uses the document's reading when the item has none, and invents none when neither was read", async () => {
      const documentReading = { documentKind: 'supplier_invoice', lineItems: [] }
      enqueue({ data: { ...doc, extracted_data: documentReading } })
      enqueue({ data: [item({ kind_hint: null, extracted_data: null })] })
      enqueue({ data: [{ id: 'item-1' }] })
      expect(await retypedByPerson('credit_note')).toBe('retyped')
      expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({
        ...inUnderlag,
        kind_hint: 'supplier_invoice',
        extracted_data: { ...documentReading, documentKind: 'credit_note' },
      })

      reset()
      enqueue({ data: { ...doc, extracted_data: null } })
      enqueue({ data: [item({ kind_hint: null, extracted_data: null })] })
      enqueue({ data: [{ id: 'item-1' }] })
      expect(await retypedByPerson('credit_note')).toBe('retyped')
      expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ ...inUnderlag, kind_hint: 'supplier_invoice' })
    })

    it('puts a routed item back with what the person said, in one write', async () => {
      enqueue({ data: doc })
      enqueue({ data: [item({ kind_hint: null, extracted_data: readAsInvoice, routed_to_arkiv_at: '2026-09-16T05:00:00Z' })] })
      enqueue({ data: [{ id: 'item-1' }] })
      expect(await retypedByPerson('receipt')).toBe('requeued')
      expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ ...inUnderlag, kind_hint: 'receipt' }]])
    })

    it('keeps what an item was booked as when it was booked between the read and the write', async () => {
      enqueue({ data: doc })
      enqueue({ data: [item({ kind_hint: null, extracted_data: readAsInvoice })] })
      enqueue({ data: [] })
      expect(await retypedByPerson('receipt')).toBe('booked')
    })

    it('throws when the write fails, so the handler logs it', async () => {
      enqueue({ data: doc })
      enqueue({ data: [item({ kind_hint: null, extracted_data: readAsInvoice })] })
      enqueue({ error: { message: 'boom' } })
      await expect(retypedByPerson('receipt')).rejects.toThrow('inbox item update failed: boom')
    })
  })

  it('keeps a document in Underlag when the company cannot see the Dokument section, and still queues a receipt', async () => {
    delete process.env.ARKIV_COMPANY_IDS
    enqueue({ data: doc })
    enqueue({ data: [item()] })
    expect(await classified('other')).toBe('left')
    enqueue({ data: doc })
    enqueue({ data: [item()] })
    expect(await classified('agreement.loan')).toBe('left')
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])

    process.env.ARKIV_COMPANY_IDS = 'co-2'
    enqueue({ data: doc })
    enqueue({ data: [] })
    enqueue({})
    expect(await classified('receipt')).toBe('queued')
    expect(findCalls('invoice_inbox_items', 'insert')).toHaveLength(1)
  })
})

describe('routeStaleQueueItems', () => {
  it('asks nothing when no company sees the Dokument section', async () => {
    delete process.env.ARKIV_COMPANY_IDS
    expect(await routeStaleQueueItems(supabase)).toBe(0)
    expect(mock.calls).toEqual([])
  })

  it('routes only the rows of the companies that see the section', async () => {
    process.env.ARKIV_COMPANY_IDS = 'co-1,co-2'
    enqueue({
      data: [
        { id: 'item-1', document_attachments: { doc_type: 'agreement.loan', admission_state: 'admitted' } },
        { id: 'item-2', document_attachments: [{ doc_type: 'receipt', admission_state: 'admitted' }] },
        { id: 'item-3', document_attachments: { doc_type: 'other', admission_state: 'held' } },
      ],
    })
    enqueue({})
    expect(await routeStaleQueueItems(supabase)).toBe(1)
    expect(findCall('invoice_inbox_items', 'in')).toEqual(['company_id', ['co-1', 'co-2']])
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ routed_to_arkiv_at: expect.any(String), routed_doc_type: 'agreement.loan' })
    expect(findCalls('invoice_inbox_items', 'in')[1]).toEqual(['id', ['item-1']])
  })

  it('scans every company when the section is open for everyone', async () => {
    process.env.ARKIV_COMPANY_IDS = '*'
    enqueue({ data: [] })
    expect(await routeStaleQueueItems(supabase)).toBe(0)
    expect(findCalls('invoice_inbox_items', 'in')).toEqual([])
    expect(findCalls('invoice_inbox_items', 'select')).toHaveLength(1)
  })
})

describe('requeueHiddenRoutedItems', () => {
  it('brings back every routed row when no company sees the section', async () => {
    delete process.env.ARKIV_COMPANY_IDS
    enqueue({ data: [{ id: 'item-1' }, { id: 'item-2' }] })
    enqueue({})
    expect(await requeueHiddenRoutedItems(supabase)).toBe(2)
    expect(findCalls('invoice_inbox_items', 'not')).toEqual([['routed_to_arkiv_at', 'is', null]])
    expect(findCall('invoice_inbox_items', 'limit')).toEqual([500])
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ routed_to_arkiv_at: null, routed_doc_type: null })
    expect(findCall('invoice_inbox_items', 'in')).toEqual(['id', ['item-1', 'item-2']])
  })

  it('brings back the routed rows of the companies outside the section only', async () => {
    process.env.ARKIV_COMPANY_IDS = 'co-1,co-2'
    enqueue({ data: [{ id: 'item-9' }] })
    enqueue({})
    expect(await requeueHiddenRoutedItems(supabase)).toBe(1)
    expect(findCalls('invoice_inbox_items', 'not')).toEqual([
      ['routed_to_arkiv_at', 'is', null],
      ['company_id', 'in', '("co-1","co-2")'],
    ])
    expect(findCall('invoice_inbox_items', 'in')).toEqual(['id', ['item-9']])
  })

  it('writes nothing when no routed row is hidden', async () => {
    delete process.env.ARKIV_COMPANY_IDS
    enqueue({ data: [] })
    expect(await requeueHiddenRoutedItems(supabase)).toBe(0)
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
  })

  it('touches nothing when the section is open for everyone', async () => {
    process.env.ARKIV_COMPANY_IDS = '*'
    expect(await requeueHiddenRoutedItems(supabase)).toBe(0)
    expect(mock.calls).toEqual([])
  })

  it('throws on a failed update so the sweep logs it', async () => {
    delete process.env.ARKIV_COMPANY_IDS
    enqueue({ data: [{ id: 'item-1' }] })
    enqueue({ error: { message: 'boom' } })
    await expect(requeueHiddenRoutedItems(supabase)).rejects.toThrow('boom')
  })
})

describe('inboxSawABill: where the readers disagree, the item stays in Underlag', () => {
  it('keeps what the inbox read as a receipt or supplier invoice, whatever Arkiv typed it', () => {
    expect(inboxSawABill({ documentKind: 'supplier_invoice' }, 'customer_invoice')).toBe(true)
    expect(inboxSawABill({ documentKind: 'receipt' }, 'other')).toBe(true)
    expect(inboxSawABill({ documentKind: 'credit_note' }, 'other')).toBe(true)
  })

  it('keeps an amount on a government letter (a congestion-tax bill) or on a document Arkiv could only call other (a credit note)', () => {
    expect(inboxSawABill({ documentKind: 'government_letter', totals: { total: 86 } }, 'decision.skatteverket')).toBe(true)
    expect(inboxSawABill({ documentKind: 'other', totals: { total: 16.4 } }, 'other')).toBe(true)
  })

  it('lets go of a letter with nothing to pay, an agreement with an amount in it, and anything the inbox never read', () => {
    expect(inboxSawABill({ documentKind: 'government_letter', totals: { total: null } }, 'registration.bolagsverket')).toBe(false)
    expect(inboxSawABill({ documentKind: 'other', totals: { total: 5000 } }, 'minutes.board')).toBe(false)
    expect(inboxSawABill(null, 'other')).toBe(false)
  })
})

describe('routing a bill the inbox saw', () => {
  it('leaves it in the queue when Arkiv types it as something else', async () => {
    enqueue({ data: doc })
    enqueue({ data: [item({ extracted_data: { documentKind: 'government_letter', totals: { total: 86 } } })] })
    expect(await classified('decision.skatteverket')).toBe('left')
    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('is left in the queue by the nightly catch-up too', async () => {
    enqueue({
      data: [
        { id: 'bill', document_id: 'd1', extracted_data: { documentKind: 'receipt' }, document_attachments: { doc_type: 'other', admission_state: 'admitted' } },
        { id: 'deal', document_id: 'd2', extracted_data: { documentKind: 'other' }, document_attachments: { doc_type: 'agreement.loan', admission_state: 'admitted' } },
      ],
    })
    enqueue({})
    expect(await routeStaleQueueItems(supabase)).toBe(1)
    // The first `in` scopes the select to the section companies; the second names the rows routed.
    expect(findCalls('invoice_inbox_items', 'in')[1]).toEqual(['id', ['deal']])
  })
})

