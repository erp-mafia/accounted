/**
 * The dashboard doors of the semesterlöneskuld: POST .../reconcile (stäm av
 * per datum) and GET/POST .../method (the settings row). The services are
 * mocked: auth, the write and admin gates, validation, the pinned preview
 * (PREVIEW_STALE) and the error mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const isAdminMock = vi.fn()
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...a: unknown[]) => requireAuthMock(...a) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: (...a: unknown[]) => requireWriteMock(...a),
  isCompanyAdmin: (...a: unknown[]) => isAdminMock(...a),
}))

const reconcileMock = vi.fn()
const setMethodMock = vi.fn()
const readMethodMock = vi.fn()
vi.mock('@/lib/salary/vacation-liability-reconcile', () => ({
  reconcileVacationLiability: (...a: unknown[]) => reconcileMock(...a),
  setVacationLiabilityMethod: (...a: unknown[]) => setMethodMock(...a),
  readVacationLiabilityMethod: (...a: unknown[]) => readMethodMock(...a),
}))

import { POST as reconcile } from '../reconcile/route'
import { GET as getMethod, POST as postMethod } from '../method/route'

const routeCtx = { params: Promise.resolve({}) }
const post = (handler: typeof reconcile, url: string, body: unknown) =>
  handler(createMockRequest(url, { method: 'POST', body }), routeCtx)

const PREVIEW = { as_of: '2026-10-25', would_post: true, difference_2920: 4000, lines: [{ account_number: '2920', debit_amount: 0, credit_amount: 4000 }] }

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  isAdminMock.mockResolvedValue(true)
  reconcileMock.mockImplementation(async (_ctx: unknown, _input: unknown, { dryRun }: { dryRun: boolean }) =>
    dryRun ? { ok: true, dryRun: true, preview: PREVIEW } : { ok: true, data: { adjusted: true, journal_entry_id: 'je-41' } },
  )
})

describe('POST /api/salary/vacation-liability/reconcile', () => {
  const URL = '/api/salary/vacation-liability/reconcile'

  it('401 when not signed in', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await post(reconcile, URL, { as_of: '2026-10-25', dry_run: true })
    expect(res.status).toBe(401)
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it('403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }) })
    const res = await post(reconcile, URL, { as_of: '2026-10-25', dry_run: true })
    expect(res.status).toBe(403)
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it('400 on a malformed date or an unknown field', async () => {
    expect((await post(reconcile, URL, { as_of: '2026-13-45' })).status).toBe(400)
    expect((await post(reconcile, URL, { as_of: '2026-10-25', lines: [] })).status).toBe(400)
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it('the dry run answers the preview and its token', async () => {
    const res = await post(reconcile, URL, { as_of: '2026-10-25', dry_run: true })
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { preview: typeof PREVIEW; preview_token: string } }>(res)
    expect(body.data.preview).toEqual(PREVIEW)
    expect(body.data.preview_token).toMatch(/^pv1\./)
  })

  it('books with the token of the preview the dialog showed', async () => {
    const dry = await parseJsonResponse<{ data: { preview_token: string } }>(
      await post(reconcile, URL, { as_of: '2026-10-25', dry_run: true }),
    )
    const res = await post(reconcile, URL, { as_of: '2026-10-25', preview_token: dry.body.data.preview_token })
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { journal_entry_id: string } }>(res)
    expect(body.data.journal_entry_id).toBe('je-41')
    expect(reconcileMock.mock.calls.at(-1)?.[2]).toEqual({ dryRun: false })
  })

  it('409 PREVIEW_STALE when the books moved since the preview, with the fresh one', async () => {
    const dry = await parseJsonResponse<{ data: { preview_token: string } }>(
      await post(reconcile, URL, { as_of: '2026-10-25', dry_run: true }),
    )
    reconcileMock.mockResolvedValue({ ok: true, dryRun: true, preview: { ...PREVIEW, difference_2920: 4100 } })
    const res = await post(reconcile, URL, { as_of: '2026-10-25', preview_token: dry.body.data.preview_token })
    expect(res.status).toBe(409)
    const { body } = await parseJsonResponse<{ error: { code: string; details: { preview: typeof PREVIEW } } }>(res)
    expect(body.error.code).toBe('PREVIEW_STALE')
    expect(body.error.details.preview.difference_2920).toBe(4100)
  })

  it('a locked period answers the engine\'s refusal in Swedish', async () => {
    reconcileMock.mockResolvedValue({ ok: false, code: 'PERIOD_LOCKED', details: { entry_date: '2025-12-31' } })
    const res = await post(reconcile, URL, { as_of: '2025-12-31', dry_run: true })
    expect(res.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.message).toBe('Bokföringen är låst för denna period.')
  })
})

describe('/api/salary/vacation-liability/method', () => {
  const URL = '/api/salary/vacation-liability/method'

  it('GET answers the current method', async () => {
    readMethodMock.mockResolvedValue('accrual')
    const res = await getMethod(createMockRequest(URL), routeCtx)
    expect(res.status).toBe(200)
    expect((await parseJsonResponse<{ data: { method: string } }>(res)).body.data.method).toBe('accrual')
  })

  it('POST 401 when not signed in', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post(postMethod, URL, { method: 'remeasure', dry_run: true })).status).toBe(401)
  })

  it('POST 403 for a member who is not owner or admin', async () => {
    isAdminMock.mockResolvedValue(false)
    const res = await post(postMethod, URL, { method: 'remeasure', dry_run: true })
    expect(res.status).toBe(403)
    expect(setMethodMock).not.toHaveBeenCalled()
  })

  it('POST 400 on an unknown method', async () => {
    expect((await post(postMethod, URL, { method: 'true_up' })).status).toBe(400)
    expect(setMethodMock).not.toHaveBeenCalled()
  })

  it('previews the catch-up, then switches with the pinned preview', async () => {
    const preview = { method: 'remeasure', previous_method: 'accrual', catch_up: PREVIEW }
    setMethodMock.mockImplementation(async (_ctx: unknown, _input: unknown, { dryRun }: { dryRun: boolean }) =>
      dryRun ? { ok: true, dryRun: true, preview } : { ok: true, data: { method: 'remeasure', previous_method: 'accrual', catch_up: { journal_entry_id: 'je-41' } } },
    )
    const dry = await parseJsonResponse<{ data: { preview: typeof preview; preview_token: string } }>(
      await post(postMethod, URL, { method: 'remeasure', dry_run: true }),
    )
    expect(dry.body.data.preview).toEqual(preview)
    const res = await post(postMethod, URL, { method: 'remeasure', preview_token: dry.body.data.preview_token })
    expect(res.status).toBe(200)
    expect((await parseJsonResponse<{ data: { method: string } }>(res)).body.data.method).toBe('remeasure')
  })
})
