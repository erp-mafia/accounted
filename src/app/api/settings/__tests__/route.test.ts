import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, enqueueMany, reset, findCall, findCalls } = createQueuedMockSupabase()

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
const isAdminMock = vi.fn()
// The real envelope builder stays: only the database predicate is mocked.
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return {
    requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
    isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
    // The operations' owner/admin gate (lib/operations/access.ts) reads the
    // caller's company_members row: real, against the queued mock.
    getCompanyRole: actual.getCompanyRole,
    companyAdminRequiredResponse: actual.companyAdminRequiredResponse,
  }
})

// The accounting method correction record goes to audit_log with the service role.
const auditInsert = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>()
  return { ...actual, createServiceClient: () => ({ from: () => ({ insert: auditInsert }) }) }
})

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

// The company's Stripe customer (crm#1378). Called only for a company with a
// subscription row whose identity columns moved.
const stripeMocks = vi.hoisted(() => ({
  update: vi.fn(),
  listTaxIds: vi.fn(),
  createTaxId: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    customers: {
      update: stripeMocks.update,
      listTaxIds: stripeMocks.listTaxIds,
      createTaxId: stripeMocks.createTaxId,
    },
  }),
}))

import { PUT } from '../route'
import { regenerateTaxDeadlinesForUser } from '@/lib/tax/deadline-generator'
import { STANDARD_VOUCHER_SERIES_MAP } from '@/lib/bookkeeping/voucher-series-resolver'

