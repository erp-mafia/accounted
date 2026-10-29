import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bokslut/stock-count/register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/stock-count/register')>()),
  updateStockCount: vi.fn(),
  deleteStockCount: vi.fn(),
}))
vi.mock('@/lib/bokslut/stock-count/signing', () => ({
  getStockCount: vi.fn(),
  signStockCountManually: vi.fn(),
  requestStockCountBankIdSignature: vi.fn(),
  renderStockCountPdfFor: vi.fn(),
}))
vi.mock('@/lib/bokslut/stock-count/booking', () => ({ previewStockCountBooking: vi.fn(), bookStockCount: vi.fn() }))

import { requireAuth } from '@/lib/auth/require-auth'
import { deleteStockCount, updateStockCount } from '@/lib/bokslut/stock-count/register'
import { getStockCount, requestStockCountBankIdSignature, signStockCountManually } from '@/lib/bokslut/stock-count/signing'
import { bookStockCount, previewStockCountBooking } from '@/lib/bokslut/stock-count/booking'
import { StockCountError } from '@/lib/bokslut/stock-count/errors'
import { DELETE, GET, PUT } from '../route'
import { POST as SIGN } from '../sign/route'
import { POST as BANKID } from '../bankid/route'
import { POST as BOOK } from '../book/route'

const supabase = {}
const params = { params: Promise.resolve({ id: 'count-1' }) } as never
const PERIOD_ID = '3f6c2a1e-8b4d-4c2e-9a71-5d0e6b7c8a90'
const URL = '/api/bookkeeping/inventory-counts/count-1'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const unauthenticated = () =>
  vi.mocked(requireAuth).mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  } as never)

function signForm(fields: Record<string, string>): Request {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return new Request(`http://localhost${URL}/sign`, { method: 'POST', body: form })
}

describe('GET /api/bookkeeping/inventory-counts/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await GET(createMockRequest(URL), params)).status).toBe(401)
  })

  it('returns 404 for a count that is not the company\'s', async () => {
    vi.mocked(getStockCount).mockRejectedValue(new StockCountError('STOCK_COUNT_NOT_FOUND'))
    const res = await GET(createMockRequest(URL), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('STOCK_COUNT_NOT_FOUND')
  })

  it('answers a signed count with the booking it would make', async () => {
    vi.mocked(getStockCount).mockResolvedValue({ id: 'count-1', status: 'signed' } as never)
    vi.mocked(previewStockCountBooking).mockResolvedValue({ adjustments: [{ adjustment: 200 }] } as never)
    const res = await GET(createMockRequest(URL), params)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.booking.adjustments[0].adjustment).toBe(200)
  })

  it('answers a draft without a booking', async () => {
    vi.mocked(getStockCount).mockResolvedValue({ id: 'count-1', status: 'draft' } as never)
    const { data } = await (await GET(createMockRequest(URL), params)).json()
    expect(data.booking).toBeNull()
    expect(previewStockCountBooking).not.toHaveBeenCalled()
  })
})

describe('PUT and DELETE /api/bookkeeping/inventory-counts/[id]', () => {
  const body = { fiscal_period_id: PERIOD_ID, count_date: '2026-12-31', rows: [] }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await PUT(createMockRequest(URL, { method: 'PUT', body }), params)).status).toBe(401)
    expect((await DELETE(createMockRequest(URL, { method: 'DELETE' }), params)).status).toBe(401)
  })

  it('returns 400 for a body without rows', async () => {
    expect((await PUT(createMockRequest(URL, { method: 'PUT', body: { fiscal_period_id: PERIOD_ID } }), params)).status).toBe(400)
    expect(updateStockCount).not.toHaveBeenCalled()
  })

  it('returns 409 for a signed count', async () => {
    vi.mocked(updateStockCount).mockRejectedValue(new StockCountError('STOCK_COUNT_LOCKED'))
    const res = await PUT(createMockRequest(URL, { method: 'PUT', body }), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('STOCK_COUNT_LOCKED')
  })

  it('changes and deletes a draft', async () => {
    vi.mocked(updateStockCount).mockResolvedValue({ id: 'count-1' } as never)
    expect((await PUT(createMockRequest(URL, { method: 'PUT', body }), params)).status).toBe(200)
    vi.mocked(deleteStockCount).mockResolvedValue()
    const res = await DELETE(createMockRequest(URL, { method: 'DELETE' }), params)
    expect(res.status).toBe(200)
    expect(deleteStockCount).toHaveBeenCalledWith(supabase, 'company-1', 'count-1')
  })
})

