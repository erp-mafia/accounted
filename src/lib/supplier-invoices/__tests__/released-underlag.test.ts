/**
 * The underlag of a credited supplier invoice is released for a new
 * registration: the item's pointer at the credited invoice, the verifikat
 * its document stays on and the credited invoice's use of the document hold
 * nothing any more, and the new registration gets a byte-identical copy. A
 * live invoice, a live verifikat and a credit note still hold it.
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
} from '../released-underlag'

const COMPANY = 'company-1'

type Rows = Record<string, Record<string, unknown>[]>

/** Each invoice carries its document as PostgREST embeds it (supplier_invoices_document_id_fkey). */
function withDocumentEmbed(tables: Rows): Rows {
  const documents = tables.document_attachments ?? []
  const invoices = (tables.supplier_invoices ?? []).map((invoice) => ({
    ...invoice,
    document: documents.find((d) => d.id === invoice.document_id) ?? null,
  }))
  return tables.supplier_invoices ? { ...tables, supplier_invoices: invoices } : tables
}

function db(tables: Rows) {
  const writes: { table: string; method: string; row: unknown }[] = []
  const mock = createRowsMockSupabase(withDocumentEmbed(tables), writes)
  return { supabase: mock.supabase as unknown as SupabaseClient, writes, mock }
}

/** An invoice registered from doc-1 on verifikat je-1, then credited. */
function creditedOriginal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'si-1',
    company_id: COMPANY,
    status: 'credited',
    is_credit_note: false,
    registration_journal_entry_id: 'je-1',
    document_id: 'doc-1',
    ...overrides,
  }
}

/** An inbox item read with INBOX_ITEM_DOCUMENT_HOLD: its document sits on `entry` in `status`. */
function itemRow(entry: string | null, status: string | null, pointer: string | null = 'si-1') {
  return {
    id: 'item-1',
    document_id: 'doc-1',
    created_supplier_invoice_id: pointer,
    created_journal_entry_id: null,
    document_hold: entry ? { journal_entry_id: entry, entry: { status } } : null,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('releasesItsUnderlag', () => {
  it('a credited or reversed original releases it', () => {
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
    const { supabase } = db({ supplier_invoices: [creditedOriginal()] })
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1', 'posted'))
    expect(item.created_supplier_invoice_id).toBeNull()
    expect(item.document_journal_entry_id).toBeNull()
    expect(release).toEqual({ supplier_invoice_id: 'si-1', copy_from_document_id: 'doc-1' })
    expect(item).not.toHaveProperty('document_hold')
  })

  it('an item whose invoice is still live stays converted', async () => {
    const { supabase } = db({ supplier_invoices: [creditedOriginal({ status: 'approved' })] })
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1', 'posted'))
    expect(item.created_supplier_invoice_id).toBe('si-1')
    expect(item.document_journal_entry_id).toBe('je-1')
    expect(release).toEqual({ supplier_invoice_id: null, copy_from_document_id: null })
  })

  it('a document on a verifikat that books something else stays held', async () => {
    // The pointer is released, but the document sits on a verifikat no
    // released invoice registered: that verifikat still books a purchase.
    const { supabase } = db({ supplier_invoices: [creditedOriginal({ registration_journal_entry_id: 'je-other' })] })
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1', 'posted'))
    expect(item.created_supplier_invoice_id).toBeNull()
    expect(item.document_journal_entry_id).toBe('je-1')
    expect(release.copy_from_document_id).toBeNull()
  })

  it('a document on a reversed verifikat goes on as a copy', async () => {
    const { supabase } = db({ supplier_invoices: [] })
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-9', 'reversed', null))
    expect(item.document_journal_entry_id).toBeNull()
    expect(release).toEqual({ supplier_invoice_id: null, copy_from_document_id: 'doc-1' })
  })

  it('a kontantmetod credit left the document on no verifikat: the document itself is the underlag again', async () => {
    const { supabase } = db({ supplier_invoices: [creditedOriginal({ registration_journal_entry_id: null })] })
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow(null, null))
    expect(item.created_supplier_invoice_id).toBeNull()
    expect(release).toEqual({ supplier_invoice_id: 'si-1', copy_from_document_id: null })
  })

  it('an invoice of another company releases nothing', async () => {
    const { supabase } = db({ supplier_invoices: [creditedOriginal({ company_id: 'company-2' })] })
    const { item } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1', 'posted'))
    expect(item.created_supplier_invoice_id).toBe('si-1')
    expect(item.document_journal_entry_id).toBe('je-1')
  })

  it('an underlag registered again on a copy is held by that invoice: the item answers as converted to it', async () => {
    const { supabase } = db({
      supplier_invoices: [creditedOriginal(), creditedOriginal({ id: 'si-2', status: 'registered', document_id: 'doc-copy', registration_journal_entry_id: 'je-2' })],
      document_attachments: [
        { id: 'doc-1', company_id: COMPANY, sha256_hash: 'same' },
        { id: 'doc-copy', company_id: COMPANY, sha256_hash: 'same' },
      ],
    })
    const { item, release } = await releasedForRegistration(supabase, COMPANY, itemRow('je-1', 'posted'))
    expect(item.created_supplier_invoice_id).toBe('si-2')
    expect(release).toEqual({ supplier_invoice_id: null, copy_from_document_id: null })
  })

  it('fails closed when the invoice cannot be read', async () => {
    const { mock } = db({})
    mock.setTable('supplier_invoices', { data: null, error: { message: 'boom', code: '57014' } })
    await expect(
      releasedForRegistration(mock.supabase as unknown as SupabaseClient, COMPANY, itemRow('je-1', 'posted')),
    ).rejects.toThrow()
  })
})

describe('documentForRegistration', () => {
  const document = (entry: string | null, status: string | null = 'posted') => ({
    id: 'doc-1',
    company_id: COMPANY,
    journal_entry_id: entry,
    entry: entry ? { status } : null,
  })

  it('a document nothing holds is taken as it is', async () => {
    const { supabase } = db({ document_attachments: [document(null)], supplier_invoices: [] })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: true, copy: false })
  })

  it('the underlag of a credited invoice is released, as a copy while its verifikat keeps it', async () => {
    const { supabase } = db({ document_attachments: [document('je-1')], supplier_invoices: [creditedOriginal()] })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: true, copy: true })
  })

  it('a credited invoice that never reached the books leaves the document itself', async () => {
    const { supabase } = db({
      document_attachments: [document(null)],
      supplier_invoices: [creditedOriginal({ registration_journal_entry_id: null })],
    })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: true, copy: false })
  })

  it('a live invoice on the document refuses it as used', async () => {
    const { supabase } = db({
      document_attachments: [document(null)],
      supplier_invoices: [creditedOriginal(), creditedOriginal({ id: 'si-2', status: 'registered', registration_journal_entry_id: null })],
    })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({
      ok: false,
      reason: 'document_already_used',
      supplier_invoice_id: 'si-2',
    })
  })

  it('the underlag of a credited invoice registered again on a copy is used', async () => {
    const { supabase } = db({
      document_attachments: [
        { ...document('je-1'), sha256_hash: 'same' },
        { id: 'doc-copy', company_id: COMPANY, journal_entry_id: 'je-2', sha256_hash: 'same' },
      ],
      supplier_invoices: [creditedOriginal(), creditedOriginal({ id: 'si-2', status: 'registered', document_id: 'doc-copy', registration_journal_entry_id: 'je-2' })],
    })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({
      ok: false,
      reason: 'document_already_used',
      supplier_invoice_id: 'si-2',
    })
  })

  it('a credit note on the document holds it', async () => {
    const { supabase } = db({
      document_attachments: [document(null)],
      supplier_invoices: [creditedOriginal({ id: 'cn-1', is_credit_note: true, registration_journal_entry_id: null })],
    })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toMatchObject({ ok: false, reason: 'document_already_used' })
  })

  it('a document on a verifikat that still books a purchase is unavailable', async () => {
    const { supabase } = db({ document_attachments: [document('je-bank')], supplier_invoices: [] })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: false, reason: 'document_unavailable' })
  })

  it('another company\'s document is unavailable', async () => {
    const { supabase } = db({ document_attachments: [{ ...document(null), company_id: 'company-2' }], supplier_invoices: [] })
    expect(await documentForRegistration(supabase, COMPANY, 'doc-1')).toEqual({ ok: false, reason: 'document_unavailable' })
  })
})

