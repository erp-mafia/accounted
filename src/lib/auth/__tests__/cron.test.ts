import { describe, it, expect, beforeEach, vi } from 'vitest'
import { verifyCronSecret } from '../cron'

describe('verifyCronSecret', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 401 when CRON_SECRET is not set', () => {
    vi.stubEnv('CRON_SECRET', '')
    const request = new Request('http://localhost/api/cron', {
      headers: { authorization: 'Bearer test-secret' },
    })
    const result = verifyCronSecret(request)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })

  it('returns 401 when no authorization header is provided', () => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    const request = new Request('http://localhost/api/cron')
    const result = verifyCronSecret(request)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })

  it('returns 401 when token does not match', () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret')
    const request = new Request('http://localhost/api/cron', {
      headers: { authorization: 'Bearer wrong-secret' },
    })
    const result = verifyCronSecret(request)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })

  it('returns null (authorized) when Bearer token matches', () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret')
    const request = new Request('http://localhost/api/cron', {
      headers: { authorization: 'Bearer correct-secret' },
    })
    const result = verifyCronSecret(request)
    expect(result).toBeNull()
  })

  it('returns null (authorized) when bare token matches', () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret')
    const request = new Request('http://localhost/api/cron', {
      headers: { authorization: 'correct-secret' },
    })
    const result = verifyCronSecret(request)
    expect(result).toBeNull()
  })

  it('handles tokens of different lengths safely', () => {
    vi.stubEnv('CRON_SECRET', 'short')
    const request = new Request('http://localhost/api/cron', {
      headers: { authorization: 'Bearer a-much-longer-token-that-differs-in-length' },
    })
    const result = verifyCronSecret(request)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })
})
