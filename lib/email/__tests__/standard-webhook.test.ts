import { describe, it, expect } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import { verifyStandardWebhookSignature } from '../standard-webhook'

const KEY = randomBytes(24)
const SECRET = `v1,whsec_${KEY.toString('base64')}`

function sign(id: string, timestamp: string, payload: string, key: Buffer = KEY): string {
  const sig = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64')
  return `v1,${sig}`
}

const NOW_MS = 1_754_000_000_000
const NOW_SECONDS = String(Math.floor(NOW_MS / 1000))

describe('verifyStandardWebhookSignature', () => {
  const payload = JSON.stringify({ hello: 'world' })

  it('accepts a valid v1 signature', () => {
    expect(
      verifyStandardWebhookSignature({
        secret: SECRET,
        payload,
        id: 'msg_1',
        timestamp: NOW_SECONDS,
        signature: sign('msg_1', NOW_SECONDS, payload),
        nowMs: NOW_MS,
      }),
    ).toBe(true)
  })

  it('accepts the whsec_-only secret format', () => {
    expect(
      verifyStandardWebhookSignature({
        secret: `whsec_${KEY.toString('base64')}`,
        payload,
        id: 'msg_1',
        timestamp: NOW_SECONDS,
        signature: sign('msg_1', NOW_SECONDS, payload),
        nowMs: NOW_MS,
      }),
    ).toBe(true)
  })

  it('accepts a space-separated signature list with one matching entry', () => {
    const other = sign('msg_1', NOW_SECONDS, payload, randomBytes(24))
    const good = sign('msg_1', NOW_SECONDS, payload)
    expect(
      verifyStandardWebhookSignature({
        secret: SECRET,
        payload,
        id: 'msg_1',
        timestamp: NOW_SECONDS,
        signature: `${other} ${good}`,
        nowMs: NOW_MS,
      }),
    ).toBe(true)
  })

  it('rejects a signature computed with a different key', () => {
    expect(
      verifyStandardWebhookSignature({
        secret: SECRET,
        payload,
        id: 'msg_1',
        timestamp: NOW_SECONDS,
        signature: sign('msg_1', NOW_SECONDS, payload, randomBytes(24)),
        nowMs: NOW_MS,
      }),
    ).toBe(false)
  })

  it('rejects a tampered payload', () => {
    expect(
      verifyStandardWebhookSignature({
        secret: SECRET,
        payload: payload + 'x',
        id: 'msg_1',
        timestamp: NOW_SECONDS,
        signature: sign('msg_1', NOW_SECONDS, payload),
        nowMs: NOW_MS,
      }),
    ).toBe(false)
  })

  it('rejects missing headers', () => {
    expect(
      verifyStandardWebhookSignature({
        secret: SECRET,
        payload,
        id: null,
        timestamp: NOW_SECONDS,
        signature: sign('msg_1', NOW_SECONDS, payload),
        nowMs: NOW_MS,
      }),
    ).toBe(false)
  })

  it('rejects a timestamp outside the replay tolerance', () => {
    const stale = String(Math.floor(NOW_MS / 1000) - 3600)
    expect(
      verifyStandardWebhookSignature({
        secret: SECRET,
        payload,
        id: 'msg_1',
        timestamp: stale,
        signature: sign('msg_1', stale, payload),
        nowMs: NOW_MS,
      }),
    ).toBe(false)
  })

  it('ignores non-v1 signature versions', () => {
    const sig = sign('msg_1', NOW_SECONDS, payload).slice(3)
    expect(
      verifyStandardWebhookSignature({
        secret: SECRET,
        payload,
        id: 'msg_1',
        timestamp: NOW_SECONDS,
        signature: `v1a,${sig}`,
        nowMs: NOW_MS,
      }),
    ).toBe(false)
  })
})
