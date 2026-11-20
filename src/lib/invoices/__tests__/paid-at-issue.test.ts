import { describe, expect, it } from 'vitest'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { paidAtIssueBlockReason } from '../paid-at-issue'

describe('paidAtIssueBlockReason: the date', () => {
  it('refuses an invoice dated ahead of today: the payment takes its date', () => {
    expect(paidAtIssueBlockReason({ document_type: 'invoice', invoice_date: '2099-01-01' })).toBe('dated_ahead')
  })

  it('lets an invoice dated today through', () => {
    expect(paidAtIssueBlockReason({ document_type: 'invoice', invoice_date: todayIsoStockholm() })).toBeNull()
  })

  it('has nothing to say on a document with no date yet', () => {
    expect(paidAtIssueBlockReason({ items: [] })).toBeNull()
  })
})

describe('paidAtIssueBlockReason: a credit note', () => {
  it('reads the one identity: a link or a total below zero', () => {
    expect(paidAtIssueBlockReason({ credited_invoice_id: 'inv-0' })).toBe('credit_note')
    expect(paidAtIssueBlockReason({ total: -500 })).toBe('credit_note')
  })
})
