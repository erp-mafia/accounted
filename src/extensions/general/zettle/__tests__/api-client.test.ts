import { describe, it, expect } from 'vitest'
import { isRevokedCredentialsError, ZettleApiError } from '../lib/api-client'

describe('zettle api-client', () => {
  it('treats 401/403 as revoked credentials', () => {
    expect(isRevokedCredentialsError(new ZettleApiError('denied', 401))).toBe(true)
    expect(isRevokedCredentialsError(new ZettleApiError('denied', 403))).toBe(true)
    expect(isRevokedCredentialsError(new ZettleApiError('oops', 500))).toBe(false)
    expect(isRevokedCredentialsError(new Error('nope'))).toBe(false)
  })
})
