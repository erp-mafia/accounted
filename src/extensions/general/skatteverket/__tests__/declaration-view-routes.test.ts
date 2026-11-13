/**
 * GET /declaration/submitted and /declaration/decided fetch through the same
 * fetchDeclarationView as the v1 read service: 404 is "nothing filed", and an
 * upstream failure answers with a generic sentence, never Skatteverket's own
 * response body. Both read the company's own redovisare, never the URL's: on
 * Accounted's own certificate a URL-named number would reach another
 * customer's filings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { testRoutes } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const { mockRequest, mockResolveReadAuth, mockResolveRedovisare } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockResolveReadAuth: vi.fn(),
  mockResolveRedovisare: vi.fn(),
}))
vi.mock('../lib/declaration-prep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/declaration-prep')>()),
  resolveRedovisare: (...args: unknown[]) => mockResolveRedovisare(...args),
}))
vi.mock('../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client')>()),
  skvRequestWithAuth: (...args: unknown[]) => mockRequest(...args),
}))
vi.mock('../lib/resolve-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/resolve-auth')>()),
  resolveReadAuth: (...args: unknown[]) => mockResolveReadAuth(...args),
}))

import { skatteverketExtension } from '../index'

const ctx = {
  userId: 'user-1',
  companyId: 'company-1',
  supabase: {},
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as ExtensionContext

function route(path: string) {
  const found = testRoutes(skatteverketExtension).find((r) => r.method === 'GET' && r.path === path)
  if (!found) throw new Error(`${path} not registered`)
  return found
}

const request = (path: string, redovisare = '165566778899') =>
  new Request(`http://localhost/api/extensions/ext/skatteverket${path}?redovisare=${redovisare}&redovisningsperiod=202609`)

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveReadAuth.mockResolvedValue({ ok: true, auth: { kind: 'user' } })
  mockResolveRedovisare.mockResolvedValue('165566778899')
})

describe.each([
  ['/declaration/submitted', 'inlamnat'],
  ['/declaration/decided', 'beslutat'],
])('GET %s', (path, view) => {
  it('answers the filed view as data', async () => {
    mockRequest.mockResolvedValue(new Response(JSON.stringify({ ruta05: 1000 }), { status: 200 }))

    const res = await route(path).handler(request(path), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ data: { ruta05: 1000 } })
    expect(mockRequest).toHaveBeenCalledWith(
      { kind: 'user' },
      'GET',
      `/${view}/165566778899/202609`,
      expect.objectContaining({ endpoint: view, okStatuses: [404], expectJson: true }),
    )
  })

  it('answers data null when nothing is on file (404)', async () => {
    mockRequest.mockResolvedValue(new Response('not found', { status: 404 }))

    const res = await route(path).handler(request(path), ctx)

    await expect(res.json()).resolves.toEqual({ data: null })
  })

  it("on Accounted's certificate a URL naming another company's number is refused before Skatteverket is asked", async () => {
    mockResolveReadAuth.mockResolvedValue({ ok: true, auth: { mode: 'system' } })

    const res = await route(path).handler(request(path, '165599999999'), ctx)

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'SKV_REDOVISARE_NOT_COMPANY' } })
    expect(mockRequest).not.toHaveBeenCalled()
    expect(mockResolveRedovisare).toHaveBeenCalledWith(ctx.supabase, 'company-1')
  })

  it("the company's own number in its 10-digit or dashed form reads the 12-digit number", async () => {
    mockRequest.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }))

    for (const form of ['5566778899', '556677-8899']) {
      const res = await route(path).handler(request(path, form), ctx)
      expect(res.status).toBe(200)
    }
    for (const call of mockRequest.mock.calls) expect(call[2]).toBe(`/${view}/165566778899/202609`)
  })

  it('never forwards Skatteverket\'s own error body', async () => {
    mockRequest.mockResolvedValue(new Response('internal SKV stack trace', { status: 500 }))

    const res = await route(path).handler(request(path), ctx)
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body).toEqual({ error: 'Skatteverket svarade med 500.', code: 'SKATTEVERKET_API_ERROR' })
    expect(JSON.stringify(body)).not.toContain('stack trace')
  })
})
