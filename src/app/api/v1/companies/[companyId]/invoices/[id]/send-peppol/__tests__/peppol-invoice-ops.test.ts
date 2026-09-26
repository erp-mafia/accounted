/**
 * Peppol for a customer invoice through the v1 door of the operation
 * registry (src/lib/operations/peppol.ts):
 *   GET  /api/v1/companies/:companyId/invoices/:id/peppol             (invoices.peppol-readiness)
 *   POST /api/v1/companies/:companyId/invoices/:id/send-peppol        (invoices.send-peppol)
 *   GET  /api/v1/companies/:companyId/invoices/:id/peppol/deliveries  (invoices.peppol-deliveries)
 *
 * The rules are the service's (lib/invoices/peppol-send-service.ts): the
 * access grant, the invoice state, the BIS preflight, the network only on
 * commit, the service-role staging RPC, the issuance of a draft after the
 * network accepted it, and the idempotent replay.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
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
// The v1 door must never reach for a cookie-bound or separate service client.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => { throw new Error('no session client on the v1 door') }),
  createServiceClient: vi.fn(() => { throw new Error('the v1 door already runs on service role') }),
}))
const issueAndBookMock = vi.fn()
vi.mock('@/lib/invoices/issue-and-book-invoice', () => ({
  issueAndBookInvoice: (...a: unknown[]) => issueAndBookMock(...a),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as readinessRoute } from '../../peppol/route'
import { GET as deliveriesRoute } from '../../peppol/deliveries/route'
import { POST as sendRoute } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface Resp {
  data?: unknown
  error?: unknown
  count?: number
}

/**
 * Per-table queue mock (the last entry repeats); RPCs answer from their own
 * queue keyed 'rpc:<name>'. Every (table, method, args) is recorded.
 */
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
const rpcNames = (client: ReturnType<typeof makeClient>) =>
  client.calls.filter((c) => c.table === 'rpc').map((c) => c.method)

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INV_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DELIVERY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const IDEMPOTENCY_KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INV_ID}`

const SELLER = { ...makeCompanySettings({
  company_name: 'Säljare AB',
  entity_type: 'aktiebolag',
  org_number: '556016-0680',
  vat_number: 'SE556016068001',
  bankgiro: '991-2346',
}), is_sandbox: false }
const COMPANY_SETTINGS = { data: SELLER, error: null }
const ACCESS = { data: { company_id: COMPANY_ID, status: 'enabled', max_sends: 50, receive_enabled: false }, error: null }
const SENT_COUNT = { data: null, error: null, count: 3 }

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    ...makeInvoice({
      id: INV_ID,
      invoice_number: 'F-2026-42',
      invoice_date: '2026-08-13',
      due_date: '2026-09-12',
      status: 'sent',
      subtotal: 100,
      vat_amount: 25,
      total: 125,
      remaining_amount: 125,
      vat_treatment: 'standard_25',
      your_reference: 'KST-100',
    }),
    company_id: COMPANY_ID,
    customer: makeCustomer({ name: 'Kund AB', org_number: '556677-8899', vat_number: 'SE556677889901' }),
    items: [{
      id: 'item-1', invoice_id: INV_ID, sort_order: 0, line_type: 'product', description: 'Rådgivning',
      quantity: 1, unit: 'tim', unit_price: 100, line_total: 100, vat_rate: 25, vat_amount: 25,
      created_at: '2026-08-13T00:00:00.000Z',
    }],
    ...overrides,
  }
}

const delivery = {
  id: DELIVERY_ID,
  invoice_id: INV_ID,
  idempotency_key: IDEMPOTENCY_KEY,
  recipient_scheme: '0007',
  recipient_identifier: '5566778899',
  xml_sha256: 'a'.repeat(64),
  provider: null,
  provider_submission_id: null,
  status: 'staged',
  status_at: '2026-09-26T10:00:00.000Z',
  status_detail: null,
  submitted_at: null,
  terminal_at: null,
  evidence_retrieved_at: null,
  filename: 'peppol-invoice-F-2026-42.xml',
  created_at: '2026-09-26T10:00:00.000Z',
}

function makeTransport(overrides: Partial<PeppolTransport> = {}): PeppolTransport {
  return {
    provider: 'test-ap',
    lookupRecipient: vi.fn().mockResolvedValue({
      reachable: true,
      participant: { scheme: '0007', identifier: '5566778899' },
      capabilities: [],
      checkedAt: '2026-09-26T10:00:01.000Z',
    }),
    submit: vi.fn().mockResolvedValue({
      provider: 'test-ap',
      providerSubmissionId: 'int-1',
      idempotencyKey: IDEMPOTENCY_KEY,
      tenantReference: COMPANY_ID,
      acceptedAt: '2026-09-26T10:00:02.000Z',
    }),
    verifyWebhook: vi.fn().mockResolvedValue([]),
    retrieveEvidence: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

/** The event RPC echoes each event back as the delivery projection. */
function eventEcho(status: string, submissionId: string | null = null) {
  return { data: { ...delivery, provider: 'test-ap', provider_submission_id: submissionId, status }, error: null }
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

const params = (id = INV_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

let unregister: (() => void) | null = null
let transport: PeppolTransport

beforeEach(() => {
  vi.clearAllMocks()
  process.env.PEPPOL_TRANSPORT_PROVIDER = 'test-ap'
  transport = makeTransport()
  unregister = registerPeppolTransport(transport)
  issueAndBookMock.mockResolvedValue({ ok: true, journalEntryId: JE_ID, partialFailures: [] })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:read', 'invoices:write'],
    mode: 'live',
  })
})

afterEach(() => {
  unregister?.()
  unregister = null
  delete process.env.PEPPOL_TRANSPORT_PROVIDER
})

// ---------------------------------------------------------------------------

describe('POST /api/v1/companies/:companyId/invoices/:id/send-peppol', () => {
  const send = (query = '', id = INV_ID) =>
    sendRoute(request(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${id}/send-peppol${query}`, { method: 'POST' }), params(id))

  function sendClient(overrides: Record<string, Resp | Resp[]> = {}) {
    return makeClient({
      company_members: MEMBER,
      company_settings: COMPANY_SETTINGS,
      peppol_access: ACCESS,
      peppol_deliveries: SENT_COUNT,
      invoices: { data: invoiceRow(), error: null },
      'rpc:stage_peppol_delivery_as_actor': { data: delivery, error: null },
      'rpc:record_peppol_delivery_event': [
        eventEcho('recipient_verified'),
        eventEcho('submitting'),
        eventEcho('submission_accepted', 'int-1'),
      ],
      ...overrides,
    })
  }

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await send()).status).toBe(401)
  })

  it('403 without invoices:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await send()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a path id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await send('', 'nope')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 INVOICE_NOT_FOUND for an invoice outside the company, scoped by company_id', async () => {
    const client = sendClient({ invoices: { data: null, error: { message: 'no rows' } } })
    mockServiceClient.mockReturnValue(client)
    const res = await send()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'invoices', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(wrote(client)).toBe(false)
  })

  it('503 PEPPOL_TRANSPORT_UNAVAILABLE when no access point is configured', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    unregister?.()
    unregister = null
    mockServiceClient.mockReturnValue(sendClient())
    const res = await send()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('PEPPOL_TRANSPORT_UNAVAILABLE')
    expect(body.error.details.reason).toBe('provider_selection_required')
  })

  it('403 PEPPOL_SANDBOX_NOT_ALLOWED for the demo company', async () => {
    const client = sendClient({ company_settings: { data: { ...SELLER, is_sandbox: true }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await send()
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('PEPPOL_SANDBOX_NOT_ALLOWED')
    expect(transport.submit).not.toHaveBeenCalled()
  })

  it('403 PEPPOL_ACCESS_REQUIRED without the operators\' grant, before the invoice is read', async () => {
    const client = sendClient({ peppol_access: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await send()
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('PEPPOL_ACCESS_REQUIRED')
    expect(client.from).not.toHaveBeenCalledWith('invoices')
  })

  it('409 PEPPOL_SEND_LIMIT_REACHED once the sending cap is used', async () => {
    mockServiceClient.mockReturnValue(sendClient({ peppol_deliveries: { data: null, error: null, count: 50 } }))
    const res = await send()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('PEPPOL_SEND_LIMIT_REACHED')
    expect(body.error.details).toMatchObject({ max_sends: 50, sent_count: 50 })
  })

  it.each([
    ['a credit note', { credited_invoice_id: JE_ID }],
    ['a cancelled invoice', { status: 'cancelled' }],
    ['a quote', { document_type: 'quote' }],
    ['a paid invoice', { status: 'paid' }],
  ])('409 PEPPOL_SEND_INVALID_STATUS for %s', async (_label, overrides) => {
    const client = sendClient({ invoices: { data: invoiceRow(overrides), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await send()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('PEPPOL_SEND_INVALID_STATUS')
    expect(wrote(client)).toBe(false)
  })

  it('400 VALIDATION_ERROR naming the BIS rule when the document does not build', async () => {
    const client = sendClient({ invoices: { data: invoiceRow({ your_reference: null }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await send()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues.map((i: { code: string }) => i.code)).toContain('BUYER_REFERENCE_REQUIRED')
    expect(transport.lookupRecipient).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('a dry run validates the document and writes nothing, contacting no network', async () => {
    const client = sendClient()
    mockServiceClient.mockReturnValue(client)
    const res = await send('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      invoice: { invoice_id: INV_ID, invoice_number: 'F-2026-42', total: 125, currency: 'SEK' },
      recipient: { scheme: '0007', identifier: '5566778899' },
      will_issue_invoice: false,
      network_submitted: false,
    })
    expect(transport.lookupRecipient).not.toHaveBeenCalled()
    expect(transport.submit).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('a dry run of a numberless draft allocates no number and snapshots no payee', async () => {
    const client = sendClient({ invoices: { data: invoiceRow({ status: 'draft', invoice_number: null }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await send('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      invoice: { invoice_number: '(allocated atomically on commit)' },
      will_issue_invoice: true,
    })
    expect(rpcNames(client)).not.toContain('generate_invoice_number')
    expect(wrote(client)).toBe(false)
    expect(issueAndBookMock).not.toHaveBeenCalled()
  })

  it('stages through the service-role RPC for the acting user, looks up, submits and records the lifecycle', async () => {
    const client = sendClient()
    mockServiceClient.mockReturnValue(client)
    const res = await send()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({
      invoice_id: INV_ID,
      invoice_status: 'sent',
      network_submitted: true,
      already_submitted: false,
      recipient: { scheme: '0007', identifier: '5566778899' },
      delivery: { delivery_id: DELIVERY_ID, provider_submission_id: 'int-1', status: 'submission_accepted' },
      issuance: null,
    })
    expect(body.data.delivery.id).toBeUndefined()
    // auth.uid() is NULL on service role: never the session RPC.
    expect(rpcNames(client)).not.toContain('stage_peppol_delivery')
    const stage = client.calls.find((c) => c.method === 'stage_peppol_delivery_as_actor')
    expect(stage?.args[0]).toMatchObject({ p_actor_id: 'user-1', p_company_id: COMPANY_ID, p_invoice_id: INV_ID })
    expect(transport.lookupRecipient).toHaveBeenCalledWith({ scheme: '0007', identifier: '5566778899' })
    expect(transport.submit).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: IDEMPOTENCY_KEY, tenantReference: COMPANY_ID }))
    expect(rpcNames(client).filter((n) => n === 'record_peppol_delivery_event')).toHaveLength(3)
    expect(issueAndBookMock).not.toHaveBeenCalled()
  })

  it('numbers a draft before building the document and issues it only after the network accepted it', async () => {
    const client = sendClient({
      invoices: { data: invoiceRow({ status: 'draft', invoice_number: null }), error: null },
      'rpc:generate_invoice_number': { data: 'F-2026-43', error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await send()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({
      invoice_number: 'F-2026-43',
      invoice_status: 'sent',
      journal_entry_id: JE_ID,
      issuance: { ok: true, partial_failures: [] },
    })
    const order = rpcNames(client)
    expect(order.indexOf('generate_invoice_number')).toBeLessThan(order.indexOf('stage_peppol_delivery_as_actor'))
    expect(issueAndBookMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID, userId: 'user-1' }))
  })

  it('reports a failed issuance as a warning without pretending the transmission did not happen', async () => {
    issueAndBookMock.mockResolvedValue({ ok: false, errorCode: 'INVOICE_SEND_JOURNAL_ENTRY_FAILED' })
    mockServiceClient.mockReturnValue(sendClient({
      invoices: { data: invoiceRow({ status: 'draft' }), error: null },
    }))
    const res = await send()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.issuance).toEqual({ ok: false, error_code: 'INVOICE_SEND_JOURNAL_ENTRY_FAILED' })
    expect(body.data.invoice_status).toBe('draft')
    expect(body.meta.warnings.map((w: { code: string }) => w.code)).toContain('PEPPOL_SENT_NOT_ISSUED')
  })

  it('replays an exact document already handed to the network instead of transmitting twice', async () => {
    const client = sendClient({
      'rpc:stage_peppol_delivery_as_actor': {
        data: { ...delivery, provider: 'test-ap', provider_submission_id: 'int-1', status: 'transport_succeeded' },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await send()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ already_submitted: true, network_submitted: true })
    expect(transport.lookupRecipient).not.toHaveBeenCalled()
    expect(transport.submit).not.toHaveBeenCalled()
  })

  it('422 PEPPOL_RECIPIENT_NOT_REACHABLE for a buyer outside the network, submitting nothing', async () => {
    transport.lookupRecipient = vi.fn().mockResolvedValue({
      reachable: false,
      participant: { scheme: '0007', identifier: '5566778899' },
      reasonCode: 'participant_not_registered',
      checkedAt: '2026-09-26T10:00:01.000Z',
    })
    const client = sendClient()
    mockServiceClient.mockReturnValue(client)
    const res = await send()
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('PEPPOL_RECIPIENT_NOT_REACHABLE')
    expect(body.error.details).toMatchObject({ identifier: '5566778899', reason: 'participant_not_registered' })
    expect(transport.submit).not.toHaveBeenCalled()
    expect(rpcNames(client)).not.toContain('record_peppol_delivery_event')
  })

  it('422 PEPPOL_FISCAL_PERIOD_MISSING when the staging RPC has no retention basis', async () => {
    mockServiceClient.mockReturnValue(sendClient({
      'rpc:stage_peppol_delivery_as_actor': {
        data: null,
        error: { code: 'P0002', message: 'Peppol delivery requires a fiscal period retention basis' },
      },
    }))
    const res = await send()
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('PEPPOL_FISCAL_PERIOD_MISSING')
    expect(transport.lookupRecipient).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

describe('GET /api/v1/companies/:companyId/invoices/:id/peppol', () => {
  const readiness = (id = INV_ID) =>
    readinessRoute(request(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${id}/peppol`), params(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await readiness()).status).toBe(401)
  })

  it('403 without invoices:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['companies:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await readiness()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a path id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await readiness('nope')).status).toBe(400)
  })

  it('404 INVOICE_NOT_FOUND for an invoice outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, invoices: { data: null, error: { message: 'no rows' } } }))
    const res = await readiness()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('answers ready with the participant ids when nothing is in the way, contacting no network', async () => {
    const client = makeClient({
      company_members: MEMBER,
      company_settings: COMPANY_SETTINGS,
      peppol_access: ACCESS,
      peppol_deliveries: SENT_COUNT,
      invoices: { data: invoiceRow(), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await readiness()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({
      invoice_id: INV_ID,
      ready: true,
      blockers: [],
      sender: { scheme: '0007', identifier: '5560160680' },
      recipient: { scheme: '0007', identifier: '5566778899' },
      transport: { available: true, provider: 'test-ap', reason: null },
      access: { status: 'enabled', max_sends: 50, sent_count: 3, remaining_sends: 47 },
    })
    expect(transport.lookupRecipient).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('lists every blocker at once: no grant, and the BIS rule the invoice breaks', async () => {
    mockServiceClient.mockReturnValue(makeClient({
      company_members: MEMBER,
      company_settings: COMPANY_SETTINGS,
      peppol_access: { data: null, error: null },
      invoices: { data: invoiceRow({ your_reference: null }), error: null },
    }))
    const res = await readiness()
    const body = await res.json()
    expect(body.data.ready).toBe(false)
    const codes = body.data.blockers.map((b: { code: string }) => b.code)
    expect(codes).toEqual(expect.arrayContaining(['PEPPOL_ACCESS_REQUIRED', 'BUYER_REFERENCE_REQUIRED']))
    for (const b of body.data.blockers) {
      expect(b.message_sv).toEqual(expect.any(String))
      expect(b.message_en).toEqual(expect.any(String))
    }
  })

  it('flags a credit note as not sendable', async () => {
    mockServiceClient.mockReturnValue(makeClient({
      company_members: MEMBER,
      company_settings: COMPANY_SETTINGS,
      peppol_access: ACCESS,
      peppol_deliveries: SENT_COUNT,
      invoices: { data: invoiceRow({ credited_invoice_id: JE_ID }), error: null },
    }))
    const body = await (await readiness()).json()
    expect(body.data.blockers.map((b: { code: string }) => b.code)).toContain('PEPPOL_SEND_INVALID_STATUS')
  })
})

// ---------------------------------------------------------------------------

describe('GET /api/v1/companies/:companyId/invoices/:id/peppol/deliveries', () => {
  const deliveries = (id = INV_ID) =>
    deliveriesRoute(request(`${BASE.replace(INV_ID, id)}/peppol/deliveries`), params(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await deliveries()).status).toBe(401)
  })

  it('403 without invoices:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['companies:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await deliveries()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a path id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await deliveries('nope')).status).toBe(400)
  })

  it('404 INVOICE_NOT_FOUND for an invoice outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, invoices: { data: null, error: { message: 'no rows' } } }))
    expect((await deliveries()).status).toBe(404)
  })

  it('lists the deliveries with qualified ids, filtered by company and invoice', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: { data: { id: INV_ID }, error: null },
      peppol_deliveries: { data: [{ ...delivery, provider: 'test-ap', provider_submission_id: 'int-1', status: 'transport_succeeded' }], error: null },
      peppol_access: ACCESS,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await deliveries()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.invoice_id).toBe(INV_ID)
    expect(body.data.deliveries).toEqual([
      expect.objectContaining({ delivery_id: DELIVERY_ID, status: 'transport_succeeded', provider_submission_id: 'int-1' }),
    ])
    expect(body.data.deliveries[0].id).toBeUndefined()
    expect(body.data.deliveries[0].xml_payload).toBeUndefined()
    expect(body.data.transport).toEqual({ available: true, provider: 'test-ap', reason: null })
    expect(client.calls).toContainEqual({ table: 'peppol_deliveries', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(client.calls).toContainEqual({ table: 'peppol_deliveries', method: 'eq', args: ['invoice_id', INV_ID] })
  })
})
