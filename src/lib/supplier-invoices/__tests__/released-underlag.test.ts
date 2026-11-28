/**
 * The underlag of a credited supplier invoice is released for a new
 * registration: the item's pointer at the credited invoice, the verifikat
 * its document stays on and the credited invoice's use of the document hold
 * nothing any more, and the new registration gets a byte-identical copy.
 * Released only while the credit stands and nothing else books the
 * underlag: a live invoice, a live verifikat (with the document or a copy)
 * and a credit note still hold it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRowsMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/documents/link-document', () => ({
  linkDocumentCopyToVoucher: vi.fn(async () => ({ ok: true, document: { id: 'copy-on-entry' }, source_document_id: 'doc-1', reused: false })),
  archiveDocumentCopy: vi.fn(async () => ({ id: 'copy-floating' })),
}))
vi.mock('@/lib/links/stamp', () => ({
  linkBasisColumns: vi.fn((basis: string) => ({ link_basis: basis, link_evidence: {} })),
}))

import { archiveDocumentCopy, linkDocumentCopyToVoucher } from '@/lib/documents/link-document'
import {
  copyReleasedUnderlag,
  documentForRegistration,
  registeredAgainAs,
  releasedForRegistration,
  releasesItsUnderlag,
  releasesItsUnderlagNow,
} from '../released-underlag'

const COMPANY = 'company-1'

type Row = Record<string, unknown>
type Rows = Record<string, Row[]>

/**
 * The rows as PostgREST embeds them: an invoice carries its document
 * (supplier_invoices_document_id_fkey), a document the verifikat it sits on
 * (document_attachments_journal_entry_id_fkey).
 */
function withEmbeds(tables: Rows): Rows {
  const entries = tables.journal_entries ?? []
  const documents = (tables.document_attachments ?? []).map((d) => ({
    ...d,
    entry: entries.find((e) => e.id === d.journal_entry_id) ?? null,
  }))
  const invoices = (tables.supplier_invoices ?? []).map((invoice) => ({
    ...invoice,
    document: documents.find((d) => d.id === invoice.document_id) ?? null,
  }))
  return { ...tables, document_attachments: documents, supplier_invoices: invoices }
}

function db(tables: Rows) {
  const writes: { table: string; method: string; row: unknown }[] = []
  const mock = createRowsMockSupabase(withEmbeds(tables), writes)
  return { supabase: mock.supabase as unknown as SupabaseClient, writes, mock }
}

const doc = (id: string, entry: string | null, hash = 'pdf') => ({ id, company_id: COMPANY, journal_entry_id: entry, sha256_hash: hash })
const entry = (id: string, status = 'posted') => ({ id, company_id: COMPANY, status })
const invoice = (overrides: Row = {}): Row => ({
  id: 'si-1',
  company_id: COMPANY,
  status: 'credited',
  is_credit_note: false,
  credited_invoice_id: null,
  registration_journal_entry_id: 'je-1',
  payment_journal_entry_id: null,
  document_id: 'doc-1',
  ...overrides,
})
const creditNote = (overrides: Row = {}): Row =>
  invoice({ id: 'cn-1', is_credit_note: true, credited_invoice_id: 'si-1', registration_journal_entry_id: 'je-cn', document_id: null, ...overrides })

/**
 * The reported case: si-1 registered from doc-1 on je-1, then credited by
 * cn-1, whose verifikat je-cn stands.
 */
function credited(overrides: Partial<Rows> = {}): Rows {
  return {
    supplier_invoices: [invoice(), creditNote()],
    document_attachments: [doc('doc-1', 'je-1')],
    journal_entries: [entry('je-1'), entry('je-cn')],
    ...overrides,
  }
}

