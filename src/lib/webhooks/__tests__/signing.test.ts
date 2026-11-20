/**
 * `t=<unix>,v1=<hex>` signatures over `${t}.${rawBody}` (ADA CASA 7.2.1-7.2.3):
 * our outbound deliveries and inbound Qvalia webhooks share the scheme.
 *
 * The vectors are fixed, not recomputed by the code under test; the expected
 * MAC was cross-checked with `openssl dgst -sha256 -hmac`.
 */
import { describe, expect, it } from 'vitest'
import { signPayload, verifySignatureHeader } from '../signing'

const SECRET = 'qv_whsec_5f2b8c1d9e7a4b3c'
const T = 1790000000 // 2026-09-21T14:13:20Z
const BODY =
  '{"eventId":"evt_01J9ZK3Q8X","eventType":"document_delivery","integrationId":"int-1","globalTransactionId":"int-1","direction":"outgoing","status":{"status":"processed"}}'
const V1 = '0b28bc4ae53a95f08964407393255dbdcd5718cad0699be64be185ebf80c2c4a'
/** The same body signed with a previous secret, as sent during a rotation overlap. */
const V1_OLD_SECRET = '801926c8f1e2f1c42e3aabb46a019d9d011230006b79057b8ea45ff2cc73ba6b'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('verifySignatureHeader: fixed vectors', () => {
  it('accepts the vector over the raw bytes and over the same text', () => {
    expect(verifySignatureHeader({ header: `t=${T},v1=${V1}`, rawBody: bytes(BODY), secret: SECRET, nowSeconds: T })).toEqual({
      ok: true,
      timestamp: T,
    })
    expect(verifySignatureHeader({ header: `t=${T},v1=${V1}`, rawBody: BODY, secret: SECRET, nowSeconds: T }).ok).toBe(true)
  })

  it('matches what signPayload produces for the same inputs', () => {
    expect(signPayload({ body: BODY, secret: SECRET, timestamp: T }).header).toBe(`t=${T},v1=${V1}`)
  })

  it('accepts any v1 entry, so a rotation overlap (old and new signature) verifies', () => {
    const header = `t=${T},v1=${V1_OLD_SECRET},v1=${V1}`
    expect(verifySignatureHeader({ header, rawBody: bytes(BODY), secret: SECRET, nowSeconds: T }).ok).toBe(true)
    expect(
      verifySignatureHeader({ header, rawBody: bytes(BODY), secret: 'qv_whsec_old_rotated', nowSeconds: T }).ok,
    ).toBe(true)
  })

  it('tolerates whitespace around entries and upper-case hex', () => {
    const header = ` t=${T} , v1=${V1.toUpperCase()} `
    expect(verifySignatureHeader({ header, rawBody: bytes(BODY), secret: SECRET, nowSeconds: T }).ok).toBe(true)
  })
})

describe('verifySignatureHeader: refusals', () => {
  const base = { rawBody: bytes(BODY), secret: SECRET, nowSeconds: T }

  it('refuses a missing or empty header', () => {
    expect(verifySignatureHeader({ ...base, header: null })).toEqual({ ok: false, reason: 'missing_header' })
    expect(verifySignatureHeader({ ...base, header: '  ' })).toEqual({ ok: false, reason: 'missing_header' })
  })

  it('refuses headers without a timestamp, without a v1, with a non-numeric or doubled t', () => {
    for (const header of [`v1=${V1}`, `t=${T}`, `t=abc,v1=${V1}`, `t=${T},t=${T},v1=${V1}`, `t=${T},v1=zz`, 'garbage']) {
      expect(verifySignatureHeader({ ...base, header })).toEqual({ ok: false, reason: 'malformed_header' })
    }
  })

  it('refuses a modified body (one byte)', () => {
    const tampered = BODY.replace('processed', 'Processed')
    expect(verifySignatureHeader({ ...base, rawBody: bytes(tampered), header: `t=${T},v1=${V1}` })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  it('refuses a timestamp changed without re-signing (t is inside the MAC)', () => {
    expect(verifySignatureHeader({ ...base, header: `t=${T + 1},v1=${V1}`, nowSeconds: T + 1 })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  it('refuses the wrong secret', () => {
    expect(verifySignatureHeader({ ...base, secret: 'another', header: `t=${T},v1=${V1}` })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  it('refuses an authentic request older or newer than 5 minutes (replay window)', () => {
    const header = `t=${T},v1=${V1}`
    expect(verifySignatureHeader({ ...base, header, nowSeconds: T + 300 }).ok).toBe(true)
    expect(verifySignatureHeader({ ...base, header, nowSeconds: T + 301 })).toEqual({
      ok: false,
      reason: 'timestamp_outside_tolerance',
    })
    expect(verifySignatureHeader({ ...base, header, nowSeconds: T - 301 })).toEqual({
      ok: false,
      reason: 'timestamp_outside_tolerance',
    })
  })
})
