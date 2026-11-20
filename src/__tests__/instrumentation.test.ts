import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const flushAnalytics = vi.fn(async () => {})

vi.mock('@/lib/analytics/posthog-server', () => ({
  getPostHogServer: () => ({ captureException }),
  flushAnalytics: () => flushAnalytics(),
}))

import { onRequestError } from '../instrumentation'

type RequestInfo = Parameters<typeof onRequestError>[1]
type ContextInfo = Parameters<typeof onRequestError>[2]

function requestFor(path: string): RequestInfo {
  return { path, method: 'GET', headers: { 'x-posthog-distinct-id': 'd1' } } as RequestInfo
}

const context = { routerKind: 'App Router', routePath: '/api/x', routeType: 'route' } as ContextInfo

beforeEach(() => {
  vi.clearAllMocks()
})

describe('onRequestError', () => {
  it('sends the path without the org number in its query string (#95)', async () => {
    await onRequestError(new Error('lookup failed'), requestFor('/api/company/check-org-number?org_number=8001011234'), context)

    expect(captureException).toHaveBeenCalledTimes(1)
    const [error, distinctId, properties] = captureException.mock.calls[0]
    expect(distinctId).toBe('d1')
    expect(properties).toEqual({ path: '/api/company/check-org-number?org_number=[REDACTED]', method: 'GET' })
    expect(JSON.stringify(properties)).not.toContain('8001011234')
    expect((error as Error).message).toBe('lookup failed')
    expect(flushAnalytics).toHaveBeenCalled()
  })

  it('redacts a personnummer quoted in the error message', async () => {
    await onRequestError(new Error('no company 800101-1234'), requestFor('/api/x'), context)

    const [error, , properties] = captureException.mock.calls[0]
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('[REDACTED]')
    expect(properties.path).toBe('/api/x')
  })
})
