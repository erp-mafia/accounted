/**
 * The Likviditetsprognos page's session routes: GET /api/reports/cash-forecast
 * (the projection plus the open rows dated before today), POST .../rows (a
 * person's row) and POST .../rows/:id/cancel. The projection is the engine's
 * and is tested there (lib/forecast); here the doors: a session, the input,
 * the not-found answer, and what reaches the table.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, findCall, findCalls, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const engine = vi.hoisted(() => ({ buildCashForecast: vi.fn() }))
vi.mock('@/lib/forecast/build', async (orig) => ({ ...(await orig<object>()), buildCashForecast: engine.buildCashForecast }))

import { requireWritePermission } from '@/lib/auth/require-write'
import { GET as getForecast } from '../route'
import { POST as addRow } from '../rows/route'
import { POST as cancelRow } from '../rows/[id]/cancel/route'

const ROW = '7b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
const noParams = { params: Promise.resolve({}) }
const idParams = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (url: string, body?: unknown) => createMockRequest(url, { method: 'POST', ...(body === undefined ? {} : { body }) })

type ErrorBody = { error: { code: string } }

function record(over: Record<string, unknown> = {}) {
  return {
    id: ROW,
    expected_date: '2026-11-20',
    amount: '48000.00',
    direction: 'in',
    currency: 'SEK',
    category: 'revenue',
    source: 'manual',
    external_source: null,
    external_id: null,
    confidence: 'likely',
    dimension_value_id: null,
    invoice_id: null,
    supplier_invoice_id: null,
    status: 'open',
    matched_transaction_id: null,
    note: 'Bokning vecka 47',
    created_at: '2026-10-29T09:00:00Z',
    updated_at: '2026-10-29T09:00:00Z',
    ...over,
  }
}

const forecast = {
  currency: 'SEK',
  today: '2026-10-29',
  horizon: { start: '2026-10-29', end: '2027-01-24', weeks: 13 },
  opening: { amount: 412500, source: 'bank', as_of: '2026-10-29T05:02:11Z', age_days: 0, accounts: [] },
  days: [],
  weeks: [],
  lowest: { date: '2026-10-29', closing: 412500, iso_week: '2026-W44' },
  closing: 412500,
  flows: [],
  overdue: { receivables: { total: 0, invoices: [] }, payables: { total: 0, invoices: [] } },
  complete: true,
  caveats: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  engine.buildCashForecast.mockResolvedValue(forecast)
})

describe('a session is required', () => {
  it.each([
    ['GET /cash-forecast', () => getForecast(createMockRequest('/api/reports/cash-forecast'), noParams)],
    ['POST /rows', () => addRow(post('/api/reports/cash-forecast/rows', {}), noParams)],
    ['POST /rows/:id/cancel', () => cancelRow(post(`/api/reports/cash-forecast/rows/${ROW}/cancel`), idParams(ROW))],
  ])('%s answers 401', async (_name, call) => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await call()).status).toBe(401)
    expect(engine.buildCashForecast).not.toHaveBeenCalled()
  })
})

describe('GET /api/reports/cash-forecast', () => {
  it('answers the projection and the open unlinked rows dated before today', async () => {
    enqueue({
      data: [
        record({ id: 'a0000000-0000-4000-8000-000000000001', expected_date: '2026-10-20' }),
        record({ id: 'a0000000-0000-4000-8000-000000000002', expected_date: '2026-10-21', invoice_id: 'b0000000-0000-4000-8000-000000000001' }),
      ],
      count: 2,
    })

    const res = await getForecast(createMockRequest('/api/reports/cash-forecast?weeks=8'), noParams)
    const { status, body } = await parseJsonResponse<{ data: { forecast: typeof forecast; past_rows: Array<{ cash_forecast_row_id: string; amount: number }> } }>(res)

    expect(status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(engine.buildCashForecast).toHaveBeenCalledWith(mockSupabase, 'company-1', { weeks: 8 })
    expect(body.data.forecast).toEqual(forecast)
    // A row pointing at an invoice yields to it: not offered for cancelling.
    expect(body.data.past_rows).toEqual([expect.objectContaining({ cash_forecast_row_id: 'a0000000-0000-4000-8000-000000000001', amount: 48000 })])
    expect(findCalls('cash_forecast_rows', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['status', 'open'],
    ])
    expect(findCall('cash_forecast_rows', 'lte')).toEqual(['expected_date', '2026-10-28'])
  })

  it('answers 400 for a horizon outside 1 to 26 weeks', async () => {
    const res = await getForecast(createMockRequest('/api/reports/cash-forecast?weeks=27'), noParams)
    expect(res.status).toBe(400)
    expect(engine.buildCashForecast).not.toHaveBeenCalled()
  })

  it('answers CASH_FORECAST_FAILED when the projection throws', async () => {
    engine.buildCashForecast.mockRejectedValue(new Error('opening balance read failed'))
    const { status, body } = await parseJsonResponse<ErrorBody>(await getForecast(createMockRequest('/api/reports/cash-forecast'), noParams))
    expect(status).toBe(500)
    expect(body.error.code).toBe('CASH_FORECAST_FAILED')
  })
})

describe('POST /api/reports/cash-forecast/rows', () => {
  const valid = { expected_date: '2026-11-20', amount: 48000, direction: 'in', category: 'revenue', confidence: 'likely', note: 'Bokning vecka 47' }

  it('adds a manual row without an outside key and answers 201', async () => {
    enqueue({ data: record() })

    const res = await addRow(post('/api/reports/cash-forecast/rows', valid), noParams)
    const { status, body } = await parseJsonResponse<{ data: { row: { cash_forecast_row_id: string; amount: number; source: string } } }>(res)

    expect(status).toBe(201)
    expect(body.data.row).toMatchObject({ cash_forecast_row_id: ROW, amount: 48000, source: 'manual' })
    expect(findCall('cash_forecast_rows', 'insert')).toEqual([
      {
        company_id: 'company-1',
        expected_date: '2026-11-20',
        amount: 48000,
        direction: 'in',
        category: 'revenue',
        confidence: 'likely',
        note: 'Bokning vecka 47',
        source: 'manual',
        created_by: 'user-1',
      },
    ])
  })

  it('rounds the amount to the öre and stores an empty note as none', async () => {
    enqueue({ data: record() })
    await addRow(post('/api/reports/cash-forecast/rows', { ...valid, amount: 100.005, note: '   ', confidence: undefined }), noParams)
    expect(findCall('cash_forecast_rows', 'insert')?.[0]).toMatchObject({ amount: 100.01, note: null, confidence: 'likely' })
  })

  it.each([
    ['a zero amount', { ...valid, amount: 0 }],
    ['a negative amount', { ...valid, amount: -5 }],
    ['an unknown direction', { ...valid, direction: 'sideways' }],
    ['an unknown category', { ...valid, category: 'snacks' }],
    ['a date that is not a date', { ...valid, expected_date: '20 november' }],
  ])('answers 400 for %s and writes nothing', async (_name, body) => {
    const res = await addRow(post('/api/reports/cash-forecast/rows', body), noParams)
    expect(res.status).toBe(400)
    expect(findCall('cash_forecast_rows', 'insert')).toBeUndefined()
  })

  it('maps a refused write to the canonical envelope', async () => {
    enqueue({ error: { code: '42501', message: 'new row violates row-level security policy' } })
    const { status, body } = await parseJsonResponse<ErrorBody>(await addRow(post('/api/reports/cash-forecast/rows', valid), noParams))
    expect(status).toBe(500)
    expect(body.error.code).toBe('CASH_FORECAST_ROWS_WRITE_FAILED')
  })

  it('is refused for a member who may not write', async () => {
    const { NextResponse } = await import('next/server')
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: false, response: NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }) } as never)
    const res = await addRow(post('/api/reports/cash-forecast/rows', valid), noParams)
    expect(res.status).toBe(403)
    expect(findCall('cash_forecast_rows', 'insert')).toBeUndefined()
  })
})

describe('POST /api/reports/cash-forecast/rows/:id/cancel', () => {
  it('cancels an open row and answers it', async () => {
    enqueue({ data: record() }) // the row
    enqueue({ data: record({ status: 'cancelled' }) }) // the compare-and-set update

    const res = await cancelRow(post(`/api/reports/cash-forecast/rows/${ROW}/cancel`), idParams(ROW))
    const { status, body } = await parseJsonResponse<{ data: { row: { status: string } } }>(res)

    expect(status).toBe(200)
    expect(body.data.row.status).toBe('cancelled')
    expect(findCall('cash_forecast_rows', 'update')).toEqual([{ status: 'cancelled' }])
    expect(findCalls('cash_forecast_rows', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('answers 404 for an id that is not a uuid, without reading', async () => {
    const { status, body } = await parseJsonResponse<ErrorBody>(await cancelRow(post('/api/reports/cash-forecast/rows/nope/cancel'), idParams('nope')))
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_FORECAST_ROW_NOT_FOUND')
    expect(findCall('cash_forecast_rows', 'select')).toBeUndefined()
  })

  it('answers 404 for a row the company does not have', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<ErrorBody>(await cancelRow(post(`/api/reports/cash-forecast/rows/${ROW}/cancel`), idParams(ROW)))
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_FORECAST_ROW_NOT_FOUND')
  })

  it('answers 409 for a row a bank transaction realised', async () => {
    enqueue({ data: record({ status: 'realised', matched_transaction_id: 'c0000000-0000-4000-8000-000000000001' }) })
    const { status, body } = await parseJsonResponse<ErrorBody>(await cancelRow(post(`/api/reports/cash-forecast/rows/${ROW}/cancel`), idParams(ROW)))
    expect(status).toBe(409)
    expect(body.error.code).toBe('CASH_FORECAST_ROW_NOT_OPEN')
    expect(findCall('cash_forecast_rows', 'update')).toBeUndefined()
  })
})
