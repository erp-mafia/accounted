import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase } from '@/tests/helpers'
import { registerPeppolTransport, type PeppolTransport } from '@/lib/invoices/peppol-transport'

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

import { DELETE, GET, POST } from '../route'

const user = { id: 'user-1', email: 'owner@example.test' }
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

  it('GET returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(createMockRequest('/api/settings/peppol'))
    expect(response.status).toBe(401)
  })

  it('GET tells the truth when no access point is switched on', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    const response = await GET(createMockRequest('/api/settings/peppol'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({
      transport: { available: false },
      receiving_supported: false,
      registration: null,
    })
  })

  it('GET returns the live registration when the adapter supports receiving', async () => {
    unregister = registerPeppolTransport(makeTransport())
    enqueue({ data: [registeredRow], error: null })
    const response = await GET(createMockRequest('/api/settings/peppol'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data.receiving_supported).toBe(true)
    expect(body.data.registration).toMatchObject({ status: 'registered', participant_identifier: '5595386219' })
    expect(body.data.registration).not.toHaveProperty('business_card')
  })

  it('POST refuses without a transport and in the sandbox', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    expect((await POST(createMockRequest('/api/settings/peppol', { method: 'POST' }))).status).toBe(503)

    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    unregister = registerPeppolTransport(makeTransport())
    enqueue({ data: { is_sandbox: true }, error: null })
    const response = await POST(createMockRequest('/api/settings/peppol', { method: 'POST' }))
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('PEPPOL_SANDBOX_NOT_ALLOWED')
  })

  it('POST registers the company and returns the minimized registration', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: { org_number: '559538-6219', company_name: 'Arcim Technology AB', vat_number: 'SE559538621901', city: 'Stockholm', country: 'SE' }, error: null })
    service.enqueue({ data: [], error: null })                 // existing
    service.enqueue({ data: { id: 'reg-1' }, error: null })    // insert pending
    service.enqueue({ data: registeredRow, error: null })      // finalize

    const response = await POST(createMockRequest('/api/settings/peppol', { method: 'POST' }))
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.data.registration).toMatchObject({ status: 'registered', participant_scheme: '0007' })
    expect(transport.registerRecipient).toHaveBeenCalledTimes(1)
  })

  it('POST maps a personnummer-based company to a 422 with the reason', async () => {
    unregister = registerPeppolTransport(makeTransport())
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: { org_number: '800101-1234', company_name: 'Firma', vat_number: null, city: null, country: 'SE' }, error: null })
    const response = await POST(createMockRequest('/api/settings/peppol', { method: 'POST' }))
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('PEPPOL_REGISTRATION_PERSONAL_NUMBER')
  })

  it('DELETE withdraws the identifier and 404s when nothing is live', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    service.enqueue({ data: [registeredRow], error: null })
    service.enqueue({ data: { ...registeredRow, status: 'deregistered', deregistered_at: '2026-08-21T17:00:00.000Z' }, error: null })
    const ok = await DELETE(createMockRequest('/api/settings/peppol', { method: 'DELETE' }))
    expect(ok.status).toBe(200)
    expect((await ok.json()).data.registration.status).toBe('deregistered')
    expect(transport.unregisterRecipient).toHaveBeenCalledWith({ scheme: '0007', identifier: '5595386219' })

    service.enqueue({ data: [], error: null })
    const missing = await DELETE(createMockRequest('/api/settings/peppol', { method: 'DELETE' }))
    expect(missing.status).toBe(404)
  })
})
