/**
 * A proposal shows the underlag it is about, whatever its operation type.
 * Only the two link previews did; the proposals that book or remove an
 * underlag printed their figures and no document.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PendingOperation } from '@/types'
import { bankRowDocumentRef, proposalDocumentRef } from '../proposal-document'
import type { RowsUnderlagRead, RowUnderlagResult } from '../review-model'

vi.mock('next-intl', () => ({
  // A message with values shows them, so a test can read the counts it was given.
  useTranslations: () =>
    Object.assign((key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key), { has: () => true }),
  useLocale: () => 'sv',
}))

// What the rows of a batch were read as: a static render runs no effect, so
// the read is handed in where the hook would have fetched it.
const rowsRead = vi.hoisted(() => ({ current: { results: new Map(), reading: false, askedForRest: false } as RowsUnderlagRead }))
vi.mock('../use-rows-underlag', () => ({
  useRowsUnderlag: () => ({ ...rowsRead.current, readRest: () => {} }),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }) }))

const { OperationPreview } = await import('../OperationPreview')
const { ReviewUnderlag } = await import('../ProposalReview')

const DOC = '11111111-1111-4111-8111-111111111111'
const INBOX = '22222222-2222-4222-8222-222222222222'
const INVOICE = '33333333-3333-4333-8333-333333333333'

describe('proposalDocumentRef', () => {
  it.each(['create_voucher', 'create_supplier_invoice_from_inbox', 'create_expense_claim', 'delete_document'])(
    'reads the document a %s proposal carries in its params',
    (operation_type) => {
      expect(proposalDocumentRef({ operation_type, params: { document_id: DOC, inbox_item_id: INBOX }, preview_data: {} })).toEqual({
        kind: 'document',
        documentId: DOC,
        fileName: null,
        mime: null,
      })
    },
  )

  it('reads the document from the staged preview when the params carry only the inbox item', () => {
    expect(
      proposalDocumentRef({
        operation_type: 'delete_inbox_item',
        params: { inbox_item_id: INBOX },
        preview_data: { document_id: DOC, file_name: 'kvitto.pdf' },
      }),
    ).toEqual({ kind: 'document', documentId: DOC, fileName: 'kvitto.pdf', mime: null })
  })

  it('covers an operation type nobody listed, as long as it carries a document', () => {
    expect(proposalDocumentRef({ operation_type: 'some_future_type', params: { document_id: DOC } })).toMatchObject({
      kind: 'document',
      documentId: DOC,
    })
  })

  it('leaves the two previews that render their own document alone', () => {
    for (const operation_type of ['attach_document_to_transaction', 'link_document_to_voucher']) {
      expect(proposalDocumentRef({ operation_type, params: { document_id: DOC } })).toBeNull()
    }
  })

  it('points a supplier invoice proposal at the invoice, whose document is looked up', () => {
    for (const operation_type of ['link_supplier_invoice_voucher', 'approve_supplier_invoice']) {
      expect(proposalDocumentRef({ operation_type, params: { supplier_invoice_id: INVOICE } })).toEqual({
        kind: 'supplier_invoice',
        supplierInvoiceId: INVOICE,
      })
    }
    expect(proposalDocumentRef({ operation_type: 'create_voucher', params: { supplier_invoice_id: INVOICE } })).toBeNull()
  })

  it('stops pointing at a removed file once the removal is resolved', () => {
    const op = { operation_type: 'delete_document', params: { document_id: DOC } }
    expect(proposalDocumentRef({ ...op, status: 'pending' })).not.toBeNull()
    expect(proposalDocumentRef({ ...op, status: 'committed' })).toBeNull()
    expect(proposalDocumentRef({ operation_type: 'create_voucher', params: { document_id: DOC }, status: 'committed' })).not.toBeNull()
  })

  it('reads the file on a bank row off the underlag route\'s answer', () => {
    expect(bankRowDocumentRef({ source: 'matched', document: { id: DOC, file_name: 'kvitto.jpg', mime_type: 'image/jpeg' } })).toEqual({
      kind: 'document',
      documentId: DOC,
      fileName: 'kvitto.jpg',
      mime: 'image/jpeg',
    })
    // A row without a file, an answer that is none, and an id that is no id.
    for (const answer of [{ document: null }, undefined, null, 'x', { document: { id: '../../etc', file_name: 'a.pdf' } }]) {
      expect(bankRowDocumentRef(answer)).toBeNull()
    }
  })

  it('never builds a link from a value that is not an id', () => {
    expect(proposalDocumentRef({ operation_type: 'create_voucher', params: { document_id: '../../etc' } })).toBeNull()
    expect(proposalDocumentRef({ operation_type: 'create_voucher', params: null, preview_data: null })).toBeNull()
  })
})

describe('OperationPreview', () => {
  const voucher = {
    operation_type: 'create_voucher',
    preview_data: {
      entry_date: '2026-03-02',
      description: 'Kontorsmaterial',
      lines: [
        { account_number: '6110', debit_amount: 100, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      ],
    },
  }

  it('embeds the underlag in the review of a voucher booked from the inbox', () => {
    const html = renderToStaticMarkup(
      createElement(OperationPreview, { op: { ...voucher, params: { document_id: DOC, inbox_item_id: INBOX } }, detail: true }),
    )
    expect(html).toContain('preview_link_document_heading')
    expect(html).toContain(`/api/documents/${DOC}/inline`)
  })

  it('adds nothing to a voucher with no underlag', () => {
    const html = renderToStaticMarkup(createElement(OperationPreview, { op: { ...voucher, params: {} }, detail: true }))
    expect(html).not.toContain('preview_link_document_heading')
    expect(html).not.toContain('/api/documents/')
  })

  it('links each file of a bulk link proposal', () => {
    const html = renderToStaticMarkup(
      createElement(OperationPreview, {
        op: {
          operation_type: 'link_documents_to_vouchers',
          preview_data: { total: 1, matched_count: 1, results: [{ document_id: DOC, document_file_name: 'faktura.pdf', voucher_label: 'A12', status: 'matched' }] },
        },
      }),
    )
    expect(html).toContain(`href="/api/documents/${DOC}/inline"`)
    expect(html).toContain('faktura.pdf')
  })
})

describe('ReviewUnderlag: the heading never stands alone (crm#1977)', () => {
  const TX = '44444444-4444-4444-8444-444444444444'
  // A static render: the bank row's underlag is still being read.
  const render = (op: Record<string, unknown>, slot = false) =>
    renderToStaticMarkup(createElement(ReviewUnderlag, { op: { status: 'pending', ...op } as unknown as PendingOperation, viewerClassName: 'h-10', slot }))

  it('a matched payment shows its bank row with no heading over it', () => {
    const html = render({
      operation_type: 'match_transaction_invoice',
      params: { transaction_id: TX },
      preview_data: { transaction_date: '2026-11-10', transaction_description: 'BG 5050-1055', transaction_amount: 12500 },
    })
    expect(html).toContain('BG 5050-1055')
    expect(html).toContain('review_bank_row')
    expect(html).not.toContain('<h3')
  })

  it('a proposal that only names a bank row renders nothing until the row has a file to show', () => {
    expect(render({ operation_type: 'ignore_transaction', params: { transaction_id: TX }, preview_data: {} })).toBe('')
  })

  it('a categorisation keeps its heading together with the skeleton it heads', () => {
    const html = render({ operation_type: 'categorize_transaction', params: { transaction_id: TX }, preview_data: {} })
    expect(html).toMatch(/<div aria-busy="true"[^>]*><h3[^>]*>preview_link_document_heading<\/h3><div[^>]*skeleton-shimmer/)
  })

  it('the full page says so where a proposal has no underlag, under the heading', () => {
    const html = render({ operation_type: 'create_customer', params: {}, preview_data: { name: 'A' } }, true)
    expect(html).toMatch(/<h3[^>]*>preview_link_document_heading<\/h3><p[^>]*>review_no_underlag<\/p>/)
  })
})

describe('ReviewUnderlag: the files on the rows of a samlingsverifikat (crm#1977)', () => {
  const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
  const DOC_2 = '55555555-5555-4555-8555-555555555555'
  const withFile = (documentId: string, fileName: string | null, text: string): RowUnderlagResult => ({
    failed: false,
    bankRow: { date: '2026-11-03', text, amount: -249, currency: 'SEK' },
    document: { kind: 'document', documentId, fileName, mime: null },
  })
  const without: RowUnderlagResult = { failed: false, bankRow: { date: '2026-11-03', text: 'SL', amount: -39, currency: 'SEK' }, document: null }
  const render = (rows: string[], read: Array<[string, RowUnderlagResult]>, { reading = false, slot = false, askedForRest = false } = {}) => {
    rowsRead.current = { results: new Map(read), reading, askedForRest }
    const op = { status: 'pending', operation_type: 'bulk_book_transactions', params: { tx_ids: rows }, preview_data: { tx_count: rows.length } }
    return renderToStaticMarkup(createElement(ReviewUnderlag, { op: op as unknown as PendingOperation, viewerClassName: 'h-10', slot }))
  }

  it('each row that has a file states the row and opens its file; a row without one is not listed', () => {
    const html = render([id(1), id(2), id(3)], [[id(1), withFile(DOC, 'kvitto.pdf', 'Clas Ohlson')], [id(2), without], [id(3), withFile(DOC_2, null, 'Kjell')]])
    expect(html).toMatch(/<h3[^>]*>preview_link_document_heading<\/h3><ul/)
    expect(html.match(/<li/g)).toHaveLength(2)
    expect(html).toContain('2026-11-03 · Clas Ohlson')
    expect(html).toMatch(new RegExp(`<a href="/api/documents/${DOC}/inline" target="_blank" rel="noopener noreferrer"[^>]*>kvitto.pdf`))
    // A file without a name is still a link that says what it is.
    expect(html).toMatch(new RegExp(`<a href="/api/documents/${DOC_2}/inline"[^>]*>link_preview_file`))
    // The row without a file says nothing: no line, no count, no warning.
    expect(html).not.toContain('SL')
    expect(html).not.toContain('review_rows_underlag')
    expect(html).not.toContain('why_upload')
  })

  it('renders nothing in the drawer when no row has a file, and while the first read is out', () => {
    expect(render([id(1), id(2)], [[id(1), without], [id(2), without]])).toBe('')
    expect(render([id(1), id(2)], [], { reading: true })).toBe('')
  })

  it('the full page keeps the slot: a skeleton under the heading while reading, then that there is none', () => {
    expect(render([id(1)], [], { reading: true, slot: true })).toMatch(/<div aria-busy="true"[^>]*><h3[^>]*>preview_link_document_heading<\/h3><div[^>]*skeleton-shimmer/)
    expect(render([id(1)], [[id(1), without]], { slot: true })).toMatch(/<h3[^>]*>preview_link_document_heading<\/h3><p[^>]*>review_no_underlag<\/p>/)
  })

  it('says how many rows could not be read, under the files that were', () => {
    const html = render([id(1), id(2), id(3)], [[id(1), withFile(DOC, 'kvitto.pdf', 'Clas Ohlson')], [id(2), { failed: true }], [id(3), { failed: true }]])
    expect(html.match(/<li/g)).toHaveLength(1)
    expect(html).toContain('review_rows_underlag_failed {&quot;count&quot;:2}')
    expect(html).not.toContain('review_rows_underlag_read')
  })

  it('a batch past the first read says how far it has read and offers the rest', () => {
    const rows = Array.from({ length: 40 }, (_, n) => id(n + 1))
    const first = rows.slice(0, 25).map((row): [string, RowUnderlagResult] => [row, without])
    const html = render(rows, first)
    // No file among the first rows: the way to the rest still shows.
    expect(html).not.toContain('<li')
    expect(html).toContain('review_rows_underlag_read {&quot;read&quot;:25,&quot;total&quot;:40}')
    expect(html).toMatch(/<button[^>]*>.*review_rows_underlag_rest/)
    // While the rest is out the button is busy and cannot be pressed twice.
    expect(render(rows, first, { reading: true, askedForRest: true })).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"|<button[^>]*aria-busy="true"[^>]*disabled=""/)
    // The rest landed and no row had a file: the section stays and says so, the button is gone.
    const all = rows.map((row): [string, RowUnderlagResult] => [row, without])
    const done = render(rows, all, { askedForRest: true })
    expect(done).toMatch(/<h3[^>]*>preview_link_document_heading<\/h3><p[^>]*>review_no_underlag<\/p>/)
    expect(done).not.toContain('<button')
  })
})
