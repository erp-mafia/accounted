import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { AssociationRegisterError } from '@/lib/associations/errors'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/associations/member-register', () => ({
  requireMemberCapitalForm: vi.fn(),
}))
vi.mock('@/lib/associations/auditors', () => ({
  listAuditors: vi.fn(),
  appointAuditor: vi.fn(),
  updateAuditor: vi.fn(),
  buildAuditBundle: vi.fn(),
  auditBundleCsv: vi.fn(),
}))

import { requireMemberCapitalForm } from '@/lib/associations/member-register'
import {
  appointAuditor,
  auditBundleCsv,
  buildAuditBundle,
  listAuditors,
  updateAuditor,
} from '@/lib/associations/auditors'
import { GET, POST } from '../route'
import { PATCH } from '../[id]/route'
import { GET as BUNDLE } from '../../audit-bundle/route'

const routeParams = { params: Promise.resolve({}) }
const idParams = { params: Promise.resolve({ id: 'a1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  vi.mocked(requireMemberCapitalForm).mockResolvedValue(undefined)
})

describe('GET /api/associations/auditors', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/associations/auditors'), routeParams)
    expect(res.status).toBe(401)
  })

  it('refuses a company that is not an ekonomisk förening with 409', async () => {
    vi.mocked(requireMemberCapitalForm).mockRejectedValue(new AssociationRegisterError('ASSOCIATION_FORM_REQUIRED'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/associations/auditors'), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ASSOCIATION_FORM_REQUIRED')
  })

  it('lists the roster, passing include_ended through', async () => {
    vi.mocked(listAuditors).mockResolvedValue([{ id: 'a1', name: 'Revisor' } as never])
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string }> }>(
      await GET(createMockRequest('/api/associations/auditors?include_ended=true'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(listAuditors).toHaveBeenCalledWith(supabase, 'company-1', { includeEnded: true })
  })
})

describe('POST /api/associations/auditors', () => {
  const body = { name: 'Revisor Ett', kind: 'auktoriserad_revisor', appointed_on: '2026-05-20' }

  it('returns 400 for an unknown kind or a term that ends before it starts', async () => {
    const badKind = await POST(
      createMockRequest('/api/associations/auditors', { method: 'POST', body: { ...body, kind: 'granskare' } }),
      routeParams,
    )
    expect(badKind.status).toBe(400)
    const badTerm = await POST(
      createMockRequest('/api/associations/auditors', { method: 'POST', body: { ...body, term_ends_on: '2026-01-01' } }),
      routeParams,
    )
    expect(badTerm.status).toBe(400)
    expect(appointAuditor).not.toHaveBeenCalled()
  })

  it('appoints as the signed-in user and answers 201', async () => {
    vi.mocked(appointAuditor).mockResolvedValue({ id: 'a1', ...body } as never)
    const { status, body: res } = await parseJsonResponse<{ data: { id: string } }>(
      await POST(createMockRequest('/api/associations/auditors', { method: 'POST', body }), routeParams),
    )
    expect(status).toBe(201)
    expect(res.data.id).toBe('a1')
    expect(appointAuditor).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', expect.objectContaining(body))
  })

  it('refuses viewers (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await POST(createMockRequest('/api/associations/auditors', { method: 'POST', body }), routeParams)
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/associations/auditors/[id]', () => {
  it('maps an already ended assignment to 409', async () => {
    vi.mocked(updateAuditor).mockRejectedValue(new AssociationRegisterError('ASSOCIATION_AUDITOR_ALREADY_ENDED'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(
        createMockRequest('/api/associations/auditors/a1', { method: 'PATCH', body: { ended_on: '2026-06-30' } }),
        idParams,
      ),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ASSOCIATION_AUDITOR_ALREADY_ENDED')
  })

  it('returns 400 for an empty patch and ends the assignment otherwise', async () => {
    const empty = await PATCH(createMockRequest('/api/associations/auditors/a1', { method: 'PATCH', body: {} }), idParams)
    expect(empty.status).toBe(400)
    vi.mocked(updateAuditor).mockResolvedValue({ id: 'a1', ended_on: '2026-06-30' } as never)
    const { status, body } = await parseJsonResponse<{ data: { ended_on: string } }>(
      await PATCH(
        createMockRequest('/api/associations/auditors/a1', { method: 'PATCH', body: { ended_on: '2026-06-30' } }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.ended_on).toBe('2026-06-30')
    expect(updateAuditor).toHaveBeenCalledWith(supabase, 'company-1', 'a1', { ended_on: '2026-06-30' })
  })
})

describe('GET /api/associations/audit-bundle', () => {
  it('requires fiscal_period_id and answers 404 for a period of another company', async () => {
    const missing = await BUNDLE(createMockRequest('/api/associations/audit-bundle'), routeParams)
    expect(missing.status).toBe(400)
    enqueue({ data: null, error: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await BUNDLE(createMockRequest('/api/associations/audit-bundle?fiscal_period_id=p9'), routeParams),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
  })

  it('returns the bundle as JSON, and as CSV with a BOM on request', async () => {
    enqueue({ data: { id: 'p1', period_end: '2025-12-31' }, error: null })
    vi.mocked(buildAuditBundle).mockResolvedValue({ fiscal_period_id: 'p1', auditors: { all: [], active_on_period_end: [] } } as never)
    const { status, body } = await parseJsonResponse<{ data: { fiscal_period_id: string } }>(
      await BUNDLE(createMockRequest('/api/associations/audit-bundle?fiscal_period_id=p1'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data.fiscal_period_id).toBe('p1')
    expect(buildAuditBundle).toHaveBeenCalledWith(supabase, 'company-1', 'p1', '2025-12-31')

    enqueue({ data: { id: 'p1', period_end: '2025-12-31' }, error: null })
    vi.mocked(auditBundleCsv).mockReturnValue('# Revisorer\nNamn\n')
    const csv = await BUNDLE(
      createMockRequest('/api/associations/audit-bundle?fiscal_period_id=p1&format=csv'),
      routeParams,
    )
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toContain('text/csv')
    // Response.text() strips the BOM while decoding, so check the raw bytes.
    const bytes = Buffer.from(await csv.arrayBuffer())
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe('# Revisorer\nNamn\n')
  })
})
