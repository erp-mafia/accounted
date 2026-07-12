/**
 * Tests for GET/POST /api/articles (artikelregister).
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: list, validation (400), revenue-account guard (400),
 * and the happy-path create with auto-numbering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

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

import { GET, POST } from '../route'

describe('GET/POST /api/articles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('GET lists the company articles', async () => {
    enqueue({ data: [{ id: 'a1', name: 'Konsulttimme' }, { id: 'a2', name: 'Licens' }] })

    const response = await GET(createMockRequest('/api/articles'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
  })

  it('POST rejects an invalid body (missing name) with 400', async () => {
    const request = createMockRequest('/api/articles', {
      method: 'POST',
      body: { price_excl_vat: 100 },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('POST rejects a 3xxx revenue_account unknown to both chart and BAS catalogue', async () => {
    // Non-3xxx numbers are already stopped by the Zod schema; the route-level
    // 'invalid' branch covers 3xxx numbers that exist nowhere, no chart row
    // and not in the BAS reference (3041 is not a BAS 2026 account).
    enqueue({ data: null })

    const request = createMockRequest('/api/articles', {
      method: 'POST',
      body: { name: 'Frakt', price_excl_vat: 100, revenue_account: '3041' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ARTICLE_REVENUE_ACCOUNT_INVALID')
  })

  it('POST answers ACCOUNTS_NOT_IN_CHART for a BAS class-3 account missing from the chart', async () => {
    // No chart row, but 3999 is a known BAS class-3 account → activatable, so
    // the client can run the activate-and-retry dialog flow.
    enqueue({ data: null })

    const request = createMockRequest('/api/articles', {
      method: 'POST',
      body: { name: 'Frakt', price_excl_vat: 100, revenue_account: '3999' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      error: { code: string; account_numbers: string[] }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.account_numbers).toEqual(['3999'])
  })

  it('POST answers ACCOUNTS_NOT_IN_CHART for an inactive class-3 chart account', async () => {
    enqueue({ data: { account_class: 3, is_active: false } })

    const request = createMockRequest('/api/articles', {
      method: 'POST',
      body: { name: 'Frakt', price_excl_vat: 100, revenue_account: '3001' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
  })

  it('POST accepts a revenue_account that is active class 3 in the chart', async () => {
    // 1st DB hit: chart_of_accounts lookup → active class-3 row.
    enqueue({ data: { account_class: 3, is_active: true } })
    // 2nd DB hit: insert ... returning the row.
    enqueue({ data: { id: 'a1', name: 'Frakt', article_number: '3', revenue_account: '3001' } })

    const request = createMockRequest('/api/articles', {
      method: 'POST',
      body: { name: 'Frakt', price_excl_vat: 100, revenue_account: '3001' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { revenue_account: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.revenue_account).toBe('3001')
  })

  it('POST creates an article and auto-assigns a number', async () => {
    // 1st DB hit: insert ... returning the row (article_number still null).
    enqueue({ data: { id: 'a1', name: 'Konsulttimme', article_number: null, type: 'tjanst', vat_rate: 25 } })
    // 2nd DB hit: generate_article_number RPC returns the assigned number.
    enqueue({ data: '7' })

    const request = createMockRequest('/api/articles', {
      method: 'POST',
      body: { name: 'Konsulttimme', price_excl_vat: 1200, vat_rate: 25 },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { id: string; article_number: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('a1')
    expect(body.data.article_number).toBe('7')
  })
})