describe('POST /api/bookkeeping/inventory-counts/[id]/sign', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await SIGN(signForm({ signer_name: 'Anna', signed_on: '2027-01-03' }), params)).status).toBe(401)
  })

  it('returns 400 without a name or with a malformed day', async () => {
    expect((await SIGN(signForm({ signed_on: '2027-01-03' }), params)).status).toBe(400)
    expect((await SIGN(signForm({ signer_name: 'Anna', signed_on: '3 jan' }), params)).status).toBe(400)
    expect(signStockCountManually).not.toHaveBeenCalled()
  })

  it('signs by hand', async () => {
    vi.mocked(signStockCountManually).mockResolvedValue({ id: 'count-1', status: 'signed' } as never)
    const res = await SIGN(signForm({ signer_name: 'Anna Svensson', signed_on: '2027-01-03' }), params)
    expect(res.status).toBe(200)
    expect(signStockCountManually).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'count-1', {
      signerName: 'Anna Svensson',
      signedOn: '2027-01-03',
      file: null,
    })
  })
})

describe('POST /api/bookkeeping/inventory-counts/[id]/bankid', () => {
  it('returns 400 without a signer name', async () => {
    expect((await BANKID(createMockRequest(`${URL}/bankid`, { method: 'POST', body: {} }), params)).status).toBe(400)
  })

  it('passes the signing refusal through', async () => {
    vi.mocked(requestStockCountBankIdSignature).mockResolvedValue({ ok: false, code: 'SIGNING_UNAVAILABLE' })
    const res = await BANKID(createMockRequest(`${URL}/bankid`, { method: 'POST', body: { signer_name: 'Anna' } }), params)
    expect((await res.json()).error.code).toBe('SIGNING_UNAVAILABLE')
  })

  it('answers the created request', async () => {
    vi.mocked(requestStockCountBankIdSignature).mockResolvedValue({
      ok: true,
      data: { signing_request_id: 'sr-1', signers: [{ url: 'https://app/signera/x' }] },
    } as never)
    const res = await BANKID(createMockRequest(`${URL}/bankid`, { method: 'POST', body: { signer_name: 'Anna' } }), params)
    expect(res.status).toBe(201)
    expect((await res.json()).data.signing_request_id).toBe('sr-1')
  })
})

describe('POST /api/bookkeeping/inventory-counts/[id]/book', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await BOOK(createMockRequest(`${URL}/book`, { method: 'POST' }), params)).status).toBe(401)
  })

  it('returns 409 for an unsigned count', async () => {
    vi.mocked(bookStockCount).mockRejectedValue(new StockCountError('STOCK_COUNT_NOT_SIGNED'))
    const res = await BOOK(createMockRequest(`${URL}/book`, { method: 'POST' }), params)
    expect(res.status).toBe(409)
  })

  it('books and answers the verifikat', async () => {
    vi.mocked(bookStockCount).mockResolvedValue({
      count: { id: 'count-1', status: 'booked' },
      entry: { id: 'je-1', voucher_series: 'A', voucher_number: 42 },
      preview: { adjustments: [] },
    } as never)
    const res = await BOOK(createMockRequest(`${URL}/book`, { method: 'POST' }), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ journal_entry_id: 'je-1', voucher_series: 'A', voucher_number: 42 })
  })
})
