/**
 * Tests for DELETE /api/import/sie/[id]/undo.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking its
 * auth/company/write dependencies and the undoSIEImport service. Covers: 401,
 * 403 viewer, the { success, deletedEntries } passthrough, and the
 * SIE_UNDO_FAILED envelope with the service's Swedish reason in details.
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

const undoSIEImportMock = vi.fn()
vi.mock('@/lib/import/sie-import', () => ({
  undoSIEImport: (...args: unknown[]) => undoSIEImportMock(...args),
}))

import { DELETE } from '../route'

const routeParams = () => createMockRouteParams({ id: 'import-1' })

describe('DELETE /api/import/sie/[id]/undo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await DELETE(
      createMockRequest('/api/import/sie/import-1/undo', { method: 'DELETE' }),
      routeParams(),
    )

    expect(response.status).toBe(401)
    expect(undoSIEImportMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await DELETE(
      createMockRequest('/api/import/sie/import-1/undo', { method: 'DELETE' }),
      routeParams(),
    )

    expect(response.status).toBe(403)
    expect(undoSIEImportMock).not.toHaveBeenCalled()
  })

  it('passes through { success, deletedEntries } on a successful undo', async () => {
    undoSIEImportMock.mockResolvedValue({ success: true, deletedEntries: 214 })

    const response = await DELETE(
      createMockRequest('/api/import/sie/import-1/undo', { method: 'DELETE' }),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{
      success: boolean
      deletedEntries: number
    }>(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true, deletedEntries: 214 })
    expect(undoSIEImportMock).toHaveBeenCalledWith(supabase, 'company-1', 'import-1', 'user-1')
  })

  it('returns the SIE_UNDO_FAILED envelope when the service refuses', async () => {
    undoSIEImportMock.mockResolvedValue({
      success: false,
      deletedEntries: 0,
      error: 'Kan inte ångra import i ett låst eller stängt räkenskapsår. Öppna perioden först.',
    })

    const response = await DELETE(
      createMockRequest('/api/import/sie/import-1/undo', { method: 'DELETE' }),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{
      error: {
        code: string
        message: string
        message_en: string
        details?: { reason?: string }
      }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SIE_UNDO_FAILED')
    expect(body.error.message).toBe('SIE-importen kunde inte ångras.')
    expect(body.error.message_en).toBe('Failed to undo SIE import.')
    expect(body.error.details?.reason).toBe(
      'Kan inte ångra import i ett låst eller stängt räkenskapsår. Öppna perioden först.',
    )
  })
})
