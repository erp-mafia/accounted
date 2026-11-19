import { describe, it, expect } from 'vitest'
import { documentPayment, documentState, type DocumentFacts } from '../document-state'

const issued: DocumentFacts = { issued: true, cancelled: false, creditFlag: false, total: 1000 }

describe('documentState', () => {
  it('an issued, ordinary invoice leaves its status to the provider', () => {
    expect(documentState(issued)).toEqual({ invoiceTypeCode: undefined, status: null })
  })

  it('a provider flag or a negative total makes a credit note', () => {
    expect(documentState({ ...issued, creditFlag: true })).toEqual({ invoiceTypeCode: '381', status: 'credited' })
    expect(documentState({ ...issued, total: -100 })).toEqual({ invoiceTypeCode: '381', status: 'credited' })
  })

  it('a zero total is no credit note', () => {
    expect(documentState({ ...issued, total: 0 }).invoiceTypeCode).toBeUndefined()
  })

  it('an unissued document is a draft, and an unissued credit note stays one', () => {
    expect(documentState({ ...issued, issued: false })).toEqual({ invoiceTypeCode: undefined, status: 'draft' })
    expect(documentState({ ...issued, issued: false, total: -100 })).toEqual({ invoiceTypeCode: '381', status: 'draft' })
    expect(documentState({ ...issued, issued: false, creditFlag: true })).toEqual({ invoiceTypeCode: '381', status: 'draft' })
  })

  it('a stated payment says the document went out, unless there is no amount to pay', () => {
    expect(documentState({ ...issued, issued: false, paymentStated: true }).status).toBeNull()
    expect(documentState({ ...issued, issued: false, paymentStated: true, total: -100 })).toEqual({ invoiceTypeCode: '381', status: 'credited' })
    expect(documentState({ ...issued, issued: false, paymentStated: true, total: 0 }).status).toBe('draft')
    expect(documentState({ ...issued, cancelled: true, paymentStated: true }).status).toBe('cancelled')
  })

  it('a voided document is cancelled ahead of everything else, and keeps its type', () => {
    expect(documentState({ ...issued, cancelled: true })).toEqual({ invoiceTypeCode: undefined, status: 'cancelled' })
    expect(documentState({ ...issued, cancelled: true, issued: false })).toEqual({ invoiceTypeCode: undefined, status: 'cancelled' })
    expect(documentState({ ...issued, cancelled: true, total: -100 })).toEqual({ invoiceTypeCode: '381', status: 'cancelled' })
  })
})

describe('documentPayment', () => {
  const stated = { paid: true, balance: 0 }

  it('an unissued document settled nothing and owes its whole total', () => {
    expect(documentPayment(documentState({ ...issued, issued: false }), 1000, stated)).toEqual({ paid: false, balance: 1000 })
  })

  it('leaves every other document to what its fields say', () => {
    expect(documentPayment(documentState(issued), 1000, stated)).toEqual(stated)
    expect(documentPayment(documentState({ ...issued, cancelled: true }), 1000, stated)).toEqual(stated)
    expect(documentPayment(documentState({ ...issued, total: -100 }), -100, stated)).toEqual(stated)
  })
})
