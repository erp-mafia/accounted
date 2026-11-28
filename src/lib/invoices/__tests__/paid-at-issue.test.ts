import { describe, expect, it } from 'vitest'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { isPaidAtIssueAccount, paidAtIssueBlockReason } from '../paid-at-issue'

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

describe('isPaidAtIssueAccount (crm#2324)', () => {
  it('allows the cash ledgers: kassa, bank, Swish', () => {
    expect(isPaidAtIssueAccount('1910')).toBe(true)
    expect(isPaidAtIssueAccount('1930')).toBe(true)
    expect(isPaidAtIssueAccount('1940')).toBe(true)
  })

  it('allows 1686, the claim on a card acquirer or payment provider until the payout', () => {
    expect(isPaidAtIssueAccount('1686')).toBe(true)
  })

  it("allows an account a store books a payment method to, only when the company's stores name it", () => {
    expect(isPaidAtIssueAccount('1517')).toBe(false)
    expect(isPaidAtIssueAccount('1517', ['1517', '1518'])).toBe(true)
    expect(isPaidAtIssueAccount('1518', ['1517'])).toBe(false)
  })

  it('refuses anything else: a kundfordran, revenue, nothing', () => {
    expect(isPaidAtIssueAccount('1510')).toBe(false)
    expect(isPaidAtIssueAccount('3001')).toBe(false)
    expect(isPaidAtIssueAccount('')).toBe(false)
    expect(isPaidAtIssueAccount(null)).toBe(false)
  })
})
