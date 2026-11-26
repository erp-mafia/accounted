/**
 * Tests for GET/PATCH/DELETE /api/articles/[id] (artikelregister).
 *
 * DELETE permanently removes only articles that have never been used on an
 * invoice line. PATCH is a sparse update.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

// Route path ids are uuids: the route answers its 404 to anything else before it reads.
const ARTICLE_ID = '672e115f-dd27-5863-afc4-ba0d0f95abcc'

const { supabase, enqueue, reset, calls } = createQueuedMockSupabase()

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

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET, PATCH, DELETE } from '../[id]/route'

describe('GET/PATCH/DELETE /api/articles/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('GET returns 404 when the article is not found', async () => {
    enqueue({ data: null, error: { code: 'PGRST116', message: 'not found' } })

    const response = await GET(createMockRequest(`/api/articles/${ARTICLE_ID}`), createMockRouteParams({ id: ARTICLE_ID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('ARTICLE_NOT_FOUND')
  })

  it('answers 404 for an id that is not a uuid, before any query, on every method', async () => {
    // Postgres refused `new` in the id filter: GET answered INTERNAL_ERROR and
    // DELETE ARTICLE_DELETE_FAILED, both as a 500.
    const params = createMockRouteParams({ id: 'new' })
    const responses = [
      await GET(createMockRequest('/api/articles/new'), params),
      await PATCH(createMockRequest('/api/articles/new', { method: 'PATCH', body: { price_excl_vat: 1500 } }), params),
      await DELETE(createMockRequest('/api/articles/new', { method: 'DELETE' }), params),
    ]

    for (const response of responses) {
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
      expect(status).toBe(404)
      expect(body.error.code).toBe('ARTICLE_NOT_FOUND')
    }
    expect(calls).toEqual([])
  })

  it('PATCH updates a field and returns the row', async () => {
    enqueue({ data: { id: ARTICLE_ID, name: 'Konsulttimme', price_excl_vat: 1500 } })

    const request = createMockRequest(`/api/articles/${ARTICLE_ID}`, {
      method: 'PATCH',
      body: { price_excl_vat: 1500 },
    })

    const response = await PATCH(request, createMockRouteParams({ id: ARTICLE_ID }))
    const { status, body } = await parseJsonResponse<{ data: { price_excl_vat: number } }>(response)

    expect(status).toBe(200)
    expect(body.data.price_excl_vat).toBe(1500)
  })

  // The article detail page's Inaktivera/Aktivera button sends nothing but the
  // flag, so an active-only body must be a valid sparse update on its own.
  it('PATCH toggles active on its own without any other field', async () => {
    enqueue({ data: { id: ARTICLE_ID, name: 'Konsulttimme', active: false } })

    const request = createMockRequest(`/api/articles/${ARTICLE_ID}`, {
      method: 'PATCH',
      body: { active: false },
    })

    const response = await PATCH(request, createMockRouteParams({ id: ARTICLE_ID }))
    const { status, body } = await parseJsonResponse<{ data: { active: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.active).toBe(false)
    // Only the articles update: no revenue-account lookup is triggered by a
    // body that carries nothing but the flag.
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('articles')
  })

  it('PATCH answers ACCOUNTS_NOT_IN_CHART for a BAS class-3 account missing from the chart', async () => {
    // chart_of_accounts lookup: no row, but 3999 is a known BAS class-3
    // account → activatable via the activate-and-retry dialog flow.
    enqueue({ data: null })

    const request = createMockRequest(`/api/articles/${ARTICLE_ID}`, {
      method: 'PATCH',
      body: { revenue_account: '3999' },
    })

    const response = await PATCH(request, createMockRouteParams({ id: ARTICLE_ID }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; account_numbers: string[] }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.account_numbers).toEqual(['3999'])
  })

  it('PATCH rejects a 3xxx revenue_account unknown to both chart and BAS catalogue', async () => {
    // No chart row and 3041 is not in the BAS reference → invalid, no dialog.
    enqueue({ data: null })

    const request = createMockRequest(`/api/articles/${ARTICLE_ID}`, {
      method: 'PATCH',
      body: { revenue_account: '3041' },
    })

    const response = await PATCH(request, createMockRouteParams({ id: ARTICLE_ID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ARTICLE_REVENUE_ACCOUNT_INVALID')
  })

  it('DELETE returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await DELETE(
      createMockRequest(`/api/articles/${ARTICLE_ID}`, { method: 'DELETE' }),
      createMockRouteParams({ id: ARTICLE_ID }),
    )

    expect(response.status).toBe(401)
  })

  it('DELETE returns 404 when the article is not found', async () => {
    enqueue({ data: null, error: { code: 'PGRST116', message: 'not found' } })

    const response = await DELETE(
      createMockRequest(`/api/articles/${ARTICLE_ID}`, { method: 'DELETE' }),
      createMockRouteParams({ id: ARTICLE_ID }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('ARTICLE_NOT_FOUND')
  })

  it('DELETE rejects an article used on an invoice line', async () => {
    enqueue({ data: { id: ARTICLE_ID }, error: null })
    enqueue({ data: null, error: null, count: 1 })

    const response = await DELETE(
      createMockRequest(`/api/articles/${ARTICLE_ID}`, { method: 'DELETE' }),
      createMockRouteParams({ id: ARTICLE_ID }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('ARTICLE_IN_USE')
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('DELETE permanently removes an unused article', async () => {
    enqueue({ data: { id: ARTICLE_ID }, error: null })
    enqueue({ data: null, error: null, count: 0 })
    enqueue({ data: null, error: null, count: 1 })

    const emitSpy = vi.spyOn(eventBus, 'emit')
    const response = await DELETE(
      createMockRequest(`/api/articles/${ARTICLE_ID}`, { method: 'DELETE' }),
      createMockRouteParams({ id: ARTICLE_ID }),
    )
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(supabase.from).toHaveBeenNthCalledWith(1, 'articles')
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'invoice_items')
    expect(supabase.from).toHaveBeenNthCalledWith(3, 'articles')
    expect(emitSpy).toHaveBeenCalledWith({
      type: 'article.deleted',
      payload: { articleId: ARTICLE_ID, companyId: 'company-1', userId: 'user-1' },
    })
  })
})

describe('DELETE usage-check query shape', () => {
  it('must not filter invoice_items by company_id (column does not exist)', async () => {
    // Regression pin for a support case: invoice_items has no
    // company_id column, so filtering on it made PostgREST answer 42703 and
    // the route mapped that to ARTICLE_DELETE_FAILED for EVERY delete. The
    // queued supabase mock swallows chained filters, so no behavioral mock
    // test can catch a phantom column: pin the source instead. Tenancy is
    // enforced by the preceding articles lookup.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(path.resolve(__dirname, '../[id]/route.ts'), 'utf8')
    const usageBlock = src.slice(src.indexOf("from('invoice_items')"))
    const firstQuery = usageBlock.slice(0, usageBlock.indexOf('usageError'))
    expect(firstQuery).not.toContain("eq('company_id'")
  })
})
