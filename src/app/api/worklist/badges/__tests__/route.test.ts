import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, createMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const countPendingOperations = vi.fn()
const countInboxDocuments = vi.fn()
vi.mock('@/lib/worklist/categories', () => ({
  countPendingOperations: (...args: unknown[]) => countPendingOperations(...args),
  countInboxDocuments: (...args: unknown[]) => countInboxDocuments(...args),
}))
const inboxCompanionIds = vi.fn(() => async () => new Set<string>())
vi.mock('@/lib/worklist/inbox-companions', () => ({
  inboxCompanionIds: (...args: unknown[]) => inboxCompanionIds(...(args as [])),
}))

import { GET } from '../route'

const get = () => GET(createMockRequest('/api/worklist/badges'), createMockRouteParams({}))

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  countPendingOperations.mockResolvedValue(0)
  countInboxDocuments.mockResolvedValue(0)
})

describe('GET /api/worklist/badges', () => {
  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    expect(countPendingOperations).not.toHaveBeenCalled()
  })

  it('returns the two sidebar counts for the active company', async () => {
    countPendingOperations.mockResolvedValue(43)
    countInboxDocuments.mockResolvedValue(6)
    const res = await get()
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { pending_operations: number; inbox: number } }>(res)
    expect(body.data).toEqual({ pending_operations: 43, inbox: 6 })
    expect(countPendingOperations).toHaveBeenCalledWith(supabase, 'company-1')
  })

  it('counts the inbox with the pairing read, as the Att göra row does', async () => {
    await get()
    expect(inboxCompanionIds).toHaveBeenCalledWith(supabase, 'company-1')
    const [, companyId, options] = countInboxDocuments.mock.calls[0] as [unknown, string, { companionIds?: unknown }]
    expect(companyId).toBe('company-1')
    expect(typeof options.companionIds).toBe('function')
  })
})
