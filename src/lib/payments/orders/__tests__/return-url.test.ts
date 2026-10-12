import { describe, expect, it } from 'vitest'
import { parsePaymentSigningReturn, paymentSigningReturnUrl, stripPaymentSigningReturn } from '../return-url'

const params = (query: string) => new URLSearchParams(query)

describe('paymentSigningReturnUrl', () => {
  it('names the signing on the Betalningar page of the given origin', () => {
    expect(paymentSigningReturnUrl('https://app.accounted.se', 'batch-1')).toBe('https://app.accounted.se/payments?signing=batch-1')
    expect(paymentSigningReturnUrl('https://books.example.se/', 'b/2')).toBe('https://books.example.se/payments?signing=b%2F2')
  })
})

describe('parsePaymentSigningReturn', () => {
  it("reads the bank's return: the batch, the flag and the code on an error", () => {
    expect(parsePaymentSigningReturn(params('signing=batch-1&state=batch-1&result=ok'))).toEqual({ batchId: 'batch-1', result: 'ok', code: null })
    expect(parsePaymentSigningReturn(params('signing=batch-1&state=batch-1&result=error&code=access_denied'))).toEqual({
      batchId: 'batch-1',
      result: 'error',
      code: 'ACCESS_DENIED',
    })
    // The code is only read with an error; an ok return never carries a reason.
    expect(parsePaymentSigningReturn(params('signing=batch-1&result=ok&code=whatever'))?.code).toBeNull()
  })

  it('falls back to state for the batch, and resumes nothing without a result', () => {
    expect(parsePaymentSigningReturn(params('state=batch-1&result=ok'))).toEqual({ batchId: 'batch-1', result: 'ok', code: null })
    expect(parsePaymentSigningReturn(params('signing=batch-1'))).toBeNull()
    expect(parsePaymentSigningReturn(params('state=other-flow'))).toBeNull()
    expect(parsePaymentSigningReturn(params('signing=batch-1&result=maybe'))).toBeNull()
    expect(parsePaymentSigningReturn(params(''))).toBeNull()
  })

  it('bounds the code to 64 upper-case characters', () => {
    const parsed = parsePaymentSigningReturn(params(`signing=b&result=error&code=${'x'.repeat(80)}`))
    expect(parsed?.code).toBe('X'.repeat(64))
    expect(parsePaymentSigningReturn(params('signing=b&result=error&code='))?.code).toBeNull()
  })
})

describe('stripPaymentSigningReturn', () => {
  it('drops every return parameter and keeps the rest of the URL', () => {
    expect(stripPaymentSigningReturn('https://app.accounted.se/payments?signing=b&state=b&result=ok&code=x&tab=all#top')).toBe('/payments?tab=all#top')
    expect(stripPaymentSigningReturn('https://app.accounted.se/payments?signing=b&result=error')).toBe('/payments')
  })
})
