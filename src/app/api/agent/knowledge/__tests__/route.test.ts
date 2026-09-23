/**
 * Tests for GET /api/agent/knowledge (the "Vad din agent vet" data source for
 * the Kunskap tab in the assistant settings hub). Exercises the route through
 * the real withRouteContext wrapper, mocking auth/company and the three
 * ledger-context builders. Covers auth 401, no-company 400, and the happy path
 * aggregation shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const getActiveCompanyIdMock = vi.fn()
const getCompanyDisplayNameMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
  getCompanyDisplayName: (...args: unknown[]) => getCompanyDisplayNameMock(...args),
}))

const buildLedgerContextMock = vi.fn()
vi.mock('@/lib/agent-context/ledger-context', () => ({
  buildLedgerContext: (...args: unknown[]) => buildLedgerContextMock(...args),
}))

const buildDeepEntitiesMock = vi.fn()
vi.mock('@/lib/agent-context/ledger-deep', () => ({
  buildDeepEntities: (...args: unknown[]) => buildDeepEntitiesMock(...args),
}))

const buildAgentCompetenceMock = vi.fn()
vi.mock('@/lib/agent-context/agent-competence', () => ({
  buildAgentCompetence: (...args: unknown[]) => buildAgentCompetenceMock(...args),
}))

import { GET } from '../route'

describe('GET /api/agent/knowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    getActiveCompanyIdMock.mockResolvedValue('company-1')
    getCompanyDisplayNameMock.mockResolvedValue('Acme AB')
    buildLedgerContextMock.mockResolvedValue({ meta: { coverage: {} }, explicit_rules: [], vat_profile: {}, conventions: {} })
    buildDeepEntitiesMock.mockResolvedValue({ counterparty_entities: [], supplier_entities: [] })
    buildAgentCompetenceMock.mockResolvedValue({ atoms: [], facts: [] })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/agent/knowledge'), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when there is no active company', async () => {
    getActiveCompanyIdMock.mockResolvedValue(null)
    const res = await GET(createMockRequest('/api/agent/knowledge'), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('aggregates the ledger context, deep entities, competence and company name', async () => {
    const res = await GET(createMockRequest('/api/agent/knowledge'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { context: unknown; deep: unknown; competence: unknown; companyName: string }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.companyName).toBe('Acme AB')
    expect(body.data.context).toEqual({ meta: { coverage: {} }, explicit_rules: [], vat_profile: {}, conventions: {} })
    expect(body.data.deep).toEqual({ counterparty_entities: [], supplier_entities: [] })
    expect(body.data.competence).toEqual({ atoms: [], facts: [] })
    // each builder was called with the resolved supabase + companyId
    expect(buildLedgerContextMock).toHaveBeenCalledWith(supabase, 'company-1')
    expect(buildDeepEntitiesMock).toHaveBeenCalledWith(supabase, 'company-1')
    expect(buildAgentCompetenceMock).toHaveBeenCalledWith(supabase, 'company-1')
  })
})
