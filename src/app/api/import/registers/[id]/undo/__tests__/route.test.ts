/**
 * DELETE /api/import/registers/[id]/undo through the real withRouteContext
 * wrapper: 401, 403 viewer, 400 malformed id, the service's failure codes
 * (404 / 409 / 403), and the success report passthrough. The rules
 * themselves are the RPC's (tests/pg/register-import-undo.pg.test.ts).
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

const undoRegisterImportMock = vi.fn()
vi.mock('@/lib/import/register-runs', () => ({
  undoRegisterImport: (...args: unknown[]) => undoRegisterImportMock(...args),
}))

import { DELETE } from '../route'

const RUN_ID = '0b9f6c1e-5a43-4c55-9d0a-3f1c2b7e8a10'

function call(id = RUN_ID) {
  return DELETE(
    createMockRequest(`/api/import/registers/${id}/undo`, { method: 'DELETE' }),
    createMockRouteParams({ id }),
  )
}

type ErrorBody = { error: { code: string; message: string } }

describe('DELETE /api/import/registers/[id]/undo', () => {
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

    const response = await call()

    expect(response.status).toBe(401)
    expect(undoRegisterImportMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await call()

    expect(response.status).toBe(403)
    expect(undoRegisterImportMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an id that is not a uuid', async () => {
    const { status, body } = await parseJsonResponse<ErrorBody>(await call('not-a-uuid'))

    expect(status).toBe(400)
    expect(body.error.code).toBe('REG_IMPORT_UNDO_INVALID_ID')
    expect(undoRegisterImportMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the run does not exist in the company', async () => {
    undoRegisterImportMock.mockResolvedValue({ ok: false, code: 'REG_IMPORT_UNDO_NOT_FOUND' })

    const { status, body } = await parseJsonResponse<ErrorBody>(await call())

    expect(status).toBe(404)
    expect(body.error.code).toBe('REG_IMPORT_UNDO_NOT_FOUND')
    expect(body.error.message).toBe('Importen kunde inte hittas.')
  })

  it('returns 409 when the run is already undone', async () => {
    undoRegisterImportMock.mockResolvedValue({ ok: false, code: 'REG_IMPORT_UNDO_ALREADY_UNDONE' })

    const { status, body } = await parseJsonResponse<ErrorBody>(await call())

    expect(status).toBe(409)
    expect(body.error.code).toBe('REG_IMPORT_UNDO_ALREADY_UNDONE')
  })

  it('returns 403 when the RPC refuses the actor', async () => {
    undoRegisterImportMock.mockResolvedValue({
      ok: false,
      code: 'REG_IMPORT_UNDO_FORBIDDEN',
      error: { code: '42501', message: 'no write access' },
    })

    const { status, body } = await parseJsonResponse<ErrorBody>(await call())

    expect(status).toBe(403)
    expect(body.error.code).toBe('REG_IMPORT_UNDO_FORBIDDEN')
  })

  it('undoes the run for the active company and the caller, and returns the report', async () => {
    const result = {
      deleted: 2,
      kept: [
        { id: 'c3', name: 'Kund som används', reason: 'referenced', referenced_by: ['invoices'] },
      ],
    }
    undoRegisterImportMock.mockResolvedValue({ ok: true, result })

    const { status, body } = await parseJsonResponse<{ data: typeof result }>(await call())

    expect(status).toBe(200)
    expect(body.data).toEqual(result)
    expect(undoRegisterImportMock).toHaveBeenCalledWith(supabase, 'company-1', RUN_ID, 'user-1')
  })
})
