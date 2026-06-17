import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockEmit = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/events', () => ({ eventBus: { emit: (...a: unknown[]) => mockEmit(...a) } }))

const mockFetchAllRows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => mockFetchAllRows(...a),
}))

const mockEnsureArticleNumber = vi.fn().mockResolvedValue('AUTO-1')
vi.mock('@/lib/articles/ensure-article-number', () => ({
  ensureArticleNumber: (...a: unknown[]) => mockEnsureArticleNumber(...a),
}))

const mockCheckRevenueAccount = vi.fn().mockResolvedValue('ok')
vi.mock('@/lib/articles/validate-revenue-account', () => ({
  checkRevenueAccount: (...a: unknown[]) => mockCheckRevenueAccount(...a),
}))

import { POST } from '../execute/route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function row(overrides: Record<string, unknown> = {}) {
  return {
    row_index: 2,
    name: 'Konsulttimme',
    name_en: null,
    article_number: null,
    type: 'tjanst',
    unit: 'tim',
    price_excl_vat: 950,
    vat_rate: 25,
    revenue_account: null,
    cost_price: null,
    ean: null,
    housework_type: null,
    notes: null,
    ...overrides,
  }
}

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/articles/execute', { method: 'POST', body })
}

describe('POST /api/import/articles/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
    mockCheckRevenueAccount.mockResolvedValue('ok')
    mockEnsureArticleNumber.mockResolvedValue('AUTO-1')
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({ rows: [row()], update_duplicates: false }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 for an empty rows array', async () => {
    const res = await POST(makeRequest({ rows: [], update_duplicates: false }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('creates new articles and emits article.created', async () => {
    enqueue({ data: { id: 'a1', name: 'Konsulttimme', article_number: null } })
    enqueue({ data: { id: 'a2', name: 'Skruv', article_number: 'A-200' } })

    const res = await POST(makeRequest({
      rows: [row(), row({ row_index: 3, name: 'Skruv', article_number: 'A-200', type: 'vara' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(2)
    expect(body.data.failed).toBe(0)
    expect(mockEmit).toHaveBeenCalledTimes(2)
    // The numberless row gets auto-numbered; the one with A-200 does not.
    expect(mockEnsureArticleNumber).toHaveBeenCalledTimes(1)
  })

  it('skips a duplicate matched by article number when update_duplicates is false', async () => {
    mockFetchAllRows.mockResolvedValue([{ id: 'x', name: 'Existing', article_number: 'A-1' }])

    const res = await POST(makeRequest({
      rows: [row({ article_number: 'A-1' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.skipped).toBe(1)
    expect(body.data.created).toBe(0)
  })

  it('updates a duplicate matched by article number when update_duplicates is true', async () => {
    mockFetchAllRows.mockResolvedValue([{ id: 'x', name: 'Old', article_number: 'A-1' }])
    enqueue({ data: { id: 'x', name: 'New name', article_number: 'A-1' } })

    const res = await POST(makeRequest({
      rows: [row({ article_number: 'A-1', name: 'New name' })],
      update_duplicates: true,
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.updated).toBe(1)
    expect(body.data.created).toBe(0)
  })

  it('matches a duplicate by name (case-insensitive)', async () => {
    mockFetchAllRows.mockResolvedValue([{ id: 'x', name: 'Konsulttimme', article_number: null }])

    const res = await POST(makeRequest({
      rows: [row({ name: 'KONSULTTIMME' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.skipped).toBe(1)
  })

  it('treats a 23505 unique violation as a soft skip', async () => {
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })

    const res = await POST(makeRequest({
      rows: [row({ article_number: 'A-DUP' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.skipped).toBe(1)
    expect(body.data.failed).toBe(0)
  })

  it('drops an inactive/unknown revenue account and records a warning', async () => {
    mockCheckRevenueAccount.mockResolvedValue('activatable')
    enqueue({ data: { id: 'a1', name: 'Konsulttimme', article_number: 'A-1' } })

    const res = await POST(makeRequest({
      rows: [row({ article_number: 'A-1', revenue_account: '3999' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(body.data.warnings.length).toBeGreaterThan(0)
    expect(body.data.warnings[0]).toContain('3999')
  })
})
