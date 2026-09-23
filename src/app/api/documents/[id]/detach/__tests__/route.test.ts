/**
 * Tests for POST /api/documents/[id]/detach (detach a duplicate underlag from
 * a posted verifikat via the audited detach_underlag_duplicate RPC).
 *
 * Covers: 401, rule-violation 409 passthrough (Swedish RPC messages verbatim),
 * tenant guard 403, unexpected RPC failure 500, and the happy path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const rpcMock = vi.fn()
;(supabase as { rpc?: unknown }).rpc = rpcMock

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'

const params = () => createMockRouteParams({ id: 'doc-1' })

function makeRequest() {
  return createMockRequest('/api/documents/doc-1/detach', { method: 'POST' })
}

describe('POST /api/documents/[id]/detach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(makeRequest(), params())
    expect(response.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('passes rule violations through as 409 with the Swedish message', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message:
          'Verifikationen skulle stå utan underlag: det sista underlaget kan inte kopplas bort. Ersätt det med en ny version i stället.',
      },
    })

    const response = await POST(makeRequest(), params())
    const { body } = await parseJsonResponse<{ error: string }>(response)

    expect(response.status).toBe(409)
    expect(body.error).toContain('sista underlaget')
  })

  it('maps the tenant guard (42501) to 403', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'unauthorized: caller is not a member of company company-1' },
    })

    const response = await POST(makeRequest(), params())
    expect(response.status).toBe(403)
  })

  it('returns 500 on unexpected RPC failure', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    })

    const response = await POST(makeRequest(), params())
    expect(response.status).toBe(500)
  })

  it('detaches the duplicate and returns the RPC result', async () => {
    rpcMock.mockResolvedValue({
      data: {
        detached: true,
        document_id: 'doc-1',
        journal_entry_id: 'je-1',
        remaining_documents: 1,
      },
      error: null,
    })

    const response = await POST(makeRequest(), params())
    const { body } = await parseJsonResponse<{
      data: { detached: boolean; journal_entry_id: string; remaining_documents: number }
    }>(response)

    expect(response.status).toBe(200)
    expect(body.data.detached).toBe(true)
    expect(body.data.remaining_documents).toBe(1)
    expect(rpcMock).toHaveBeenCalledWith('detach_underlag_duplicate', {
      p_company_id: 'company-1',
      p_document_id: 'doc-1',
      p_user_id: 'user-1',
    })
  })
})
