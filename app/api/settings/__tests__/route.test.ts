import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, enqueueMany, reset, findCall } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
// The payee write-through is its own unit (lib/cash-accounts/__tests__/invoice-payee.test.ts);
// here it must not consume the queued company_settings results.
vi.mock('@/lib/cash-accounts/invoice-payee', () => ({
  propagateLegacyPayeeWrite: vi.fn().mockResolvedValue(['SEK']),
}))

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

const deadlineMocks = vi.hoisted(() => ({
  regenerate: vi.fn().mockResolvedValue(undefined),
}))

// Mock only the function that writes to the database. The field detector,
// settings normalizer, and regeneration predicate stay real so these tests
// fail if a new tax-relevant field stops triggering regeneration.
vi.mock('@/lib/tax/deadline-generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tax/deadline-generator')>()
  return {
    ...actual,
    regenerateTaxDeadlinesForUser: deadlineMocks.regenerate,
  }
})

import { PUT } from '../route'
import { regenerateTaxDeadlinesForUser } from '@/lib/tax/deadline-generator'

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
      { data: null, count: 5 },                                                // deadlines count (has some -> no regen)
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'New Name' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { company_name: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.company_name).toBe('New Name')
    expect(deadlineMocks.regenerate).not.toHaveBeenCalled()
  })

  it('stores voucher_series_labels with trimmed names and cleared letters stripped', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },      // fetch oldSettings
      { data: { id: 's1', voucher_series_labels: { L: 'Lön' } } },            // update ... returning
      { data: null, count: 5 },                                                // deadlines count
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { voucher_series_labels: { L: ' Lön ', K: '', M: '   ' } },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { voucher_series_labels: Record<string, string> } }>(response)

    expect(status).toBe(200)
    expect(body.data.voucher_series_labels).toEqual({ L: 'Lön' })
    // The row receives the normalized map: the cleared letters never reach the DB.
    expect(findCall('company_settings', 'update')?.[0]).toEqual({ voucher_series_labels: { L: 'Lön' } })
  })

  it('rejects a voucher_series_labels key that is not a single uppercase letter', async () => {
    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { voucher_series_labels: { lön: 'Lön' } },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    expect(response.status).toBe(400)
  })

  it('accepts the mileage_enabled visibility toggle', async () => {
    enqueueMany([
      { data: { entity_type: 'enskild_firma', onboarding_complete: true } }, // fetch oldSettings
      { data: { id: 's1', mileage_enabled: true } },                          // update ... returning
      { data: null, count: 5 },                                               // deadlines count (has some -> no regen)
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { mileage_enabled: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { mileage_enabled: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.mileage_enabled).toBe(true)
    expect(deadlineMocks.regenerate).not.toHaveBeenCalled()
  })

  it('accepts the data_analysis_opt_in consent toggle', async () => {
    enqueueMany([
      { data: { entity_type: 'enskild_firma', onboarding_complete: true } }, // fetch oldSettings
      { data: { id: 's1', data_analysis_opt_in: true } },                     // update ... returning
      { data: null, count: 5 },                                               // deadlines count (has some -> no regen)
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { data_analysis_opt_in: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { data_analysis_opt_in: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.data_analysis_opt_in).toBe(true)
    expect(deadlineMocks.regenerate).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean data_analysis_opt_in value', async () => {
    enqueueMany([
      { data: { onboarding_complete: true } }, // oldSettings
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { data_analysis_opt_in: 'yes' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
  })

  it('round-trips share capital fields and clears them with null', async () => {
    const updates = { aktiekapital: 25000, antal_aktier: 500 }
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { id: 's1', ...updates } },
      { data: null, count: 5 },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: updates,
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: typeof updates }>(response)

    expect(status).toBe(200)
    expect(body.data).toMatchObject(updates)

    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { id: 's1', aktiekapital: null, antal_aktier: null } },
      { data: null, count: 5 },
    ])
    const clearResponse = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { aktiekapital: null, antal_aktier: null },
    }), { params: Promise.resolve({}) })
    const cleared = await parseJsonResponse<{ data: Record<string, unknown> }>(clearResponse)
    expect(cleared.status).toBe(200)
    expect(cleared.body.data.aktiekapital).toBeNull()
    expect(cleared.body.data.antal_aktier).toBeNull()
  })

  it('rejects non-positive aktiekapital and fractional antal_aktier', async () => {
    for (const body of [
      { aktiekapital: 0 },
      { aktiekapital: -25000 },
      { aktiekapital: 25000.5 },
      { antal_aktier: 0 },
      { antal_aktier: 500.5 },
    ]) {
      const response = await PUT(createMockRequest('/api/settings', {
        method: 'PUT',
        body,
      }), { params: Promise.resolve({}) })
      expect((await parseJsonResponse(response)).status).toBe(400)
    }
  })

  it('rejects aktiekapital without antal aktier with a clear message (issue #1137)', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        onboarding_complete: true,
        aktiekapital: null,
        antal_aktier: null,
      },
    })

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { aktiekapital: 25000, antal_aktier: null },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('antal aktier')
    // The guard fired before the update: only the oldSettings fetch ran.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('rejects clearing only one half of a stored share-capital pair', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        onboarding_complete: true,
        aktiekapital: 25000,
        antal_aktier: 500,
      },
    })

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { antal_aktier: null },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('antal aktier')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('allows updating one half when the other half is already stored', async () => {
    enqueueMany([
      {
        data: {
          entity_type: 'aktiebolag',
          onboarding_complete: true,
          aktiekapital: 25000,
          antal_aktier: 500,
        },
      },
      { data: { id: 's1', aktiekapital: 50000, antal_aktier: 500 } },
      { data: null, count: 5 },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { aktiekapital: 50000 },
    }), { params: Promise.resolve({}) })

    expect((await parseJsonResponse(response)).status).toBe(200)
  })

  it('updates invoice email recipients and payment accounts', async () => {
    const updates = {
      invoice_email_cc_addresses: ['info@example.com', 'owner@example.com'],
      invoice_email_bcc_addresses: ['archive@example.com'],
      invoice_payment_accounts: {
        EUR: {
          bank_name: 'Example Bank',
          iban: 'SE0022222222222222222222',
          bic: 'EXAMSESS',
        },
      },
    }
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'admin' } },
      { data: { id: 's1', ...updates } },
      { data: null, count: 5 },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: updates,
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: typeof updates }>(response)

    expect(status).toBe(200)
    expect(body.data).toMatchObject(updates)
  })

  it('rejects fixed invoice recipient changes from a regular member', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'member' }, error: null },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { invoice_email_bcc_addresses: ['archive@example.com'] },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { required_roles?: string[] } }
    }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.details?.required_roles).toEqual(['owner', 'admin'])
    expect(supabase.from.mock.calls.map(([table]) => table)).toEqual([
      'company_settings',
      'company_members',
    ])
  })

  it('rejects invoice payment instruction changes from a regular member', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'member' }, error: null },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: {
        invoice_payment_accounts: {
          SEK: { bankgiro: '123-4567' },
        },
        bankgiro: '123-4567',
      },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { required_roles?: string[] } }
    }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.details?.required_roles).toEqual(['owner', 'admin'])
    expect(supabase.from.mock.calls.map(([table]) => table)).toEqual([
      'company_settings',
      'company_members',
    ])
  })

  it('rejects invalid invoice recipients with otherwise valid payment accounts', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', onboarding_complete: true } })

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: {
        invoice_email_cc_addresses: ['not-an-email'],
        invoice_payment_accounts: {
          EUR: { bank_name: 'Example Bank', iban: 'SE0022222222222222222222' },
        },
      },
    }), { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('rejects a foreign payment account without IBAN with valid recipients', async () => {
    enqueue({ data: { entity_type: 'aktiebolag', onboarding_complete: true } })

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: {
        invoice_email_cc_addresses: ['billing@example.com'],
        invoice_payment_accounts: { EUR: { bank_name: 'Example Bank' } },
      },
    }), { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('regenerates deadlines when unchanged tax settings are saved', async () => {
    const settings = {
      company_id: 'company-1',
      entity_type: 'aktiebolag',
      moms_period: 'monthly',
      f_skatt: true,
      vat_registered: false,
      pays_salaries: false,
      fiscal_year_start_month: 1,
      onboarding_complete: true,
    }
    enqueueMany([
      { data: settings },
      { data: { id: 's1', ...settings } },
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { f_skatt: true, vat_registered: false },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(200)
    expect(deadlineMocks.regenerate).toHaveBeenCalledWith(
      supabase,
      'company-1',
      expect.objectContaining({ entity_type: 'aktiebolag', f_skatt: true }),
    )
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
      { data: null, count: 5 }, // deadlines count (has some -> no regen)
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

  it('regenerates tax deadlines when the company has none yet (self-heal)', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } }, // oldSettings
      {
        data: {
          id: 's1',
          entity_type: 'aktiebolag',
          moms_period: 'quarterly',
          f_skatt: true,
          vat_registered: true,
          pays_salaries: true,
          fiscal_year_start_month: 1,
        },
      }, // update
      { data: null, count: 0 }, // no system deadlines -> self-heal generation
    ])

    // A save with NO tax-relevant field: only the zero-count self-heal path
    // can trigger regeneration here.
    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'Self Heal AB' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(vi.mocked(regenerateTaxDeadlinesForUser)).toHaveBeenCalledOnce()
  })

  it('clears VAT-dependent flags when VAT registration is turned off', async () => {
    const settings = {
      company_id: 'company-1',
      entity_type: 'aktiebolag',
      vat_registered: true,
      vat_number: 'SE556012579001',
      moms_period: 'quarterly',
      vat_taxable_base_over_40m: false,
      vat_has_eu_trade: true,
      periodisk_sammanstallning_enabled: true,
      onboarding_complete: true,
    }
    enqueueMany([
      { data: settings },
      {
        data: {
          ...settings,
          id: 's1',
          vat_registered: false,
          vat_has_eu_trade: false,
          periodisk_sammanstallning_enabled: false,
        },
      },
    ])

    // Without the coercion this request 400s: the stored PS flag stays
    // effective while registration is being switched off.
    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { vat_registered: false },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(deadlineMocks.regenerate).toHaveBeenCalledOnce()
  })

  it('still rejects explicitly enabling the EU sales list without EU trade', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        vat_registered: true,
        vat_number: 'SE556012579001',
        moms_period: 'quarterly',
        vat_has_eu_trade: false,
        onboarding_complete: true,
      },
    })

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { periodisk_sammanstallning_enabled: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
  })

  it('does not regenerate tax deadlines when the company already has some', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } }, // oldSettings
      { data: { id: 's1', entity_type: 'aktiebolag' } },                   // update
      { data: null, count: 12 },                                           // already has deadlines
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'Unchanged Tax' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(vi.mocked(regenerateTaxDeadlinesForUser)).not.toHaveBeenCalled()
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

  it('rejects quarterly VAT when the VAT taxable base is above SEK 40 million', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        vat_registered: true,
        vat_number: 'SE556012579001',
        moms_period: 'quarterly',
        vat_taxable_base_over_40m: false,
        onboarding_complete: true,
      },
    })

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { vat_taxable_base_over_40m: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('allows EU-trade changes with quarterly VAT and regenerates deadlines', async () => {
    const settings = {
      company_id: 'company-1',
      entity_type: 'aktiebolag',
      vat_registered: true,
      vat_number: 'SE556012579001',
      moms_period: 'quarterly',
      vat_taxable_base_over_40m: false,
      vat_has_eu_trade: true,
      onboarding_complete: true,
    }
    enqueueMany([
      { data: { ...settings, vat_has_eu_trade: false } },
      { data: settings },
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { vat_has_eu_trade: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(200)
    expect(deadlineMocks.regenerate).toHaveBeenCalledOnce()
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

  it('accepts the öresavrundning toggle', async () => {
    enqueueMany([
      { data: { onboarding_complete: true } },                              // oldSettings
      { data: { company_id: 'company-1', salary_net_rounding: true } },     // update result
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { salary_net_rounding: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { salary_net_rounding: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.salary_net_rounding).toBe(true)
  })

  it('rejects a non-boolean öresavrundning value', async () => {
    enqueueMany([
      { data: { onboarding_complete: true } }, // oldSettings
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { salary_net_rounding: 'yes' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
  })

  it('allows a bank-details save when stored VAT state is incomplete (bank dialog)', async () => {
    // Pre-existing inconsistency: registered without a VAT number. The invoice
    // bank-details dialog has no VAT fields and must not be blocked by it.
    const settings = {
      entity_type: 'aktiebolag',
      vat_registered: true,
      vat_number: null,
      moms_period: 'quarterly',
      onboarding_complete: true,
    }
    enqueueMany([
      { data: settings },                                         // oldSettings
      { data: { role: 'owner' } },                                // payment-instructions role gate
      { data: { id: 's1', bank_name: 'Testbanken', bankgiro: '223-8194' } }, // update
      { data: null, count: 5 },                                   // deadlines count
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { bank_name: 'Testbanken', bankgiro: '223-8194' },
    }), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('still rejects enabling VAT registration without a VAT number', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        vat_registered: false,
        vat_number: null,
        moms_period: 'quarterly',
        onboarding_complete: true,
      },
    })

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { vat_registered: true },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('Momsregistreringsnummer')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('rejects clearing the VAT number while the company stays registered', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        vat_registered: true,
        vat_number: 'SE556012579001',
        moms_period: 'quarterly',
        onboarding_complete: true,
      },
    })

    // Explicit null is a clear, not an omission: it must not fall back to the
    // stored number during validation.
    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { vat_number: null },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('Momsregistreringsnummer')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('rejects clearing the moms period while the company stays registered', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        vat_registered: true,
        vat_number: 'SE556012579001',
        moms_period: 'quarterly',
        onboarding_complete: true,
      },
    })

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { moms_period: null },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('Momsperiod')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('rejects enabling periodisk sammanställning while the VAT registration is incomplete', async () => {
    enqueue({
      data: {
        entity_type: 'aktiebolag',
        vat_registered: true,
        vat_number: null,
        moms_period: 'quarterly',
        vat_has_eu_trade: true,
        onboarding_complete: true,
      },
    })

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { periodisk_sammanstallning_enabled: true },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('Momsregistreringsnummer')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('allows an unrelated save when a stored 40m/period conflict already exists', async () => {
    // Stored state violates the 40m-monthly rule; a save that touches neither
    // group must still go through.
    enqueueMany([
      {
        data: {
          entity_type: 'aktiebolag',
          vat_registered: true,
          vat_number: 'SE556012579001',
          moms_period: 'quarterly',
          vat_taxable_base_over_40m: true,
          onboarding_complete: true,
        },
      },
      { data: { id: 's1', company_name: 'Testbolaget AB' } }, // update
      { data: null, count: 5 },                               // deadlines count
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'Testbolaget AB' },
    }), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })
})
