import { describe, it, expect } from 'vitest'
import {
  classifyProxyRequest,
  createProxyTimings,
  formatProxyServerTiming,
  proxyRouteTemplate,
  timed,
} from '../proxy-timing'

describe('classifyProxyRequest', () => {
  it('treats /api paths as api regardless of headers', () => {
    const headers = new Headers({ 'next-router-prefetch': '1', rsc: '1' })
    expect(classifyProxyRequest('/api/settings', headers)).toBe('api')
  })

  it('recognises app-router prefetch and RSC requests by header', () => {
    expect(
      classifyProxyRequest('/invoices', new Headers({ 'Next-Router-Prefetch': '1', RSC: '1' })),
    ).toBe('prefetch')
    expect(classifyProxyRequest('/invoices', new Headers({ RSC: '1' }))).toBe('rsc')
  })

  it('falls back to page for a plain document request', () => {
    expect(classifyProxyRequest('/invoices', new Headers())).toBe('page')
  })
})

describe('proxyRouteTemplate', () => {
  it('replaces UUID and numeric segments with placeholders', () => {
    expect(proxyRouteTemplate('/invoices/6f1c2a3e-1234-4bcd-9abc-0123456789ab/edit')).toBe(
      '/invoices/:id/edit',
    )
    expect(proxyRouteTemplate('/salary/runs/42')).toBe('/salary/runs/:n')
  })

  it('collapses token-carrying prefixes so secrets never reach the log', () => {
    expect(proxyRouteTemplate('/invite/9f8e7d6c5b4a3928171605f4e3d2c1b0')).toBe('/invite/*')
    expect(proxyRouteTemplate('/payslip/abc')).toBe('/payslip/*')
    expect(proxyRouteTemplate('/auth/callback')).toBe('/auth/*')
    expect(proxyRouteTemplate('/auth')).toBe('/auth/*')
  })

  it('masks long opaque segments outside the known prefixes', () => {
    expect(proxyRouteTemplate('/e/sector/aVeryLongOpaqueSlugThatLooksLikeAToken')).toBe(
      '/e/sector/:token',
    )
  })

  it('keeps ordinary routes and the root untouched', () => {
    expect(proxyRouteTemplate('/settings/company')).toBe('/settings/company')
    expect(proxyRouteTemplate('/')).toBe('/')
  })
})

describe('formatProxyServerTiming', () => {
  it('emits one mw-* metric per phase plus the total', () => {
    const timing = { authMs: 12, sessionMs: 3, companyMs: 40, mfaMs: 0 }
    expect(formatProxyServerTiming(timing, 61)).toBe(
      'mw-auth;dur=12, mw-session;dur=3, mw-company;dur=40, mw-mfa;dur=0, mw-total;dur=61',
    )
  })
})

describe('timed', () => {
  it('returns the wrapped value and accumulates elapsed time on the key', async () => {
    const timing = createProxyTimings()
    const value = await timed(timing, 'sessionMs', async () => 'ok')
    expect(value).toBe('ok')
    await timed(timing, 'sessionMs', async () => undefined)
    expect(timing.sessionMs).toBeGreaterThanOrEqual(0)
    expect(timing.authMs).toBe(0)
  })

  it('still records time when the wrapped call throws', async () => {
    const timing = createProxyTimings()
    await expect(
      timed(timing, 'authMs', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(timing.authMs).toBeGreaterThanOrEqual(0)
  })
})
