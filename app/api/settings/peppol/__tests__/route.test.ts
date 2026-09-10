import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'
import { PeppolTransportError, registerPeppolTransport, type PeppolTransport } from '@/lib/invoices/peppol-transport'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const service = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => service.supabase,
}))

import { DELETE, GET, POST, maxDuration } from '../route'

const user = { id: 'user-1', email: 'owner@example.test' }
const enabledAccess = {
  company_id: 'company-1', status: 'enabled', max_sends: 50, receive_enabled: true,
  requested_at: null, requested_by: null, request_note: null,
  enabled_at: '2026-08-21T16:00:00.000Z', enabled_by: 'jakob', disabled_at: null, note: null,
  created_at: '2026-08-21T16:00:00.000Z', updated_at: '2026-08-21T16:00:00.000Z',
}
const companySettings = { org_number: '559538-6219', company_name: 'Arcim Technology AB', vat_number: 'SE559538621901', city: 'Stockholm', country: 'SE' }
const personnummerSettings = { org_number: '800101-1234', company_name: 'Firma', vat_number: null, city: null, country: 'SE' }

const registeredRow = {
  id: 'reg-1',
  company_id: 'company-1',
  user_id: 'user-1',
  provider: 'qvalia',
  provider_account_reference: 'SE5595386219',
  participant_scheme: '0007',
  participant_identifier: '5595386219',
  status: 'registered',
  business_card: {},
  document_types: [],
  registered_at: '2026-08-21T16:00:00.000Z',
  deregistered_at: null,
  last_error: null,
  last_error_code: null,
  created_at: '2026-08-21T15:59:00.000Z',
  updated_at: '2026-08-21T16:00:00.000Z',
}