/** An inbox item read with INBOX_ITEM_DOCUMENT_HOLD: its document sits on `entryId` in `status`. */
function itemRow(entryId: string | null, status: string | null = 'posted', pointer: string | null = 'si-1') {
  return {
    id: 'item-1',
    document_id: 'doc-1',
    created_supplier_invoice_id: pointer,
    created_journal_entry_id: null,
    document_hold: entryId ? { journal_entry_id: entryId, entry: { status } } : null,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('releasesItsUnderlag', () => {
  it('a credited or reversed original may release it', () => {
    expect(releasesItsUnderlag({ status: 'credited', is_credit_note: false })).toBe(true)
    expect(releasesItsUnderlag({ status: 'reversed', is_credit_note: false })).toBe(true)
  })

  it('a live invoice holds it, and so does a credit note, which rests at credited too', () => {
    for (const status of ['registered', 'approved', 'overdue', 'paid', 'partially_paid']) {
      expect(releasesItsUnderlag({ status, is_credit_note: false })).toBe(false)
    }
    expect(releasesItsUnderlag({ status: 'credited', is_credit_note: true })).toBe(false)
  })
})

describe('releasedForRegistration', () => {
  it('an item whose invoice was credited is free, and its document goes on as a copy', async () => {
    const { supabase } = db(credited())
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1'))
    expect(item.created_supplier_invoice_id).toBeNull()
    expect(item.document_journal_entry_id).toBeNull()
    expect(release).toEqual({ supplier_invoice_id: 'si-1', copy_from_document_id: 'doc-1' })
    expect(item).not.toHaveProperty('document_hold')
  })

  it('an item whose invoice still stands stays converted', async () => {
    const { supabase } = db(credited({ supplier_invoices: [invoice({ status: 'approved' })] }))
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1'))
    expect(item.created_supplier_invoice_id).toBe('si-1')
    expect(item.document_journal_entry_id).toBe('je-1')
    expect(release).toEqual({ supplier_invoice_id: null, copy_from_document_id: null })
  })

  it('a credit whose verifikat was reversed by hand releases nothing: the registration books the purchase again', async () => {
    const { supabase } = db(credited({ journal_entries: [entry('je-1'), entry('je-cn', 'reversed')] }))
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1'))
    expect(item.created_supplier_invoice_id).toBe('si-1')
    expect(item.document_journal_entry_id).toBe('je-1')
    expect(release).toEqual({ supplier_invoice_id: null, copy_from_document_id: null })
  })

  it('an underlag registered again on a copy is held by that invoice: the item answers as converted to it', async () => {
    const { supabase } = db(
      credited({
        supplier_invoices: [invoice(), creditNote(), invoice({ id: 'si-2', status: 'registered', registration_journal_entry_id: 'je-2', document_id: 'doc-copy' })],
        document_attachments: [doc('doc-1', 'je-1'), doc('doc-copy', 'je-2')],
        journal_entries: [entry('je-1'), entry('je-cn'), entry('je-2')],
      }),
    )
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1'))
    expect(item.created_supplier_invoice_id).toBe('si-2')
    expect(release).toEqual({ supplier_invoice_id: null, copy_from_document_id: null })
  })

  it('a purchase booked again on another verifikat with a copy holds it: the item answers as booked there', async () => {
    const { supabase } = db(
      credited({
        document_attachments: [doc('doc-1', 'je-1'), doc('doc-copy', 'je-bank')],
        journal_entries: [entry('je-1'), entry('je-cn'), entry('je-bank')],
      }),
    )
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1'))
    expect(item.document_journal_entry_id).toBe('je-bank')
    expect(item.created_supplier_invoice_id).toBe('si-1')
    expect(release).toEqual({ supplier_invoice_id: null, copy_from_document_id: null })
  })

  it('a copy of the original on the kreditfaktura\'s own verifikat holds nothing', async () => {
    const { supabase } = db(credited({ document_attachments: [doc('doc-1', 'je-1'), doc('doc-on-credit', 'je-cn')] }))
    const { release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1'))
    expect(release).toEqual({ supplier_invoice_id: 'si-1', copy_from_document_id: 'doc-1' })
  })

  it('a document on a reversed verifikat no released invoice owns keeps the plain reading, and no copy', async () => {
    const { supabase } = db({ supplier_invoices: [], document_attachments: [doc('doc-1', 'je-9')], journal_entries: [entry('je-9', 'reversed')] })
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-9', 'reversed', null))
    expect(item.document_journal_entry_id).toBeNull()
    expect(release).toEqual({ supplier_invoice_id: null, copy_from_document_id: null })
  })

  it('a kontantmetod credit left the document on no verifikat: the document itself is the underlag again', async () => {
    const { supabase } = db({
      supplier_invoices: [invoice({ registration_journal_entry_id: null }), creditNote({ registration_journal_entry_id: null })],
      document_attachments: [doc('doc-1', null)],
      journal_entries: [],
    })
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow(null))
    expect(item.created_supplier_invoice_id).toBeNull()
    expect(release).toEqual({ supplier_invoice_id: 'si-1', copy_from_document_id: null })
  })

  it('an invoice of another company releases nothing', async () => {
    const { supabase } = db(credited({ supplier_invoices: [invoice({ company_id: 'company-2' }), creditNote({ company_id: 'company-2' })] }))
    const { item } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1'))
    expect(item.created_supplier_invoice_id).toBe('si-1')
    expect(item.document_journal_entry_id).toBe('je-1')
  })

  it('fails closed when the invoice cannot be read', async () => {
    const { mock } = db({})
    mock.setTable('supplier_invoices', { data: null, error: { message: 'boom', code: '57014' } })
    await expect(releasedForRegistration(mock.supabase as unknown as SupabaseClient, COMPANY, itemRow('je-1'))).rejects.toThrow()
  })
})

describe('documentForRegistration', () => {
  it('a document nothing holds is taken as it is', async () => {
    const { supabase } = db({ document_attachments: [doc('doc-1', null)], supplier_invoices: [], journal_entries: [] })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: true, copy: false })
  })

  it('the underlag of a credited invoice is released, as a copy while its verifikat keeps it', async () => {
    const { supabase } = db(credited())
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: true, copy: true })
  })

  it('a credited invoice that never reached the books leaves the document itself', async () => {
    const { supabase } = db({
      supplier_invoices: [invoice({ registration_journal_entry_id: null }), creditNote({ registration_journal_entry_id: null })],
      document_attachments: [doc('doc-1', null)],
      journal_entries: [],
    })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: true, copy: false })
  })

  it('a live invoice on the document refuses it as used', async () => {
    const { supabase } = db({
      supplier_invoices: [invoice({ status: 'registered', registration_journal_entry_id: null })],
      document_attachments: [doc('doc-1', null)],
      journal_entries: [],
    })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: false, reason: 'document_already_used', supplier_invoice_id: 'si-1' })
  })

  it('a credit note on the document holds it', async () => {
    const { supabase } = db({
      supplier_invoices: [creditNote({ document_id: 'doc-1', registration_journal_entry_id: null })],
      document_attachments: [doc('doc-1', null)],
      journal_entries: [],
    })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toMatchObject({ ok: false, reason: 'document_already_used' })
  })

  it.each([
    ['a live verifikat', 'posted'],
    ['a reversed verifikat, as before', 'reversed'],
  ])('a document on %s no released invoice owns is unavailable', async (_label, status) => {
    const { supabase } = db({ document_attachments: [doc('doc-1', 'je-bank')], supplier_invoices: [], journal_entries: [entry('je-bank', status)] })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: false, reason: 'document_unavailable' })
  })

  it('a credit whose verifikat was reversed by hand keeps the document unavailable', async () => {
    const { supabase } = db(credited({ journal_entries: [entry('je-1'), entry('je-cn', 'reversed')] }))
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: false, reason: 'document_unavailable' })
  })

  it('the underlag registered again on a copy is used', async () => {
    const { supabase } = db(
      credited({
        supplier_invoices: [invoice(), creditNote(), invoice({ id: 'si-2', status: 'registered', registration_journal_entry_id: 'je-2', document_id: 'doc-copy' })],
        document_attachments: [doc('doc-1', 'je-1'), doc('doc-copy', 'je-2')],
        journal_entries: [entry('je-1'), entry('je-cn'), entry('je-2')],
      }),
    )
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: false, reason: 'document_already_used', supplier_invoice_id: 'si-2' })
  })

  it('the underlag booked again on another verifikat with a copy is unavailable', async () => {
    const { supabase } = db(
      credited({
        document_attachments: [doc('doc-1', 'je-1'), doc('doc-copy', 'je-bank')],
        journal_entries: [entry('je-1'), entry('je-cn'), entry('je-bank')],
      }),
    )
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: false, reason: 'document_unavailable' })
  })

  it('another company\'s document is unavailable', async () => {
    const { supabase } = db({ document_attachments: [{ ...doc('doc-1', null), company_id: 'company-2' }], supplier_invoices: [], journal_entries: [] })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: false, reason: 'document_unavailable' })
  })
})

