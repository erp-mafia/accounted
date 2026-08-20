import { describe, it, expect, afterEach, vi } from 'vitest'
import { isConnectorState, signConnectorState, verifyConnectorState } from '../state'

afterEach(() => vi.unstubAllEnvs())

const BASE = { kid: 'k1', svc: 'bank' as const, ret: 'https://bokforing.example.se/cb', st: 'inst-state', cref: 'company-1' }

describe('connector state', () => {
  it('round-trips a signed payload', () => {
    vi.stubEnv('CONNECTOR_STATE_SECRET', 'secret')
    const now = 1_000_000
    const token = signConnectorState(BASE, now)
    expect(isConnectorState(token)).toBe(true)
    const v = verifyConnectorState(token, now)
    expect(v).toEqual({ ok: true, payload: { ...BASE, iat: now } })
  })

  it('rejects a tampered payload', () => {
    vi.stubEnv('CONNECTOR_STATE_SECRET', 'secret')
    const token = signConnectorState(BASE, 1000)
    const [ver, body, sig] = token.split('.')
    const tamperedBody = Buffer.from(JSON.stringify({ ...BASE, cref: 'other', iat: 1000 })).toString('base64url')
    expect(verifyConnectorState(`${ver}.${tamperedBody}.${sig}`, 1000)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a signature made with a different secret', () => {
    vi.stubEnv('CONNECTOR_STATE_SECRET', 'secret-a')
    const token = signConnectorState(BASE, 1000)
    vi.stubEnv('CONNECTOR_STATE_SECRET', 'secret-b')
    expect(verifyConnectorState(token, 1000)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('expires after the TTL and rejects a future iat', () => {
    vi.stubEnv('CONNECTOR_STATE_SECRET', 'secret')
    const token = signConnectorState(BASE, 1000)
    expect(verifyConnectorState(token, 1000 + 16 * 60 * 1000)).toEqual({ ok: false, reason: 'expired' })
    const future = signConnectorState(BASE, 10_000_000)
    expect(verifyConnectorState(future, 1000)).toEqual({ ok: false, reason: 'expired' })
  })

  it('flags malformed tokens', () => {
    vi.stubEnv('CONNECTOR_STATE_SECRET', 'secret')
    expect(verifyConnectorState('nope')).toEqual({ ok: false, reason: 'malformed' })
    expect(isConnectorState('random-uuid-state')).toBe(false)
  })

  it('derives a secret from the service-role key when none is set (still verifiable)', () => {
    vi.stubEnv('CONNECTOR_STATE_SECRET', '')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'svc-key')
    const token = signConnectorState(BASE, 2000)
    expect(verifyConnectorState(token, 2000).ok).toBe(true)
  })
})
