/**
 * The Open Payments bank feed through the v1 door of the operation registry
 * (src/lib/operations/bank-feed.ts):
 *   GET  /api/v1/companies/:companyId/bank-feed
 *   GET  /api/v1/companies/:companyId/bank-feed/banks
 *   GET  /api/v1/companies/:companyId/bank-feed/banks/:bic
 *   GET  /api/v1/companies/:companyId/bank-feed/switch-progress
 *   POST /api/v1/companies/:companyId/bank-feed/invites
 *
 * Auth, scope and envelope are withApiV1's; the rules are the services' in
 * lib/bank-feed. The BankID consent itself has no door: the link answers
 * where the firmatecknare signs.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
const door = vi.hoisted(() => ({ openBankFeedDoor: vi.fn(), reachesUncoveredBanks: vi.fn(() => false) }))
vi.mock('@/lib/bank-feed/door', () => door)
const switchCampaign = vi.hoisted(() => ({ getBankSwitchProgress: vi.fn() }))
vi.mock('@/lib/bank-feed/switch-campaign', () => switchCampaign)
vi.mock('@/lib/email/brand-sender', () => ({
  getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se'),
  getSenderForCompany: vi.fn().mockResolvedValue({ fromName: null, fromAddress: null, replyTo: null, brand: null }),
}))
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(), isConfigured: vi.fn().mockReturnValue(true) }))
vi.mock('@/lib/email/service', () => ({ getEmailService: vi.fn().mockResolvedValue(mail) }))
// The mail path and the switch totals read through the service role.
const writer = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => writer.client }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET as overview } from '../route'
import { GET as banks } from '../banks/route'
import { GET as bank } from '../banks/[bic]/route'
import { GET as switchProgress } from '../switch-progress/route'
import { POST as invite } from '../invites/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONNECTION_ID = 'b1111111-1111-4111-8111-111111111111'
const INVITE_ID = 'c2222222-2222-4222-8222-222222222222'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/bank-feed`

const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }

const BANKS = [
  { bic: 'SWEDSESS', name: 'Swedbank', logoUrl: null, decoupled: true, redirect: true },
  { bic: 'ESSESESS', name: 'SEB', logoUrl: null, decoupled: true, redirect: false },
]
const connect = {
  banks: vi.fn(async () => BANKS),
  getBankDetails: vi.fn(async (_companyId: string, bic: string) => ({
    bic,
    name: 'Swedbank',
    decoupled: true,
    redirect: true,
    affiliates: [{ id: '08999', name: 'Sparbanken Nord' }],
    transactionHistoryMaxDays: 88,
    extendedTransactionHistoryMaxDays: 760,
  })),
}

const PROGRESS = {
  campaign: { on: true, deadline: '2026-11-09', days_left: 27, passed: false },
  company: { state: 'pending', pending: [{ connection_id: CONNECTION_ID, bank_name: 'Swedbank' }], uncovered: [], open_payments: 0, deadline: '2026-11-09', days_left: 27, passed: false, urgent: false },
  totals: null,
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
const post = (body: unknown, query = '') => request(`${BASE}/invites${query}`, { method: 'POST', body: JSON.stringify(body) })

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const bicParams = (bic: string) => ({ params: Promise.resolve({ companyId: COMPANY_ID, bic }) })

function client(byTable: Record<string, { data?: unknown; error?: unknown } | Array<{ data?: unknown; error?: unknown }>> = {}) {
  const db = createTableMockSupabase({
    company_members: MEMBER,
    bank_connections: { data: [] },
    bank_connect_invites: { data: { id: INVITE_ID } },
    companies: { data: { name: 'Bolaget AB', team_id: null } },
    ...byTable,
  })
  mockServiceClient.mockReturnValue(db.supabase)
  writer.client = db.supabase
  return db
}

function authOk(scopes: string[]) {
  mockValidate.mockResolvedValue({ userId: 'user-1', keyId: 'key-1', keyName: 'Test key', scopes, mode: 'live' })
}

beforeEach(() => {
  vi.clearAllMocks()
  door.openBankFeedDoor.mockResolvedValue({ ok: true, connect })
  switchCampaign.getBankSwitchProgress.mockResolvedValue(PROGRESS)
  mail.isConfigured.mockReturnValue(true)
  mail.sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
  authOk(['transactions:read', 'transactions:write'])
})

describe('GET /bank-feed/banks', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ valid: false, error: 'invalid' })
    client()
    expect((await banks(request(`${BASE}/banks`), companyParams)).status).toBe(401)
  })

  it('403 INSUFFICIENT_SCOPE without transactions:read', async () => {
    authOk(['invoices:read'])
    client({ company_members: OWNER })
    expect((await banks(request(`${BASE}/banks`), companyParams)).status).toBe(403)
  })

  it('404 when the key user is not a member of the company', async () => {
    client({ company_members: { data: null } })
    expect((await banks(request(`${BASE}/banks`), companyParams)).status).toBe(404)
  })

  it('answers the banks the connector reaches, in the v1 envelope', async () => {
    client()
    const res = await banks(request(`${BASE}/banks`), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.banks).toEqual([
      { bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: true, reached: true },
      { bic: 'ESSESESS', name: 'SEB', logo_url: null, decoupled: true, redirect: false, reached: true },
    ])
    expect(body.meta.request_id).toMatch(/^req_/)
    expect(connect.banks).toHaveBeenCalledWith(COMPANY_ID)
  })

  it('answers OPEN_BANKING_NOT_AVAILABLE with the reason when the company is not switched on', async () => {
    door.openBankFeedDoor.mockResolvedValue({ ok: false, reason: 'not_in_pilot' })
    client()
    const res = await banks(request(`${BASE}/banks`), companyParams)
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.error.code).toBe('OPEN_BANKING_NOT_AVAILABLE')
    expect(body.error.details).toMatchObject({ reason: 'not_in_pilot' })
  })
})

describe('GET /bank-feed/banks/:bic', () => {
  it('400 VALIDATION_ERROR for a malformed bic', async () => {
    client()
    const res = await bank(request(`${BASE}/banks/swedbank`), bicParams('swedbank'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('answers one bank with its sparbanker under affiliate_id', async () => {
    client()
    const res = await bank(request(`${BASE}/banks/SWEDSESS`), bicParams('SWEDSESS'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: true, transaction_history_max_days: 88 })
    expect(body.data.affiliates).toEqual([{ affiliate_id: '08999', name: 'Sparbanken Nord' }])
    expect(connect.getBankDetails).toHaveBeenCalledWith(COMPANY_ID, 'SWEDSESS')
  })
})

describe('GET /bank-feed', () => {
  it('answers the company\'s Open Payments connections and availability', async () => {
    client({
      bank_connections: {
        data: [
          {
            id: CONNECTION_ID,
            status: 'active',
            aggregator: 'open_payments',
            provider: 'open_payments',
            bic: 'SWEDSESS',
            bank_name: 'Swedbank',
            consent_expires: '2027-04-10T00:00:00Z',
            last_synced_at: '2026-10-13T05:00:00Z',
            initial_sync_completed_at: '2026-10-12T21:12:00Z',
            error_message: null,
            accounts_data: [],
          },
        ],
      },
    })
    const res = await overview(request(BASE), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.available).toBe(true)
    expect(body.data.reason).toBeNull()
    expect(body.data.connections).toEqual([
      expect.objectContaining({ connection_id: CONNECTION_ID, bank_name: 'Swedbank', bic: 'SWEDSESS', status: 'active', consent_expires: '2027-04-10T00:00:00Z' }),
    ])
    expect(body.data.connections[0]).not.toHaveProperty('id')
  })

  it('answers available=false with the reason, never an error, when the company is not switched on', async () => {
    door.openBankFeedDoor.mockResolvedValue({ ok: false, reason: 'subscription' })
    client()
    const res = await overview(request(BASE), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ available: false, reason: 'subscription', connections: [] })
  })
})

describe('GET /bank-feed/switch-progress', () => {
  it('answers the campaign and the company state; a member gets no totals client', async () => {
    client({ company_members: MEMBER })
    const res = await switchProgress(request(`${BASE}/switch-progress`), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual(PROGRESS)
    expect(switchCampaign.getBankSwitchProgress).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID }), { totalsClient: null })
  })

  it('reads the totals for an owner through the service role', async () => {
    client({ company_members: OWNER })
    const res = await switchProgress(request(`${BASE}/switch-progress`), companyParams)
    expect(res.status).toBe(200)
    const [, options] = switchCampaign.getBankSwitchProgress.mock.calls[0] as [unknown, { totalsClient: unknown }]
    expect(options.totalsClient).toBe(writer.client)
  })
})

describe('POST /bank-feed/invites', () => {
  it('400 VALIDATION_ERROR for a malformed body', async () => {
    client({ company_members: OWNER })
    expect((await invite(post({ offer_payments: 'yes' }), companyParams)).status).toBe(400)
    expect((await invite(post({ bic: 'swedbank' }), companyParams)).status).toBe(400)
    expect((await invite(post({ recipient_email: 'not-a-mail' }), companyParams)).status).toBe(400)
  })

  it('403 FORBIDDEN for a member below admin, before anything is stored', async () => {
    const db = client({ company_members: MEMBER })
    const res = await invite(post({ offer_payments: false }), companyParams)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('FORBIDDEN')
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
  })

  it('refuses OPEN_BANKING_NOT_AVAILABLE when the company is not switched on, before the admin check', async () => {
    door.openBankFeedDoor.mockResolvedValue({ ok: false, reason: 'no_connector' })
    const db = client({ company_members: OWNER })
    const res = await invite(post({ offer_payments: false }), companyParams)
    expect((await res.json()).error.code).toBe('OPEN_BANKING_NOT_AVAILABLE')
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
  })

  it('404 NOT_FOUND when the replaced connection is not the company\'s', async () => {
    const db = client({ company_members: OWNER, bank_connections: { data: null } })
    const res = await invite(post({ replace_connection_id: CONNECTION_ID }), companyParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
  })

  it('?dry_run=true answers the preview and mints nothing', async () => {
    const db = client({
      company_members: OWNER,
      bank_connections: { data: { id: CONNECTION_ID, status: 'active', bank_name: 'Swedbank', aggregator: 'open_payments' } },
    })
    const res = await invite(post({ replace_connection_id: CONNECTION_ID, bic: 'SWEDSESS' }, '?dry_run=true'), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data ?? body.preview ?? body).toBeTruthy()
    const preview = (body.preview ?? body.data?.preview ?? body.data) as Record<string, unknown>
    expect(preview).toMatchObject({
      bic: 'SWEDSESS',
      bank_name: 'Swedbank',
      replaces: { connection_id: CONNECTION_ID, aggregator: 'open_payments', kind: 'renewal' },
      email_will_be_sent: false,
      valid_days: 7,
      url: null,
    })
    expect(db.payloads('bank_connect_invites', 'insert')).toEqual([])
    expect(mail.sendEmail).not.toHaveBeenCalled()
  })

  it('mints the link for an owner (201) and mails it when a recipient is given', async () => {
    const db = client({ company_members: OWNER })
    const res = await invite(post({ recipient_email: 'Anna@Example.se', offer_payments: true, bank_name: 'Swedbank' }), companyParams)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.invite_id).toBe(INVITE_ID)
    expect(body.data.url).toMatch(/^https:\/\/app\.accounted\.se\/koppla\/[A-Za-z0-9_-]{43}$/)
    expect(body.data.email_sent).toBe(true)
    expect(typeof body.data.expires_at).toBe('string')
    const [inserted] = db.payloads('bank_connect_invites', 'insert') as Array<Record<string, unknown>>
    expect(inserted).toMatchObject({ company_id: COMPANY_ID, created_by: 'user-1', recipient_email: 'anna@example.se', offer_payments: true, bic: null })
    expect(inserted.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(mail.sendEmail).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mail.sendEmail.mock.calls[0])).toContain(body.data.url)
  })

  it('mints the link without a mail when no recipient is given', async () => {
    client({ company_members: OWNER })
    const res = await invite(post({ offer_payments: false }), companyParams)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.email_sent).toBe(false)
    expect(mail.sendEmail).not.toHaveBeenCalled()
  })
})
