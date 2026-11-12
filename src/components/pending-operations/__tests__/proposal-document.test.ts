/**
 * A proposal shows the underlag it is about, whatever its operation type.
 * Only the two link previews did; the proposals that book or remove an
 * underlag printed their figures and no document.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { proposalDocumentRef } from '../proposal-document'

vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { has: () => true }),
  useLocale: () => 'sv',
}))

const { OperationPreview } = await import('../OperationPreview')

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
