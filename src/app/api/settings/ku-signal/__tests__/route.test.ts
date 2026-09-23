/**
 * Tests for /api/settings/ku-signal — ledger-derived kontrolluppgifter signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const fetchEntryLinesMock = vi.fn()
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: (...args: unknown[]) => fetchEntryLinesMock(...args),
}))

import { GET } from '../route'

function supabaseWithEntityType(entityType: string | null) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: entityType ? { entity_type: entityType } : null })),
        })),
      })),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/settings/ku-signal', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/settings/ku-signal'), {})
    expect(res.status).toBe(401)
  })

  it('reports a KU signal when an aktiebolag has utdelning/ägarlån postings', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithEntityType('aktiebolag'),
      error: null,
    })
    fetchEntryLinesMock.mockResolvedValue([{ account_number: '2898' }])

    const { status, body } = await parseJsonResponse<{ data: { has_ku_signal: boolean } }>(
      await GET(createMockRequest('/api/settings/ku-signal'), {})
    )
    expect(status).toBe(200)
    expect(body.data.has_ku_signal).toBe(true)
  })

  it('reports no signal for an empty result', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithEntityType('aktiebolag'),
      error: null,
    })
    fetchEntryLinesMock.mockResolvedValue([])

    const { status, body } = await parseJsonResponse<{ data: { has_ku_signal: boolean } }>(
      await GET(createMockRequest('/api/settings/ku-signal'), {})
    )
    expect(status).toBe(200)
    expect(body.data.has_ku_signal).toBe(false)
  })

  it('never signals for enskild firma, even with matching postings', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithEntityType('enskild_firma'),
      error: null,
    })
    fetchEntryLinesMock.mockResolvedValue([{ account_number: '2893' }])

    const { status, body } = await parseJsonResponse<{ data: { has_ku_signal: boolean } }>(
      await GET(createMockRequest('/api/settings/ku-signal'), {})
    )
    expect(status).toBe(200)
    expect(body.data.has_ku_signal).toBe(false)
    // The ledger query is skipped entirely for non-AB companies.
    expect(fetchEntryLinesMock).not.toHaveBeenCalled()
  })
})
