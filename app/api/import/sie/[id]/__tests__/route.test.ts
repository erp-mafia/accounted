/**
 * Tests for GET/DELETE /api/import/sie/[id].
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, 403 viewer, the completed-import guard, and the
 * retention of failed imports after unknown outcomes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { GET, DELETE } from '../route'

const routeParams = () => createMockRouteParams({ id: '11111111-1111-4111-8111-111111111111' })

describe('GET/DELETE /api/import/sie/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('DELETE returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await DELETE(
      createMockRequest('/api/import/sie/11111111-1111-4111-8111-111111111111', { method: 'DELETE' }),
      routeParams(),
    )

    expect(response.status).toBe(401)
  })

  it('DELETE returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await DELETE(
      createMockRequest('/api/import/sie/11111111-1111-4111-8111-111111111111', { method: 'DELETE' }),
      routeParams(),
    )

    expect(response.status).toBe(403)
  })

  it('DELETE refuses to delete a completed import (BFL retention)', async () => {
    enqueue({ data: { status: 'completed' } })

    const response = await DELETE(
      createMockRequest('/api/import/sie/11111111-1111-4111-8111-111111111111', { method: 'DELETE' }),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; message_en: string; remediation: { tool: string } } }>(response)

    expect(status).toBe(409)
    expect(body.error.message).toContain('Importhistoriken bevaras')
  })

  it('DELETE retains failed imports whose outcomes may be unknown', async () => {
    // A failed status never establishes that its transaction rolled back.
    enqueue({ data: { status: 'failed' } })

    const response = await DELETE(
      createMockRequest('/api/import/sie/11111111-1111-4111-8111-111111111111', { method: 'DELETE' }),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; message_en: string; remediation: { tool: string } } }>(response)

    expect(status).toBe(409)
    expect(body.error.message).toContain('Importhistoriken bevaras')
  })

  it('GET returns the import record', async () => {
    enqueue({ data: { id: '11111111-1111-4111-8111-111111111111', status: 'pending' } })

    const response = await GET(
      createMockRequest('/api/import/sie/11111111-1111-4111-8111-111111111111'),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string }; recovery_url: string }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(body.recovery_url).toBe('/api/import/sie/11111111-1111-4111-8111-111111111111/recovery')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it.each([401, 403])('GET preserves auth/MFA refusal %s before querying imports', async status => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Denied' }, { status }) })
    expect((await GET(createMockRequest('/api/import/sie/import'), routeParams())).status).toBe(status)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('keeps durable progress on the job view without a legacy recovery link', async () => {
    enqueue({ data: { id: '11111111-1111-4111-8111-111111111111', job_state: 'completed' } })
    const response = await GET(createMockRequest('/api/import/sie/import?progress'), routeParams())
    expect(response.status).toBe(200)
    expect((await response.json()).recovery_url).toBeUndefined()
  })

  it.each([GET, DELETE])('rejects malformed IDs before database access', async route => {
    expect((await route(createMockRequest('/api/import/sie/invalid'), createMockRouteParams({ id: 'invalid' }))).status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it.each([GET, DELETE])('does not disguise database failure as a missing import', async route => {
    enqueue({ error: { code: '57014', message: 'statement timeout' } })
    expect((await route(createMockRequest('/api/import/sie/import'), routeParams())).status).toBe(500)
  })

  it.each([GET, DELETE])('returns a scoped 404 for a missing or inaccessible import', async route => {
    enqueue({ data: null })
    const response = await route(createMockRequest('/api/import/sie/import'), routeParams())
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('NOT_FOUND')
  })

  it('provides bilingual review guidance without deleting legacy history', async () => {
    enqueue({ data: { status: 'failed', job_state: null } })
    const response = await DELETE(createMockRequest('/api/import/sie/import', { method: 'DELETE' }), routeParams())
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatchObject({
      code: 'SIE_IMPORT_LEGACY_REVIEW_REQUIRED', message: expect.stringContaining('Granska'),
      message_en: expect.stringContaining('Review'), remediation: { tool: 'gnubok_sie_import_status' },
    })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('retains the durable history refusal', async () => {
    enqueue({ data: { status: 'completed', job_state: 'completed' } })
    const response = await DELETE(createMockRequest('/api/import/sie/import', { method: 'DELETE' }), routeParams())
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('SIE_IMPORT_HISTORY_RETAINED')
  })
})
