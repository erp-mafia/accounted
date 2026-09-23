import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const db = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const importId = '11111111-1111-4111-8111-111111111111'
const request = (id = importId) => GET(
  createMockRequest(`/api/import/sie/${id}/recovery`), createMockRouteParams({ id }),
)

describe('GET /api/import/sie/[id]/recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: db.supabase })
  })

  it('returns 401 before reading any import when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null, supabase: db.supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await request()).status).toBe(401)
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('preserves the hosted MFA refusal', async () => {
    requireAuthMock.mockResolvedValue({
      user: null, supabase: db.supabase,
      error: NextResponse.json({ error: { code: 'MFA_REQUIRED' } }, { status: 403 }),
    })
    expect((await request()).status).toBe(403)
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid ID before querying the database', async () => {
    const response = await request('not-a-uuid')
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing or foreign-company import', async () => {
    db.enqueue({ data: null })
    const response = await request()
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('NOT_FOUND')
    expect(db.findCalls('sie_imports', 'eq')).toEqual([['company_id', 'company-1'], ['id', importId]])
  })

  it('returns a read-only assessment even when a legacy row has no fiscal-year metadata', async () => {
    db.enqueueMany([
      { data: { id: importId, status: 'failed', job_state: null, fiscal_period_id: null } },
      { data: { bookkeeping_locked_through: null } },
    ])
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect((await response.json()).data).toMatchObject({ importId, periodResolution: 'missing', entries: null })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 409 for a tracked job, which already has its own recovery controls', async () => {
    db.enqueue({ data: { id: importId, job_state: 'completed' } })
    const response = await request()
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('CONFLICT')
  })

  it('returns 500 on a database failure, never an empty successful assessment', async () => {
    db.enqueue({ error: { code: '57014', message: 'statement timeout' } })
    const response = await request()
    expect(response.status).toBe(500)
    expect((await response.json()).data).toBeUndefined()
  })
})
