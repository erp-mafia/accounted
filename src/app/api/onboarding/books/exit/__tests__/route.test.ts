import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()
const companyRoleMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
  getCompanyRole: (...args: unknown[]) => companyRoleMock(...args),
}))

const CTX = { params: Promise.resolve({}) }
import { POST } from '../route'

describe('POST /api/onboarding/books/exit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
    companyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
  })

  it('returns 401 when the user is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(
      createMockRequest('/api/onboarding/books/exit', { method: 'POST', body: { outcome: 'done' } }),
      CTX,
    )
    expect(response.status).toBe(401)
  })

  it('returns 400 for an unknown outcome', async () => {
    const response = await POST(
      createMockRequest('/api/onboarding/books/exit', { method: 'POST', body: { outcome: 'later' } }),
      CTX,
    )
    expect(response.status).toBe(400)
  })

  it('rejects read-only members without updating settings or clearing the gate', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    const response = await POST(createMockRequest('/api/onboarding/books/exit', { method: 'POST', body: { outcome: 'done' } }), CTX)
    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('returns 404 when the company has no settings row', async () => {
    enqueue({ data: null })
    const response = await POST(
      createMockRequest('/api/onboarding/books/exit', {
        method: 'POST',
        body: { outcome: 'done', path: 'migration' },
      }),
      CTX,
    )
    expect(response.status).toBe(404)
  })

  it('clears the gate cookie and records the path once', async () => {
    enqueue({ data: { initial_setup_path: null, initial_setup_completed_at: null } })
    enqueue({ data: { company_id: 'company-1' } })
    const response = await POST(
      createMockRequest('/api/onboarding/books/exit', {
        method: 'POST',
        body: { outcome: 'done', path: 'migration' },
      }),
      CTX,
    )
    const { status, body } = await parseJsonResponse<{ data: { outcome: string; path: string } }>(response)
    expect(status).toBe(200)
    expect(body.data).toEqual({ outcome: 'done', path: 'migration', recorded: true })
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('gnubok-books-gate=')
    expect(cookie).toMatch(/Max-Age=0/i)
    // Finishing the act is the initial setup: Hem must open on Att göra, not
    // on the checklist that asks for the same imports again.
    const patch = findCall('company_settings', 'update')?.[0] as Record<string, unknown>
    expect(patch.initial_setup_path).toBe('migration')
    expect(typeof patch.initial_setup_completed_at).toBe('string')
  })

  it('a done exit without a path still stamps the checklist as completed', async () => {
    enqueue({ data: { initial_setup_path: 'fresh', initial_setup_completed_at: null } })
    enqueue({ data: { company_id: 'company-1' } })
    const response = await POST(
      createMockRequest('/api/onboarding/books/exit', { method: 'POST', body: { outcome: 'done' } }),
      CTX,
    )
    expect(response.status).toBe(200)
    const patch = findCall('company_settings', 'update')?.[0] as Record<string, unknown>
    expect(patch).toEqual({ initial_setup_completed_at: expect.any(String) })
  })

  it('lets a member leave the act and says the outcome was not recorded', async () => {
    companyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
    enqueue({ data: { initial_setup_path: null, initial_setup_completed_at: null } })
    const response = await POST(
      createMockRequest('/api/onboarding/books/exit', {
        method: 'POST',
        body: { outcome: 'done', path: 'migration' },
      }),
      CTX,
    )
    const { status, body } = await parseJsonResponse<{ data: { recorded: boolean } }>(response)
    expect(status).toBe(200)
    expect(body.data.recorded).toBe(false)
    expect(response.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/i)
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('answers 500 when the record could not be written', async () => {
    enqueue({ data: { initial_setup_path: null, initial_setup_completed_at: null } })
    enqueue({ data: null, error: { message: 'boom' } })
    const response = await POST(
      createMockRequest('/api/onboarding/books/exit', { method: 'POST', body: { outcome: 'done' } }),
      CTX,
    )
    expect(response.status).toBe(500)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('leaves settings alone when path and completion are already recorded', async () => {
    enqueue({ data: { initial_setup_path: 'migration', initial_setup_completed_at: '2026-09-01T00:00:00.000Z' } })
    const response = await POST(
      createMockRequest('/api/onboarding/books/exit', {
        method: 'POST',
        body: { outcome: 'done', path: 'bank' },
      }),
      CTX,
    )
    expect(response.status).toBe(200)
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('a skip clears the cookie without touching settings', async () => {
    const response = await POST(
      createMockRequest('/api/onboarding/books/exit', { method: 'POST', body: { outcome: 'skipped' } }),
      CTX,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/i)
  })
})
