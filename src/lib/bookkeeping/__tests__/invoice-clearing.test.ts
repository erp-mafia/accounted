import { describe, expect, it } from 'vitest'
import { clearsAnInvoice, isClearingAccount } from '../invoice-clearing'

describe('invoice clearing', () => {
  it('a clearing account is one in the receivables or the payables group', () => {
    for (const account of ['1510', '1513', '2440', '2441']) expect(isClearingAccount(account), account).toBe(true)
    for (const account of ['1930', '1630', '2890', '2893', '2641', '5420', '3001', '244', '15100']) {
      expect(isClearingAccount(account), account).toBe(false)
    }
  })

  it('a verifikat clears an invoice when any of its lines is on one', () => {
    expect(clearsAnInvoice(['2440', '1930'])).toBe(true)
    expect(clearsAnInvoice(['1930', '1510'])).toBe(true)
    expect(clearsAnInvoice(['2440', '6570', '1930'])).toBe(true)
    expect(clearsAnInvoice(['5420', '2641', '1930'])).toBe(false)
    expect(clearsAnInvoice([])).toBe(false)
  })
})
