/**
 * Tests for GET /api/reports/ink3 and GET/PUT /api/reports/ink3/inputs
 * (cookie session, withRouteContext). The services are mocked (they have
 * their own tests in lib/reports/ink3); what is under test is the wrapper
 * (401, 403), the query and body validation (400), the code-to-status
 * mapping of the services' refusals (404, 400, 422) and the JSON and PDF
 * answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

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
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}))
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_client: unknown, _company: string, _purpose: string, read: () => Promise<unknown>) => read(),
}))

const service = vi.hoisted(() => ({
  getInk3Underlag: vi.fn(),
  getInk3UnderlagInputs: vi.fn(),
  putInk3UnderlagInputs: vi.fn(),
}))
vi.mock('@/lib/reports/filing-report-service', () => ({ getInk3Underlag: service.getInk3Underlag }))
vi.mock('@/lib/reports/ink3/inputs-service', () => ({
  getInk3UnderlagInputs: service.getInk3UnderlagInputs,
  putInk3UnderlagInputs: service.putInk3UnderlagInputs,
}))
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 ink3')) }))
vi.mock('@/lib/reports/ink3/pdf-template', () => ({ Ink3UnderlagPDF: vi.fn().mockReturnValue(null) }))

import { GET } from '../route'
import { GET as getInputs, PUT as putInputs } from '../inputs/route'

const PERIOD_ID = '11111111-1111-4111-8111-111111111111'
const noParams = () => ({ params: Promise.resolve({}) })
const BASE = 'http://localhost/api/reports/ink3'

const UNDERLAG = {
  fiscalYear: { id: PERIOD_ID, name: '2026', start: '2026-01-01', end: '2026-12-31', isClosed: true },
  beskattningsperiod: '2026P4',
  fieldTable: { beskattningsperiod: '2026P4', files: ['INK3R_SKV2003-33-02-26-07.xls'] },
  companyInfo: { companyName: 'Föreningen', orgNumber: '802400-0000' },
  allmannyttig: true,
  sufApplicable: true,
  fields: [],
  filing: { '8650': 42_000 },
  accounts: [],
  totals: { totalAssets: 0, totalEquityLiabilities: 0, bookkeepingResult: 0, taxableResult: 0, taxableSurplus: 0 },
  complete: true,
  warnings: [],
}

const INPUTS = { allmannyttig: true, accountTreatments: { '3010': 'taxable' }, fieldOverrides: { '8671': 1_000 } }
const BODY = { allmannyttig: true, account_treatments: { '3010': 'taxable' }, field_overrides: { '8671': 1_000 } }

function put(body: unknown, query = `?period_id=${PERIOD_ID}`) {
  return putInputs(createMockRequest(`${BASE}/inputs${query}`, { method: 'PUT', body }), noParams())
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
  service.getInk3Underlag.mockResolvedValue({ ok: true, data: UNDERLAG })
  service.getInk3UnderlagInputs.mockResolvedValue({ ok: true, data: INPUTS })
  service.putInk3UnderlagInputs.mockResolvedValue({ ok: true, data: INPUTS })
})

describe('GET /api/reports/ink3', () => {
  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await GET(createMockRequest(`${BASE}?period_id=${PERIOD_ID}`), noParams())
    expect(res.status).toBe(401)
    expect(service.getInk3Underlag).not.toHaveBeenCalled()
  })

  it.each([[''], ['?period_id=not-a-uuid'], [`?period_id=${PERIOD_ID}&format=sru`]])('400s the query %s', async (query) => {
    const res = await GET(createMockRequest(`${BASE}${query}`), noParams())
    expect(res.status).toBe(400)
    expect(service.getInk3Underlag).not.toHaveBeenCalled()
  })

  it.each([
    ['FISCAL_PERIOD_NOT_FOUND', 404],
    ['TAX_DECL_INK3_WRONG_LEGAL_FORM', 400],
    ['TAX_DECL_INK3_PERIOD_NOT_SUPPORTED', 422],
    ['TAX_DECL_GENERATION_FAILED', 500],
  ])('answers the refusal %s with %i', async (code, status) => {
    service.getInk3Underlag.mockResolvedValue({ ok: false, code })
    const res = await GET(createMockRequest(`${BASE}?period_id=${PERIOD_ID}`), noParams())
    expect(res.status).toBe(status)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe(code)
  })

  it('returns the underlag as JSON for the company and period', async () => {
    const res = await GET(createMockRequest(`${BASE}?period_id=${PERIOD_ID}`), noParams())
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: typeof UNDERLAG }>(res)
    expect(body.data.filing).toEqual({ '8650': 42_000 })
    expect(service.getInk3Underlag).toHaveBeenCalledWith(
      expect.objectContaining({ supabase, companyId: 'company-1', userId: 'user-1' }),
      PERIOD_ID,
    )
  })

  it('returns the PDF with format=pdf', async () => {
    const res = await GET(createMockRequest(`${BASE}?period_id=${PERIOD_ID}&format=pdf`), noParams())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('ink3-underlag-2026-01-01--2026-12-31.pdf')
  })
})

describe('GET /api/reports/ink3/inputs', () => {
  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await getInputs(createMockRequest(`${BASE}/inputs?period_id=${PERIOD_ID}`), noParams())
    expect(res.status).toBe(401)
  })

  it('400s a missing period_id', async () => {
    const res = await getInputs(createMockRequest(`${BASE}/inputs`), noParams())
    expect(res.status).toBe(400)
  })

  it('404s a period that is not the company\'s', async () => {
    service.getInk3UnderlagInputs.mockResolvedValue({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })
    const res = await getInputs(createMockRequest(`${BASE}/inputs?period_id=${PERIOD_ID}`), noParams())
    expect(res.status).toBe(404)
  })

  it('returns the saved inputs', async () => {
    const res = await getInputs(createMockRequest(`${BASE}/inputs?period_id=${PERIOD_ID}`), noParams())
    const { status, body } = await parseJsonResponse<{ data: typeof INPUTS }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(INPUTS)
  })
})

describe('PUT /api/reports/ink3/inputs', () => {
  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await put(BODY)).status).toBe(401)
    expect(service.putInk3UnderlagInputs).not.toHaveBeenCalled()
  })

  it('403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await put(BODY)).status).toBe(403)
    expect(service.putInk3UnderlagInputs).not.toHaveBeenCalled()
  })

  it.each([
    ['a balance sheet account', { ...BODY, account_treatments: { '1930': 'taxable' } }],
    ['an unknown treatment', { ...BODY, account_treatments: { '3010': 'partly' } }],
    ['öre in an override', { ...BODY, field_overrides: { '8671': 10.5 } }],
    ['a missing allmannyttig', { account_treatments: {}, field_overrides: {} }],
    ['an extra key', { ...BODY, extra: 1 }],
  ])('400s %s', async (_label, body) => {
    expect((await put(body)).status).toBe(400)
    expect(service.putInk3UnderlagInputs).not.toHaveBeenCalled()
  })

  it('400s a missing period_id', async () => {
    expect((await put(BODY, '')).status).toBe(400)
  })

  it.each([
    ['FISCAL_PERIOD_NOT_FOUND', 404],
    ['TAX_DECL_INK3_WRONG_LEGAL_FORM', 400],
    ['TAX_DECL_INK3_PERIOD_NOT_SUPPORTED', 422],
    ['VALIDATION_ERROR', 400],
  ])('answers the refusal %s with %i', async (code, status) => {
    service.putInk3UnderlagInputs.mockResolvedValue({ ok: false, code, messageSv: 'Fältkod 8695 är en summa.' })
    const res = await put(BODY)
    expect(res.status).toBe(status)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe(code)
  })

  it('saves and returns the inputs', async () => {
    const res = await put(BODY)
    const { status, body } = await parseJsonResponse<{ data: typeof INPUTS }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual(INPUTS)
    expect(service.putInk3UnderlagInputs).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      PERIOD_ID,
      BODY,
    )
  })
})
