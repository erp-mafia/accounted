import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest } from '@/tests/helpers'

const { supabase } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/core/audit/audit-service', () => ({
  getAuditLog: vi.fn(),
}))

import { getAuditLog } from '@/lib/core/audit/audit-service'
import { GET } from '../route'

const mockGetAuditLog = vi.mocked(getAuditLog)

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

const sampleEntries = [
  {
    id: '1',
    user_id: 'user-1',
    action: 'INSERT' as const,
    table_name: 'journal_entries',
    record_id: 'rec-1',
    actor_id: null,
    old_state: null,
    new_state: { description: 'Test entry' },
    description: 'Created journal entry',
    created_at: '2024-06-15T10:00:00Z',
  },
  {
    id: '2',
    user_id: 'user-1',
    action: 'COMMIT' as const,
    table_name: 'journal_entries',
    record_id: 'rec-1',
    actor_id: null,
    old_state: { status: 'draft' },
    new_state: { status: 'posted' },
    description: 'Committed journal entry',
    created_at: '2024-06-15T10:01:00Z',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  authed()
})

describe('GET /api/reports/audit-trail', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const req = createMockRequest('/api/reports/audit-trail')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns CSV format with correct headers', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAuditLog.mockResolvedValue({ data: sampleEntries as any, count: 2 })

    const req = createMockRequest('/api/reports/audit-trail', {
      searchParams: { format: 'csv' },
    })
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="audit-trail.csv"')

    const text = await res.text()
    const lines = text.split('\n')
    expect(lines[0]).toBe('timestamp,action,table_name,record_id,description,old_state,new_state')
    expect(lines).toHaveLength(3) // header + 2 entries
    expect(lines[1]).toContain('INSERT')
    expect(lines[1]).toContain('journal_entries')
  })

  it('returns JSON format as downloadable file', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAuditLog.mockResolvedValue({ data: sampleEntries as any, count: 2 })

    const req = createMockRequest('/api/reports/audit-trail', {
      searchParams: { format: 'json' },
    })
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="audit-trail.json"')

    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.count).toBe(2)
  })

  it('paginates through all entries', async () => {
    // First call returns 500 entries (full page), second returns 100 (last page)
    const bigPage = Array.from({ length: 500 }, (_, i) => ({
      ...sampleEntries[0],
      id: `entry-${i}`,
    }))
    const lastPage = Array.from({ length: 100 }, (_, i) => ({
      ...sampleEntries[0],
      id: `entry-${500 + i}`,
    }))

    mockGetAuditLog
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce({ data: bigPage as any, count: 600 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce({ data: lastPage as any, count: 600 })

    const req = createMockRequest('/api/reports/audit-trail', {
      searchParams: { format: 'json' },
    })
    const res = await GET(req)
    const body = await res.json()

    expect(body.data).toHaveLength(600)
    expect(mockGetAuditLog).toHaveBeenCalledTimes(2)
  })
})
