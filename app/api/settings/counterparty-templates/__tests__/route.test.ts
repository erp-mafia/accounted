import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

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

import { GET, DELETE, PATCH } from '../route'

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

describe('PATCH /api/settings/counterparty-templates', () => {
  const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111'
  const TWIN_ID = '22222222-2222-4222-8222-222222222222'
  const existing = {
    id: TEMPLATE_ID,
    company_id: 'company-1',
    counterparty_name: 'spotify ab stockholm 4471',
    counterparty_aliases: ['spotify ab stockholm 4471 kortköp'],
    is_active: true,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  function patch(body: unknown) {
    const request = createMockRequest('/api/settings/counterparty-templates', {
      method: 'PATCH',
      body,
    })
    return PATCH(request, { params: Promise.resolve({}) })
  }

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await parseJsonResponse(await patch({ id: TEMPLATE_ID, counterparty_name: 'Spotify' }))
    expect(status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const { status } = await parseJsonResponse(await patch({ id: TEMPLATE_ID, counterparty_name: 'Spotify' }))
    expect(status).toBe(403)
  })

  it('returns 400 for an empty name', async () => {
    const { status } = await parseJsonResponse(await patch({ id: TEMPLATE_ID, counterparty_name: '   ' }))
    expect(status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for a name that is too long', async () => {
    const { status } = await parseJsonResponse(
      await patch({ id: TEMPLATE_ID, counterparty_name: 'a'.repeat(101) }),
    )
    expect(status).toBe(400)
  })

  it('returns 400 for a one-character name', async () => {
    const { status } = await parseJsonResponse(await patch({ id: TEMPLATE_ID, counterparty_name: 'S' }))
    expect(status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 when the template is not in the active company', async () => {
    enqueue({ data: null }) // lookup by id + company

    const { status } = await parseJsonResponse(await patch({ id: TEMPLATE_ID, counterparty_name: 'Spotify' }))
    expect(status).toBe(404)
    expect(findCall('categorization_templates', 'update')).toBeUndefined()
  })

  it('returns 409 when another active template already has the name', async () => {
    enqueue({ data: existing }) // lookup by id
    enqueue({ data: { id: TWIN_ID, is_active: true } }) // twin lookup

    const { status } = await parseJsonResponse(await patch({ id: TEMPLATE_ID, counterparty_name: 'Spotify' }))
    expect(status).toBe(409)
    expect(findCall('categorization_templates', 'update')).toBeUndefined()
  })

  it('removes a soft-deleted twin instead of refusing the rename', async () => {
    enqueue({ data: existing }) // lookup by id
    enqueue({ data: { id: TWIN_ID, is_active: false } }) // inactive twin
    enqueue({ error: null }) // delete twin
    enqueue({ data: { ...existing, counterparty_name: 'spotify' } }) // update

    const { status } = await parseJsonResponse(await patch({ id: TEMPLATE_ID, counterparty_name: 'Spotify' }))
    expect(status).toBe(200)
    expect(findCall('categorization_templates', 'delete')).toBeDefined()
    expect(findCall('categorization_templates', 'update')).toBeDefined()
  })

  it('renames, lowercases the key and keeps the old name as an alias', async () => {
    enqueue({ data: existing }) // lookup by id
    enqueue({ data: null }) // no twin
    enqueue({
      data: {
        ...existing,
        counterparty_name: 'spotify',
        counterparty_aliases: [...existing.counterparty_aliases, existing.counterparty_name],
      },
    }) // update

    const { status, body } = await parseJsonResponse<{
      data: { counterparty_name: string; counterparty_aliases: string[] }
    }>(await patch({ id: TEMPLATE_ID, counterparty_name: '  Spotify  ' }))

    expect(status).toBe(200)
    expect(body.data.counterparty_name).toBe('spotify')
    const payload = findCall('categorization_templates', 'update')?.[0] as {
      counterparty_name: string
      counterparty_aliases: string[]
    }
    expect(payload.counterparty_name).toBe('spotify')
    expect(payload.counterparty_aliases).toContain('spotify ab stockholm 4471')
    expect(payload.counterparty_aliases).toContain('spotify ab stockholm 4471 kortköp')
    expect(findCall('categorization_templates', 'delete')).toBeUndefined()
  })

  it('returns 409 when the update loses the race on the unique name', async () => {
    enqueue({ data: existing }) // lookup by id
    enqueue({ data: null }) // no twin at check time
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key value' } }) // update

    const { status } = await parseJsonResponse(await patch({ id: TEMPLATE_ID, counterparty_name: 'Spotify' }))
    expect(status).toBe(409)
  })

  it('is a no-op when the name is unchanged', async () => {
    enqueue({ data: existing }) // lookup by id

    const { status } = await parseJsonResponse(
      await patch({ id: TEMPLATE_ID, counterparty_name: 'Spotify AB Stockholm 4471' }),
    )
    expect(status).toBe(200)
    expect(findCall('categorization_templates', 'update')).toBeUndefined()
  })
})
