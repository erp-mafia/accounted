import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { runDeductionBackfill, hasVismaInvoiceSource, isProviderImportRunning } = vi.hoisted(() => ({
  runDeductionBackfill: vi.fn(),
  hasVismaInvoiceSource: vi.fn(),
  isProviderImportRunning: vi.fn(),
}))
vi.mock('../deduction-backfill', () => ({ runDeductionBackfill, hasVismaInvoiceSource, isProviderImportRunning }))

import { deductionBackfillRoutes } from '../deduction-backfill-routes'

const route = (method: string) => deductionBackfillRoutes.find((r) => r.method === method)!
const handler = (method: string) => route(method).handler as (request: Request, ctx: ExtensionContext) => Promise<Response>
const post = (body: unknown) =>
  new Request('https://example.test/deduction-backfill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

function context(role: string | null = 'owner') {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: role ? { role } : null }) // company_members (requireWritePermission)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const ctx = { supabase: mock.supabase, companyId: 'company', userId: 'user', log } as unknown as ExtensionContext
  return { ...mock, log, ctx }
}

const REPORT = {
  mode: 'apply',
  complete: true,
  stopReason: null,
  candidates: 1,
  processed: 1,
  buckets: {},
  skipped: {},
  review: [],
  doubleRequests: [],
  applied: { invoices: 1, amount: 3750, statusRepaired: 0 },
  failures: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  eventBus.clear()
})

describe('POST /deduction-backfill', () => {
  it('declares the write gate for the dispatcher', () => {
    expect((route('POST') as { requireWrite?: boolean }).requireWrite).toBe(true)
  })

  it.each([{}, { mode: 'delete' }, { mode: 'apply', companyId: 'foreign' }, 'not json'])(
    'rejects invalid or extended input %#',
    async (body) => {
      const { ctx, findCall } = context()
      expect((await handler('POST')(post(body), ctx)).status).toBe(400)
      expect(findCall('company_members', 'select')).toBeUndefined()
      expect(runDeductionBackfill).not.toHaveBeenCalled()
    },
  )

  it.each(['viewer', null])('refuses a caller without write access (%s) before running', async (role) => {
    const { ctx, findCalls } = context(role)
    expect((await handler('POST')(post({ mode: 'preview' }), ctx)).status).toBe(403)
    expect(findCalls('company_members', 'eq')).toEqual([
      ['company_id', 'company'],
      ['user_id', 'user'],
    ])
    expect(runDeductionBackfill).not.toHaveBeenCalled()
  })

  it.each([
    ['NOT_APPLICABLE', 404],
    ['IMPORT_RUNNING', 409],
    ['RECONNECT_REQUIRED', 409],
    ['DIFFERENT_COMPANY', 409],
  ])('answers the refusal %s with %i', async (code, status) => {
    const { ctx } = context()
    runDeductionBackfill.mockResolvedValue({ ok: false, code })

    const response = await handler('POST')(post({ mode: 'preview' }), ctx)
    const { body } = await parseJsonResponse<{ error: { code: string; message: string; message_en: string } }>(response)

    expect(response.status).toBe(status)
    expect(body.error.code).toBe(`MIGRATED_DEDUCTION_${code}`)
    expect(body.error.message).toEqual(expect.any(String))
    expect(body.error.message_en).toEqual(expect.any(String))
  })

  it.each(['preview', 'apply'] as const)('runs %s for the server company and returns the report', async (mode) => {
    const { ctx } = context()
    runDeductionBackfill.mockResolvedValue({ ok: true, report: { ...REPORT, mode } })

    const response = await handler('POST')(post({ mode }), ctx)
    const { status, body } = await parseJsonResponse<{ data: typeof REPORT }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ ...REPORT, mode })
    expect(runDeductionBackfill).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ supabase: ctx.supabase, companyId: 'company', userId: 'user' }),
      { mode, budgetMs: 600_000 },
    )
  })

  it('answers 500 and logs when the run throws', async () => {
    const { ctx, log } = context()
    const failure = new Error('database unavailable')
    runDeductionBackfill.mockRejectedValue(failure)

    const response = await handler('POST')(post({ mode: 'apply' }), ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('MIGRATED_DEDUCTION_FAILED')
    expect(log.error).toHaveBeenCalledWith(expect.any(String), failure, { mode: 'apply' })
  })
})

describe('GET /deduction-backfill', () => {
  it('reports applicability and a running import, uncached', async () => {
    const { ctx } = context()
    hasVismaInvoiceSource.mockResolvedValue(true)
    isProviderImportRunning.mockResolvedValue(true)

    const response = await handler('GET')(new Request('https://example.test/deduction-backfill'), ctx)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ data: { applicable: true, importRunning: true } })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(hasVismaInvoiceSource).toHaveBeenCalledWith(ctx.supabase, 'company')
    expect(isProviderImportRunning).toHaveBeenCalledWith(ctx.supabase, 'company')
  })

  it('does not ask about an import when the step does not apply', async () => {
    const { ctx } = context()
    hasVismaInvoiceSource.mockResolvedValue(false)

    const response = await handler('GET')(new Request('https://example.test/deduction-backfill'), ctx)

    expect(await response.json()).toEqual({ data: { applicable: false, importRunning: false } })
    expect(isProviderImportRunning).not.toHaveBeenCalled()
  })

  it('answers 500 when the lookup fails', async () => {
    const { ctx, log } = context()
    hasVismaInvoiceSource.mockRejectedValue(new Error('boom'))

    const response = await handler('GET')(new Request('https://example.test/deduction-backfill'), ctx)

    expect(response.status).toBe(500)
    expect(log.error).toHaveBeenCalledTimes(1)
  })
})