describe('registeredAgainAs', () => {
  it('names the live invoice that holds a copy of the credited invoice\'s underlag', async () => {
    const { supabase } = db(
      credited({
        supplier_invoices: [invoice(), creditNote(), invoice({ id: 'si-2', status: 'registered', registration_journal_entry_id: null, document_id: 'doc-copy' })],
        document_attachments: [doc('doc-1', 'je-1'), doc('doc-copy', null)],
      }),
    )
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: 'doc-1' })).toEqual({ supplier_invoice_id: 'si-2' })
  })

  it('names the verifikat that books a copy of it', async () => {
    const { supabase } = db(
      credited({
        document_attachments: [doc('doc-1', 'je-1'), doc('doc-copy', 'je-bank')],
        journal_entries: [entry('je-1'), entry('je-cn'), entry('je-bank')],
      }),
    )
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: 'doc-1' })).toEqual({ journal_entry_id: 'je-bank' })
  })

  it('names nothing when every other use was credited too, or is another document', async () => {
    const { supabase } = db(
      credited({
        supplier_invoices: [
          invoice(),
          creditNote(),
          invoice({ id: 'si-2', registration_journal_entry_id: null, document_id: 'doc-copy' }),
          creditNote({ id: 'cn-2', credited_invoice_id: 'si-2', registration_journal_entry_id: null }),
          invoice({ id: 'si-3', status: 'registered', registration_journal_entry_id: null, document_id: 'doc-other' }),
        ],
        document_attachments: [doc('doc-1', 'je-1'), doc('doc-copy', null), doc('doc-other', null, 'other')],
      }),
    )
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: 'doc-1' })).toBeNull()
  })

  it('never counts the asking invoice\'s own verifikat, also once it stands again', async () => {
    const { supabase } = db(credited({ supplier_invoices: [invoice({ status: 'registered' })] }))
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: 'doc-1' })).toBeNull()
  })

  it('finds the live invoice however many byte-identical documents the company holds', async () => {
    const many = Array.from({ length: 120 }, (_, i) => doc(`doc-${i}`, null))
    const { supabase } = db(
      credited({
        supplier_invoices: [invoice(), creditNote(), invoice({ id: 'si-late', status: 'registered', registration_journal_entry_id: null, document_id: 'doc-119' })],
        document_attachments: [doc('doc-1', 'je-1'), ...many],
      }),
    )
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: 'doc-1' })).toEqual({ supplier_invoice_id: 'si-late' })
  })

  it('an invoice without an underlag names nothing and reads nothing', async () => {
    const { supabase, mock } = db({})
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: null })).toBeNull()
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })
})

