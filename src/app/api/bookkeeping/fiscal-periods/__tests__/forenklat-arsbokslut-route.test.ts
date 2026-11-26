/**
 * Tests for GET/PATCH /api/bookkeeping/fiscal-periods/{id}/forenklat-arsbokslut
 * and GET .../forenklat-arsbokslut/pdf (cookie session, withRouteContext).
 * The service is mocked; the wrapper, the validation and the failure mapping
 * are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

// Route path ids are uuids: the route answers its 404 to anything else before it reads.
const NOPE_ID = 'de4ba771-91d4-59ed-8f99-a25a38e6dbeb'

const { supabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => supabase) }))
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
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_s: unknown, _c: unknown, _p: unknown, read: () => Promise<unknown>) => read(),
}))

const getMock = vi.fn()
const updateMock = vi.fn()
const pdfMock = vi.fn()
vi.mock('@/lib/bokslut/forenklat-arsbokslut/service', () => ({
  getForenklatArsbokslut: (...args: unknown[]) => getMock(...args),
  updateForenklatArsbokslutInputs: (...args: unknown[]) => updateMock(...args),
  getForenklatArsbokslutPdfFile: (...args: unknown[]) => pdfMock(...args),
}))

import { GET, PATCH } from '../[id]/forenklat-arsbokslut/route'
import { GET as GET_PDF } from '../[id]/forenklat-arsbokslut/pdf/route'

const PERIOD = '11111111-1111-4111-8111-111111111111'
const p = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const REPORT = { regelverk: 'BFNAR 2010:1', blockers: [], warnings: [] }
const INPUTS = { eligibility_confirmed_at: '2027-03-01T10:00:00Z', notes: null, signatories: [], updated_at: null }

describe('förenklat årsbokslut routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    getMock.mockResolvedValue({ ok: true, data: REPORT })
    updateMock.mockResolvedValue({ ok: true, data: INPUTS })
    pdfMock.mockResolvedValue({
      ok: true,
      data: { filename: 'forenklat-arsbokslut-2026-12-31.pdf', contentType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) },
    })
  })

  it('401 without a session on every door', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await GET(createMockRequest('http://localhost/x'), p(PERIOD))).status).toBe(401)
    expect(
      (await PATCH(createMockRequest('http://localhost/x', { method: 'PATCH', body: { notes: 'x' } }), p(PERIOD))).status,
    ).toBe(401)
    expect((await GET_PDF(createMockRequest('http://localhost/x'), p(PERIOD))).status).toBe(401)
    expect(getMock).not.toHaveBeenCalled()
  })

  it('GET answers the report for the active company, and maps a foreign period to 404 and a wrong form to 400', async () => {
    const res = await GET(createMockRequest('http://localhost/x'), p(PERIOD))
    expect(res.status).toBe(200)
    expect((await parseJsonResponse<{ data: typeof REPORT }>(res)).body.data).toEqual(REPORT)
    expect(getMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), PERIOD)

    getMock.mockResolvedValue({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })
    expect((await GET(createMockRequest('http://localhost/x'), p(NOPE_ID))).status).toBe(404)

    getMock.mockResolvedValue({ ok: false, code: 'FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM' })
    const wrong = await GET(createMockRequest('http://localhost/x'), p(PERIOD))
    expect(wrong.status).toBe(400)
  })

  it('PATCH validates the body and saves in the caller\'s name', async () => {
    const res = await PATCH(
      createMockRequest('http://localhost/x', {
        method: 'PATCH',
        body: { eligibility_confirmed: true, notes: 'Not 1', signatories: [{ name: 'Ledamot A', role: 'ordförande' }] },
      }),
      p(PERIOD),
    )
    expect(res.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      PERIOD,
      { eligibility_confirmed: true, notes: 'Not 1', signatories: [{ name: 'Ledamot A', role: 'ordförande' }] },
    )

    for (const body of [{}, { unknown: true }, { signatories: [{ name: '' }] }, { eligibility_confirmed: 'yes' }]) {
      const bad = await PATCH(createMockRequest('http://localhost/x', { method: 'PATCH', body }), p(PERIOD))
      expect(bad.status, JSON.stringify(body)).toBe(400)
    }
    expect(updateMock).toHaveBeenCalledTimes(1)
  })

  it('PATCH answers 404 for a foreign period and needs write permission', async () => {
    updateMock.mockResolvedValue({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })
    const missing = await PATCH(createMockRequest('http://localhost/x', { method: 'PATCH', body: { notes: 'x' } }), p(NOPE_ID))
    expect(missing.status).toBe(404)

    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Läsbehörighet' }, { status: 403 }) })
    const forbidden = await PATCH(createMockRequest('http://localhost/x', { method: 'PATCH', body: { notes: 'x' } }), p(PERIOD))
    expect(forbidden.status).toBe(403)
  })

  it('GET .../pdf streams the document, and refuses it with 422 while blockers hold', async () => {
    const res = await GET_PDF(createMockRequest('http://localhost/x'), p(PERIOD))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('forenklat-arsbokslut-2026-12-31.pdf')
    expect(res.headers.get('Cache-Control')).toContain('no-store')

    pdfMock.mockResolvedValue({ ok: false, code: 'FORENKLAT_ARSBOKSLUT_BLOCKED', details: { reason: 'Räkenskapsåret är inte stängt.' } })
    const blocked = await GET_PDF(createMockRequest('http://localhost/x'), p(PERIOD))
    expect(blocked.status).toBe(422)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(blocked)
    expect(body.error.code).toBe('FORENKLAT_ARSBOKSLUT_BLOCKED')
  })
})
