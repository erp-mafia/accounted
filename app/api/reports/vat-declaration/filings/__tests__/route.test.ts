/**
 * Tests for /api/reports/vat-declaration/filings (issue #2746): the momsdeklaration
 * page's record of filed periods. The store is mocked (it has its own tests
 * in lib/vat/__tests__/filing-record-store.test.ts); what matters here is the
 * wrapper contract (401/403), the Zod contract (400) and the code-to-status
 * mapping of the store's refusals (400/404/409).
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

const store = vi.hoisted(() => ({
  listVatFilings: vi.fn(),
  markVatPeriodFiled: vi.fn(),
  unmarkVatPeriodFiled: vi.fn(),
}))
vi.mock('@/lib/vat/filing-record-store', () => store)

import { GET as getRoute, POST as postRoute, DELETE as deleteRoute } from '../route'

// A static route still receives Next's route context as its second argument.
const noParams = () => ({ params: Promise.resolve({}) })
const GET = (request: Request) => getRoute(request, noParams())
const POST = (request: Request) => postRoute(request, noParams())
const DELETE = (request: Request) => deleteRoute(request, noParams())

const RECORD = {
  deadline_id: '11111111-1111-4111-8111-111111111111',
  period_type: 'quarterly',
  year: 2026,
  period: 2,
  tax_period: '2026-Q2',
  filed_on: '2026-08-10',
  source: 'manual',
  reference: null,
}

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

const validBody = { period_type: 'quarterly', year: 2026, period: 2, filed_on: '2026-08-10' }

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/reports/vat-declaration/filings', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await GET(createMockRequest('/api/reports/vat-declaration/filings'))
    expect(res.status).toBe(401)
  })

  it('returns the filing records', async () => {
    auth()
    store.listVatFilings.mockResolvedValue([RECORD])
    const res = await GET(createMockRequest('/api/reports/vat-declaration/filings'))
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual([RECORD])
    expect(store.listVatFilings).toHaveBeenCalledWith({}, 'company-1')
  })
})

describe('POST /api/reports/vat-declaration/filings', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await POST(
      createMockRequest('/api/reports/vat-declaration/filings', { method: 'POST', body: validBody }),
    )
    expect(res.status).toBe(401)
    expect(store.markVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    auth()
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await POST(
      createMockRequest('/api/reports/vat-declaration/filings', { method: 'POST', body: validBody }),
    )
    expect(res.status).toBe(403)
    expect(store.markVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('returns 400 for a quarterly period outside 1-4', async () => {
    auth()
    const res = await POST(
      createMockRequest('/api/reports/vat-declaration/filings', {
        method: 'POST',
        body: { ...validBody, period: 7 },
      }),
    )
    expect(res.status).toBe(400)
    expect(store.markVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('returns 400 for a yearly period_type or a missing filed_on', async () => {
    auth()
    const yearly = await POST(
      createMockRequest('/api/reports/vat-declaration/filings', {
        method: 'POST',
        body: { ...validBody, period_type: 'yearly', period: 1 },
      }),
    )
    expect(yearly.status).toBe(400)
    const noDate = await POST(
      createMockRequest('/api/reports/vat-declaration/filings', {
        method: 'POST',
        body: { period_type: 'quarterly', year: 2026, period: 2 },
      }),
    )
    expect(noDate.status).toBe(400)
    expect(store.markVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('maps a store refusal to its structured error', async () => {
    auth()
    store.markVatPeriodFiled.mockResolvedValue({ ok: false, code: 'VAT_FILING_DATE_IN_FUTURE' })
    const res = await POST(
      createMockRequest('/api/reports/vat-declaration/filings', {
        method: 'POST',
        body: { ...validBody, filed_on: '2099-01-01' },
      }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VAT_FILING_DATE_IN_FUTURE')
  })

  it('records the filing and returns the record', async () => {
    auth()
    store.markVatPeriodFiled.mockResolvedValue({
      ok: true,
      record: { ...RECORD, reference: 'KV-1' },
      created: false,
      changed: true,
    })
    const res = await POST(
      createMockRequest('/api/reports/vat-declaration/filings', {
        method: 'POST',
        body: { ...validBody, reference: 'KV-1' },
      }),
    )
    const { status, body } = await parseJsonResponse<{
      data: typeof RECORD
      created: boolean
      changed: boolean
    }>(res)
    expect(status).toBe(200)
    expect(body.data.reference).toBe('KV-1')
    expect(body.created).toBe(false)
    expect(body.changed).toBe(true)
    expect(store.markVatPeriodFiled).toHaveBeenCalledWith({}, 'company-1', {
      periodType: 'quarterly',
      year: 2026,
      period: 2,
      filedOn: '2026-08-10',
      reference: 'KV-1',
      userId: 'user-1',
    })
  })
})

describe('DELETE /api/reports/vat-declaration/filings', () => {
  const url = '/api/reports/vat-declaration/filings'
  const query = { period_type: 'quarterly', year: '2026', period: '2' }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await DELETE(createMockRequest(url, { method: 'DELETE', searchParams: query }))
    expect(res.status).toBe(401)
  })

  it('returns 400 for an invalid query', async () => {
    auth()
    const res = await DELETE(
      createMockRequest(url, { method: 'DELETE', searchParams: { ...query, period: 'x' } }),
    )
    expect(res.status).toBe(400)
    expect(store.unmarkVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('returns 404 when the period has no filing record', async () => {
    auth()
    store.unmarkVatPeriodFiled.mockResolvedValue({ ok: false, code: 'VAT_FILING_NOT_FOUND' })
    const res = await DELETE(createMockRequest(url, { method: 'DELETE', searchParams: query }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(404)
    expect(body.error.code).toBe('VAT_FILING_NOT_FOUND')
  })

  it('returns 409 for a Skatteverket-confirmed period', async () => {
    auth()
    store.unmarkVatPeriodFiled.mockResolvedValue({
      ok: false,
      code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET',
    })
    const res = await DELETE(createMockRequest(url, { method: 'DELETE', searchParams: query }))
    expect(res.status).toBe(409)
  })

  it('unmarks a manual filing', async () => {
    auth()
    store.unmarkVatPeriodFiled.mockResolvedValue({ ok: true, deadline_id: RECORD.deadline_id })
    const res = await DELETE(createMockRequest(url, { method: 'DELETE', searchParams: query }))
    const { status, body } = await parseJsonResponse<{ data: { deadline_id: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.deadline_id).toBe(RECORD.deadline_id)
    expect(store.unmarkVatPeriodFiled).toHaveBeenCalledWith({}, 'company-1', {
      periodType: 'quarterly',
      year: 2026,
      period: 2,
    })
  })
})
