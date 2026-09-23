import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, enqueueMany, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()
const isAdminMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
// The real envelope builder stays: only the database predicate is mocked.
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return {
    requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
    isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
    companyAdminRequiredResponse: actual.companyAdminRequiredResponse,
  }
})

import { GET, PATCH } from '../route'

// Typed route params for the tests added with the owner/admin gate.
const NO_PARAMS: { params: Promise<Record<string, never>> } = { params: Promise.resolve({}) }

describe('/api/onboarding/state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
    isAdminMock.mockResolvedValue(true)
  })

  it('returns 401 when the user is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest('/api/onboarding/state'), {})
    expect(response.status).toBe(401)
  })

  it('returns the persisted company setup state', async () => {
    enqueue({
      data: {
        initial_setup_path: 'migration',
        initial_setup_completed_at: null,
        initial_setup_dismissed_at: null,
      },
    })

    const { status, body } = await parseJsonResponse<{
      data: { path: string; completedAt: string | null; dismissedAt: string | null }
    }>(await GET(createMockRequest('/api/onboarding/state'), {}))

    expect(status).toBe(200)
    expect(body.data).toEqual({ path: 'migration', completedAt: null, dismissedAt: null })
  })

  it('returns 400 for an empty update', async () => {
    const response = await PATCH(createMockRequest('/api/onboarding/state', {
      method: 'PATCH',
      body: {},
    }), {})

    expect(response.status).toBe(400)
  })

  it('returns 404 when company settings do not exist', async () => {
    enqueue({ data: null, error: null })
    const response = await PATCH(createMockRequest('/api/onboarding/state', {
      method: 'PATCH',
      body: { path: 'bank' },
    }), {})

    expect(response.status).toBe(404)
  })

  it('persists a selected path and clears dismissal', async () => {
    enqueueMany([
      {
        data: {
          initial_setup_path: null,
          initial_setup_completed_at: null,
          initial_setup_dismissed_at: null,
        },
      },
      {
        data: {
          initial_setup_path: 'bank',
          initial_setup_completed_at: null,
          initial_setup_dismissed_at: null,
        },
      },
    ])

    const { status, body } = await parseJsonResponse<{
      data: { path: string; completedAt: string | null; dismissedAt: string | null }
    }>(await PATCH(createMockRequest('/api/onboarding/state', {
      method: 'PATCH',
      body: { path: 'bank' },
    }), {}))

    expect(status).toBe(200)
    expect(body.data).toEqual({ path: 'bank', completedAt: null, dismissedAt: null })
  })

  // company_settings is writable by owner/admin only (RLS). The route used to
  // gate on requireWrite, which lets a `member` through: the UPDATE then
  // matched zero rows and `.single()` turned that into PGRST116 and a 500.
  it('gates PATCH on the owner/admin predicate for the resolved company, not on the write role', async () => {
    enqueueMany([
      { data: { initial_setup_path: null, initial_setup_completed_at: null, initial_setup_dismissed_at: null } },
      { data: { initial_setup_path: 'bank', initial_setup_completed_at: null, initial_setup_dismissed_at: null } },
    ])

    await PATCH(createMockRequest('/api/onboarding/state', { method: 'PATCH', body: { path: 'bank' } }), NO_PARAMS)

    expect(isAdminMock).toHaveBeenCalledWith(supabase, 'company-1')
    expect(requireWriteMock).not.toHaveBeenCalled()
  })

  it('answers a member with 403 and never reaches the table', async () => {
    isAdminMock.mockResolvedValue(false)

    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details?: { required_roles?: string[] } }
    }>(await PATCH(createMockRequest('/api/onboarding/state', {
      method: 'PATCH',
      body: { dismissed: true },
    }), NO_PARAMS))

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toContain('ägare eller en administratör')
    expect(body.error.details?.required_roles).toEqual(['owner', 'admin'])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('does not gate GET on the admin predicate: every member may read the setup state', async () => {
    enqueue({ data: { initial_setup_path: null, initial_setup_completed_at: null, initial_setup_dismissed_at: null } })

    const response = await GET(createMockRequest('/api/onboarding/state'), NO_PARAMS)

    expect(response.status).toBe(200)
    expect(isAdminMock).not.toHaveBeenCalled()
  })

  it('answers 403, not 500, when the UPDATE matches zero rows (refused by row-level security)', async () => {
    enqueueMany([
      { data: { initial_setup_path: null, initial_setup_completed_at: null, initial_setup_dismissed_at: null } },
      // What PostgREST returns through maybeSingle() when RLS filters the row
      // out of the UPDATE: no row, no error.
      { data: null, error: null },
    ])

    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details?: { required_roles?: string[] } }
    }>(await PATCH(createMockRequest('/api/onboarding/state', {
      method: 'PATCH',
      body: { path: 'fresh' },
    }), NO_PARAMS))

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toContain('ägare eller en administratör')
    expect(body.error.details?.required_roles).toEqual(['owner', 'admin'])
  })

  it('still answers 500 for a real database error on the UPDATE', async () => {
    enqueueMany([
      { data: { initial_setup_path: null, initial_setup_completed_at: null, initial_setup_dismissed_at: null } },
      { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    ])

    const response = await PATCH(createMockRequest('/api/onboarding/state', {
      method: 'PATCH',
      body: { path: 'fresh' },
    }), NO_PARAMS)

    expect(response.status).toBe(500)
  })
})