describe('releasesItsUnderlagNow', () => {
  it('reads whether the credit stands', async () => {
    const standing = db(credited())
    expect(await releasesItsUnderlagNow(standing.supabase, COMPANY, invoice() as never)).toBe(true)
    const reversedByHand = db(credited({ journal_entries: [entry('je-1'), entry('je-cn', 'reversed')] }))
    expect(await releasesItsUnderlagNow(reversedByHand.supabase, COMPANY, invoice() as never)).toBe(false)
  })
})

describe('copyReleasedUnderlag', () => {
  it('copies onto the new registration verifikat, booked from the document, and the invoice names the copy', async () => {
    const { supabase, writes, mock } = db({ supplier_invoices: [{ id: 'si-new', company_id: COMPANY, document_id: 'doc-1' }] })
    const id = await copyReleasedUnderlag(supabase, COMPANY, 'user-1', {
      sourceDocumentId: 'doc-1',
      supplierInvoiceId: 'si-new',
      journalEntryId: 'je-new',
    })
    expect(id).toBe('copy-on-entry')
    expect(linkDocumentCopyToVoucher).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      'user-1',
      { document_id: 'doc-1', journal_entry_id: 'je-new' },
      { linkBasis: { link_basis: 'user_created', link_evidence: {} } },
    )
    expect(writes).toEqual([{ table: 'supplier_invoices', method: 'update', row: { document_id: 'copy-on-entry' } }])
    // Only while the invoice still names the original.
    expect(mock.findCalls('supplier_invoices', 'eq')).toContainEqual(['document_id', 'doc-1'])
  })

  it('with no verifikat now, the copy waits on no verifikat for the booking to anchor it', async () => {
    const { supabase, writes } = db({ supplier_invoices: [{ id: 'si-new', company_id: COMPANY, document_id: 'doc-1' }] })
    const id = await copyReleasedUnderlag(supabase, COMPANY, 'user-1', {
      sourceDocumentId: 'doc-1',
      supplierInvoiceId: 'si-new',
      journalEntryId: null,
    })
    expect(id).toBe('copy-floating')
    expect(archiveDocumentCopy).toHaveBeenCalledWith(supabase, COMPANY, 'user-1', 'doc-1', 'supplier-invoice:si-new')
    expect(linkDocumentCopyToVoucher).not.toHaveBeenCalled()
    expect(writes).toEqual([{ table: 'supplier_invoices', method: 'update', row: { document_id: 'copy-floating' } }])
  })

  it('a refused copy throws, and the invoice keeps the original', async () => {
    vi.mocked(linkDocumentCopyToVoucher).mockResolvedValueOnce({ ok: false, code: 'PERIOD_LOCKED', details: { period: {} } } as never)
    const { supabase, writes } = db({ supplier_invoices: [] })
    await expect(
      copyReleasedUnderlag(supabase, COMPANY, 'user-1', { sourceDocumentId: 'doc-1', supplierInvoiceId: 'si-new', journalEntryId: 'je-new' }),
    ).rejects.toThrow('PERIOD_LOCKED')
    expect(writes).toEqual([])
  })
})
