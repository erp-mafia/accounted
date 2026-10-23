/**
 * The redaction primitives themselves.
 *
 * sink.test.ts and lib/__tests__/logger-sink.test.ts cover redaction on the
 * way INTO the sink; this file locks in the primitive's own contract: which
 * shapes are scrubbed, that scrubbing is idempotent, and that serialized
 * errors keep a (redacted) stack in every environment: the sink only runs in
 * production, and a stackless event is useless to group on.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { redact, redactRequestPath, redactString, redactedError, REDACTED } from '../redact'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('redactString', () => {
  it('replaces the WHOLE string when a personnummer appears', () => {
    expect(redactString('payment for 800101-1234 failed')).toBe(REDACTED)
    expect(redactString('customer 19800101-1234')).toBe(REDACTED)
  })

  it('preserves UUIDs', () => {
    const s = 'company 57484518-3409-4b29-9d23-5d22f08bda63 ok'
    expect(redactString(s)).toBe(s)
  })

  it('scrubs gnubok API keys in place, keeping the rest of the line', () => {
    expect(redactString('auth failed for key gnubok_sk_live_abc123 on /v1')).toBe(
      'auth failed for key [REDACTED_API_KEY] on /v1',
    )
    expect(redactString('invite gnubok_inv_XyZ_9 expired')).toBe(
      'invite [REDACTED_API_KEY] expired',
    )
  })

  it('scrubs Swedish IBANs, compact and space-grouped', () => {
    expect(redactString('payout to SE4550000000058398257466 bounced')).toBe(
      'payout to [REDACTED_IBAN] bounced',
    )
    expect(redactString('iban SE45 5000 0000 0583 9825 7466 rejected')).toBe(
      'iban [REDACTED_IBAN] rejected',
    )
  })

  it('scrubs email addresses in place', () => {
    expect(redactString('reminder sent to anna.svensson@example.com just now')).toBe(
      'reminder sent to [REDACTED_EMAIL] just now',
    )
  })

  it('does not mistake package specs for emails', () => {
    const s = 'installing @anthropic-ai/bedrock-sdk@0.29.1'
    expect(redactString(s)).toBe(s)
  })

  it('scrubs several kinds of secret in one string', () => {
    expect(
      redactString('key gnubok_sk_live_secret1 for anna@example.com on SE4550000000058398257466'),
    ).toBe('key [REDACTED_API_KEY] for [REDACTED_EMAIL] on [REDACTED_IBAN]')
  })

  it('is idempotent: a second pass changes nothing', () => {
    const inputs = [
      'key gnubok_sk_live_secret1 for anna@example.com on SE4550000000058398257466',
      'payment for 800101-1234 failed',
      'plain harmless message',
    ]
    for (const input of inputs) {
      const once = redactString(input)
      expect(redactString(once)).toBe(once)
    }
  })
})

describe('redact() on Error instances', () => {
  it('keeps a stack on the serialized error in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const err = new Error('clean failure')
    const out = redact(err) as { name: string; message: string; stack?: string }
    expect(out.name).toBe('Error')
    expect(out.message).toBe('clean failure')
    expect(typeof out.stack).toBe('string')
    expect(out.stack).toContain('clean failure')
  })

  it('redacts the stack like any other string', () => {
    // The first stack line carries the message, so a personnummer in the
    // message means the whole stack is nuked (whole-string personnummer rule).
    const pii = new Error('no match for 800101-1234')
    const outPii = redact(pii) as { message: string; stack?: string }
    expect(outPii.message).toBe(REDACTED)
    expect(outPii.stack).toBe(REDACTED)

    // Substring secrets are scrubbed in place: the frames stay readable.
    const keyErr = new Error('bad key gnubok_sk_live_abc')
    const outKey = redact(keyErr) as { message: string; stack?: string }
    expect(outKey.message).toBe('bad key [REDACTED_API_KEY]')
    expect(outKey.stack).toContain('[REDACTED_API_KEY]')
    expect(outKey.stack).not.toContain('gnubok_sk_live_abc')
    expect(outKey.stack).toContain('at ')
  })
})

describe('redactRequestPath', () => {
  it('replaces an org number in the query string, and only its value (#95)', () => {
    // A sole trader's org number is the owner's personnummer.
    expect(redactRequestPath('/api/company/check-org-number?org_number=8001011234')).toBe(
      `/api/company/check-org-number?org_number=${REDACTED}`,
    )
    expect(redactRequestPath('/api/extensions/ext/tic/lookup?org_number=556012-5790&x=1')).toBe(
      `/api/extensions/ext/tic/lookup?org_number=${REDACTED}&x=1`,
    )
  })

  it('replaces an identity key whatever the value looks like', () => {
    // '+' (the over-100 separator) decodes to a space, which the regex misses.
    expect(redactRequestPath('/x?personnummer=121212%2B1212&pnr=121212+1212')).toBe(
      `/x?personnummer=${REDACTED}&pnr=${REDACTED}`,
    )
    expect(redactRequestPath('/x?token=abc')).toBe(`/x?token=${REDACTED}`)
  })

  it('redacts a personnummer under any other key, and emails in place', () => {
    expect(redactRequestPath('/x?q=19800101-1234&page=2')).toBe(`/x?q=${REDACTED}&page=2`)
    expect(redactRequestPath('/x?email=anna%40example.com')).toBe('/x?email=[REDACTED_EMAIL]')
  })

  it('leaves a path without personal data as it was', () => {
    expect(redactRequestPath('/api/invoices/57484518-3409-4b29-9d23-5d22f08bda63')).toBe(
      '/api/invoices/57484518-3409-4b29-9d23-5d22f08bda63',
    )
    expect(redactRequestPath('/api/reports/vat?period=2026-09&page=2')).toBe('/api/reports/vat?period=2026-09&page=2')
    expect(redactRequestPath('/x?')).toBe('/x')
    expect(redactRequestPath('/x?flag')).toBe('/x?flag')
  })

  it('redacts a personnummer in the pathname itself', () => {
    expect(redactRequestPath('/api/thing/800101-1234')).toBe(REDACTED)
  })
})

describe('redactedError', () => {
  it('is an Error instance with the message and stack redacted', () => {
    const out = redactedError(new TypeError('no company for 8001011234'))
    expect(out).toBeInstanceOf(Error)
    expect(out.name).toBe('TypeError')
    expect(out.message).toBe(REDACTED)
    expect(out.stack).toBe(REDACTED)
  })

  it('keeps a clean error readable, and wraps a thrown non-Error', () => {
    const out = redactedError(new Error('clean failure'))
    expect(out.message).toBe('clean failure')
    expect(out.stack).toContain('at ')
    expect(redactedError('boom').message).toBe('boom')
  })
})
