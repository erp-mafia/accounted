import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const matchSupplierMock = vi.fn()
vi.mock('@/lib/suppliers/match-supplier', () => ({
  matchSupplierId: (...args: unknown[]) => matchSupplierMock(...args),
  supplierIdentityFrom: (raw: { name?: string } | null) => ({ orgNumber: null, vatNumber: null, name: raw?.name ?? null }),
}))
const bankMatchMock = vi.fn()
vi.mock('@/lib/operations/inbox-bank-match', () => ({
  proposeBankMatchForInboxItem: (...args: unknown[]) => bankMatchMock(...args),
}))
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolveInboxKind, type InboxKindSource } from '@/lib/documents/inbox-kind'
import { inboxSawABill, putInUnderlagByAPerson, requeueHiddenRoutedItems, routeClassifiedDocument, routeStaleQueueItems } from '../route-from-arkiv'

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
  vi.clearAllMocks()
  matchSupplierMock.mockResolvedValue(null)
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

  // crm#1848: an agent archived the underlag of a posted verifikat and links it next (archive_only on the MCP
  // upload). Arkiv types it within minutes, before the link is approved.
  it('files nothing for an archive-only upload the model typed as a receipt', async () => {
    enqueue({ data: { ...doc, extracted_data: null, extraction_model: 'skipped:archive_only', created_at: new Date().toISOString() } })
    enqueue({ data: [] })
    expect(await classified('receipt', 'admitted', 'model')).toBe('left')
    expect(findCall('invoice_inbox_items', 'insert')).toBeUndefined()
  })

  it('queues an archive-only upload when a person types it in Dokument', async () => {
    enqueue({ data: { ...doc, extracted_data: null, extraction_model: 'skipped:archive_only', created_at: new Date().toISOString() } })
    enqueue({ data: [] })
    enqueue({})
    expect(await retypedByPerson('receipt')).toBe('queued')
    expect(findCall('invoice_inbox_items', 'insert')).toBeDefined()
  })

  it('queues a loose upload whose reading was skipped for any other reason', async () => {
    enqueue({ data: { ...doc, extracted_data: null, extraction_model: 'skipped:opted_out', created_at: new Date().toISOString() } })
    enqueue({ data: [] })
    enqueue({})
    expect(await classified('receipt', 'admitted', 'model')).toBe('queued')
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
      channel_context: { intake_source: 'upload' },
      document_id: 'doc-1',
      kind_hint: 'receipt',
      extracted_data: { lineItems: [] },
      extraction_skipped: false,
    })
  })

  it.each([
    ['file_upload', 'upload', 'upload'],
    ['camera', 'upload', 'upload'],
    ['scan', 'upload', 'upload'],
    ['api', 'upload', 'partner_api'],
    ['email', 'email', 'intake_email'],
    ['mail_hunt', 'mail_hunt', 'mailbox'],
    ['whatsapp', 'whatsapp', 'whatsapp'],
    ['e_invoice', 'peppol', 'peppol'],
    ['system', 'upload', 'system'],
    [null, 'upload', 'upload'],
  ])('keeps the door a %s document came through: source %s, intake_source %s', async (uploadSource, source, intakeSource) => {
    enqueue({ data: { ...doc, upload_source: uploadSource, file_name: 'kvitto.pdf' } })
    enqueue({ data: [] })
    enqueue({})
    expect(await classified('receipt')).toBe('queued')
    expect(findCall('invoice_inbox_items', 'insert')?.[0]).toMatchObject({ source, channel_context: { intake_source: intakeSource } })
  })

  describe('a byte-identical copy of a document already booked or queued', () => {
    const hashed = { ...doc, sha256_hash: 'hash-1' }

    it('does not queue a copy of a document booked on a verifikat (double-booking risk)', async () => {
      enqueue({ data: hashed })
      enqueue({ data: [] })
      enqueue({ data: [{ id: 'doc-booked', journal_entry_id: 'je-1' }] })
      expect(await classified('receipt')).toBe('duplicate_of_queued_or_booked')
      expect(findCall('invoice_inbox_items', 'insert')).toBeUndefined()
    })

    it('does not queue a copy of a document that already has an inbox item', async () => {
      enqueue({ data: hashed })
      enqueue({ data: [] })
      enqueue({ data: [{ id: 'doc-queued', journal_entry_id: null }] })
      enqueue({ data: [{ id: 'item-9' }] })
      expect(await classified('receipt')).toBe('duplicate_of_queued_or_booked')
      expect(findCall('invoice_inbox_items', 'insert')).toBeUndefined()
    })

    it('queues it when the copy is neither booked nor queued', async () => {
      enqueue({ data: hashed })
      enqueue({ data: [] })
      enqueue({ data: [{ id: 'doc-loose', journal_entry_id: null }] })
      enqueue({ data: [] })
      enqueue({})
      expect(await classified('receipt')).toBe('queued')
      expect(findCall('invoice_inbox_items', 'insert')?.[0]).toMatchObject({ document_id: 'doc-1' })
    })

    it('queues it when no other document of the company has the same content', async () => {
      enqueue({ data: hashed })
      enqueue({ data: [] })
      enqueue({ data: [] })
      enqueue({})
      expect(await classified('receipt')).toBe('queued')
    })

    it('throws when the lookup fails, so the handler logs it instead of queueing blind', async () => {
      enqueue({ data: hashed })
      enqueue({ data: [] })
      enqueue({ data: null, error: { message: 'boom' } })
      await expect(classified('receipt')).rejects.toThrow('duplicate lookup failed: boom')
      expect(findCall('invoice_inbox_items', 'insert')).toBeUndefined()
    })
  })

  it('reads the upload door from the document row it fetched', async () => {
    enqueue({ data: doc })
    enqueue({ data: [] })
    enqueue({})
    await classified('receipt')
    expect(findCall('document_attachments', 'select')?.[0]).toContain('upload_source')
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

  // PH 101: the reading usually lands after the item is filed (the reader fills it then); one that landed between the
  // fetch and the insert found no item, so the queue looks once more after filing.
  it('fills an item it queued unread when the reading landed meanwhile, with the supplier match and a bank check', async () => {
    matchSupplierMock.mockResolvedValue('sup-1')
    enqueue({ data: { ...doc, extracted_data: null } })
    enqueue({ data: [] })
    enqueue({}) // the insert
    enqueue({ data: { extracted_data: { supplier: { name: 'Elgiganten' } } } }) // the look after filing
    enqueue({ data: [{ id: 'item-new' }] }) // the item it just filed, still unread
    enqueue({ data: { doc_type: 'receipt' } })
    enqueue({ data: [{ id: 'item-new', matched_supplier_id: null }] }) // the fill
    enqueue({}) // the supplier write
    expect(await classified('receipt')).toBe('queued')
    const updates = findCalls('invoice_inbox_items', 'update')
    expect(updates[0][0]).toEqual({ extracted_data: { supplier: { name: 'Elgiganten' } }, extraction_skipped: false })
    expect(updates[1][0]).toEqual({ matched_supplier_id: 'sup-1' })
    expect(bankMatchMock).toHaveBeenCalledWith(supabase, 'co-1', 'item-new')
  })

  it('leaves an item it queued unread for the reader when the document is still being read', async () => {
    enqueue({ data: { ...doc, extracted_data: null } })
    enqueue({ data: [] })
    enqueue({})
    enqueue({ data: { extracted_data: null } })
    expect(await classified('receipt')).toBe('queued')
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
    expect(bankMatchMock).not.toHaveBeenCalled()
  })

  it('queues even when the look after filing fails', async () => {
    enqueue({ data: { ...doc, extracted_data: null } })
    enqueue({ data: [] })
    enqueue({})
    enqueue({ data: { extracted_data: { supplier: { name: 'Elgiganten' } } } })
    enqueue({ error: { message: 'boom' } })
    expect(await classified('receipt')).toBe('queued')
  })

  it('does not look again for an item queued with its reading', async () => {
    enqueue({ data: doc })
    enqueue({ data: [] })
    enqueue({})
    await classified('receipt')
    expect(findCalls('document_attachments', 'select')).toHaveLength(1)
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
  it("keeps the company's own invoice in Underlag, whatever Arkiv typed it (crm#1830)", () => {
    const own = { documentKind: 'other', sellerIsOwnCompany: true, supplier: { name: null }, totals: { total: null } }
    expect(inboxSawABill(own, 'customer_invoice')).toBe(true)
    expect(inboxSawABill({ ...own, sellerIsOwnCompany: undefined }, 'customer_invoice')).toBe(false)
  })

  it('keeps what the inbox read as a receipt or supplier invoice, whatever Arkiv typed it', () => {
    expect(inboxSawABill({ documentKind: 'supplier_invoice' }, 'customer_invoice')).toBe(true)
    expect(inboxSawABill({ documentKind: 'receipt' }, 'other')).toBe(true)
    expect(inboxSawABill({ documentKind: 'credit_note' }, 'other')).toBe(true)
  })

  it('keeps an amount on a government letter (a congestion-tax bill) or on a document Arkiv could only call other (a credit note)', () => {
    expect(inboxSawABill({ documentKind: 'government_letter', totals: { total: 86 } }, 'decision.skatteverket')).toBe(true)
    expect(inboxSawABill({ documentKind: 'other', totals: { total: 16.4 } }, 'other')).toBe(true)
  })

  it('keeps an amount paid out: a negative total is an amount too (crm#1887)', () => {
    // A bank's advice of a payout, a refund decision, a credit the reader could not name.
    expect(inboxSawABill({ documentKind: 'other', totals: { total: -1500 } }, 'other')).toBe(true)
    expect(inboxSawABill({ documentKind: 'other', totals: { total: '-1500' } }, 'other')).toBe(true)
    expect(inboxSawABill({ documentKind: 'government_letter', totals: { total: -86 } }, 'decision.skatteverket')).toBe(true)
    // Still only where the readers leave it open: a typed document goes to its page.
    expect(inboxSawABill({ documentKind: 'other', totals: { total: -1500 } }, 'minutes.board')).toBe(false)
    expect(inboxSawABill({ documentKind: 'other', totals: { total: 0 } }, 'other')).toBe(false)
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

  // crm#1887: a bank's advice of a dividend paid out, typed "other" by Arkiv, left Underlag as if nothing
  // were to be booked, because its amount is negative.
  it('leaves a payout advice Arkiv could only call other in the queue', async () => {
    enqueue({ data: doc })
    enqueue({ data: [item({ extracted_data: { documentKind: 'other', totals: { total: -1500 } } })] })
    expect(await classified('other')).toBe('left')
    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('still routes an other document with no amount on it', async () => {
    enqueue({ data: doc })
    enqueue({ data: [item({ extracted_data: { documentKind: 'other', totals: { total: null } } })] })
    enqueue({})
    expect(await classified('other')).toBe('routed_to_arkiv')
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ routed_to_arkiv_at: expect.any(String), routed_doc_type: 'other' })
  })

  it('is left in the queue by the nightly catch-up too', async () => {
    enqueue({
      data: [
        { id: 'bill', document_id: 'd1', extracted_data: { documentKind: 'receipt' }, document_attachments: { doc_type: 'other', admission_state: 'admitted' } },
        { id: 'deal', document_id: 'd2', extracted_data: { documentKind: 'other' }, document_attachments: { doc_type: 'agreement.loan', admission_state: 'admitted' } },
        { id: 'payout', document_id: 'd3', extracted_data: { documentKind: 'other', totals: { total: -1500 } }, document_attachments: { doc_type: 'other', admission_state: 'admitted' } },
      ],
    })
    enqueue({})
    expect(await routeStaleQueueItems(supabase)).toBe(1)
    // The first `in` scopes the select to the section companies; the second names the rows routed.
    expect(findCalls('invoice_inbox_items', 'in')[1]).toEqual(['id', ['deal']])
  })
})


// crm#1954: a payroll list a person uploaded in Underlag to match against the salary payout. The model typed it
// "other" and the inbox reader found no total, so the routing took it out of Underlag into Arkiv.
describe('a document a person uploaded into Underlag', () => {
  const uploaded = { ...doc, upload_source: 'file_upload', created_at: new Date().toISOString() }
  const payrollList = { documentKind: 'other', totals: { total: null }, prominentAmounts: [38300, 26885, 11415] }
  const personsItem = (over: Record<string, unknown> = {}) => item({ source: 'upload', channel_context: null, extracted_data: payrollList, ...over })

  it('is told apart from every other door that files source upload, by the missing door stamp', () => {
    expect(putInUnderlagByAPerson({ source: 'upload', channel_context: null }, 'file_upload')).toBe(true)
    expect(putInUnderlagByAPerson({ source: 'upload' }, 'camera')).toBe(true)
    expect(putInUnderlagByAPerson({ source: 'upload', channel_context: {} }, 'scan')).toBe(true)
    // The person's door filing an item for bytes the company already had from another door is still their upload.
    expect(putInUnderlagByAPerson({ source: 'upload', channel_context: null }, 'email')).toBe(true)
    // Arkiv's queueing, MCP (stamped, and from before the stamp), a partner delivery, a digital mailbox.
    expect(putInUnderlagByAPerson({ source: 'upload', channel_context: { intake_source: 'upload' } }, 'file_upload')).toBe(false)
    expect(putInUnderlagByAPerson({ source: 'upload', channel_context: { intake_source: 'mcp' } }, 'api')).toBe(false)
    expect(putInUnderlagByAPerson({ source: 'upload', channel_context: null }, 'api')).toBe(false)
    expect(putInUnderlagByAPerson({ source: 'upload', channel_context: { channel: 'partner_api', intake_source: 'partner_api' } }, 'file_upload')).toBe(false)
    expect(putInUnderlagByAPerson({ source: 'upload', channel_context: { intake_source: 'kivra' } }, 'file_upload')).toBe(false)
    // E-mail, WhatsApp, the receipt hunt, Peppol.
    for (const source of ['email', 'whatsapp', 'mail_hunt', 'peppol']) {
      expect(putInUnderlagByAPerson({ source, channel_context: null }, 'file_upload')).toBe(false)
    }
  })

  it.each([['other'], ['agreement.loan'], ['minutes.board']])('stays in Underlag when the model types it %s (reported case)', async (docType) => {
    enqueue({ data: uploaded })
    enqueue({ data: [personsItem()] })
    expect(await classified(docType, 'admitted', 'model')).toBe('left')
    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
    expect(findCall('invoice_inbox_items', 'select')?.[0]).toContain('channel_context')
  })

  it('stays when the type is replayed without saying who decided it (a re-upload of a typed document)', async () => {
    enqueue({ data: uploaded })
    enqueue({ data: [personsItem()] })
    expect(await classified('other')).toBe('left')
    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('still leaves Underlag when a person retypes it in Dokument', async () => {
    enqueue({ data: uploaded })
    enqueue({ data: [personsItem()] })
    enqueue({})
    expect(await retypedByPerson('agreement.loan')).toBe('routed_to_arkiv')
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ routed_to_arkiv_at: expect.any(String), routed_doc_type: 'agreement.loan' })
    expect(findCall('invoice_inbox_items', 'in')).toEqual(['id', ['item-1']])
  })

  it.each([
    ['an e-mailed agreement', 'agreement.loan', 'email', { source: 'email', channel_context: null }],
    ['an e-mailed document Arkiv could only call other', 'other', 'email', { source: 'email', channel_context: null }],
    ['a WhatsApp photo of minutes', 'minutes.board', 'whatsapp', { source: 'whatsapp', channel_context: { channel: 'whatsapp' } }],
    ['an MCP upload', 'other', 'api', { source: 'upload', channel_context: { intake_source: 'mcp' } }],
    ['an MCP upload from before the stamp', 'other', 'api', { source: 'upload', channel_context: null }],
    ['a partner delivery', 'agreement.lease', 'file_upload', { source: 'upload', channel_context: { channel: 'partner_api', intake_source: 'partner_api' } }],
    ['a Peppol delivery', 'other', 'e_invoice', { source: 'peppol', channel_context: { channel: 'peppol' } }],
  ])('still routes %s with no bill in it out of Underlag', async (_door, docType, uploadSource, columns) => {
    enqueue({ data: { ...doc, upload_source: uploadSource } })
    enqueue({ data: [item({ ...columns, extracted_data: payrollList })] })
    enqueue({})
    expect(await classified(docType, 'admitted', 'model')).toBe('routed_to_arkiv')
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ routed_to_arkiv_at: expect.any(String), routed_doc_type: docType })
  })

  it('is skipped by the catch-up, which still routes what came through another door', async () => {
    enqueue({
      data: [
        { id: 'mine', document_id: 'd1', source: 'upload', channel_context: null, extracted_data: payrollList, document_attachments: { doc_type: 'other', admission_state: 'admitted', upload_source: 'file_upload' } },
        { id: 'mail', document_id: 'd2', source: 'email', channel_context: null, extracted_data: payrollList, document_attachments: { doc_type: 'agreement.loan', admission_state: 'admitted', upload_source: 'email' } },
        { id: 'mcp', document_id: 'd3', source: 'upload', channel_context: { intake_source: 'mcp' }, extracted_data: payrollList, document_attachments: [{ doc_type: 'other', admission_state: 'admitted', upload_source: 'api' }] },
      ],
    })
    enqueue({})
    enqueue({})
    expect(await routeStaleQueueItems(supabase)).toBe(2)
    const columns = String(findCall('invoice_inbox_items', 'select')?.[0])
    expect(columns).toContain('channel_context')
    expect(columns).toContain('upload_source')
    const routedIds = findCalls('invoice_inbox_items', 'in').slice(1).flatMap((args) => args[1] as string[])
    expect(routedIds.sort()).toEqual(['mail', 'mcp'])
  })
})
