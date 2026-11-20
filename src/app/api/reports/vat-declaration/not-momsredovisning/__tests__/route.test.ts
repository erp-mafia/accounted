/**
 * Tests for /api/reports/vat-declaration/not-momsredovisning (crm#1849): a
 * person marks a verifikat the momsredovisning shapes catch as a correction,
 * and takes the mark back. The service is mocked (it has its own tests in
 * lib/vat/__tests__); what matters here is the wrapper contract (401/403),
 * the Zod contract (400), the code-to-status mapping of the service's
 * refusals (404/409) and that the route passes the session's user and company.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

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

const serviceClient = { service: true }
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => serviceClient),
}))

const service = vi.hoisted(() => ({
  listMarkedInPeriod: vi.fn(),
  markNotMomsredovisning: vi.fn(),
  withdrawNotMomsredovisning: vi.fn(),
}))
vi.mock('@/lib/vat/momsredovisning-marks', () => service)

const declaration = vi.hoisted(() => ({ resolvePeriodDates: vi.fn() }))
vi.mock('@/lib/reports/vat-declaration', () => declaration)

import { GET as getRoute, POST as postRoute, DELETE as deleteRoute } from '../route'

const noParams = () => ({ params: Promise.resolve({}) })
const GET = (request: Request) => getRoute(request, noParams())
const POST = (request: Request) => postRoute(request, noParams())
const DELETE = (request: Request) => deleteRoute(request, noParams())

const PATH = '/api/reports/vat-declaration/not-momsredovisning'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'

function auth() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
}

function unauthenticated() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase: {},
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
  declaration.resolvePeriodDates.mockResolvedValue({ start: '2026-07-01', end: '2026-09-30', source: 'calendar' })
})

describe('GET /api/reports/vat-declaration/not-momsredovisning', () => {
  const query = { period_type: 'quarterly', year: '2026', period: '3' }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await GET(createMockRequest(PATH, { searchParams: query }))
    expect(res.status).toBe(401)
    expect(service.listMarkedInPeriod).not.toHaveBeenCalled()
  })

  it('returns 400 without a period', async () => {
    auth()
    const res = await GET(createMockRequest(PATH, { searchParams: { year: '2026' } }))
    expect(res.status).toBe(400)
    expect(service.listMarkedInPeriod).not.toHaveBeenCalled()
  })

  it('lists the period\'s marked verifikat', async () => {
    auth()
    const data = [{ journal_entry_id: ENTRY_ID, voucher_series: 'A', voucher_number: 158, entry_date: '2026-09-30' }]
    service.listMarkedInPeriod.mockResolvedValue(data)
    const res = await GET(createMockRequest(PATH, { searchParams: query }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(data)
    expect(service.listMarkedInPeriod).toHaveBeenCalledWith(expect.anything(), 'company-1', { start: '2026-07-01', end: '2026-09-30' })
  })
})

describe('POST /api/reports/vat-declaration/not-momsredovisning', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await POST(createMockRequest(PATH, { method: 'POST', body: { journal_entry_id: ENTRY_ID } }))
    expect(res.status).toBe(401)
    expect(service.markNotMomsredovisning).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    auth()
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    const res = await POST(createMockRequest(PATH, { method: 'POST', body: { journal_entry_id: ENTRY_ID } }))
    expect(res.status).toBe(403)
    expect(service.markNotMomsredovisning).not.toHaveBeenCalled()
  })

  it('returns 400 without a valid journal entry id', async () => {
    auth()
    for (const body of [{}, { journal_entry_id: 'A158' }]) {
      const res = await POST(createMockRequest(PATH, { method: 'POST', body }))
      expect(res.status).toBe(400)
    }
    expect(service.markNotMomsredovisning).not.toHaveBeenCalled()
  })

  it('answers 404 for a verifikat the company does not have', async () => {
    auth()
    service.markNotMomsredovisning.mockResolvedValue({ ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' })
    const res = await POST(createMockRequest(PATH, { method: 'POST', body: { journal_entry_id: ENTRY_ID } }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(404)
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })

  it('answers 409 for the app\'s own momsredovisning, a locked period and a filed period', async () => {
    auth()
    for (const code of ['VAT_MARK_TAGGED_SETTLEMENT', 'VAT_MARK_STORNO', 'VAT_MARK_PERIOD_LOCKED', 'VAT_MARK_PERIOD_FILED', 'VAT_MARK_NOT_POSTED']) {
      service.markNotMomsredovisning.mockResolvedValueOnce({ ok: false, code })
      const res = await POST(createMockRequest(PATH, { method: 'POST', body: { journal_entry_id: ENTRY_ID } }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
      expect(status).toBe(409)
      expect(body.error.code).toBe(code)
    }
  })

  it('marks the verifikat for the session\'s user and company', async () => {
    auth()
    const data = { journal_entry_id: ENTRY_ID, marked: true, changed: true }
    service.markNotMomsredovisning.mockResolvedValue({ ok: true, data })
    const res = await POST(createMockRequest(PATH, { method: 'POST', body: { journal_entry_id: ENTRY_ID } }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(data)
    // The session reads and checks; the service-role client records the mark.
    expect(service.markNotMomsredovisning).toHaveBeenCalledWith(expect.anything(), serviceClient, 'company-1', 'user-1', ENTRY_ID)
  })
})

describe('DELETE /api/reports/vat-declaration/not-momsredovisning', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await DELETE(createMockRequest(PATH, { method: 'DELETE', searchParams: { journal_entry_id: ENTRY_ID } }))
    expect(res.status).toBe(401)
  })

  it('returns 400 without a journal entry id', async () => {
    auth()
    const res = await DELETE(createMockRequest(PATH, { method: 'DELETE' }))
    expect(res.status).toBe(400)
    expect(service.withdrawNotMomsredovisning).not.toHaveBeenCalled()
  })

  it('answers 404 when the verifikat carries no mark', async () => {
    auth()
    service.withdrawNotMomsredovisning.mockResolvedValue({ ok: false, code: 'VAT_MARK_NOT_FOUND' })
    const res = await DELETE(createMockRequest(PATH, { method: 'DELETE', searchParams: { journal_entry_id: ENTRY_ID } }))
    expect(res.status).toBe(404)
  })

  it('takes the mark back', async () => {
    auth()
    const data = { journal_entry_id: ENTRY_ID, marked: false, changed: true }
    service.withdrawNotMomsredovisning.mockResolvedValue({ ok: true, data })
    const res = await DELETE(createMockRequest(PATH, { method: 'DELETE', searchParams: { journal_entry_id: ENTRY_ID } }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(data)
    expect(service.withdrawNotMomsredovisning).toHaveBeenCalledWith(expect.anything(), serviceClient, 'company-1', 'user-1', ENTRY_ID)
  })
})
