import { describe, it, expect } from 'vitest'
import { isPsuHeaderRefusal, psuHeadersOf } from '../psu-headers'

describe('psuHeadersOf', () => {
  it('names the person by IP address and user agent', () => {
    expect(psuHeadersOf({ ipAddress: ' 203.0.113.7 ', userAgent: 'Mozilla/5.0' })).toEqual({
      'Psu-Ip-Address': '203.0.113.7',
      'Psu-User-Agent': 'Mozilla/5.0',
    })
  })

  it('sends nothing unless both are known: the bank wants every required header or none', () => {
    expect(psuHeadersOf({ ipAddress: '203.0.113.7', userAgent: null })).toBeUndefined()
    expect(psuHeadersOf({ ipAddress: null, userAgent: 'Mozilla/5.0' })).toBeUndefined()
    expect(psuHeadersOf({ ipAddress: ' ', userAgent: 'Mozilla/5.0' })).toBeUndefined()
    expect(psuHeadersOf(undefined)).toBeUndefined()
  })
})

describe('isPsuHeaderRefusal', () => {
  it('reads both PSU header refusals', () => {
    expect(isPsuHeaderRefusal('{"code":422,"message":"PSU header psuIpAddress is not provided","error":"PSU_HEADER_NOT_PROVIDED"}')).toBe(true)
    expect(isPsuHeaderRefusal('{"code":422,"error":"PSU_HEADER_INVALID"}')).toBe(true)
  })

  it('leaves every other refusal to its own handling', () => {
    expect(isPsuHeaderRefusal('{"code":429,"error":"ASPSP_RATE_LIMIT_EXCEEDED"}')).toBe(false)
    expect(isPsuHeaderRefusal('{"code":400,"error":"ASPSP_ERROR"}')).toBe(false)
  })
})
