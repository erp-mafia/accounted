import { describe, expect, it } from 'vitest'
import { draftDownloadDecision } from '../draft-download-decision'

describe('draftDownloadDecision', () => {
  it('downloads issued documents without asking', () => {
    expect(draftDownloadDecision({ status: 'sent', invoice_number: 'F-1' })).toBe('download')
    expect(draftDownloadDecision({ status: 'paid', invoice_number: 'F-1' })).toBe('download')
    expect(draftDownloadDecision({ status: 'overdue', invoice_number: 'F-1' })).toBe('download')
  })

  it('offers to issue any numbered draft: the renderer stamps every draft kind', () => {
    expect(draftDownloadDecision({ status: 'draft', invoice_number: 'F-1' })).toBe('offer_issue')
    expect(
      draftDownloadDecision({ status: 'draft', invoice_number: 'O-1', document_type: 'quote' }),
    ).toBe('offer_issue')
    expect(
      draftDownloadDecision({ status: 'draft', invoice_number: 'P-1', document_type: 'proforma' }),
    ).toBe('offer_issue')
    expect(
      draftDownloadDecision({
        status: 'draft',
        invoice_number: 'FS-1',
        document_type: 'delivery_note',
      }),
    ).toBe('offer_issue')
  })

  it('only warns for an unnumbered draft: there is nothing to issue yet', () => {
    expect(draftDownloadDecision({ status: 'draft', invoice_number: null })).toBe('confirm_draft')
    expect(draftDownloadDecision({ status: 'draft', invoice_number: '' })).toBe('confirm_draft')
  })

  it('leaves self-billed invoices alone: there is no own PDF to issue', () => {
    expect(
      draftDownloadDecision({ status: 'draft', invoice_number: null, is_self_billed: true }),
    ).toBe('download')
  })
})
