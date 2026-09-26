/**
 * The company settings through the v1 door of the operation registry
 * (src/lib/operations/company-settings.ts via lib/operations/v1.ts):
 *   GET   /api/v1/companies/:companyId/settings                   settings.get
 *   PATCH /api/v1/companies/:companyId/settings                   settings.update
 *   PATCH /api/v1/companies/:companyId/settings/tax-profile       settings.update-tax-profile
 *   PATCH /api/v1/companies/:companyId/settings/bookkeeping-lock  settings.update-bookkeeping-lock
 *
 * The rules themselves are pinned by the dashboard route tests
 * (src/app/api/settings/__tests__/route.test.ts), which run the same service.
 * Here: auth, scope, the owner/admin gate API keys cannot skip, validation,
 * the public field names, dry run writing nothing, and deadline regeneration
 * happening on a tax-profile save and not on its dry run.
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
// The payee write-through is its own unit (lib/cash-accounts/__tests__/invoice-payee.test.ts).
vi.mock('@/lib/cash-accounts/invoice-payee', () => ({
  propagateLegacyPayeeWrite: vi.fn().mockResolvedValue(['SEK']),
}))
const deadlineMocks = vi.hoisted(() => ({ regenerate: vi.fn().mockResolvedValue({ created: 4, deleted: 4 }) }))
vi.mock('@/lib/tax/deadline-generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tax/deadline-generator')>()
  return { ...actual, regenerateTaxDeadlinesForUser: deadlineMocks.regenerate }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { propagateLegacyPayeeWrite } from '@/lib/cash-accounts/invoice-payee'
import { GET as getSettings, PATCH as updateSettings } from '../route'
import { PATCH as updateTaxProfile } from '../tax-profile/route'
import { PATCH as updateLock } from '../bookkeeping-lock/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

/** Per-table queue (the last entry repeats) that records every (table, method, args). */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
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
  const updates = (table: string) => calls.filter((c) => c.table === table && c.method === 'update').map((c) => c.args[0])
  return { calls, updates, from: vi.fn((table: string) => buildChain(table)), rpc: vi.fn(() => buildChain('rpc')) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/settings`
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const HAS_DEADLINES = { data: null, count: 5, error: null }
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

const STORED = {
  company_id: COMPANY_ID,
  entity_type: 'aktiebolag',
  onboarding_complete: true,
  bank_name: 'Testbanken',
  bankgiro: '991-2346',
  default_our_reference: 'Anna Andersson',
  email: 'faktura@acme.test',
  vat_registered: true,
  vat_number: 'SE556677889901',
  moms_period: 'quarterly',
  accounting_method: 'accrual',
  bookkeeping_locked_through: '2026-06-30',
  reminder_days_level_1: 15,
  reminder_days_level_2: 30,
  reminder_days_level_3: 45,
}

function request(url: string, init: RequestInit & { body?: string } = {}): Request {
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
const patch = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  request(url, { method: 'PATCH', body: JSON.stringify(body), headers })

function withScopes(scopes: string[]) {
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes,
    mode: 'live',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  withScopes(['companies:read', 'companies:write'])
})

describe('GET /api/v1/companies/:companyId/settings', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await getSettings(request(BASE), params)
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
  })

  it('403 without companies:read', async () => {
    withScopes(['reports:read'])
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await getSettings(request(BASE), params)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('returns the resource under public names, unset fields as null', async () => {
    const client = makeClient({ company_members: OWNER, company_settings: { data: STORED } })
    mockServiceClient.mockReturnValue(client)
    const res = await getSettings(request(BASE), params)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({
      company_id: COMPANY_ID,
      contact_person: 'Anna Andersson',
      bankgiro: '991-2346',
      moms_period: 'quarterly',
      accounting_method: 'accrual',
      bookkeeping_locked_through: '2026-06-30',
      website: null,
    })
    expect(data).not.toHaveProperty('default_our_reference')
    // A literal column list, never '*'.
    const select = client.calls.find((c) => c.table === 'company_settings' && c.method === 'select')
    expect(select?.args[0]).not.toBe('*')
  })

  it('a viewer may read', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: { data: { company_id: COMPANY_ID, role: 'viewer' } }, company_settings: { data: STORED } }),
    )
    const res = await getSettings(request(BASE), params)
    expect(res.status).toBe(200)
  })

  it('404 NOT_FOUND when the company has no settings row', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, company_settings: { data: null } }))
    const res = await getSettings(request(BASE), params)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

describe('PATCH /api/v1/companies/:companyId/settings', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await updateSettings(patch(BASE, { bank_name: 'X' }), params)
    expect(res.status).toBe(401)
  })

  it('403 INSUFFICIENT_SCOPE without companies:write', async () => {
    withScopes(['companies:read'])
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await updateSettings(patch(BASE, { bank_name: 'X' }), params)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details.required_scope).toBe('companies:write')
  })

  it('403 FORBIDDEN for a key whose user is a plain member: settings are owner/admin only', async () => {
    const client = makeClient({
      company_members: { data: { company_id: COMPANY_ID, role: 'member' } },
      company_settings: { data: STORED },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateSettings(patch(BASE, { phone: '08-1' }), params)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.details.required_roles).toEqual(['owner', 'admin'])
    expect(client.updates('company_settings')).toHaveLength(0)
  })

  it('400 without an Idempotency-Key', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const req = new Request(BASE, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-fixture-not-a-real-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ bank_name: 'X' }),
    })
    const res = await updateSettings(req, params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('400 for an empty body, an invalid bankgiro, an unknown placeholder, and fields owned by another door', async () => {
    for (const body of [
      {},
      { bankgiro: '991-2345' },
      { invoice_email_texts: { sv: { body: 'Se faktura {faktura_nr}.' } } },
      { default_our_reference: 'Sneaky' },
      { vat_registered: true },
      { bookkeeping_locked_through: '2026-01-31' },
    ]) {
      const client = makeClient({ company_members: OWNER, company_settings: { data: STORED } })
      mockServiceClient.mockReturnValue(client)
      const res = await updateSettings(patch(BASE, body), params)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
      expect(client.updates('company_settings')).toHaveLength(0)
    }
  })

  it('400 SETTINGS_REMINDER_DAYS_ORDER when the thresholds would stop increasing', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, company_settings: { data: STORED } }))
    const res = await updateSettings(patch(BASE, { reminder_days_level_2: 60 }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SETTINGS_REMINDER_DAYS_ORDER')
  })

  it('updates, maps contact_person onto default_our_reference and writes payment details through', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: [{ data: STORED }, { data: { ...STORED, bankgiro: '5050-1055', default_our_reference: 'Bo Berg' } }],
      deadlines: HAS_DEADLINES,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateSettings(patch(BASE, { contact_person: 'Bo Berg', bankgiro: '5050-1055' }), params)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ company_id: COMPANY_ID, contact_person: 'Bo Berg', bankgiro: '5050-1055' })
    // Only the supplied columns reach PostgREST, under the column name.
    expect(JSON.parse(JSON.stringify(client.updates('company_settings')[0]))).toEqual({
      bankgiro: '5050-1055',
      default_our_reference: 'Bo Berg',
    })
    expect(propagateLegacyPayeeWrite).toHaveBeenCalledTimes(1)
    expect(deadlineMocks.regenerate).not.toHaveBeenCalled()
  })

  it('accepts the wider non-legal settings, e.g. invoice copy recipients and toggles', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: [{ data: STORED }, { data: { ...STORED, quotes_enabled: false } }],
      deadlines: HAS_DEADLINES,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateSettings(
      patch(BASE, { quotes_enabled: false, invoice_email_cc_addresses: ['kopia@acme.test'] }),
      params,
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(JSON.stringify(client.updates('company_settings')[0]))).toEqual({
      quotes_enabled: false,
      invoice_email_cc_addresses: ['kopia@acme.test'],
    })
  })

  it('dry run: the merged resource plus what changes, and nothing written', async () => {
    const client = makeClient({ company_members: OWNER, company_settings: { data: STORED }, deadlines: HAS_DEADLINES })
    mockServiceClient.mockReturnValue(client)
    const res = await updateSettings(patch(`${BASE}?dry_run=true`, { contact_person: 'Bo Berg' }), params)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const { data } = await res.json()
    expect(data.dry_run).toBe(true)
    expect(data.preview).toMatchObject({
      contact_person: 'Bo Berg',
      bank_name: 'Testbanken',
      changes: { contact_person: 'Bo Berg' },
      previous: { contact_person: 'Anna Andersson' },
      deadlines_will_regenerate: false,
    })
    expect(client.updates('company_settings')).toHaveLength(0)
    expect(propagateLegacyPayeeWrite).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/v1/companies/:companyId/settings/tax-profile', () => {
  const URL_ = `${BASE}/tax-profile`

  it('409 ACCOUNTING_METHOD_CHANGE_MID_YEAR when the current fiscal year has posted verifikat', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: { data: { ...STORED, accounting_method: 'accrual' } },
      fiscal_periods: { data: { id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' } },
      journal_entries: { data: null, count: 12, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateTaxProfile(patch(URL_, { accounting_method: 'cash' }), params)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ACCOUNTING_METHOD_CHANGE_MID_YEAR')
    expect(body.error.details).toMatchObject({ fiscal_period_id: 'fp-2026', posted_entries: 12 })
    expect(client.updates('company_settings')).toHaveLength(0)
  })

  it('lets the method change while the current fiscal year has no posted verifikat (the onboarding fix)', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: [
        { data: { ...STORED, accounting_method: 'accrual' } },
        { data: { ...STORED, accounting_method: 'accrual' } },
        { data: { ...STORED, accounting_method: 'cash' } },
      ],
      fiscal_periods: { data: { id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' } },
      journal_entries: { data: null, count: 0, error: null },
      deadlines: HAS_DEADLINES,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateTaxProfile(patch(URL_, { accounting_method: 'cash' }), params)
    expect(res.status).toBe(200)
  })

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await updateTaxProfile(patch(URL_, { f_skatt: true }), params)
    expect(res.status).toBe(401)
  })

  it('403 FORBIDDEN for a plain member', async () => {
    const client = makeClient({ company_members: { data: { company_id: COMPANY_ID, role: 'member' } }, company_settings: { data: STORED } })
    mockServiceClient.mockReturnValue(client)
    const res = await updateTaxProfile(patch(URL_, { moms_period: 'monthly' }), params)
    expect(res.status).toBe(403)
    expect(client.updates('company_settings')).toHaveLength(0)
  })

  it('400 for a field outside the tax profile and for an invalid VAT number', async () => {
    for (const body of [{ bankgiro: '991-2346' }, { vat_number: 'SE123' }, {}]) {
      mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, company_settings: { data: STORED } }))
      const res = await updateTaxProfile(patch(URL_, body), params)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('refuses what the settings page refuses: a registered company without a VAT number', async () => {
    const client = makeClient({ company_members: OWNER, company_settings: { data: { ...STORED, vat_registered: false, vat_number: null } } })
    mockServiceClient.mockReturnValue(client)
    const res = await updateTaxProfile(patch(URL_, { vat_registered: true, moms_period: 'quarterly' }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SETTINGS_VAT_NUMBER_REQUIRED')
    expect(client.updates('company_settings')).toHaveLength(0)
  })

  it('refuses a non-calendar fiscal year for an enskild firma (BFL 3 kap.)', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, company_settings: { data: { ...STORED, entity_type: 'enskild_firma' } } }),
    )
    const res = await updateTaxProfile(patch(URL_, { fiscal_year_start_month: 7 }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SETTINGS_EF_CALENDAR_YEAR')
  })

  it('saves and regenerates the tax deadlines', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: [{ data: STORED }, { data: { ...STORED, moms_period: 'monthly' } }],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateTaxProfile(patch(URL_, { moms_period: 'monthly' }), params)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ moms_period: 'monthly', deadlines_regenerated: true })
    expect(deadlineMocks.regenerate).toHaveBeenCalledTimes(1)
    expect(deadlineMocks.regenerate.mock.calls[0][1]).toBe(COMPANY_ID)
  })

  it('switching to kontantmetoden turns deferred invoice booking off in the same write', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: [{ data: STORED }, { data: { ...STORED, accounting_method: 'cash' } }],
      deadlines: HAS_DEADLINES,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateTaxProfile(patch(URL_, { accounting_method: 'cash' }), params)
    expect(res.status).toBe(200)
    expect(JSON.parse(JSON.stringify(client.updates('company_settings')[0]))).toEqual({
      accounting_method: 'cash',
      defer_invoice_booking: false,
    })
  })

  it('dry run: previews the regeneration, regenerates nothing and writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, company_settings: { data: STORED } })
    mockServiceClient.mockReturnValue(client)
    const res = await updateTaxProfile(patch(`${URL_}?dry_run=true`, { moms_period: 'monthly' }), params)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.preview).toMatchObject({
      moms_period: 'monthly',
      changes: { moms_period: 'monthly' },
      previous: { moms_period: 'quarterly' },
      deadlines_will_regenerate: true,
    })
    expect(client.updates('company_settings')).toHaveLength(0)
    expect(deadlineMocks.regenerate).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/v1/companies/:companyId/settings/bookkeeping-lock', () => {
  const URL_ = `${BASE}/bookkeeping-lock`

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await updateLock(patch(URL_, { bookkeeping_locked_through: '2026-07-31' }), params)
    expect(res.status).toBe(401)
  })

  it('403 FORBIDDEN for a plain member', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: { data: { company_id: COMPANY_ID, role: 'member' } }, company_settings: { data: STORED } }),
    )
    const res = await updateLock(patch(URL_, { bookkeeping_locked_through: '2026-07-31' }), params)
    expect(res.status).toBe(403)
  })

  it('400 for a malformed date and for an empty body', async () => {
    for (const body of [{ bookkeeping_locked_through: '31/07/2026' }, {}, { auto_lock_period_days: 0 }]) {
      mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
      const res = await updateLock(patch(URL_, body), params)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('moves the lock forward without a warning', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: [{ data: STORED }, { data: { ...STORED, bookkeeping_locked_through: '2026-07-31' } }],
      deadlines: HAS_DEADLINES,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateLock(patch(URL_, { bookkeeping_locked_through: '2026-07-31' }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.bookkeeping_locked_through).toBe('2026-07-31')
    expect(body.meta?.warnings ?? body.warnings ?? []).toEqual([])
    expect(JSON.parse(JSON.stringify(client.updates('company_settings')[0]))).toEqual({
      bookkeeping_locked_through: '2026-07-31',
    })
  })

  it('moving it back is allowed, as on the settings page, and says it reopened dates', async () => {
    const client = makeClient({
      company_members: OWNER,
      // The lock op reads the current lock date first (filed-VAT check).
      company_settings: [{ data: STORED }, { data: STORED }, { data: { ...STORED, bookkeeping_locked_through: '2026-03-31' } }],
      deadlines: HAS_DEADLINES,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateLock(patch(URL_, { bookkeeping_locked_through: '2026-03-31' }), params)
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toContain('BOOKKEEPING_LOCK_MOVED_BACKWARDS')
  })

  // A filed momsdeklaration period: 2026 Q2 (april-june), filed in august.
  const FILED_Q2 = {
    data: [
      {
        id: 'dl-q2',
        tax_deadline_type: 'moms_quarterly',
        tax_period: '2026-Q2',
        is_completed: true,
        completed_at: '2026-08-12T10:00:00Z',
        status: 'completed',
        notes: null,
        due_date: '2026-08-12',
      },
    ],
    error: null,
  }

  it('409 BOOKKEEPING_LOCK_REOPENS_FILED_VAT when a move would reopen a filed period, naming it', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: { data: { ...STORED, bookkeeping_locked_through: '2026-06-30' } },
      deadlines: FILED_Q2,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateLock(patch(URL_, { bookkeeping_locked_through: '2026-04-30' }), params)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('BOOKKEEPING_LOCK_REOPENS_FILED_VAT')
    expect(JSON.stringify(body.error.details)).toContain('2026-Q2')
    expect(client.updates('company_settings')).toHaveLength(0)
  })

  it('acknowledge_filed_vat_periods lets it through and warns what was reopened', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: [
        { data: { ...STORED, bookkeeping_locked_through: '2026-06-30' } },
        { data: { ...STORED, bookkeeping_locked_through: '2026-06-30' } },
        { data: { ...STORED, bookkeeping_locked_through: '2026-04-30' } },
      ],
      deadlines: [FILED_Q2, HAS_DEADLINES],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateLock(
      patch(URL_, { bookkeeping_locked_through: '2026-04-30', acknowledge_filed_vat_periods: true }),
      params,
    )
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toContain('BOOKKEEPING_LOCK_REOPENED_FILED_VAT')
  })

  it('a lock move that stays behind every filed period needs no acknowledgement', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: [
        { data: { ...STORED, bookkeeping_locked_through: '2026-09-30' } },
        { data: { ...STORED, bookkeeping_locked_through: '2026-09-30' } },
        { data: { ...STORED, bookkeeping_locked_through: '2026-07-31' } },
      ],
      deadlines: [FILED_Q2, HAS_DEADLINES],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateLock(patch(URL_, { bookkeeping_locked_through: '2026-07-31' }), params)
    expect(res.status).toBe(200)
  })

  it('dry run of removing the lock warns and writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, company_settings: { data: STORED }, deadlines: HAS_DEADLINES })
    mockServiceClient.mockReturnValue(client)
    const res = await updateLock(patch(`${URL_}?dry_run=true`, { bookkeeping_locked_through: null }), params)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.preview.bookkeeping_locked_through).toBeNull()
    expect(data.preview.warnings).toEqual([expect.objectContaining({ code: 'BOOKKEEPING_LOCK_MOVED_BACKWARDS' })])
    expect(client.updates('company_settings')).toHaveLength(0)
  })
})
