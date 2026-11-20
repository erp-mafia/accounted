import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/bokslut/k3-transition/transition-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/k3-transition/transition-service')>()),
  getK3Transition: vi.fn(),
  startK3Transition: vi.fn(),
  updateK3Transition: vi.fn(),
  deleteK3Transition: vi.fn(),
  previewK3Transition: vi.fn(),
  commitK3TransitionPosting: vi.fn(),
}))

import { K3TransitionBlockedError, K3TransitionInvalidError } from '@/lib/bookkeeping/errors'
import {
  commitK3TransitionPosting,
  deleteK3Transition,
  getK3Transition,
  previewK3Transition,
  startK3Transition,
  updateK3Transition,
} from '@/lib/bokslut/k3-transition/transition-service'
import { DELETE, GET, PATCH, POST } from '../route'
import { POST as PREVIEW } from '../preview/route'
import { POST as COMMIT } from '../commit/route'

const NO_PARAMS = { params: Promise.resolve({}) }
const PERIOD_ID = '11111111-1111-4111-8111-111111111111'
const STATE = { transition: null, committed: false, period: null, assets: [] }

function request(method: string, path: string, body?: unknown) {
  return createMockRequest(path, { method, ...(body === undefined ? {} : { body }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('/api/bookkeeping/k3-transition', () => {
  it('answers 401 without a session, on every verb', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await GET(request('GET', '/api/bookkeeping/k3-transition'), NO_PARAMS)).status).toBe(401)
    expect((await POST(request('POST', '/api/bookkeeping/k3-transition', { fiscal_period_id: PERIOD_ID }), NO_PARAMS)).status).toBe(401)
    expect((await COMMIT(request('POST', '/api/bookkeeping/k3-transition/commit', {}), NO_PARAMS)).status).toBe(401)
    expect(startK3Transition).not.toHaveBeenCalled()
    expect(commitK3TransitionPosting).not.toHaveBeenCalled()
  })

  it('answers 400 for a malformed body', async () => {
    expect((await POST(request('POST', '/api/bookkeeping/k3-transition', { fiscal_period_id: 'x' }), NO_PARAMS)).status).toBe(400)
    expect((await PATCH(request('PATCH', '/api/bookkeeping/k3-transition', { relief_rules: ['35.27'] }), NO_PARAMS)).status).toBe(400)
    expect(
      (
        await PREVIEW(
          request('POST', '/api/bookkeeping/k3-transition/preview', { adjustments: [{ account_number: '17', amount: 1, description: 'x' }] }),
          NO_PARAMS,
        )
      ).status,
    ).toBe(400)
    expect(startK3Transition).not.toHaveBeenCalled()
    expect(updateK3Transition).not.toHaveBeenCalled()
    expect(previewK3Transition).not.toHaveBeenCalled()
  })

  it('answers 404 for a year outside the company, 409 with the reason when the transition is refused', async () => {
    vi.mocked(startK3Transition).mockRejectedValueOnce(Object.assign(new Error('Fiscal period not found'), { code: 'PERIOD_NOT_FOUND' }))
    expect((await POST(request('POST', '/api/bookkeeping/k3-transition', { fiscal_period_id: PERIOD_ID }), NO_PARAMS)).status).toBe(404)
    vi.mocked(commitK3TransitionPosting).mockRejectedValueOnce(new K3TransitionBlockedError('committed'))
    const refused = await parseJsonResponse<{ error: { code: string } }>(
      await COMMIT(request('POST', '/api/bookkeeping/k3-transition/commit', {}), NO_PARAMS),
    )
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('K3_TRANSITION_BLOCKED')
    vi.mocked(previewK3Transition).mockRejectedValueOnce(new K3TransitionInvalidError('Konto 5010: ...'))
    const invalid = await parseJsonResponse<{ error: { code: string } }>(
      await PREVIEW(request('POST', '/api/bookkeeping/k3-transition/preview', {}), NO_PARAMS),
    )
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('INVALID_K3_TRANSITION')
  })

  it('reads, starts, updates, drops, previews and commits the transition', async () => {
    vi.mocked(getK3Transition).mockResolvedValue(STATE)
    vi.mocked(startK3Transition).mockResolvedValue(STATE)
    vi.mocked(updateK3Transition).mockResolvedValue(STATE)
    vi.mocked(deleteK3Transition).mockResolvedValue(undefined)
    vi.mocked(previewK3Transition).mockResolvedValue({ lines: [] } as never)
    vi.mocked(commitK3TransitionPosting).mockResolvedValue({ entry: null, preview: { lines: [] } } as never)

    expect((await GET(request('GET', '/api/bookkeeping/k3-transition'), NO_PARAMS)).status).toBe(200)
    expect((await POST(request('POST', '/api/bookkeeping/k3-transition', { fiscal_period_id: PERIOD_ID }), NO_PARAMS)).status).toBe(201)
    expect(startK3Transition).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', { fiscal_period_id: PERIOD_ID })
    const patch = { deferred_tax_relief: true, relief_rules: ['35.22'], changed_principles: 'Komponentavskrivning' }
    expect((await PATCH(request('PATCH', '/api/bookkeeping/k3-transition', patch), NO_PARAMS)).status).toBe(200)
    expect(updateK3Transition).toHaveBeenCalledWith(supabase, 'company-1', patch)
    expect((await DELETE(request('DELETE', '/api/bookkeeping/k3-transition'), NO_PARAMS)).status).toBe(200)

    const body = {
      adjustments: [{ account_number: '1790', amount: 12_500, description: 'Förutbetald hyra' }],
      loss_carryforward: { deficit: 50_000, reason: 'Avtal ger vinst 2026' },
      manual_items: [],
    }
    expect((await PREVIEW(request('POST', '/api/bookkeeping/k3-transition/preview', body), NO_PARAMS)).status).toBe(200)
    expect(previewK3Transition).toHaveBeenCalledWith(supabase, 'company-1', body)
    expect((await COMMIT(request('POST', '/api/bookkeeping/k3-transition/commit', body), NO_PARAMS)).status).toBe(200)
    expect(commitK3TransitionPosting).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', body)
  })
})