describe('registeredAgainAs', () => {
  const docs = [
    { id: 'doc-1', company_id: COMPANY, sha256_hash: 'abc' },
    { id: 'doc-copy', company_id: COMPANY, sha256_hash: 'abc' },
    { id: 'doc-other', company_id: COMPANY, sha256_hash: 'def' },
  ]

  it('names the live invoice that holds a copy of the credited invoice\'s underlag', async () => {
    const { supabase } = db({
      document_attachments: docs,
      supplier_invoices: [creditedOriginal(), creditedOriginal({ id: 'si-2', status: 'registered', document_id: 'doc-copy' })],
    })
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: 'doc-1' })).toBe('si-2')
  })

  it('names nothing when every other use is credited too, or another document', async () => {
    const { supabase } = db({
      document_attachments: docs,
      supplier_invoices: [
        creditedOriginal(),
        creditedOriginal({ id: 'si-2', document_id: 'doc-copy' }),
        creditedOriginal({ id: 'si-3', status: 'registered', document_id: 'doc-other' }),
      ],
    })
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: 'doc-1' })).toBeNull()
  })

  it('finds the live invoice however many byte-identical documents the company holds', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `doc-${i}`, company_id: COMPANY, sha256_hash: 'abc' }))
    const { supabase } = db({
      document_attachments: [...docs, ...many],
      supplier_invoices: [creditedOriginal(), creditedOriginal({ id: 'si-late', status: 'registered', document_id: 'doc-119' })],
    })
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: 'doc-1' })).toBe('si-late')
  })

  it('an invoice without an underlag names nothing and reads nothing', async () => {
    const { supabase, mock } = db({})
    expect(await registeredAgainAs(supabase, COMPANY, { id: 'si-1', document_id: null })).toBeNull()
    expect(mock.supabase.from).not.toHaveBeenCalled()
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
