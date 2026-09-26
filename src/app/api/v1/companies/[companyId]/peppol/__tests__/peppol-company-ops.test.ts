/**
 * The company side of Peppol through the v1 door of the operation registry
 * (src/lib/operations/peppol.ts):
 *   GET  /api/v1/companies/:companyId/peppol/registration    (peppol.get-registration)
 *   POST /api/v1/companies/:companyId/peppol/registration    (peppol.register)
 *   POST /api/v1/companies/:companyId/peppol/access-request  (peppol.request-access)
 *
 * The rules are the service's (lib/invoices/peppol-settings-service.ts):
 * owner/admin for registering, the operators' grant and receiving slot, the
 * personnummer refusal, the access point contacted on commit only, and the
 * operator mail sent on commit only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPeppolTransport, type PeppolTransport } from '@/lib/invoices/peppol-transport'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => { throw new Error('no session client on the v1 door') }),
  createServiceClient: vi.fn(() => { throw new Error('the v1 door already runs on service role') }),
}))
const sendEmailMock = vi.fn()
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ sendEmail: (...a: unknown[]) => sendEmailMock(...a), isConfigured: () => true }),
}))
vi.mock('@/lib/support', () => ({ getSupportRecipientEmail: () => 'support@example.test' }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as registrationGet, POST as registrationPost } from '../registration/route'
import { POST as accessRequestPost } from '../access-request/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface Resp {
  data?: unknown
  error?: unknown
  count?: number
}

/** Per-table queue mock (the last entry repeats); every (table, method, args) is recorded. */
function makeClient(byTable: Record<string, Resp | Resp[]>) {
  const queues = new Map<string, Resp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  const rpc = vi.fn((fn: string, ...args: unknown[]) => {
    calls.push({ table: 'rpc', method: fn, args })
    return buildChain(`rpc:${fn}`)
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
/** withApiV1's own bookkeeping (the idempotency cache) is not the operation's. */
const DOOR_TABLES = new Set(['idempotency_keys', 'company_members'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (!DOOR_TABLES.has(c.table) && WRITES.has(c.method)) || c.table === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/peppol`
const role = (r: string) => ({ data: { company_id: COMPANY_ID, role: r }, error: null })

const SETTINGS = {
  data: { org_number: '559538-6219', company_name: 'Arcim Technology AB', vat_number: 'SE559538621901', city: 'Stockholm', country: 'SE', is_sandbox: false },
  error: null,
}
const GRANT = { company_id: COMPANY_ID, status: 'enabled', max_sends: 50, receive_enabled: true }
const registeredRow = {
  id: REG_ID,
  company_id: COMPANY_ID,
  user_id: 'user-1',
  provider: 'test-ap',
  provider_account_reference: 'SE5595386219',
  participant_scheme: '0007',
  participant_identifier: '5595386219',
  status: 'registered',
  business_card: {},
  document_types: [],
  registered_at: '2026-09-26T10:00:00.000Z',
  deregistered_at: null,
  last_error: 'raw provider prose',
  last_error_code: null,
  created_at: '2026-09-26T09:59:00.000Z',
  updated_at: '2026-09-26T10:00:00.000Z',
}

function makeTransport(overrides: Partial<PeppolTransport> = {}): PeppolTransport {
  return {
    provider: 'test-ap',
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
    unregisterRecipient: vi.fn(),
    ...overrides,
  }
}

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

let unregister: (() => void) | null = null
let transport: PeppolTransport

beforeEach(() => {
  vi.clearAllMocks()
  process.env.PEPPOL_TRANSPORT_PROVIDER = 'test-ap'
  delete process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS
  transport = makeTransport()
  unregister = registerPeppolTransport(transport)
  sendEmailMock.mockResolvedValue({ success: true })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['companies:read', 'companies:write'],
    mode: 'live',
  })
})

afterEach(() => {
  unregister?.()
  unregister = null
  delete process.env.PEPPOL_TRANSPORT_PROVIDER
})

// ---------------------------------------------------------------------------

describe('GET /api/v1/companies/:companyId/peppol/registration', () => {
  const get = () => registrationGet(request(`${BASE}/registration`), params)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await get()).status).toBe(401)
  })

  it('403 without companies:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: role('member') }))
    expect((await get()).status).toBe(403)
  })

  it('answers the grant, eligibility and the registration with a qualified id and no raw provider text', async () => {
    mockServiceClient.mockReturnValue(makeClient({
      company_members: role('member'),
      peppol_registrations: { data: [registeredRow], error: null },
      company_settings: SETTINGS,
      peppol_access: { data: GRANT, error: null },
      peppol_deliveries: { data: null, error: null, count: 2 },
    }))
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      transport: { available: true, provider: 'test-ap', reason: null },
      receiving_supported: true,
      access: { status: 'enabled', receive_enabled: true, sent_count: 2 },
      participant: { ok: true, code: null },
      registration: { registration_id: REG_ID, status: 'registered', can_retry: false, stale_pending: false },
    })
    expect(body.data.registration.id).toBeUndefined()
    expect(body.data.registration.last_error).toBeUndefined()
  })

  it('tells a personnummer-based sole trader up front that it cannot be registered', async () => {
    mockServiceClient.mockReturnValue(makeClient({
      company_members: role('member'),
      peppol_registrations: { data: [], error: null },
      company_settings: { data: { org_number: '800101-1234', company_name: 'Firma', vat_number: null, city: null, country: 'SE' }, error: null },
    }))
    const body = await (await get()).json()
    expect(body.data.participant).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
    expect(body.data.registration).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/v1/companies/:companyId/peppol/registration', () => {
  const post = (query = '') => registrationPost(request(`${BASE}/registration${query}`, { method: 'POST' }), params)

  function ownerClient(overrides: Record<string, Resp | Resp[]> = {}) {
    return makeClient({
      company_members: role('owner'),
      company_settings: SETTINGS,
      peppol_access: { data: GRANT, error: null },
      peppol_registrations: [
        { data: [], error: null },                    // no registration yet
        { data: { id: REG_ID }, error: null },        // insert pending
        { data: registeredRow, error: null },         // finalize
      ],
      ...overrides,
    })
  }

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post()).status).toBe(401)
  })

  it('403 without companies:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['companies:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: role('owner') }))
    expect((await post()).status).toBe(403)
  })

  it('403 FORBIDDEN for a plain member, on a dry run too, before anything else is read', async () => {
    for (const query of ['', '?dry_run=true']) {
      const client = ownerClient({ company_members: role('member') })
      mockServiceClient.mockReturnValue(client)
      const res = await post(query)
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe('FORBIDDEN')
      expect(client.from).not.toHaveBeenCalledWith('peppol_access')
      expect(wrote(client)).toBe(false)
    }
    expect(transport.registerRecipient).not.toHaveBeenCalled()
  })

  it('403 PEPPOL_ACCESS_REQUIRED without the operators\' grant', async () => {
    mockServiceClient.mockReturnValue(ownerClient({ peppol_access: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('PEPPOL_ACCESS_REQUIRED')
  })

  it('403 PEPPOL_RECEIVING_NOT_ENABLED with a sending grant but no receiving slot', async () => {
    mockServiceClient.mockReturnValue(ownerClient({ peppol_access: { data: { ...GRANT, receive_enabled: false }, error: null } }))
    const res = await post()
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('PEPPOL_RECEIVING_NOT_ENABLED')
  })

  it('422 PEPPOL_REGISTRATION_PERSONAL_NUMBER for a personnummer, on the dry run already', async () => {
    const client = ownerClient({ company_settings: { data: { org_number: '800101-1234', company_name: 'Firma', country: 'SE' }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('PEPPOL_REGISTRATION_PERSONAL_NUMBER')
    expect(wrote(client)).toBe(false)
  })

  it('409 PEPPOL_REGISTRATION_CAP_REACHED on the dry run when every receiving slot is taken', async () => {
    process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS = '10'
    try {
      mockServiceClient.mockReturnValue(ownerClient({
        peppol_registrations: [{ data: [], error: null }, { data: null, error: null, count: 10 }],
      }))
      const res = await post('?dry_run=true')
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe('PEPPOL_REGISTRATION_CAP_REACHED')
    } finally {
      delete process.env.PEPPOL_RECEIVING_MAX_REGISTRATIONS
    }
  })

  it('a dry run previews the participant id and contacts no network, writing nothing', async () => {
    const client = ownerClient()
    mockServiceClient.mockReturnValue(client)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      participant_id: '0007:5595386219',
      action: 'register',
      network_call: 'on_commit',
    })
    expect(transport.registerRecipient).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('publishes the participant id for an owner and answers 201 with the registration', async () => {
    const client = ownerClient()
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.registration).toMatchObject({ registration_id: REG_ID, status: 'registered', participant_identifier: '5595386219' })
    expect(transport.registerRecipient).toHaveBeenCalledWith(expect.objectContaining({
      participant: { scheme: '0007', identifier: '5595386219' },
      tenantReference: COMPANY_ID,
    }))
  })

  it('an admin may register too', async () => {
    mockServiceClient.mockReturnValue(ownerClient({ company_members: role('admin') }))
    expect((await post()).status).toBe(201)
  })
})

// ---------------------------------------------------------------------------

describe('POST /api/v1/companies/:companyId/peppol/access-request', () => {
  const post = (body: unknown = {}, query = '') =>
    accessRequestPost(request(`${BASE}/access-request${query}`, { method: 'POST', body: JSON.stringify(body) }), params)

  const requestedRow = { company_id: COMPANY_ID, status: 'requested', max_sends: null, receive_enabled: false, requested_at: '2026-09-26T10:00:00.000Z' }

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post()).status).toBe(401)
  })

  it('403 without companies:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['companies:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: role('member') }))
    expect((await post()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a note over 1800 characters or an unknown type', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: role('member') }))
    expect((await post({ note: 'x'.repeat(1801) })).status).toBe(400)
    expect((await post({ wants_receiving: 'yes' })).status).toBe(400)
  })

  it('409 PEPPOL_ACCESS_ALREADY_ENABLED for a company that has access, on the dry run too', async () => {
    for (const query of ['', '?dry_run=true']) {
      const client = makeClient({
        company_members: role('member'),
        company_settings: SETTINGS,
        peppol_access: { data: GRANT, error: null },
      })
      mockServiceClient.mockReturnValue(client)
      const res = await post({}, query)
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe('PEPPOL_ACCESS_ALREADY_ENABLED')
      expect(wrote(client)).toBe(false)
    }
  })

  it('a dry run records nothing and mails nobody', async () => {
    const client = makeClient({
      company_members: role('member'),
      company_settings: SETTINGS,
      peppol_access: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ wants_receiving: true }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({
      current_status: 'none',
      would_create_request: true,
      note: '[vill ta emot e-fakturor]',
    })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('records the request, mails the operators once and answers 201', async () => {
    const client = makeClient({
      company_members: role('member'),
      company_settings: SETTINGS,
      peppol_access: [
        { data: null, error: null },                  // no row yet
        { data: requestedRow, error: null },          // upsert
        { data: requestedRow, error: null },          // summary
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ wants_receiving: true, note: 'Vi fakturerar kommuner.' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({ created: true, access: { status: 'requested', send_enabled: false } })
    expect(client.calls).toContainEqual(expect.objectContaining({ table: 'peppol_access', method: 'upsert' }))
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: 'support@example.test' })
    expect(sendEmailMock.mock.calls[0][0].text).toContain('--receive')
  })

  it('answers 200 without a second mail when a request is already open', async () => {
    mockServiceClient.mockReturnValue(makeClient({
      company_members: role('member'),
      company_settings: SETTINGS,
      peppol_access: { data: requestedRow, error: null },
    }))
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data.created).toBe(false)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})
