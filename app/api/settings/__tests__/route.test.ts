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

  it('updates all three reminder thresholds', async () => {
    enqueueMany([
      {
        data: {
          entity_type: 'aktiebolag',
          onboarding_complete: true,
          reminder_days_level_1: 15,
          reminder_days_level_2: 30,
          reminder_days_level_3: 45,
        },
      },
      {
        data: {
          id: 's1',
          reminder_days_level_1: 7,
          reminder_days_level_2: 21,
          reminder_days_level_3: 35,
        },
      },
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: {
        reminder_days_level_1: 7,
        reminder_days_level_2: 21,
        reminder_days_level_3: 35,
      },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { reminder_days_level_1: number; reminder_days_level_2: number; reminder_days_level_3: number }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      reminder_days_level_1: 7,
      reminder_days_level_2: 21,
      reminder_days_level_3: 35,
    })
  })

  it('returns 400 when reminder thresholds are not increasing', async () => {
    enqueue({
      data: {
        reminder_days_level_1: 15,
        reminder_days_level_2: 30,
        reminder_days_level_3: 45,
      },
    })

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: {
        reminder_days_level_1: 30,
        reminder_days_level_2: 20,
        reminder_days_level_3: 45,
      },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('returns 404 when the settings row does not exist', async () => {
    enqueueMany([
      { data: { onboarding_complete: false } },
      { data: null, error: { code: 'PGRST116', message: 'No rows returned' } },
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { reminder_days_level_1: 10 },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('blocks a vacation-year basis change while open balances exist', async () => {
    enqueueMany([
      { data: { salary_vacation_year_basis: 'calendar', onboarding_complete: true } }, // oldSettings
      { data: null, count: 2 },                                                            // open-rows count
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { salary_vacation_year_basis: 'statutory_apr_mar' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    // The guard consumed the count result and the update never ran.
    expect(supabase.from.mock.calls.map(([table]) => table)).toEqual([
      'company_settings',
      'employee_vacation_balances',
    ])
  })

  it('fails closed when the open-balances guard query errors', async () => {
    enqueueMany([
      { data: { salary_vacation_year_basis: 'calendar', onboarding_complete: true } }, // oldSettings
      { data: null, count: null, error: { message: 'connection reset' } },                 // guard query fails
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { salary_vacation_year_basis: 'statutory_apr_mar' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
    // The 500 must come from the guard, not from company_settings.update()
    // swallowing the queued error: the guard query ran and no second
    // company_settings query followed it.
    expect(supabase.from.mock.calls.map(([table]) => table)).toEqual([
      'company_settings',
      'employee_vacation_balances',
    ])
  })
})
