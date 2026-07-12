import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, enqueueMany, reset } = createQueuedMockSupabase()

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

vi.mock('@/lib/tax/deadline-generator', () => ({
  didTaxFieldsChange: vi.fn().mockReturnValue(false),
  regenerateTaxDeadlinesForUser: vi.fn().mockResolvedValue(undefined),
}))

import { PUT } from '../route'

describe('PUT /api/settings', () => {
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

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'New Name' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'New Name' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
  })

  it('updates the settings on the happy path', async () => {
    enqueueMany([
      { data: { entity_type: 'enskild_firma', onboarding_complete: false } }, // fetch oldSettings
      { data: { id: 's1', company_name: 'New Name' } },                        // update ... returning
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'New Name' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { company_name: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.company_name).toBe('New Name')
  })
})
