/**
 * Tests for DELETE /api/import/bank-file/[id]/undo.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking its
 * auth/company/write dependencies and the undoBankFileImport service. Covers:
 * 401, 403 viewer, 403 non-owner/admin (RPC 42501 mapped to
 * BANK_FILE_UNDO_FORBIDDEN), 404 unknown import (BANK_FILE_UNDO_NOT_FOUND),
 * the success passthrough with the skip report, and the
 * BANK_FILE_UNDO_FAILED envelope with the service's Swedish reason.
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

const undoBankFileImportMock = vi.fn()
vi.mock('@/lib/import/bank-file/undo', () => ({
  undoBankFileImport: (...args: unknown[]) => undoBankFileImportMock(...args),
}))

import { DELETE } from '../route'

const routeParams = () => createMockRouteParams({ id: 'import-1' })

describe('DELETE /api/import/bank-file/[id]/undo', () => {
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
      createMockRequest('/api/import/bank-file/import-1/undo', { method: 'DELETE' }),
      routeParams(),
    )

    expect(response.status).toBe(401)
    expect(undoBankFileImportMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await DELETE(
      createMockRequest('/api/import/bank-file/import-1/undo', { method: 'DELETE' }),
      routeParams(),
    )

    expect(response.status).toBe(403)
    expect(undoBankFileImportMock).not.toHaveBeenCalled()
  })

  it('maps the RPC role rejection to BANK_FILE_UNDO_FORBIDDEN (403)', async () => {
    undoBankFileImportMock.mockResolvedValue({
      success: false,
      deletedTransactions: 0,
      skippedBooked: 0,
      skippedMatchHistory: 0,
      forbidden: true,
      error: 'Endast ägare eller administratörer kan ångra en bankfilsimport',
    })

    const response = await DELETE(
      createMockRequest('/api/import/bank-file/import-1/undo', { method: 'DELETE' }),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en: string }
    }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('BANK_FILE_UNDO_FORBIDDEN')
    expect(body.error.message).toBe(
      'Endast ägare eller administratörer kan ångra en bankfilsimport.',
    )
  })

  it('maps an unknown import to BANK_FILE_UNDO_NOT_FOUND (404)', async () => {
    undoBankFileImportMock.mockResolvedValue({
      success: false,
      deletedTransactions: 0,
      skippedBooked: 0,
      skippedMatchHistory: 0,
      notFound: true,
      error: 'Importen hittades inte',
    })

    const response = await DELETE(
      createMockRequest('/api/import/bank-file/import-1/undo', { method: 'DELETE' }),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en: string }
    }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('BANK_FILE_UNDO_NOT_FOUND')
    expect(body.error.message).toBe('Bankfilsimporten kunde inte hittas.')
    expect(body.error.message_en).toBe('Bank file import not found.')
  })

  it('passes through the deletion report on a successful undo', async () => {
    undoBankFileImportMock.mockResolvedValue({
      success: true,
      deletedTransactions: 212,
      skippedBooked: 3,
      skippedMatchHistory: 2,
    })

    const response = await DELETE(
      createMockRequest('/api/import/bank-file/import-1/undo', { method: 'DELETE' }),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{
      success: boolean
      deletedTransactions: number
      skippedBooked: number
      skippedMatchHistory: number
    }>(response)

    expect(status).toBe(200)
    expect(body).toEqual({
      success: true,
      deletedTransactions: 212,
      skippedBooked: 3,
      skippedMatchHistory: 2,
    })
    expect(undoBankFileImportMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'import-1',
      'user-1',
    )
  })

  it('returns the BANK_FILE_UNDO_FAILED envelope when the service refuses', async () => {
    undoBankFileImportMock.mockResolvedValue({
      success: false,
      deletedTransactions: 0,
      skippedBooked: 0,
      skippedMatchHistory: 0,
      error: 'Kan bara ångra slutförda importer (status: processing)',
    })

    const response = await DELETE(
      createMockRequest('/api/import/bank-file/import-1/undo', { method: 'DELETE' }),
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
    expect(body.error.code).toBe('BANK_FILE_UNDO_FAILED')
    expect(body.error.message).toBe('Bankfilsimporten kunde inte ångras.')
    expect(body.error.message_en).toBe('Failed to undo bank file import.')
    expect(body.error.details?.reason).toBe(
      'Kan bara ångra slutförda importer (status: processing)',
    )
  })
})
