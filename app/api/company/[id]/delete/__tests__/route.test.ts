import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { POST } from '../route'

const mockRequireAuth = vi.mocked(requireAuth)
const mockCreateServiceClient = vi.mocked(createServiceClient)

type Row = { data: unknown; error: unknown }

function mockService(rowsByTable: Record<string, Row[]>) {
  const insertSpy = vi.fn().mockResolvedValue({ data: null, error: null })
  const updateSpies: Record<string, ReturnType<typeof vi.fn>> = {}

  const from = vi.fn().mockImplementation((table: string) => {
    const queue = rowsByTable[table] ?? []
    const next = queue.shift() ?? { data: null, error: null }

    const updateFn = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      }),
    })
    updateSpies[table] = updateFn

    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue(next),
          }),
          maybeSingle: vi.fn().mockResolvedValue(next),
        }),
      }),
      update: updateFn,
      insert: insertSpy,
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreateServiceClient.mockReturnValue({ from } as any)
  return { from, insertSpy, updateSpies }
}

function mockAuth(userId: string | null) {
  if (userId) {
    mockRequireAuth.mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { id: userId, email: 'u@example.com' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      error: null,
    })
  } else {
    mockRequireAuth.mockResolvedValue({
      user: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: { status: 401 } as any,
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('POST /api/company/[id]/delete', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuth(null)
    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme' },
    })
    const res = await POST(req, createMockRouteParams({ id: 'c1' }))
    // requireAuth already returned a NextResponse error
    expect(res).toBeDefined()
  })

  it('returns 400 when confirm_name does not match', async () => {
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Wrong Name' },
    })
    const { status, body } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  it('accepts the settings display name when companies.name is stale', async () => {
    // Regression: the UI shows company_settings.company_name (the dialog,
    // label and the enable-gate all use it), but companies.name can be stale.
    // The server must accept the displayed name, not just the raw column.
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Gammalt namn', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      company_settings: [{ data: { company_name: 'Nytt namn' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Nytt namn' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(200)
  })

  it('rejects the stale companies.name when a settings name exists (only the displayed name is accepted)', async () => {
    // Security: the UI only ever shows company_settings.company_name when set, so
    // the server must not accept the stale companies.name as an alternative
    // confirmation: that would be a delete path the user was never shown.
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Gammalt namn', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      company_settings: [{ data: { company_name: 'Nytt namn' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Gammalt namn' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(400)
  })

  it('returns 403 when caller is member but not owner', async () => {
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'member' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(403)
  })

  it('returns 404 when company is already archived', async () => {
    mockAuth('user-1')
    mockService({
      companies: [
        {
          data: {
            id: 'c1',
            name: 'Acme AB',
            archived_at: '2026-01-01T00:00:00Z',
          },
          error: null,
        },
      ],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(404)
  })

  it('archives company, writes audit log, emits event on happy path', async () => {
    mockAuth('user-1')
    const { insertSpy, updateSpies } = mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
    })

    const emitted: unknown[] = []
    eventBus.on('company.deleted', (payload) => {
      emitted.push(payload)
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
    const { status, body } = await parseJsonResponse<{
      data: { companyId: string; archivedAt: string }
    }>(await POST(req, createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(200)
    expect(body.data.companyId).toBe('c1')
    expect(body.data.archivedAt).toBeTruthy()

    // Verified the companies.update was called (archived_at + archived_by)
    expect(updateSpies.companies).toHaveBeenCalledWith(
      expect.objectContaining({
        archived_at: expect.any(String),
        archived_by: 'user-1',
      })
    )

    // Audit log row written
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DELETE',
        table_name: 'companies',
        record_id: 'c1',
        user_id: 'user-1',
      })
    )

    // Event emitted
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ companyId: 'c1', userId: 'user-1' })
  })
})
