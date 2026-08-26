/**
 * Tests for GET /api/reports/bokslutsbilagor (cookie session, withRouteContext).
 * The generator and the PDF renderer are mocked; the wrapper and the query
 * validation are real.
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
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}))
const generateMock = vi.fn()
vi.mock('@/lib/reports/bokslutsbilagor', () => ({
  generateBokslutsbilagor: (...args: unknown[]) => generateMock(...args),
}))
const renderMock = vi.fn()
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => renderMock(...args),
}))
vi.mock('@/lib/reports/bokslutsbilagor-pdf-template', () => ({
  BokslutsbilagorPDF: () => null,
}))
vi.mock('@/lib/reports/behandlingshistorik', () => ({
  resolveUserLabelsFromProfiles: vi.fn().mockResolvedValue(new Map()),
}))

import { GET } from '../route'

const PERIOD_ID = '11111111-1111-4111-8111-111111111111'
const REPORT = {
  company: { name: 'Väla Redovisning AB', org_number: '5592383508' },
  period: { id: PERIOD_ID, name: 'Räkenskapsår 2026', start: '2026-01-01', end: '2026-12-31' },
  generated_at: '2027-01-15T10:00:00Z',
  app_version: null,
  checklist: { items: [], summary: { total: 0, done: 0, not_applicable: 0, open: 0 } },
  accounts: [],
  summary: { accounts: 0, signed_on_balansdag: 0, signed_other_date: 0, unsigned: 0, attachments: 0 },
}

describe('GET /api/reports/bokslutsbilagor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    generateMock.mockResolvedValue(REPORT)
    renderMock.mockResolvedValue(Buffer.from('%PDF-1.4 stub'))
  })

  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await GET(createMockRequest(`http://localhost/api/reports/bokslutsbilagor?period_id=${PERIOD_ID}`))
    expect(res.status).toBe(401)
  })

  it('400s a missing or malformed period_id and an unknown format', async () => {
    expect((await GET(createMockRequest('http://localhost/api/reports/bokslutsbilagor'))).status).toBe(400)
    expect((await GET(createMockRequest('http://localhost/api/reports/bokslutsbilagor?period_id=nope'))).status).toBe(400)
    expect((await GET(createMockRequest(`http://localhost/api/reports/bokslutsbilagor?period_id=${PERIOD_ID}&format=xlsx`))).status).toBe(400)
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('returns the JSON report for the user, private and uncached', async () => {
    const res = await GET(createMockRequest(`http://localhost/api/reports/bokslutsbilagor?period_id=${PERIOD_ID}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
    const { body } = await parseJsonResponse<{ data: { period: { id: string } } }>(res)
    expect(body.data.period.id).toBe(PERIOD_ID)
    expect(generateMock).toHaveBeenCalledWith(supabase, 'company-1', PERIOD_ID, expect.objectContaining({ userId: 'user-1' }))
  })

  it('renders the PDF with a dated filename', async () => {
    const res = await GET(createMockRequest(`http://localhost/api/reports/bokslutsbilagor?period_id=${PERIOD_ID}&format=pdf`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toMatch(/bokslutsbilagor-.*-20261231\.pdf/)
    expect(renderMock).toHaveBeenCalledTimes(1)
  })

  it('404s an unknown period and 500s a generator failure without leaking the message', async () => {
    generateMock.mockResolvedValue(null)
    expect((await GET(createMockRequest(`http://localhost/api/reports/bokslutsbilagor?period_id=${PERIOD_ID}`))).status).toBe(404)
    generateMock.mockRejectedValue(new Error('relation account_reconciliations does not exist'))
    const failed = await GET(createMockRequest(`http://localhost/api/reports/bokslutsbilagor?period_id=${PERIOD_ID}`))
    expect(failed.status).toBe(500)
    expect(JSON.stringify(await parseJsonResponse(failed))).not.toMatch(/relation/)
  })
})