describe('PUT /api/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
    isAdminMock.mockResolvedValue(true)
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

  // company_settings is owner/admin only in RLS. The route used to gate on
  // requireWrite: a `member` reached the UPDATE, matched zero rows and was
  // told 404 "Inställningarna hittades inte."
  it('returns 403 for anyone who is not owner or admin, before touching the table', async () => {
    isAdminMock.mockResolvedValue(false)

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'New Name' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
    expect(isAdminMock).toHaveBeenCalledWith(supabase, 'company-1')
    expect(supabase.from).not.toHaveBeenCalled()
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

  // accounted#104: a pending reminder batch can no longer be approved once
  // reminders are off; it used to wait in Att göra for the next cron sweep.
  describe('turning reminders off', () => {
    const put = (body: Record<string, unknown>) =>
      PUT(createMockRequest('/api/settings', { method: 'PUT', body }), { params: Promise.resolve({}) })

    it("withdraws the company's pending reminder batch as the cron would", async () => {
      enqueueMany([
        { data: { send_invoice_reminders: true } },            // fetch oldSettings
        { data: { id: 's1', send_invoice_reminders: false } }, // update ... returning
        { data: [{ id: 'op-1' }] },                            // pending_operations withdrawal
        { data: null, count: 5 },                              // deadlines count
      ])
      const response = await put({ send_invoice_reminders: false })
      expect(response.status).toBe(200)
      expect(findCall('pending_operations', 'update')?.[0]).toMatchObject({
        status: 'rejected',
        rejection_category: 'superseded',
        result_data: { auto_rejected: true, reason: 'reminders_off' },
      })
      expect(findCalls('pending_operations', 'eq')).toEqual([
        ['company_id', 'company-1'],
        ['operation_type', 'reminder_daily_batch'],
        ['status', 'pending'],
      ])
    })

    it('leaves the batch alone when reminders stay on, or were off already', async () => {
      enqueueMany([
        { data: { send_invoice_reminders: true, reminder_days_level_1: 15, reminder_days_level_2: 30, reminder_days_level_3: 45 } },
        { data: { id: 's1', send_invoice_reminders: true, reminder_days_level_1: 10 } },
        { data: null, count: 5 },
      ])
      expect((await put({ reminder_days_level_1: 10 })).status).toBe(200)

      enqueueMany([
        { data: { send_invoice_reminders: false } },
        { data: { id: 's1', send_invoice_reminders: false } },
        { data: null, count: 5 },
      ])
      expect((await put({ send_invoice_reminders: false })).status).toBe(200)
      expect(findCall('pending_operations', 'update')).toBeUndefined()
    })

    it('still saves when the withdrawal fails: the cron sweeps behind it', async () => {
      enqueueMany([
        { data: { send_invoice_reminders: true } },
        { data: { id: 's1', send_invoice_reminders: false } },
        { data: null, error: { message: 'boom' } },
        { data: null, count: 5 },
      ])
      const response = await put({ send_invoice_reminders: false })
      const { status, body } = await parseJsonResponse<{ data: { send_invoice_reminders: boolean } }>(response)
      expect(status).toBe(200)
      expect(body.data.send_invoice_reminders).toBe(false)
    })
  })

  // crm#1378: the identity reached the Stripe customer once, at checkout, so
  // a company that changed its details kept getting renewal invoices made
  // out to the old ones.
  describe('the company identity on its Stripe customer', () => {
    const IDENTITY = {
      entity_type: 'aktiebolag',
      company_name: 'Gamla Bolaget AB',
      org_number: '5566778899',
      address_line1: 'Storgatan 1',
      address_line2: null,
      postal_code: '111 22',
      city: 'Stockholm',
      country: 'SE',
      vat_registered: true,
      vat_number: 'SE556677889901',
    }
    const RENAMED = { ...IDENTITY, company_name: 'Nya Bolaget AB' }

    beforeEach(() => {
      stripeMocks.update.mockResolvedValue({})
      stripeMocks.listTaxIds.mockResolvedValue({ data: [{ id: 'txi_1' }] })
      stripeMocks.createTaxId.mockResolvedValue({})
    })

    function renameSave() {
      enqueueMany([
        { data: { ...IDENTITY, onboarding_complete: true } }, // fetch oldSettings
        { data: { id: 's1', ...RENAMED } }, // update ... returning
        { data: null, count: 5 }, // deadlines count
        { data: { stripe_customer_id: 'cus_1' } }, // company_subscriptions
        { data: { name: 'Nya Bolaget AB', org_number: '5566778899', entity_type: 'aktiebolag' } }, // companies
        { data: RENAMED }, // company_settings, read for the identity
      ])
      return PUT(
        createMockRequest('/api/settings', { method: 'PUT', body: { company_name: 'Nya Bolaget AB' } }),
        { params: Promise.resolve({}) },
      )
    }

    it('writes a changed company name onto the Stripe customer', async () => {
      const { status } = await parseJsonResponse(await renameSave())

      expect(status).toBe(200)
      expect(stripeMocks.update).toHaveBeenCalledWith(
        'cus_1',
        expect.objectContaining({ name: 'Nya Bolaget AB', business_name: 'Nya Bolaget AB' }),
      )
      // The tax ID it already has is kept.
      expect(stripeMocks.createTaxId).not.toHaveBeenCalled()
    })

    it('still saves when Stripe refuses the update', async () => {
      stripeMocks.update.mockRejectedValue(new Error('stripe down'))

      const { status, body } = await parseJsonResponse<{ data: { company_name: string } }>(await renameSave())

      expect(status).toBe(200)
      expect(body.data.company_name).toBe('Nya Bolaget AB')
    })

    it('leaves Stripe alone when no identity column changed', async () => {
      enqueueMany([
        { data: { ...IDENTITY, mileage_enabled: false } }, // fetch oldSettings
        { data: { id: 's1', ...IDENTITY, mileage_enabled: true } }, // update ... returning
        { data: null, count: 5 }, // deadlines count
      ])

      const { status } = await parseJsonResponse(
        await PUT(
          createMockRequest('/api/settings', { method: 'PUT', body: { mileage_enabled: true } }),
          { params: Promise.resolve({}) },
        ),
      )

      expect(status).toBe(200)
      expect(findCall('company_subscriptions', 'select')).toBeUndefined()
      expect(stripeMocks.update).not.toHaveBeenCalled()
    })
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

  it('stores the standard voucher series set as sent (Använd standarduppsättningen)', async () => {
    const standard = { ...STANDARD_VOUCHER_SERIES_MAP }
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },              // fetch oldSettings
      { data: { id: 's1', default_voucher_series_per_source_type: standard } },        // update ... returning
      { data: null, count: 5 },                                                        // deadlines count
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { default_voucher_series_per_source_type: standard },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { default_voucher_series_per_source_type: Record<string, string> }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.default_voucher_series_per_source_type).toEqual(standard)
    // Every source type, storno and correction included, reaches the row unchanged.
    expect(findCall('company_settings', 'update')?.[0]).toEqual({
      default_voucher_series_per_source_type: standard,
    })
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

  it('turning dimensions on registers the codes already on journal lines, in the save itself', async () => {
    // The scan used to run only when the settings page's toggle called
    // /api/dimensions/import-existing after the save, so a v1 or MCP save
    // turned dimensions on without it. It is now part of the transition.
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true, dimensions_enabled: false } }, // oldSettings
      { data: { id: 's1', dimensions_enabled: true } }, // update ... returning
      { data: null, count: 5 }, // deadlines count (has some -> no regen)
      { data: null }, // ensure_company_dimensions rpc
      { data: [{ id: 'entry-1' }] }, // entries of the company
      { data: [{ id: 'line-1', journal_entry_id: 'entry-1', dimensions: { '6': 'P001' } }] }, // tagged lines
      { data: [{ id: 'dim-6', sie_dim_no: 6 }] }, // registry dimensions
      { data: [] }, // registered values: none yet
      { data: [{ id: 'value-1' }] }, // value upsert
    ])

    const response = await PUT(
      createMockRequest('/api/settings', { method: 'PUT', body: { dimensions_enabled: true } }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(200)
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('ensure_company_dimensions')
    expect(findCall('dimension_values', 'upsert')?.[0]).toEqual([
      { company_id: 'company-1', dimension_id: 'dim-6', code: 'P001', name: 'P001', is_active: false },
    ])
    // The settings page's toggle confirms the registration from this count
    // instead of scanning a second time.
    const body = await response.json()
    expect(body.dimension_codes_imported).toBe(1)
    expect(body.data).toEqual({ id: 's1', dimensions_enabled: true })
  })

  it('does not scan again when the save leaves dimensions on', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true, dimensions_enabled: true } }, // oldSettings
      { data: { id: 's1', dimensions_enabled: true } }, // update ... returning
      { data: null, count: 5 }, // deadlines count
    ])

    const response = await PUT(
      createMockRequest('/api/settings', { method: 'PUT', body: { dimensions_enabled: true } }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(200)
    expect(supabase.rpc).not.toHaveBeenCalled()
    // No transition, no registration: null tells the toggle to run the scan
    // itself if it still wants to.
    expect((await response.json()).dimension_codes_imported).toBeNull()
  })

  it('accepts the invoice type visibility toggles', async () => {
    enqueueMany([
      { data: { entity_type: 'enskild_firma', onboarding_complete: true } }, // fetch oldSettings
      { data: { id: 's1', quotes_enabled: false, recurring_invoices_enabled: false } }, // update ... returning
      { data: null, count: 5 },                                               // deadlines count (has some -> no regen)
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { quotes_enabled: false, recurring_invoices_enabled: false },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { quotes_enabled: boolean; recurring_invoices_enabled: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.quotes_enabled).toBe(false)
    expect(body.data.recurring_invoices_enabled).toBe(false)
    expect(deadlineMocks.regenerate).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean invoice type toggle value', async () => {
    enqueueMany([
      { data: { entity_type: 'enskild_firma', onboarding_complete: true } }, // fetch oldSettings
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { proforma_enabled: 'nej' },
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

  // ML 17 kap 24 § p. 2: a next number the series already has, or one under
  // its highest number, would fill a hole in the series or restart it.
  it('refuses a next invoice number the series already has, naming the number to use', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', invoice_prefix: null, next_invoice_number: 1 } }, // oldSettings
      {
        data: { prefix: '', next_invoice_number: 667, next_number: '669', highest_number: 668, behind: false, first_allowed: 669 },
      }, // invoice_number_series_status
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { next_invoice_number: 667 },
    }), { params: Promise.resolve({}) })
    // The settings page answers a refusal with its Swedish sentence.
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('upp till 668')
    expect(body.error).toContain('669 eller högre')
    expect(supabase.rpc).toHaveBeenCalledWith('invoice_number_series_status', {
      p_company_id: 'company-1',
      p_document_type: 'invoice',
      p_prefix: '',
      p_next_number: 667,
    })
    // Refused before the update: only the oldSettings fetch touched a table.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('accepts a next invoice number past the highest one in the series', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', invoice_prefix: null, next_invoice_number: 1 } }, // oldSettings
      {
        data: { prefix: '', next_invoice_number: 669, next_number: '669', highest_number: 668, behind: false, first_allowed: 669 },
      }, // invoice_number_series_status
      { data: { id: 's1', next_invoice_number: 669 } }, // update ... returning
      { data: null, count: 5 }, // deadlines count
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { next_invoice_number: 669 },
    }), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('judges a new prefix as its own series', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', invoice_prefix: null, next_invoice_number: 1 } }, // oldSettings
      {
        data: { prefix: 'F', next_invoice_number: 1, next_number: 'F001', highest_number: null, behind: false, first_allowed: 1 },
      }, // invoice_number_series_status
      { data: { id: 's1', invoice_prefix: 'F' } }, // update ... returning
      { data: null, count: 5 }, // deadlines count
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { invoice_prefix: 'F' },
    }), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(supabase.rpc).toHaveBeenCalledWith(
      'invoice_number_series_status',
      expect.objectContaining({ p_prefix: 'F', p_next_number: 1 }),
    )
  })

  it('leaves the series alone when the save keeps the prefix and the next number', async () => {
    // A company an import left behind can still save other settings: the
    // first issue asks where the series continues instead.
    enqueueMany([
      { data: { entity_type: 'aktiebolag', invoice_prefix: null, next_invoice_number: 1 } }, // oldSettings
      { data: { id: 's1', company_name: 'Nytt namn' } }, // update ... returning
      { data: null, count: 5 }, // deadlines count
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { company_name: 'Nytt namn', invoice_prefix: '', next_invoice_number: 1 },
    }), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(supabase.rpc).not.toHaveBeenCalledWith('invoice_number_series_status', expect.anything())
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

  it('rejects a reply-address change from a regular member', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'member' }, error: null },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { invoice_email_reply_to: 'svar@example.com' },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('saves and clears the reply address for an admin', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'admin' } },
      { data: { id: 's1', invoice_email_reply_to: 'svar@example.com' } },
      { data: null, count: 5 },
    ])
    const saved = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { invoice_email_reply_to: ' svar@example.com ' },
    }), { params: Promise.resolve({}) })
    expect((await parseJsonResponse<{ data: { invoice_email_reply_to: string } }>(saved)).body.data.invoice_email_reply_to)
      .toBe('svar@example.com')

    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'admin' } },
      { data: { id: 's1', invoice_email_reply_to: null } },
      { data: null, count: 5 },
    ])
    const cleared = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { invoice_email_reply_to: null },
    }), { params: Promise.resolve({}) })
    expect((await parseJsonResponse(cleared)).status).toBe(200)
  })

  it('rejects a malformed reply address', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
    ])
    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { invoice_email_reply_to: 'svara till mig' },
    }), { params: Promise.resolve({}) })
    expect((await parseJsonResponse(response)).status).toBe(400)
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

  // Swedbank's own ids for payment files (crm#1117): who the bank sees as the
  // sender and under which agreement it pays, so owner/admin only.
  it('saves the Swedbank payment-file ids normalised, for an admin', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'admin' } },
      { data: { id: 's1', swedbank_signer_id: '123456789ORI0001', swedbank_corporate_pay_id: '123456789CPO0001' } },
      { data: null, count: 5 },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { swedbank_signer_id: '123456789-ori-0001', swedbank_corporate_pay_id: ' 123456789 CPO 0001 ' },
    }), { params: Promise.resolve({}) })

    expect((await parseJsonResponse(response)).status).toBe(200)
    expect(findCall('company_settings', 'update')?.[0]).toEqual({
      swedbank_signer_id: '123456789ORI0001',
      swedbank_corporate_pay_id: '123456789CPO0001',
    })
  })

  it('clears a Swedbank payment-file id sent empty', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'owner' } },
      { data: { id: 's1', swedbank_signer_id: null } },
      { data: null, count: 5 },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { swedbank_signer_id: '' },
    }), { params: Promise.resolve({}) })

    expect((await parseJsonResponse(response)).status).toBe(200)
    expect(findCall('company_settings', 'update')?.[0]).toEqual({ swedbank_signer_id: null })
  })

  it('rejects a Swedbank id that is not in Swedbank format, naming the format', async () => {
    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { swedbank_signer_id: '5566778899' },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(JSON.stringify(body)).toContain('123456789ORI0001')
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('rejects Swedbank\'s ISO 1.0 agreement number, saying what it is and what to use instead', async () => {
    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { swedbank_signer_id: '06 5566778899 B001' },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(JSON.stringify(body)).toContain('avtalsnummer för ISO 20022 1.0')
    expect(JSON.stringify(body)).toContain('Betala via banken')
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('rejects Swedbank payment-file id changes from a regular member', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'member' }, error: null },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { swedbank_corporate_pay_id: '123456789CPO0001' },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  // Nordea's Signer ID (crm#1530): who Nordea sees as the sender, so owner/admin only.
  it('saves the Nordea Signer ID normalised, for an admin', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'admin' } },
      { data: { id: 's1', nordea_signer_id: 'NB10000123456' } },
      { data: null, count: 5 },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { nordea_signer_id: 'nb 10000-123456' },
    }), { params: Promise.resolve({}) })

    expect((await parseJsonResponse(response)).status).toBe(200)
    expect(findCall('company_settings', 'update')?.[0]).toEqual({ nordea_signer_id: 'NB10000123456' })
  })

  it('rejects a Nordea Signer ID change from a regular member', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'member' }, error: null },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { nordea_signer_id: 'NB10000123456' },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('rejects a Nordea Signer ID with other characters than letters and digits', async () => {
    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { nordea_signer_id: 'NB1000/0123' },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(JSON.stringify(body)).toContain('bokstäver och siffror')
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  // Nordea's CCM agreement id (crm#1530): which agreement Nordea debits under, so owner/admin only.
  it('saves the Nordea agreement id normalised, for an admin', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'admin' } },
      { data: { id: 's1', nordea_agreement_id: 'NB123456' } },
      { data: null, count: 5 },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { nordea_agreement_id: ' nb-123 456 ' },
    }), { params: Promise.resolve({}) })

    expect((await parseJsonResponse(response)).status).toBe(200)
    expect(findCall('company_settings', 'update')?.[0]).toEqual({ nordea_agreement_id: 'NB123456' })
  })

  it('rejects a Nordea agreement id change from a regular member', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true } },
      { data: { role: 'member' }, error: null },
    ])

    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { nordea_agreement_id: 'NB123456' },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('rejects a Nordea agreement id with other characters than letters and digits', async () => {
    const response = await PUT(createMockRequest('/api/settings', {
      method: 'PUT',
      body: { nordea_agreement_id: 'NB/123456' },
    }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(JSON.stringify(body)).toContain('Avtals-ID får bara innehålla bokstäver och siffror')
    expect(findCall('company_settings', 'update')).toBeUndefined()
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
    // Validation runs before the settings service reads anything.
    expect(supabase.from).not.toHaveBeenCalled()
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
    // Validation runs before the settings service reads anything.
    expect(supabase.from).not.toHaveBeenCalled()
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

  it('still saves the superseded bank-app payment QR switch (crm#249), for API compatibility', async () => {
    enqueueMany([
      { data: { onboarding_complete: true } }, // oldSettings
      { data: { company_id: 'company-1', invoice_show_payment_qr: true } }, // update result
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { invoice_show_payment_qr: true },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { invoice_show_payment_qr: boolean } }>(response)

    expect(status).toBe(200)
    expect(findCall('company_settings', 'update')?.[0]).toEqual({ invoice_show_payment_qr: true })
    expect(body.data.invoice_show_payment_qr).toBe(true)
  })

  it('rejects a non-boolean bank-app payment QR switch', async () => {
    enqueueMany([
      { data: { onboarding_complete: true } }, // oldSettings
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { invoice_show_payment_qr: 'on' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
  })

  it('accepts the invoice QR mode (one QR code per invoice)', async () => {
    enqueueMany([
      { data: { onboarding_complete: true } }, // oldSettings
      { data: { company_id: 'company-1', invoice_qr_mode: 'swish' } }, // update result
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { invoice_qr_mode: 'swish' },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { invoice_qr_mode: string } }>(response)

    expect(status).toBe(200)
    expect(findCall('company_settings', 'update')?.[0]).toEqual({ invoice_qr_mode: 'swish' })
    expect(body.data.invoice_qr_mode).toBe('swish')
  })

  it('rejects an invoice QR mode that is not one of the modes', async () => {
    for (const value of ['all', null, true]) {
      enqueueMany([
        { data: { onboarding_complete: true } }, // oldSettings
      ])
      const request = createMockRequest('/api/settings', {
        method: 'PUT',
        body: { invoice_qr_mode: value },
      })
      const response = await PUT(request, { params: Promise.resolve({}) })
      expect(response.status, String(value)).toBe(400)
    }
  })

  it('accepts the payslip section switches (crm#202)', async () => {
    enqueueMany([
      { data: { onboarding_complete: true } }, // oldSettings
      {
        data: {
          company_id: 'company-1',
          salary_payslip_show_employer_cost: false,
          salary_payslip_show_breakdown: false,
        },
      }, // update result
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false },
    })
    const response = await PUT(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { salary_payslip_show_employer_cost: boolean; salary_payslip_show_breakdown: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.salary_payslip_show_employer_cost).toBe(false)
    expect(body.data.salary_payslip_show_breakdown).toBe(false)
  })

  it('rejects a non-boolean payslip section switch', async () => {
    enqueueMany([
      { data: { onboarding_complete: true } }, // oldSettings
    ])

    const request = createMockRequest('/api/settings', {
      method: 'PUT',
      body: { salary_payslip_show_breakdown: 'hide' },
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

// crm#1206: the company's own org number is writable while no valid one is
// stored (either copy), never replaced once one is (lib/company/org-number-rule.ts).
describe('PUT /api/settings: org number', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
    isAdminMock.mockResolvedValue(true)
  })

  const put = (body: Record<string, unknown>) =>
    PUT(createMockRequest('/api/settings', { method: 'PUT', body }), { params: Promise.resolve({}) })

  it('fills in an empty org number after onboarding, on both copies, as ten digits', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true, org_number: null } }, // oldSettings
      { data: { org_number: null, entity_type: 'aktiebolag' } },                            // companies (stored copy)
      { data: { id: 's1', org_number: '5560125790' } },                                     // update ... returning
      { data: null },                                                                       // companies mirror
      { data: null, count: 5 },                                                             // deadlines count
    ])

    const response = await put({ org_number: '556012-5790' })
    const { status, body } = await parseJsonResponse<{ data: { org_number: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.org_number).toBe('5560125790')
    expect(findCall('company_settings', 'update')?.[0]).toEqual({ org_number: '5560125790' })
    expect(findCall('companies', 'update')?.[0]).toEqual({ org_number: '5560125790' })
  })

  it('fixes a stored number with a wrong check digit', async () => {
    enqueueMany([
      { data: { entity_type: 'enskild_firma', onboarding_complete: true, org_number: '121212-1213' } },
      { data: { org_number: '1212121213', entity_type: 'enskild_firma' } },
      { data: { id: 's1', org_number: '1212121212' } },
      { data: null },
      { data: null, count: 5 },
    ])

    const response = await put({ org_number: '19121212-1212' })

    expect(response.status).toBe(200)
    expect(findCall('company_settings', 'update')?.[0]).toEqual({ org_number: '1212121212' })
  })

  it('refuses to replace a valid number (409) and writes nothing', async () => {
    enqueueMany([{ data: { entity_type: 'aktiebolag', onboarding_complete: false, org_number: '556012-5790' } }])

    const response = await put({ org_number: '202100-5489', city: 'Malmö' })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toBe('Företaget har redan ett giltigt organisationsnummer, och det kan inte ändras.')
    expect(findCall('company_settings', 'update')).toBeUndefined()
    expect(findCall('companies', 'update')).toBeUndefined()
  })

  it('refuses a number with a wrong check digit (400)', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true, org_number: '' } },
      { data: { org_number: null, entity_type: 'aktiebolag' } },
    ])

    const response = await put({ org_number: '556012-5791' })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toMatch(/^Organisationsnumret är inte giltigt/)
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('refuses a personnummer for an aktiebolag (400)', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true, org_number: null } },
      { data: { org_number: null, entity_type: 'aktiebolag' } },
    ])

    const response = await put({ org_number: '121212-1212' })

    expect(response.status).toBe(400)
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('a save that sends the stored value back changes nothing about it, valid or not', async () => {
    enqueueMany([
      { data: { entity_type: 'aktiebolag', onboarding_complete: true, org_number: 'saknas' } },
      { data: { id: 's1', city: 'Malmö' } },
      { data: null, count: 5 },
    ])

    const response = await put({ org_number: 'saknas', city: 'Malmö' })

    expect(response.status).toBe(200)
    expect(findCall('company_settings', 'update')?.[0]).toEqual({ city: 'Malmö' })
    expect(findCall('companies', 'select')).toBeUndefined()
  })

  it('returns 404 when the company has no settings row', async () => {
    enqueueMany([
      { data: null },                                            // oldSettings: none
      { data: { org_number: null, entity_type: 'aktiebolag' } }, // companies
      { data: null, error: { code: 'PGRST116', message: 'no rows' } }, // update ... single
    ])

    const response = await put({ org_number: '556012-5790' })

    expect(response.status).toBe(404)
    expect(findCall('companies', 'update')).toBeUndefined()
  })

  it('returns 400 for an org number that is not a string', async () => {
    const response = await put({ org_number: 5560125790 })
    expect(response.status).toBe(400)
  })
})

