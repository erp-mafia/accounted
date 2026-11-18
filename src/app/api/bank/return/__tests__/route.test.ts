import { beforeEach, describe, expect, it, vi } from 'vitest'

const trusted = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('@/lib/domains/trusted-app-origin', () => ({
  getCanonicalAppOrigin: () => 'https://app.accounted.se',
  resolveTrustedAppOrigin: (...args: unknown[]) => trusted.resolve(...args),
}))

import { GET } from '../route'

function call(to: string | null, extra: Record<string, string> = {}) {
  const url = new URL('https://app.accounted.se/api/bank/return')
  if (to !== null) url.searchParams.set('to', to)
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  return GET(new Request(url))
}

beforeEach(() => {
  trusted.resolve.mockReset()
})

describe('GET /api/bank/return', () => {
  it('forwards to a trusted brand host with the bank\'s parameters', async () => {
    trusted.resolve.mockResolvedValue('https://app.testbrand.example')
    const response = await call('https://app.testbrand.example/settings/connections?bank_connect=c1', { state: 'c1', result: 'ok' })
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe('https://app.testbrand.example')
    expect(location.pathname).toBe('/settings/connections')
    expect(location.searchParams.get('bank_connect')).toBe('c1')
    expect(location.searchParams.get('state')).toBe('c1')
    expect(location.searchParams.get('result')).toBe('ok')
    expect(location.searchParams.has('to')).toBe(false)
    expect(trusted.resolve).toHaveBeenCalledWith('app.testbrand.example', { onLookupFailure: 'canonical' })
  })

  it('forwards a payment signing return with the bank\'s error code', async () => {
    trusted.resolve.mockResolvedValue('https://brand.accounted.se')
    const response = await call('https://brand.accounted.se/payments?signing=b1', { state: 'b1', result: 'error', code: 'SCA_FAILED' })
    const location = new URL(response.headers.get('location')!)
    expect(location.toString()).toBe('https://brand.accounted.se/payments?signing=b1&state=b1&result=error&code=SCA_FAILED')
  })

  it('never forwards to a host Accounted does not serve', async () => {
    trusted.resolve.mockResolvedValue('https://app.accounted.se')
    const response = await call('https://evil.example/settings/connections?bank_connect=c1', { state: 'c1', result: 'ok' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://app.accounted.se/')
  })

  it('never forwards to a page that is not a signing page', async () => {
    trusted.resolve.mockResolvedValue('https://app.testbrand.example')
    const response = await call('https://app.testbrand.example/login?next=/x')
    expect(response.headers.get('location')).toBe('https://app.accounted.se/')
  })

  it('lands on the start page without a target or with one that is not a URL', async () => {
    expect((await call(null)).headers.get('location')).toBe('https://app.accounted.se/')
    expect((await call('not a url')).headers.get('location')).toBe('https://app.accounted.se/')
    expect(trusted.resolve).not.toHaveBeenCalled()
  })
})
