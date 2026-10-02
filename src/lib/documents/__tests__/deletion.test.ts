import { describe, it, expect, vi } from 'vitest'
import {
  canDeleteDocument,
  documentDeleteRefusal,
  offersDocumentDelete,
  readDocumentDeletePins,
  type DocumentDeletePins,
} from '../deletion'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const free: DocumentDeletePins = { supplierInvoice: false, expenseClaim: false, bankTransaction: false, inboxItems: [] }
const unlinked = { journal_entry_id: null, journal_entry_line_id: null }
const booked = { created_journal_entry_id: 'je-1', created_supplier_invoice_id: null }
const converted = { created_journal_entry_id: null, created_supplier_invoice_id: 'si-1' }
const neverBooked = { created_journal_entry_id: null, created_supplier_invoice_id: null }

describe('canDeleteDocument', () => {
  it('allows a document tied to no verifikat', () => {
    expect(canDeleteDocument({ journal_entry_id: null, journal_entry_line_id: null })).toBe(true)
    expect(canDeleteDocument({})).toBe(true)
  })

  it('refuses a document linked to a verifikat (BFL 7 kap 2 §)', () => {
    expect(canDeleteDocument({ journal_entry_id: 'je-1', journal_entry_line_id: null })).toBe(false)
  })

  it('refuses a document linked to a verifikat line, even without the entry link', () => {
    expect(canDeleteDocument({ journal_entry_id: null, journal_entry_line_id: 'line-1' })).toBe(false)
  })
})

describe('documentDeleteRefusal', () => {
  it('lets a document nothing holds go', () => {
    expect(documentDeleteRefusal(unlinked, free)).toBeNull()
  })

  it('lets the files of an inbox item that was never booked or converted go', () => {
    expect(documentDeleteRefusal(unlinked, { ...free, inboxItems: [neverBooked] })).toBeNull()
  })

  it.each([
    { pin: 'a verifikat link', doc: { journal_entry_id: 'je-1' }, pins: free, block: 'verifikat', code: 'DOC_DELETE_LINKED' },
    { pin: 'a verifikat line link', doc: { journal_entry_line_id: 'line-1' }, pins: free, block: 'verifikat', code: 'DOC_DELETE_LINKED' },
    { pin: 'supplier invoice underlag', doc: unlinked, pins: { ...free, supplierInvoice: true }, block: 'supplier_invoice', code: 'DOC_DELETE_SUPPLIER_INVOICE_UNDERLAG' },
    { pin: 'utlägg underlag', doc: unlinked, pins: { ...free, expenseClaim: true }, block: 'expense_claim', code: 'DOC_DELETE_EXPENSE_CLAIM_UNDERLAG' },
    { pin: 'a booked inbox item', doc: unlinked, pins: { ...free, inboxItems: [neverBooked, booked] }, block: 'booked_inbox_item', code: 'DOC_DELETE_BOOKED_INBOX_ITEM' },
    { pin: 'a converted inbox item', doc: unlinked, pins: { ...free, inboxItems: [converted] }, block: 'booked_inbox_item', code: 'DOC_DELETE_BOOKED_INBOX_ITEM' },
    { pin: 'a bank transaction', doc: unlinked, pins: { ...free, bankTransaction: true }, block: 'bank_transaction', code: 'DOCUMENT_DELETE_BLOCKED_BY_TRANSACTION' },
  ])('refuses $pin with its own code and the Swedish text of that code', ({ doc, pins, block, code }) => {
    const refusal = documentDeleteRefusal(doc, pins)
    expect(refusal).toMatchObject({ block, code })
    // The sentence deleteDocument() returns is the structured error's message_sv, word for word.
    expect(refusal?.message).toBe(getErrorEntry(code)?.message_sv)
    expect(getErrorEntry(code)?.httpStatus).toBe(409)
  })

  it('answers a verifikat link first, whatever else holds the document', () => {
    const all: DocumentDeletePins = { supplierInvoice: true, expenseClaim: true, bankTransaction: true, inboxItems: [booked] }
    expect(documentDeleteRefusal({ journal_entry_id: 'je-1' }, all)?.block).toBe('verifikat')
  })
})

describe('offersDocumentDelete agrees with the server rule', () => {
  // Every combination of links and pins: the Arkiv offer is exactly "the server would take it".
  const docs = [unlinked, { journal_entry_id: 'je-1' }, { journal_entry_line_id: 'line-1' }]
  const inboxSets = [[], [neverBooked], [booked], [converted], [neverBooked, converted]]
  const combos: Array<[typeof docs[number], DocumentDeletePins]> = []
  for (const doc of docs)
    for (const supplierInvoice of [false, true])
      for (const expenseClaim of [false, true])
        for (const bankTransaction of [false, true])
          for (const inboxItems of inboxSets) combos.push([doc, { supplierInvoice, expenseClaim, bankTransaction, inboxItems }])

  it(`matches documentDeleteRefusal over all ${3 * 2 * 2 * 2 * 5} combinations`, () => {
    for (const [doc, pins] of combos) expect(offersDocumentDelete(doc, pins)).toBe(documentDeleteRefusal(doc, pins) === null)
    // And the offer is not trivially always false.
    expect(combos.filter(([doc, pins]) => offersDocumentDelete(doc, pins))).toHaveLength(2)
  })
})

describe('readDocumentDeletePins', () => {
  function client(results: Array<{ data: unknown; error: unknown }>) {
    const builders: Array<Record<string, ReturnType<typeof vi.fn>> & { then?: unknown }> = []
    let i = 0
    const from = vi.fn(() => {
      const result = results[i++] ?? { data: [], error: null }
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'limit']) b[m] = vi.fn(() => b)
      b.then = (resolve: (v: unknown) => void) => resolve(result)
      builders.push(b as never)
      return b
    })
    return { supabase: { from } as never, from, builders }
  }

  it('reads every pin scoped to the company, including the received Peppol XML', async () => {
    const { supabase, from, builders } = client([
      { data: [{ id: 'si-1' }], error: null },
      { data: [], error: null },
      { data: [{ id: 'tx-1' }], error: null },
      { data: [neverBooked], error: null },
      { data: [booked], error: null },
    ])
    const pins = await readDocumentDeletePins(supabase, 'company-1', 'doc-1')
    expect(pins).toEqual({ supplierInvoice: true, expenseClaim: false, bankTransaction: true, inboxItems: [neverBooked, booked] })
    expect(from.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'supplier_invoices',
      'expense_claims',
      'transactions',
      'invoice_inbox_items',
      'invoice_inbox_items',
    ])
    for (const b of builders) expect(b.eq.mock.calls).toContainEqual(['company_id', 'company-1'])
    expect(builders[4].eq.mock.calls).toContainEqual(['channel_context->>peppol_xml_document_id', 'doc-1'])
  })

  it('treats a missing data array as no pin', async () => {
    const { supabase } = client([{ data: null, error: null }])
    expect(await readDocumentDeletePins(supabase, 'company-1', 'doc-1')).toEqual(free)
  })

  it('throws with the SQLSTATE when a pin cannot be read', async () => {
    const { supabase } = client([{ data: [], error: null }, { data: null, error: { message: 'permission denied', code: '42501' } }])
    await expect(readDocumentDeletePins(supabase, 'company-1', 'doc-1')).rejects.toMatchObject({ code: '42501' })
  })
})
