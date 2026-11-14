/**
 * GET /api/bookkeeping/fiscal-periods/[id]/bokslut-readiness: a period the
 * active company does not have (a tab left open after switching company, a
 * period removed since) is a 404 with the Swedish message and nothing at
 * error level; only a real aggregation failure is logged as one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'
import { codedRefusal } from '@/lib/errors/refusal'

const log = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  logger.child.mockReturnValue(logger)
  return logger
})
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  createLogger: () => log,
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const buildReportMock = vi.fn()
vi.mock('@/lib/bokslut/readiness-aggregator', () => ({
  buildBokslutReadinessReport: (...args: unknown[]) => buildReportMock(...args),
}))

import { GET } from '../route'

const params = createMockRouteParams({ id: 'period-1' })
const request = () => createMockRequest('/api/bookkeeping/fiscal-periods/period-1/bokslut-readiness')

beforeEach(() => {
  vi.clearAllMocks()
  log.child.mockReturnValue(log)
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
})

describe('GET /api/bookkeeping/fiscal-periods/[id]/bokslut-readiness', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    expect((await GET(request(), params)).status).toBe(401)
    expect(buildReportMock).not.toHaveBeenCalled()
  })

  it('answers a period the company does not have with 404 and no error-level log', async () => {
    buildReportMock.mockRejectedValue(codedRefusal('PERIOD_NOT_FOUND', 'Fiscal period not found'))

    const response = await GET(request(), params)
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
    expect(body.error.message).toBe('Räkenskapsperioden kunde inte hittas.')
    expect(log.error).not.toHaveBeenCalled()
  })

  it('still logs a real aggregation failure at error level', async () => {
    buildReportMock.mockRejectedValue(new Error('Fiscal period read failed: statement timeout'))

    const response = await GET(request(), params)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('YEAR_END_PREVIEW_FAILED')
    expect(log.error).toHaveBeenCalledWith('bokslut readiness aggregation failed', expect.any(Error))
  })

  it('returns the report for a period of the active company', async () => {
    buildReportMock.mockResolvedValue({ ready: true, reminders: [] })

    const response = await GET(request(), params)
    const { status, body } = await parseJsonResponse<{ data: { ready: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.ready).toBe(true)
    expect(buildReportMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'period-1')
    expect(log.error).not.toHaveBeenCalled()
  })
})