function makeTransport(overrides: Partial<PeppolTransport> = {}): PeppolTransport {
  return {
    provider: 'qvalia',
    lookupRecipient: vi.fn(),
    submit: vi.fn(),
    verifyWebhook: vi.fn(),
    retrieveEvidence: vi.fn(),
    registerRecipient: vi.fn().mockResolvedValue({
      status: 'registered',
      participant: { scheme: '0007', identifier: '5595386219' },
      providerAccountReference: 'SE5595386219',
      raw: {},
    }),
    unregisterRecipient: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const get = () => GET(createMockRequest('/api/settings/peppol'), createMockRouteParams({}))
const post = () => POST(createMockRequest('/api/settings/peppol', { method: 'POST' }), createMockRouteParams({}))
const del = () => DELETE(createMockRequest('/api/settings/peppol', { method: 'DELETE' }), createMockRouteParams({}))

/** Queue everything POST reads before it reaches the transport. */
function queueRegistrationPreamble(settings: Record<string, unknown> = companySettings) {
  enqueue({ data: { is_sandbox: false }, error: null })
  service.enqueue({ data: enabledAccess, error: null })               // access grant with receiving
  enqueue({ data: settings, error: null })                            // company settings
  service.enqueue({ data: [], error: null })                          // existing registrations
  service.enqueue({ data: { id: 'reg-1' }, error: null })             // insert pending
}

describe('/api/settings/peppol', () => {
  let unregister: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    service.reset()
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
  })

  afterEach(() => {
    unregister?.()
    unregister = null
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
  })

  it('gives the connector call room to finish: the route outlives the 60 s transport timeout', () => {
    expect(maxDuration).toBeGreaterThanOrEqual(90)
  })

  it('GET returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await get()
    expect(response.status).toBe(401)
  })

  it('GET tells the truth when no access point is switched on', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    enqueue({ data: null, error: null })                               // company settings (none yet)
    enqueue({ data: null, error: null })                               // access row (none)
    const response = await get()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({
      transport: { available: false },
      receiving_supported: false,
      access: { status: 'none', send_enabled: false },
      participant: { ok: false, code: 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED' },
      registration: null,
    })
  })

  it('GET returns the live registration, the eligibility and the stable error code, never the raw text', async () => {
    unregister = registerPeppolTransport(makeTransport())
    enqueue({ data: [registeredRow], error: null })
    enqueue({ data: companySettings, error: null })
    enqueue({ data: enabledAccess, error: null })                       // access row
    service.enqueue({ data: null, error: null, count: 3 })              // sends used
    const response = await get()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data.receiving_supported).toBe(true)
    expect(body.data.participant).toEqual({ ok: true, code: null })
    expect(body.data.access).toMatchObject({ status: 'enabled', send_enabled: true, receive_enabled: true, sent_count: 3, remaining_sends: 47 })
    expect(body.data.registration).toMatchObject({
      status: 'registered', participant_identifier: '5595386219', last_error_code: null, stale_pending: false,
    })
    expect(body.data.registration).not.toHaveProperty('business_card')
    expect(body.data.registration).not.toHaveProperty('last_error')
  })

  it('GET reports a personnummer company as ineligible and surfaces the failed row code', async () => {
    unregister = registerPeppolTransport(makeTransport())
    const failedRow = {
      ...registeredRow, status: 'failed', registered_at: null,
      last_error: 'Connector: Qvalia answered 500: Something went wrong with the request',
      last_error_code: 'CONNECTOR_UPSTREAM_ERROR',
    }
    enqueue({ data: [failedRow], error: null })
    enqueue({ data: personnummerSettings, error: null })
    enqueue({ data: enabledAccess, error: null })
    service.enqueue({ data: null, error: null, count: 0 })
    const body = await (await get()).json()
    expect(body.data.participant).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(body.data.registration).toMatchObject({ status: 'failed', last_error_code: 'CONNECTOR_UPSTREAM_ERROR' })
    expect(JSON.stringify(body)).not.toContain('Something went wrong')
  })

  it('GET marks a pending row older than five minutes as stale', async () => {
    unregister = registerPeppolTransport(makeTransport())
    const staleAt = new Date(Date.now() - 6 * 60 * 1000).toISOString()
    enqueue({ data: [{ ...registeredRow, status: 'pending', registered_at: null, updated_at: staleAt }], error: null })
    enqueue({ data: companySettings, error: null })
    enqueue({ data: enabledAccess, error: null })
    service.enqueue({ data: null, error: null, count: 0 })
    const body = await (await get()).json()
    expect(body.data.registration).toMatchObject({ status: 'pending', stale_pending: true })
  })

  it('POST refuses without a transport and in the sandbox', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    expect((await post()).status).toBe(503)

    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    unregister = registerPeppolTransport(makeTransport())
    enqueue({ data: { is_sandbox: true }, error: null })
    const response = await post()
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('PEPPOL_SANDBOX_NOT_ALLOWED')
  })

  it('POST refuses receiving without an access grant, and without the receiving flag', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    enqueue({ data: { is_sandbox: false }, error: null })
    service.enqueue({ data: null, error: null })                        // no access row
    const locked = await post()
    expect(locked.status).toBe(403)
    expect((await locked.json()).error.code).toBe('PEPPOL_ACCESS_REQUIRED')

    reset(); service.reset()
    enqueue({ data: { is_sandbox: false }, error: null })
    service.enqueue({ data: { ...enabledAccess, receive_enabled: false }, error: null })
    const sendOnly = await post()
    expect(sendOnly.status).toBe(403)
    expect((await sendOnly.json()).error.code).toBe('PEPPOL_RECEIVING_NOT_ENABLED')
    expect(transport.registerRecipient).not.toHaveBeenCalled()
  })

  it('POST registers the company and returns the minimized registration', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    queueRegistrationPreamble()
    service.enqueue({ data: registeredRow, error: null })      // finalize

    const response = await post()
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.data.registration).toMatchObject({ status: 'registered', participant_scheme: '0007', last_error_code: null })
    expect(transport.registerRecipient).toHaveBeenCalledTimes(1)
  })

  it('POST maps a personnummer-based company to a 422 with the reason', async () => {
    unregister = registerPeppolTransport(makeTransport())
    enqueue({ data: { is_sandbox: false }, error: null })
    service.enqueue({ data: enabledAccess, error: null })
    enqueue({ data: personnummerSettings, error: null })
    const response = await post()
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('PEPPOL_REGISTRATION_PERSONAL_NUMBER')
  })

  it('POST maps a permanent hosted refusal to PEPPOL_REGISTRATION_REJECTED (422) with the hosted detail and code', async () => {
    unregister = registerPeppolTransport(makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(new PeppolTransportError('Connector: taken', {
        retryable: false, code: 'CONNECTOR_PEPPOL_PARTICIPANT_TAKEN', detail: 'registered by another key',
      })),
    }))
    queueRegistrationPreamble()
    service.enqueue({ data: null, error: null })               // failed update

    const response = await post()
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_REGISTRATION_REJECTED')
    expect(body.error.details).toEqual({ reason: 'registered by another key', code: 'CONNECTOR_PEPPOL_PARTICIPANT_TAKEN' })
    expect(body.error.message).toMatch(/avvisades/)
  })

  it('POST maps a transient hosted failure to PEPPOL_REGISTRATION_FAILED (502)', async () => {
    unregister = registerPeppolTransport(makeTransport({
      registerRecipient: vi.fn().mockRejectedValue(new PeppolTransportError('Connector: Qvalia answered 500', {
        retryable: true, code: 'CONNECTOR_UPSTREAM_ERROR', detail: 'Something went wrong with the request',
      })),
    }))
    queueRegistrationPreamble()
    service.enqueue({ data: null, error: null })

    const response = await post()
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error.code).toBe('PEPPOL_REGISTRATION_FAILED')
    expect(body.error.details).toEqual({ reason: 'Something went wrong with the request', code: 'CONNECTOR_UPSTREAM_ERROR' })
  })

  it('DELETE withdraws the identifier and 404s when nothing is live', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    service.enqueue({ data: [registeredRow], error: null })
    service.enqueue({ data: { ...registeredRow, status: 'deregistered', deregistered_at: '2026-08-21T17:00:00.000Z' }, error: null })
    const ok = await del()
    expect(ok.status).toBe(200)
    expect((await ok.json()).data.registration.status).toBe('deregistered')
    expect(transport.unregisterRecipient).toHaveBeenCalledWith({ scheme: '0007', identifier: '5595386219' })

    service.enqueue({ data: [], error: null })
    const missing = await del()
    expect(missing.status).toBe(404)
  })

  it('DELETE closes the row when the hosted side does not hold the identifier, and maps other failures by retryability', async () => {
    unregister = registerPeppolTransport(makeTransport({
      unregisterRecipient: vi.fn().mockRejectedValue(new PeppolTransportError('Connector: not owned', {
        retryable: false, code: 'CONNECTOR_NOT_OWNED', detail: null,
      })),
    }))
    service.enqueue({ data: [registeredRow], error: null })
    service.enqueue({ data: { ...registeredRow, status: 'deregistered', deregistered_at: '2026-09-10T12:00:00.000Z', last_error_code: 'CONNECTOR_NOT_OWNED' }, error: null })
    const closed = await del()
    expect(closed.status).toBe(200)
    expect((await closed.json()).data.registration).toMatchObject({ status: 'deregistered', last_error_code: 'CONNECTOR_NOT_OWNED' })

    unregister()
    unregister = registerPeppolTransport(makeTransport({
      unregisterRecipient: vi.fn().mockRejectedValue(new PeppolTransportError('Connector: busy', {
        retryable: true, code: 'CONNECTOR_RATE_LIMITED', detail: 'slow down',
      })),
    }))
    service.reset()
    service.enqueue({ data: [registeredRow], error: null })
    service.enqueue({ data: null, error: null })                        // last_error update
    const failed = await del()
    expect(failed.status).toBe(502)
    const body = await failed.json()
    expect(body.error.code).toBe('PEPPOL_REGISTRATION_FAILED')
    expect(body.error.details).toEqual({ reason: 'slow down', code: 'CONNECTOR_RATE_LIMITED' })
  })
})
