import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

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
import type { ArticleImportExecuteResult } from '@/lib/import/articles/types'

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

const noParams = { params: Promise.resolve({}) }
/** The route's two arguments: the request and the (empty) segment params. */
const req = (body: unknown) => [makeRequest(body), noParams] as const

type ExecBody = { data: ArticleImportExecuteResult }

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
    const res = await POST(...req({ rows: [row()], update_duplicates: false }))
    const { status } = await parseJsonResponse<ExecBody>(res)
    expect(status).toBe(401)
  })

  it('returns 400 for an empty rows array', async () => {
    const res = await POST(...req({ rows: [], update_duplicates: false }))
    const { status } = await parseJsonResponse<ExecBody>(res)
    expect(status).toBe(400)
  })

  it('creates new articles in one insert statement and emits article.created', async () => {
    enqueue({
      data: [
        { id: 'a1', name: 'Konsulttimme', article_number: null },
        { id: 'a2', name: 'Skruv', article_number: 'A-200' },
      ],
    })

    const res = await POST(...req({
      rows: [row(), row({ row_index: 3, name: 'Skruv', article_number: 'A-200', type: 'vara' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(2)
    expect(body.data.failed).toBe(0)
    expect(mockEmit).toHaveBeenCalledTimes(2)
    // One statement for the batch, not one round trip per row (crm#1383).
    const inserts = findCalls('articles', 'insert')
    expect(inserts).toHaveLength(1)
    expect((inserts[0][0] as { name: string }[]).map((r) => r.name)).toEqual(['Konsulttimme', 'Skruv'])
    // The numberless row gets auto-numbered; the one with A-200 does not.
    expect(mockEnsureArticleNumber).toHaveBeenCalledTimes(1)
    // The run is recorded so the import can be undone from the history.
    expect(findCall('register_import_runs', 'insert')).toEqual([
      { company_id: 'company-1', user_id: 'user-1', kind: 'articles', created_ids: ['a1', 'a2'], updated_rows: [] },
    ])
  })

  it('skips a duplicate matched by article number when update_duplicates is false', async () => {
    mockFetchAllRows.mockResolvedValue([{ id: 'x', name: 'Existing', article_number: 'A-1' }])

    const res = await POST(...req({
      rows: [row({ article_number: 'A-1' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.skipped).toBe(1)
    expect(body.data.created).toBe(0)
  })

  it('updates a duplicate matched by article number when update_duplicates is true', async () => {
    mockFetchAllRows.mockResolvedValue([{ id: 'x', name: 'Old', article_number: 'A-1' }])
    enqueue({ data: { id: 'x', name: 'New name', article_number: 'A-1' } })

    const res = await POST(...req({
      rows: [row({ article_number: 'A-1', name: 'New name' })],
      update_duplicates: true,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.updated).toBe(1)
    expect(body.data.created).toBe(0)
    // The run keeps what the update changed, so an undo can put it back.
    expect(findCall('register_import_runs', 'insert')).toEqual([
      {
        company_id: 'company-1',
        user_id: 'user-1',
        kind: 'articles',
        created_ids: [],
        updated_rows: [{ id: 'x', before: { name: 'Old' }, after: { name: 'New name' } }],
      },
    ])
  })

  it('matches a duplicate by name (case-insensitive)', async () => {
    mockFetchAllRows.mockResolvedValue([{ id: 'x', name: 'Konsulttimme', article_number: null }])

    const res = await POST(...req({
      rows: [row({ name: 'KONSULTTIMME' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.skipped).toBe(1)
  })

  it('treats a 23505 unique violation as a soft skip', async () => {
    // The batch statement fails as a whole, then the row is written alone.
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })

    const res = await POST(...req({
      rows: [row({ article_number: 'A-DUP' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.skipped).toBe(1)
    expect(body.data.failed).toBe(0)
  })

  it('drops an inactive/unknown revenue account and records a warning', async () => {
    mockCheckRevenueAccount.mockResolvedValue('activatable')
    enqueue({ data: [{ id: 'a1', name: 'Konsulttimme', article_number: 'A-1' }] })

    const res = await POST(...req({
      rows: [row({ article_number: 'A-1', revenue_account: '3999' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(body.data.warnings.length).toBeGreaterThan(0)
    expect(body.data.warnings[0]).toContain('3999')
  })
})

describe('POST /api/import/articles/execute large batches (crm#1383)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
    mockCheckRevenueAccount.mockResolvedValue('ok')
    mockEnsureArticleNumber.mockResolvedValue('AUTO-1')
  })

  it('writes 1 200 new articles in three statements of at most 500', async () => {
    const many = Array.from({ length: 1200 }, (_, i) =>
      row({ row_index: i + 2, name: `Artikel ${i}`, article_number: `N-${i}` }),
    )
    for (const size of [500, 500, 200]) {
      enqueue({ data: Array.from({ length: size }, (_, i) => ({ id: `id-${size}-${i}`, name: 'x', article_number: 'n' })) })
    }

    const res = await POST(...req({ rows: many, update_duplicates: false }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1200)
    expect(findCalls('articles', 'insert').map((c) => (c[0] as unknown[]).length)).toEqual([500, 500, 200])
    expect(mockEnsureArticleNumber).not.toHaveBeenCalled()
  })

  it('finds the failing row by writing the slice row by row when the statement fails', async () => {
    enqueue({ data: null, error: { code: '23514', message: 'check violation' } })
    enqueue({ data: { id: 'a1', name: 'Bra', article_number: 'A-1' } })
    enqueue({ data: null, error: { code: '23514', message: 'check violation' } })

    const res = await POST(...req({
      rows: [
        row({ name: 'Bra', article_number: 'A-1' }),
        row({ row_index: 3, name: 'Trasig', article_number: 'A-2' }),
      ],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(body.data.failed).toBe(1)
    expect(body.data.errors[0]).toMatchObject({ row_index: 3, name: 'Trasig' })
  })

  it('folds a later row for an article the batch creates into the same insert', async () => {
    enqueue({ data: [{ id: 'a1', name: 'Skruv', article_number: 'A-1' }] })

    const res = await POST(...req({
      rows: [
        row({ name: 'Skruv', article_number: 'A-1', price_excl_vat: 10 }),
        row({ row_index: 3, name: 'Skruv', article_number: 'A-1', price_excl_vat: 12 }),
      ],
      update_duplicates: true,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(body.data.updated).toBe(1)
    const inserts = findCalls('articles', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toEqual([expect.objectContaining({ article_number: 'A-1', price_excl_vat: 12 })])
  })

  it('updates an existing article named by two rows once, with the later values', async () => {
    mockFetchAllRows.mockResolvedValue([{ id: 'x', name: 'Skruv', article_number: 'A-1', price_excl_vat: 5 }])
    enqueue({ data: { id: 'x', name: 'Skruv', article_number: 'A-1', price_excl_vat: 12 } })

    const res = await POST(...req({
      rows: [
        row({ name: 'Skruv', article_number: 'A-1', price_excl_vat: 10 }),
        row({ row_index: 3, name: 'Skruv', article_number: 'A-1', price_excl_vat: 12 }),
      ],
      update_duplicates: true,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.updated).toBe(2)
    const updates = findCalls('articles', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toMatchObject({ price_excl_vat: 12 })
  })

  it('updates existing articles in one upsert on the primary key, not one call per row', async () => {
    const existing = [
      { id: 'x', name: 'Skruv', article_number: 'A-1' },
      { id: 'y', name: 'Mutter', article_number: 'A-2' },
    ]
    const stored = existing.map((a) => ({ ...a, company_id: 'company-1', user_id: 'owner-1', price_excl_vat: 5 }))
    mockFetchAllRows.mockResolvedValueOnce(existing).mockResolvedValueOnce(stored)
    enqueue({
      data: [
        { ...stored[0], price_excl_vat: 10 },
        { ...stored[1], price_excl_vat: 20 },
      ],
    })

    const res = await POST(...req({
      rows: [
        row({ name: 'Skruv', article_number: 'A-1', price_excl_vat: 10 }),
        row({ row_index: 3, name: 'Mutter', article_number: 'A-2', price_excl_vat: 20 }),
      ],
      update_duplicates: true,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(body.data.updated).toBe(2)
    expect(body.data.failed).toBe(0)
    expect(findCalls('articles', 'update')).toHaveLength(0)
    const upserts = findCalls('articles', 'upsert')
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toEqual([
      [
        { id: 'x', company_id: 'company-1', user_id: 'owner-1', name: 'Skruv', price_excl_vat: 10 },
        { id: 'y', company_id: 'company-1', user_id: 'owner-1', name: 'Mutter', price_excl_vat: 20 },
      ],
      { onConflict: 'id' },
    ])
    // The undo still gets what changed, from the rows the upsert returned.
    expect(findCall('register_import_runs', 'insert')?.[0]).toMatchObject({
      updated_rows: [
        { id: 'x', before: { price_excl_vat: 5 }, after: { price_excl_vat: 10 } },
        { id: 'y', before: { price_excl_vat: 5 }, after: { price_excl_vat: 20 } },
      ],
    })
  })

  it('reports the failing row with its file line when the upsert statement fails', async () => {
    const existing = [
      { id: 'x', name: 'Skruv', article_number: 'A-1' },
      { id: 'y', name: 'Mutter', article_number: 'A-2' },
    ]
    const stored = existing.map((a) => ({ ...a, company_id: 'company-1', user_id: 'owner-1', price_excl_vat: 5 }))
    mockFetchAllRows.mockResolvedValueOnce(existing).mockResolvedValueOnce(stored)
    enqueue({ data: null, error: { code: '23514', message: 'check violation' } })
    enqueue({ data: { ...stored[0], price_excl_vat: 10 } })
    enqueue({ data: null, error: { code: '23514', message: 'check violation' } })

    const res = await POST(...req({
      rows: [
        row({ name: 'Skruv', article_number: 'A-1', price_excl_vat: 10 }),
        row({ row_index: 3, name: 'Mutter', article_number: 'A-2', price_excl_vat: 20 }),
      ],
      update_duplicates: true,
    }))
    const { status, body } = await parseJsonResponse<ExecBody>(res)

    expect(status).toBe(200)
    expect(findCalls('articles', 'upsert')).toHaveLength(1)
    expect(findCalls('articles', 'update')).toHaveLength(2)
    expect(body.data.updated).toBe(1)
    expect(body.data.failed).toBe(1)
    expect(body.data.errors).toEqual([expect.objectContaining({ row_index: 3, name: 'Mutter' })])
  })

  it('reads for the undo only the rows it updates, and nothing when it only creates', async () => {
    enqueue({ data: [{ id: 'a1', name: 'Ny', article_number: 'A-9' }] })
    await POST(...req({ rows: [row({ name: 'Ny', article_number: 'A-9' })], update_duplicates: true }))
    // The existing-article read only: no snapshot when nothing is updated.
    expect(mockFetchAllRows).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/import/articles/execute currency handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
    mockCheckRevenueAccount.mockResolvedValue('ok')
    mockEnsureArticleNumber.mockResolvedValue('AUTO-1')
  })

  it('imports a valid Valuta code and defaults missing to SEK', async () => {
    // First queued result: lazy currencies reference read.
    enqueue({ data: [{ code: 'SEK' }, { code: 'EUR' }, { code: 'USD' }] })
    enqueue({
      data: [
        { id: 'a1', name: 'EU-tjanst', article_number: 'A-1', currency: 'EUR' },
        { id: 'a2', name: 'Svensk tjanst', article_number: 'A-2', currency: 'SEK' },
      ],
    })

    const res = await POST(...req({
      rows: [
        row({ name: 'EU-tjanst', article_number: 'A-1', currency: 'EUR' }),
        row({ row_index: 3, name: 'Svensk tjanst', article_number: 'A-2', currency: null }),
      ],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse<{ data: { created: number; warnings: string[] } }>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(2)
    expect(body.data.warnings).toEqual([])

    const inserts = mockSupabase.from.mock.calls.filter((c: unknown[]) => c[0] === 'articles')
    expect(inserts.length).toBeGreaterThan(0)
  })

  it('drops a code missing from the currencies table with a warning', async () => {
    enqueue({ data: [{ code: 'SEK' }, { code: 'EUR' }] })
    enqueue({ data: [{ id: 'a1', name: 'X', article_number: 'A-1', currency: 'SEK' }] })

    const res = await POST(...req({
      rows: [row({ article_number: 'A-1', currency: 'XXX' })],
      update_duplicates: false,
    }))
    const { status, body } = await parseJsonResponse<{ data: { warnings: string[] } }>(res)

    expect(status).toBe(200)
    expect(body.data.warnings.some((w) => w.includes('XXX'))).toBe(true)
  })

  it('rejects a malformed currency shape at validation', async () => {
    const res = await POST(...req({
      rows: [row({ currency: 'EURO' })],
      update_duplicates: false,
    }))
    const { status } = await parseJsonResponse<ExecBody>(res)
    expect(status).toBe(400)
  })
})
