/**
 * POST /api/packages/:packageId: the Anpassa page's switch. A dry run answers
 * what the switch means; otherwise it stages enable_package or
 * disable_package as the signed-in user, for the page to approve through the
 * commit door.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createQueuedMockSupabase()
const service = vi.hoisted(() => ({ client: {} as unknown }))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn(() => service.client) }))
vi.mock('@/lib/operations/stage', () => ({ stageOperation: vi.fn() }))
vi.mock('@/lib/operations/packages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operations/packages')>()
  return {
    ...actual,
    packagesEnable: { ...actual.packagesEnable, run: vi.fn() },
    packagesDisable: { ...actual.packagesDisable, run: vi.fn() },
  }
})

import { stageOperation } from '@/lib/operations/stage'
import { packagesDisable, packagesEnable } from '@/lib/operations/packages'
import { POST } from '../route'

const params = (packageId: string) => ({ params: Promise.resolve({ packageId }) })

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'anna@example.se' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/packages/:packageId', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await POST(createMockRequest('/api/packages/payroll', { method: 'POST', body: { enabled: false } }), params('payroll'))
    expect(res.status).toBe(401)
  })

  it('returns 400 for a body without enabled', async () => {
    const res = await POST(createMockRequest('/api/packages/payroll', { method: 'POST', body: {} }), params('payroll'))
    expect(res.status).toBe(400)
  })

  it('refuses Bokföring and an unknown package', async () => {
    for (const id of ['bookkeeping', 'nope']) {
      const res = await POST(createMockRequest(`/api/packages/${id}`, { method: 'POST', body: { enabled: false } }), params(id))
      expect(res.status, id).toBe(400)
      expect((await parseJsonResponse<{ error: { code: string } }>(res)).body.error.code).toBe('PACKAGE_NOT_SWITCHABLE')
    }
    expect(stageOperation).not.toHaveBeenCalled()
  })

  it('answers the dry run of switching off: what will keep the package winding down', async () => {
    const preview = { package_id: 'payroll', package: 'Lön', change: 'Stäng av', winding_down: true, open_obligations: ['unfiled_agi'] }
    vi.mocked(packagesDisable.run).mockResolvedValue({ ok: true, dryRun: true, preview })
    const res = await POST(
      createMockRequest('/api/packages/payroll', { method: 'POST', body: { enabled: false, dry_run: true } }),
      params('payroll'),
    )
    expect(res.status).toBe(200)
    expect((await parseJsonResponse<{ data: unknown }>(res)).body.data).toEqual(preview)
    expect(packagesDisable.run).toHaveBeenCalledWith(
      expect.objectContaining({ supabase: service.client, companyId: 'company-1', userId: 'user-1' }),
      { package_id: 'payroll' },
      { dryRun: true },
    )
    expect(stageOperation).not.toHaveBeenCalled()
  })

  it('passes a refusal of switching on through in the dashboard envelope', async () => {
    vi.mocked(packagesEnable.run).mockResolvedValue({ ok: false, code: 'PACKAGE_NOT_IN_PLAN', messageSv: 'Bank ingår inte i företagets abonnemang.' })
    const res = await POST(
      createMockRequest('/api/packages/bank', { method: 'POST', body: { enabled: true, dry_run: true } }),
      params('bank'),
    )
    expect(res.status).toBe(403)
    const { body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(body.error).toMatchObject({ code: 'PACKAGE_NOT_IN_PLAN', message: 'Bank ingår inte i företagets abonnemang.' })
  })

  it('stages the switch as the signed-in user and answers the pending operation', async () => {
    vi.mocked(stageOperation).mockResolvedValue({
      ok: true,
      dryRun: false,
      plan: { pendingType: 'enable_package', title: 'Slå på Lön', params: { package_id: 'payroll' }, preview: { package: 'Lön', change: 'Slå på' }, extras: {} },
      row: { id: 'op-1' } as never,
      previewToken: 'tok',
    })
    const res = await POST(createMockRequest('/api/packages/payroll', { method: 'POST', body: { enabled: true } }), params('payroll'))
    expect(res.status).toBe(200)
    expect((await parseJsonResponse<{ data: unknown }>(res)).body.data).toEqual({
      pending_operation_id: 'op-1',
      operation_type: 'enable_package',
      title: 'Slå på Lön',
      preview: { package: 'Lön', change: 'Slå på' },
    })
    expect(stageOperation).toHaveBeenCalledWith(
      packagesEnable,
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      { package_id: 'payroll' },
      { type: 'user', label: 'anna@example.se' },
      { dryRun: false },
    )
  })
})
