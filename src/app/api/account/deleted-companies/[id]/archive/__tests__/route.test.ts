import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() }),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const serviceClient = { marker: 'service' }
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceClient,
}))

const authorizeMock = vi.fn()
vi.mock('@/lib/company/deleted-company-export', () => ({
  authorizeDeletedCompanyExport: (...args: unknown[]) => authorizeMock(...args),
}))

vi.mock('@/lib/reports/full-archive-export', () => ({
  streamFullArchive: vi.fn(),
  estimateArchiveSize: vi.fn(),
}))

import { streamFullArchive, estimateArchiveSize } from '@/lib/reports/full-archive-export'
import { GET } from '../route'

const mockStream = vi.mocked(streamFullArchive)
const mockEstimate = vi.mocked(estimateArchiveSize)

const COMPANY = '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69'
const url = (query = '') => `/api/account/deleted-companies/${COMPANY}/archive${query}`
const call = (id = COMPANY, query = '') =>
  GET(createMockRequest(url(query)), { params: Promise.resolve({ id }) })

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part)
}

const OPEN = {
  ok: true,
  company: { id: COMPANY, name: 'Acme AB', archivedAt: '2026-11-02T10:00:00Z', exportUntil: '2028-05-02' },
}

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
  authorizeMock.mockResolvedValue(OPEN)
})

describe('GET /api/account/deleted-companies/[id]/archive', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await call())
    expect(status).toBe(401)
    expect(authorizeMock).not.toHaveBeenCalled()
  })

  it('returns 404 for an id that is not a uuid, without a lookup', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call('not-a-uuid'))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(authorizeMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the person may not export this company', async () => {
    authorizeMock.mockResolvedValue({ ok: false, reason: 'not_found' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('returns 410 once the 18-month window has closed', async () => {
    authorizeMock.mockResolvedValue({ ok: false, reason: 'window_closed', exportUntil: '2028-05-02' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(410)
    expect(body.error.code).toBe('DELETED_COMPANY_EXPORT_CLOSED')
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('returns 500 when the access check fails', async () => {
    authorizeMock.mockRejectedValue(new Error('database unavailable'))
    const { status } = await parseJsonResponse(await call())
    expect(status).toBe(500)
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('checks access for the signed-in user and the path id', async () => {
    mockStream.mockReturnValue(chunks('PK'))
    await call()
    expect(authorizeMock).toHaveBeenCalledWith(serviceClient, 'user-1', COMPANY)
  })

  it('answers the size estimate with ?estimate=1', async () => {
    mockEstimate.mockResolvedValue({ estimatedBytes: 1234 } as never)
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await call(COMPANY, '?estimate=1'))
    expect(status).toBe(200)
    expect(body.data).toEqual({ estimatedBytes: 1234 })
    expect(mockEstimate).toHaveBeenCalledWith(serviceClient, COMPANY, 'all')
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('streams the full archive of the deleted company with documents', async () => {
    mockStream.mockReturnValue(chunks('PK', '-zip-'))

    const response = await call()

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Content-Disposition')).toMatch(
      new RegExp(`arkiv_raderat_${COMPANY}_\\d{8}\\.zip`),
    )
    expect(await response.text()).toBe('PK-zip-')
    expect(mockStream).toHaveBeenCalledWith(serviceClient, COMPANY, { scope: 'all', include_documents: true })
  })
})
