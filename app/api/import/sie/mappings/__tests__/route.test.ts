/**
 * Tests for GET/POST/PUT/DELETE /api/import/sie/mappings.
 *
 * Exercises the routes through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, 403 viewer, validation (400), and happy paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
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

const saveMappingsMock = vi.fn()
vi.mock('@/lib/import/sie-import', () => ({
  saveMappings: (...args: unknown[]) => saveMappingsMock(...args),
}))

import { GET, POST, PUT, DELETE } from '../route'

const emptyParams = { params: Promise.resolve({}) }

describe('/api/import/sie/mappings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    saveMappingsMock.mockResolvedValue(undefined)
  })

  it('POST returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings: [] },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
  })

  it('POST returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings: [] },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('POST rejects a non-array mappings payload with 400', async () => {
    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings: 'not-an-array' },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Invalid mappings data')
  })

  it('POST saves the mappings', async () => {
    const mappings = [{ sourceAccount: '1920', targetAccount: '1930' }]
    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'POST',
      body: { mappings },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(saveMappingsMock).toHaveBeenCalledWith(supabase, 'user-1', mappings)
  })

  it('GET lists the saved mappings', async () => {
    enqueue({ data: [{ source_account: '1920', target_account: '1930' }] })

    const response = await GET(createMockRequest('/api/import/sie/mappings'), emptyParams)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
  })

  it('PUT rejects a body missing targetAccount with 400', async () => {
    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1920' },
    })

    const response = await PUT(request, emptyParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('PUT upserts a single mapping', async () => {
    enqueue({ data: { source_account: '1920', target_account: '1930' } })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'PUT',
      body: { sourceAccount: '1920', targetAccount: '1930' },
    })

    const response = await PUT(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ data: { target_account: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.target_account).toBe('1930')
  })

  it('DELETE returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/import/sie/mappings', { method: 'DELETE' })

    const response = await DELETE(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('DELETE removes a specific mapping', async () => {
    enqueue({ data: null })

    const request = createMockRequest('/api/import/sie/mappings', {
      method: 'DELETE',
      searchParams: { sourceAccount: '1920' },
    })

    const response = await DELETE(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })
})
