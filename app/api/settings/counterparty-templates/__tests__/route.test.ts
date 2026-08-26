import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

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

const findCounterpartyTemplateMock = vi.fn()
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  findCounterpartyTemplate: (...args: unknown[]) => findCounterpartyTemplateMock(...args),
}))

import { GET, DELETE } from '../route'

describe('GET /api/settings/counterparty-templates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/settings/counterparty-templates')
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('lists active templates without a counterparty param', async () => {
    enqueue({ data: [{ id: 't1', counterparty_name: 'anthropic' }], error: null })

    const request = createMockRequest('/api/settings/counterparty-templates')
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string }> }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(findCounterpartyTemplateMock).not.toHaveBeenCalled()
  })

  it('runs the tiered matcher against a name probe in counterparty mode', async () => {
    findCounterpartyTemplateMock.mockResolvedValue({
      template: { id: 't1', counterparty_name: 'circle k', debit_account: '5611', credit_account: '1930' },
      matchMethod: 'exact_normalized',
      confidence: 0.9,
    })

    const request = createMockRequest('/api/settings/counterparty-templates?counterparty=Circle%20K')
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { template: { debit_account: string }; match_method: string; confidence: number }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.template.debit_account).toBe('5611')
    expect(body.data.match_method).toBe('exact_normalized')
    expect(body.data.confidence).toBe(0.9)
    const probe = findCounterpartyTemplateMock.mock.calls[0][2] as { description: string }
    expect(probe.description).toBe('Circle K')
  })

  it('returns null data when the matcher finds nothing', async () => {
    findCounterpartyTemplateMock.mockResolvedValue(null)

    const request = createMockRequest('/api/settings/counterparty-templates?counterparty=Unknown')
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: null }>(response)

    expect(status).toBe(200)
    expect(body.data).toBeNull()
  })

  it('rejects an oversized counterparty name', async () => {
    const request = createMockRequest(
      `/api/settings/counterparty-templates?counterparty=${'a'.repeat(201)}`
    )
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(findCounterpartyTemplateMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/settings/counterparty-templates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/settings/counterparty-templates', {
      method: 'DELETE',
      body: { id: 't1' },
    })
    const response = await DELETE(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/settings/counterparty-templates', {
      method: 'DELETE',
      body: { id: 't1' },
    })
    const response = await DELETE(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
  })

  it('soft-deletes the template on the happy path', async () => {
    enqueue({ error: null }) // update is_active: false

    const request = createMockRequest('/api/settings/counterparty-templates', {
      method: 'DELETE',
      body: { id: 't1' },
    })
    const response = await DELETE(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { success: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
  })
})
