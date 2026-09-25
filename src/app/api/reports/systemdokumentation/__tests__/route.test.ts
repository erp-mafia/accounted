/**
 * Tests for GET /api/reports/systemdokumentation (cookie session,
 * withRouteContext). The generator and the PDF renderer are mocked; the
 * wrapper and the query validation are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
const serviceClient = { from: vi.fn() }
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceClient,
}))
const generateMock = vi.fn()
vi.mock('@/lib/reports/systemdokumentation', () => ({
  generateSystemdokumentation: (...args: unknown[]) => generateMock(...args),
}))
const renderMock = vi.fn()
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => renderMock(...args),
}))
vi.mock('@/lib/reports/systemdokumentation-pdf-template', () => ({
  SystemdokumentationPDF: () => null,
}))
vi.mock('@/lib/reports/behandlingshistorik', () => ({
  resolveUserLabelsFromProfiles: vi.fn().mockResolvedValue(new Map()),
}))
const recordAppReleaseMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/reports/app-releases', () => ({
  recordAppRelease: (...args: unknown[]) => recordAppReleaseMock(...args),
}))

import { GET } from '../route'

const call = (url: string) => GET(createMockRequest(url), { params: Promise.resolve({}) })

const PERIOD_ID = '11111111-1111-4111-8111-111111111111'
const REPORT = {
  generated_at: '2026-09-25T10:00:00Z',
  app_version: 'abc1234',
  company: { name: 'Väla Redovisning AB', org_number: '5592383508' },
  period: { id: PERIOD_ID, name: 'Räkenskapsår 2026', start: '2026-01-01', end: '2026-12-31', is_closed: false, locked_at: null },
}

describe('GET /api/reports/systemdokumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    generateMock.mockResolvedValue(REPORT)
    renderMock.mockResolvedValue(Buffer.from('%PDF-1.4 stub'))
  })

  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await call(`http://localhost/api/reports/systemdokumentation?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(401)
  })

  it('400s a missing or malformed period_id and an unknown format', async () => {
    expect((await call('http://localhost/api/reports/systemdokumentation')).status).toBe(400)
    expect((await call('http://localhost/api/reports/systemdokumentation?period_id=nope')).status).toBe(400)
    expect((await call(`http://localhost/api/reports/systemdokumentation?period_id=${PERIOD_ID}&format=xlsx`)).status).toBe(400)
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('returns the JSON report, private and uncached, with the service client for keys and labels', async () => {
    const res = await call(`http://localhost/api/reports/systemdokumentation?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
    const { body } = await parseJsonResponse<{ data: { period: { id: string } } }>(res)
    expect(body.data.period.id).toBe(PERIOD_ID)
    expect(generateMock).toHaveBeenCalledWith(supabase, 'company-1', PERIOD_ID, expect.objectContaining({ serviceClient, resolveUserLabels: expect.any(Function) }))
    expect(recordAppReleaseMock).toHaveBeenCalledWith(serviceClient)
  })

  it('404s when the period is not the company\'s', async () => {
    generateMock.mockResolvedValue(null)
    const res = await call(`http://localhost/api/reports/systemdokumentation?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(404)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('FISCAL_PERIOD_NOT_FOUND')
  })

  it('streams the PDF as an attachment named after the company and balansdag', async () => {
    const res = await call(`http://localhost/api/reports/systemdokumentation?period_id=${PERIOD_ID}&format=pdf`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('systemdokumentation-')
    expect(res.headers.get('Content-Disposition')).toContain('20261231.pdf')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(renderMock).toHaveBeenCalledTimes(1)
  })

  it('500s with the canonical envelope when generation throws', async () => {
    generateMock.mockRejectedValue(new Error('relation "x" does not exist'))
    const res = await call(`http://localhost/api/reports/systemdokumentation?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(500)
    const { body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(body.error.code).toBe('REPORT_GENERATION_FAILED')
    expect(body.error.message).not.toContain('relation')
  })
})
