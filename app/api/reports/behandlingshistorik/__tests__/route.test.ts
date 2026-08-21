import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

// withRouteContext handlers take (request, routeContext); this route has no dynamic params.
const routeCtx = createMockRouteParams({})
const call = (url: string) => GET(createMockRequest(url), routeCtx)

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const serviceFrom = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: serviceFrom }),
}))

vi.mock('@/lib/reports/behandlingshistorik', () => ({
  generateBehandlingshistorik: vi.fn(),
  buildBehandlingshistorikExport: vi.fn(),
  resolveUserLabelsFromProfiles: vi.fn().mockResolvedValue(new Map()),
}))

import {
  generateBehandlingshistorik,
  buildBehandlingshistorikExport,
  resolveUserLabelsFromProfiles,
} from '@/lib/reports/behandlingshistorik'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateBehandlingshistorik)
const mockExport = vi.mocked(buildBehandlingshistorikExport)
const mockResolve = vi.mocked(resolveUserLabelsFromProfiles)

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

const sampleReport = {
  company: { name: 'Testbolaget AB', org_number: '556000-0001' },
  period: { id: 'period-1', name: 'RÅ 2026', start: '2026-01-01', end: '2026-12-31' },
  range: { from: '2026-01-01', to: '2026-12-31' },
  mode: 'fiscal_year' as const,
  generated_at: '2026-08-21T12:00:00.000Z',
  app_version: 'abc1234',
  total_events: 1,
  by_category: { verifikation: 1, kontoplan: 0, installningar: 0, period: 0, import: 0, atkomst: 0, ovrigt: 0 },
  events: [
    {
      id: 'entry:1',
      occurred_at: '2026-03-10T09:30:00.000Z',
      category: 'verifikation' as const,
      code: 'journal_entry.committed',
      event: 'Verifikation bokförd',
      object: 'A12',
      actor: { type: 'user' as const, user_id: 'user-1', label: 'anna@example.se' },
      details: ['Datum: 2026-03-09'],
      source: 'journal_entries' as const,
      count: 1,
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  authed()
})

describe('GET /api/reports/behandlingshistorik', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const res = await call('/api/reports/behandlingshistorik?period_id=period-1')
    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await call('/api/reports/behandlingshistorik')
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 on an unknown format', async () => {
    const res = await call('/api/reports/behandlingshistorik?period_id=period-1&format=pdf')
    expect(res.status).toBe(400)
  })

  it('returns 404 when the period does not belong to the company', async () => {
    mockGenerate.mockResolvedValue(null)
    const res = await call('/api/reports/behandlingshistorik?period_id=nope')
    expect(res.status).toBe(404)
  })

  it('returns 400 when the date sub-range falls outside the period', async () => {
    enqueue({ data: { period_start: '2026-01-01', period_end: '2026-12-31' } })
    const res = await call(
      '/api/reports/behandlingshistorik?period_id=period-1&from_date=2025-06-01&to_date=2026-02-01',
    )
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 404 for a sub-range on an unknown period', async () => {
    enqueue({ data: null })
    const res = await call(
      '/api/reports/behandlingshistorik?period_id=nope&from_date=2026-02-01',
    )
    expect(res.status).toBe(404)
  })

  it('returns the report as JSON and resolves actor labels through the service client', async () => {
    mockGenerate.mockResolvedValue(sampleReport)
    const res = await call(
      '/api/reports/behandlingshistorik?period_id=period-1&category=verifikation',
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await res.json()
    expect(body.data.total_events).toBe(1)
    expect(body.data.events[0].object).toBe('A12')

    expect(mockGenerate).toHaveBeenCalledTimes(1)
    const [, companyId, params, options] = mockGenerate.mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(params).toEqual({ periodId: 'period-1', fromDate: undefined, toDate: undefined, categories: ['verifikation'] })
    // The injected resolver goes through resolveUserLabelsFromProfiles with the service client.
    await options!.resolveUserLabels!(['user-1'])
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ from: serviceFrom }), ['user-1'])
  })

  it('passes a validated sub-range through to the generator', async () => {
    enqueue({ data: { period_start: '2026-01-01', period_end: '2026-12-31' } })
    mockGenerate.mockResolvedValue({ ...sampleReport, mode: 'date_range', range: { from: '2026-03-01', to: '2026-03-31' } })
    const res = await call(
      '/api/reports/behandlingshistorik?period_id=period-1&from_date=2026-03-01&to_date=2026-03-31',
    )
    expect(res.status).toBe(200)
    const [, , params] = mockGenerate.mock.calls[0]
    expect(params).toMatchObject({ periodId: 'period-1', fromDate: '2026-03-01', toDate: '2026-03-31' })
  })

  it('streams CSV with an attachment filename', async () => {
    mockGenerate.mockResolvedValue(sampleReport)
    mockExport.mockReturnValue({
      buffer: Buffer.from('﻿Tidpunkt,Kategori\n', 'utf-8'),
      contentType: 'text/csv; charset=utf-8',
      filename: 'behandlingshistorik-testbolaget-ab-20261231.csv',
    })
    const res = await call('/api/reports/behandlingshistorik?period_id=period-1&format=csv')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(res.headers.get('Content-Disposition')).toContain('behandlingshistorik-testbolaget-ab-20261231.csv')
    expect(mockExport).toHaveBeenCalledWith(sampleReport, 'csv')
    const text = await res.text()
    expect(text).toContain('Tidpunkt,Kategori')
  })

  it('maps generator failures to the report error envelope', async () => {
    mockGenerate.mockRejectedValue(new Error('relation audit_log does not exist'))
    const res = await call('/api/reports/behandlingshistorik?period_id=period-1')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('REPORT_GENERATION_FAILED')
    expect(JSON.stringify(body)).not.toContain('audit_log')
  })
})
