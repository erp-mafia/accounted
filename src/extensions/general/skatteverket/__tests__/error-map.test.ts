import { describe, it, expect } from 'vitest'
import { skvAuthCodeToStructured } from '../lib/error-map'
import { getErrorEntry } from '@/lib/errors/structured-errors'

describe('skvAuthCodeToStructured', () => {
  const reconnectCodes = [
    'NOT_CONNECTED', 'SESSION_EXPIRED', 'REFRESH_EXHAUSTED', 'TOKEN_REVOKED', 'TOKEN_CORRUPTED', 'MISSING_SCOPE',
  ] as const
  for (const code of reconnectCodes) {
    it(`${code} → SKATTEVERKET_NOT_CONNECTED (401)`, () => {
      expect(skvAuthCodeToStructured(code)).toEqual({ code: 'SKATTEVERKET_NOT_CONNECTED', httpStatus: 401 })
    })
  }

  for (const code of ['BEHORIGHET_SAKNAS', 'ACCESS_DENIED'] as const) {
    it(`${code} → SKATTEVERKET_ACCESS_DENIED (403)`, () => {
      expect(skvAuthCodeToStructured(code)).toEqual({ code: 'SKATTEVERKET_ACCESS_DENIED', httpStatus: 403 })
    })
  }

  it('RATE_LIMITED → SKATTEVERKET_RATE_LIMITED (429)', () => {
    expect(skvAuthCodeToStructured('RATE_LIMITED')).toEqual({ code: 'SKATTEVERKET_RATE_LIMITED', httpStatus: 429 })
  })

  it('every mapped structured code resolves to a real registry entry', () => {
    for (const code of ['SKATTEVERKET_NOT_CONNECTED', 'SKATTEVERKET_ACCESS_DENIED', 'SKATTEVERKET_RATE_LIMITED', 'EXTENSION_DISABLED']) {
      expect(getErrorEntry(code), code).toBeDefined()
    }
  })
})
