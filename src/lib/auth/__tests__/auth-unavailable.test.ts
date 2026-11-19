import { describe, expect, it } from 'vitest'
import {
  AUTH_UNAVAILABLE_CODE,
  apiPathAnswersWithoutSession,
  authUnavailableApiResponse,
  authUnavailablePageResponse,
} from '../auth-unavailable'

describe('the answer to a session that could not be checked', () => {
  it('is a 503 with a wait for the API, in both languages, never cached', async () => {
    const response = authUnavailableApiResponse(null)

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('10')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.error.code).toBe(AUTH_UNAVAILABLE_CODE)
    expect(body.error.message).toContain('Du är fortfarande inloggad')
    expect(body.error.message_en).toContain('You are still signed in')
  })

  it('is a page that says the user is still signed in and reloads by itself', async () => {
    const response = authUnavailablePageResponse(20, 'sv')

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('retry-after')).toBe('20')
    const html = await response.text()
    expect(html).toContain('<html lang="sv"')
    expect(html).toContain('http-equiv="refresh" content="20"')
    expect(html).toContain('Du är fortfarande inloggad')
    expect(html).toContain('<a href="">Ladda om nu</a>')
    // Written by the proxy on any host: no script, nothing from the request.
    expect(html).not.toContain('<script')
  })

  it('speaks English to an English session', async () => {
    const html = await authUnavailablePageResponse(null, 'en').text()
    expect(html).toContain('<html lang="en"')
    expect(html).toContain('You are still signed in')
  })

  it('keeps the wait between 5 seconds and a minute', () => {
    expect(authUnavailableApiResponse(0).headers.get('retry-after')).toBe('5')
    expect(authUnavailableApiResponse(1.2).headers.get('retry-after')).toBe('5')
    expect(authUnavailableApiResponse(600).headers.get('retry-after')).toBe('60')
  })

  it('lets only the sign-in and sign-out routes answer without a checked session', () => {
    for (const path of ['/api/auth/login', '/api/auth/logout', '/api/auth/otp', '/api/auth/signup', '/api/auth/password-reset', '/api/extensions/ext/tic/bankid/collect', '/api/attest/abc/approve', '/api/signera/abc', '/api/verifiera']) {
      expect(apiPathAnswersWithoutSession(path)).toBe(true)
    }
    for (const path of ['/api/auth/session-token', '/api/auth/me', '/api/auth/heartbeat', '/api/auth/login/extra', '/api/invoices']) {
      expect(apiPathAnswersWithoutSession(path)).toBe(false)
    }
  })
})
