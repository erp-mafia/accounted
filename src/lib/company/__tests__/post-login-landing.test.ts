import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolvePostLoginDestination } from '../post-login-landing'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolvePostLoginDestination', () => {
  it('follows the cockpit and every start page', async () => {
    for (const destination of ['/clients', '/', '/bookkeeping', '/att-bokfora', '/supplier-invoices', '/invoices', '/reports/resultatrapport']) {
      fetchMock.mockResolvedValueOnce(json({ data: { destination } }))
      expect(await resolvePostLoginDestination()).toBe(destination)
    }
  })

  it('lands on / for anything else the answer names', async () => {
    for (const destination of ['https://evil.example/', '//evil.example', '/settings/api', null, 3]) {
      fetchMock.mockResolvedValueOnce(json({ data: { destination } }))
      expect(await resolvePostLoginDestination()).toBe('/')
    }
  })

  it('lands on / when the question fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 500))
    expect(await resolvePostLoginDestination()).toBe('/')
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    expect(await resolvePostLoginDestination()).toBe('/')
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }))
    expect(await resolvePostLoginDestination()).toBe('/')
  })
})