// PH 187 / crm#1303: the accounting method rule is the service's, so the
// settings page gets the same one as the API and MCP doors.
describe('PUT /api/settings: accounting method mid-year', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    auditInsert.mockResolvedValue({ error: null })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
    isAdminMock.mockResolvedValue(true)
  })

  const put = (body: Record<string, unknown>) =>
    PUT(createMockRequest('/api/settings', { method: 'PUT', body }), { params: Promise.resolve({}) })
  const PERIOD = { data: { id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' } }

  it('refuses a switch in a fiscal year with posted verifikat when no reason is given', async () => {
    enqueueMany([
      { data: { id: 's1', accounting_method: 'accrual' } }, // oldSettings
      PERIOD,                                                // current fiscal year
      { data: null, count: 0 },                              // open invoices without verifikat
      { data: null, count: 0 },                              // open supplier invoices without verifikat
      { data: null, count: 112 },                            // posted verifikat
    ])
    const response = await put({ accounting_method: 'cash' })
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(409)
    expect(body.error).toContain('rättelse')
    expect(findCall('company_settings', 'update')).toBeUndefined()
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('saves a stated correction and records the reason in audit_log', async () => {
    enqueueMany([
      { data: { id: 's1', accounting_method: 'accrual' } },
      PERIOD,
      { data: null, count: 0 },                              // open invoices without verifikat
      { data: null, count: 0 },                              // open supplier invoices without verifikat
      { data: null, count: 112 },                            // posted verifikat
      { data: [], count: 0 },                                // invoice-flow verifikat this year
      { data: { id: 's1', accounting_method: 'cash' } },    // update ... returning
      { data: null, count: 5 },                              // deadlines count
    ])
    const response = await put({ accounting_method: 'cash', accounting_method_correction_reason: 'Fel metod valdes vid inflyttningen' })
    expect(response.status).toBe(200)
    const update = findCall('company_settings', 'update')?.[0] as Record<string, unknown>
    expect(update).toMatchObject({ accounting_method: 'cash', defer_invoice_booking: false })
    expect(update).not.toHaveProperty('accounting_method_correction_reason')
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({
      action: 'GUARD_BYPASSED',
      user_id: 'user-1',
      record_id: 's1',
      new_state: expect.objectContaining({ guard: 'accounting_method_mid_year', from: 'accrual', to: 'cash' }),
    }))
  })

  it('leaves an unchanged method alone: no fiscal year read, no record', async () => {
    enqueueMany([
      { data: { id: 's1', accounting_method: 'accrual' } },
      { data: { id: 's1', accounting_method: 'accrual' } },
      { data: null, count: 5 },
    ])
    const response = await put({ accounting_method: 'accrual', default_voucher_series: 'A' })
    expect(response.status).toBe(200)
    expect(findCall('fiscal_periods', 'select')).toBeUndefined()
    expect(auditInsert).not.toHaveBeenCalled()
  })
})
