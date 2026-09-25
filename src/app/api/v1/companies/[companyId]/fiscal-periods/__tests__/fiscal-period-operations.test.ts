/**
 * Räkenskapsår through the v1 door of the operation registry
 * (src/lib/operations/fiscal-periods.ts via lib/operations/v1.ts):
 *   POST  /api/v1/companies/:companyId/fiscal-periods
 *   PATCH /api/v1/companies/:companyId/fiscal-periods/:id
 *   POST  /api/v1/companies/:companyId/fiscal-periods/:id/unlock
 *   POST  /api/v1/companies/:companyId/fiscal-periods/:id/close-external
 *   POST  /api/v1/companies/:companyId/fiscal-periods/:id/reopen-external
 *
 * The rules are lib/core/bookkeeping/fiscal-year-service.ts; the dashboard
 * route tests cover the rest of its branches. Every dry run here asserts that
 * nothing was written: it is also the MCP staging preview.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'

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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as createPeriod } from '../route'
import { PATCH as updatePeriod } from '../[id]/route'
import { POST as unlockPeriod } from '../[id]/unlock/route'
import { POST as closeExternal } from '../[id]/close-external/route'
import { POST as reopenExternal } from '../[id]/reopen-external/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

/** Per-table queue mock that also records every (table, method, args). */
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
  return {
    calls,
    from: vi.fn((table: string) => buildChain(table)),
    rpc: vi.fn(() => buildChain('rpc')),
  }
}

/** Writes against the books: any insert/update/delete/upsert on these tables. */
function writesTo(client: ReturnType<typeof makeClient>, tables: string[]) {
  return client.calls.filter(
    (c) => tables.includes(c.table) && ['insert', 'update', 'delete', 'upsert'].includes(c.method),
  )
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PRIOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/fiscal-periods`

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

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const periodParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: PERIOD_ID }) }

function periodRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PERIOD_ID,
    user_id: 'user-1',
    company_id: COMPANY_ID,
    name: 'Räkenskapsår 2027',
    period_start: '2027-01-01',
    period_end: '2027-12-31',
    is_closed: false,
    closed_at: null,
    closed_externally: false,
    locked_at: null,
    closing_entry_id: null,
    opening_balance_entry_id: null,
    previous_period_id: PRIOR_ID,
    created_at: '2026-12-01T09:00:00Z',
    ...overrides,
  }
}

const PRIOR_2026 = { id: PRIOR_ID, period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/fiscal-periods', () => {
  const body = JSON.stringify({ name: 'Räkenskapsår 2027', period_start: '2027-01-01', period_end: '2027-12-31' })

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await createPeriod(request(BASE, { method: 'POST', body }), companyParams)
    expect(res.status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await createPeriod(request(BASE, { method: 'POST', body }), companyParams)
    expect(res.status).toBe(403)
  })

  it('400 VALIDATION_ERROR when the name is missing or the dates are reversed', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const noName = await createPeriod(
      request(BASE, { method: 'POST', body: '{"period_start":"2027-01-01","period_end":"2027-12-31"}' }),
      companyParams,
    )
    expect(noName.status).toBe(400)
    expect((await noName.json()).error.code).toBe('VALIDATION_ERROR')

    const reversed = await createPeriod(
      request(BASE, { method: 'POST', body: '{"name":"X","period_start":"2027-12-31","period_end":"2027-01-01"}' }),
      companyParams,
    )
    expect(reversed.status).toBe(400)
  })

  it('201 appends the next year, chained onto its predecessor, with the open-prior-year warning', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: [
        { data: [PRIOR_2026], error: null }, // every period
        { data: [{ id: PRIOR_ID, name: 'Räkenskapsår 2026', period_start: '2026-01-01', period_end: '2026-12-31' }], error: null }, // open priors
        { data: [], error: null }, // overlap
        { data: periodRow(), error: null }, // insert
      ],
      company_settings: { data: { bookkeeping_locked_through: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await createPeriod(request(BASE, { method: 'POST', body }), companyParams)
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.data.fiscal_period).toMatchObject({ id: PERIOD_ID, period_start: '2027-01-01', previous_period_id: PRIOR_ID })
    // Only the public columns leave the API.
    expect(json.data.fiscal_period.user_id).toBeUndefined()
    expect(JSON.stringify(json)).toContain('PRIOR_FISCAL_YEAR_STILL_OPEN')
    const insert = client.calls.find((c) => c.table === 'fiscal_periods' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({
      company_id: COMPANY_ID,
      user_id: 'user-1',
      period_start: '2027-01-01',
      period_end: '2027-12-31',
      previous_period_id: PRIOR_ID,
    })
  })

  it('400 FISCAL_PERIOD_NOT_CONTIGUOUS names the start that continues the chain', async () => {
    const client = makeClient({ company_members: MEMBER, fiscal_periods: { data: [PRIOR_2026], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await createPeriod(
      request(BASE, { method: 'POST', body: '{"name":"X","period_start":"2027-02-01","period_end":"2027-12-31"}' }),
      companyParams,
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('FISCAL_PERIOD_NOT_CONTIGUOUS')
    expect(json.error.details.expected_start).toBe('2027-01-01')
    expect(writesTo(client, ['fiscal_periods'])).toHaveLength(0)
  })

  it('400 FISCAL_PERIOD_TOO_LONG past 18 months', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, fiscal_periods: { data: [], error: null } }))
    const res = await createPeriod(
      request(BASE, { method: 'POST', body: '{"name":"X","period_start":"2027-01-01","period_end":"2028-12-31"}' }),
      companyParams,
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('FISCAL_PERIOD_TOO_LONG')
    expect(json.error.details.months).toBe(24)
  })

  it('409 FISCAL_PERIOD_OVERLAP', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        fiscal_periods: [
          { data: [], error: null },
          { data: [{ id: PRIOR_ID, name: 'Räkenskapsår 2027' }], error: null },
        ],
      }),
    )
    const res = await createPeriod(request(BASE, { method: 'POST', body }), companyParams)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('FISCAL_PERIOD_OVERLAP')
  })

  it('a dry run previews the chain and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: [
        { data: [PRIOR_2026], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
      company_settings: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await createPeriod(request(`${BASE}?dry_run=true`, { method: 'POST', body }), companyParams)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.dry_run).toBe(true)
    expect(json.data.preview).toMatchObject({ previous_period_id: PRIOR_ID, relinks_period_id: null })
    expect(writesTo(client, ['fiscal_periods', 'audit_log'])).toHaveLength(0)
    expect(client.rpc).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/v1/companies/:companyId/fiscal-periods/:id', () => {
  it('renames through the path id without touching the dates', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: [
        { data: periodRow(), error: null },
        { data: periodRow({ name: 'Första året' }), error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updatePeriod(
      request(`${BASE}/${PERIOD_ID}`, { method: 'PATCH', body: '{"name":"Första året"}' }),
      periodParams,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.name).toBe('Första året')
    const update = client.calls.find((c) => c.table === 'fiscal_periods' && c.method === 'update')
    expect(update?.args[0]).toEqual({ name: 'Första året' })
    // A rename never asks about posted verifikat.
    expect(client.calls.some((c) => c.table === 'journal_entries')).toBe(false)
  })

  it('400 when the body changes nothing', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await updatePeriod(request(`${BASE}/${PERIOD_ID}`, { method: 'PATCH', body: '{}' }), periodParams)
    expect(res.status).toBe(400)
  })

  it('404 PERIOD_NOT_FOUND for an id outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, fiscal_periods: { data: null, error: null } }))
    const res = await updatePeriod(
      request(`${BASE}/${PERIOD_ID}`, { method: 'PATCH', body: '{"name":"X"}' }),
      periodParams,
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PERIOD_NOT_FOUND')
  })

  it('409 FISCAL_PERIOD_UPDATE_LOCKED for a locked year', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, fiscal_periods: { data: periodRow({ locked_at: '2028-01-10T00:00:00Z' }), error: null } }),
    )
    const res = await updatePeriod(
      request(`${BASE}/${PERIOD_ID}`, { method: 'PATCH', body: '{"name":"X"}' }),
      periodParams,
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('FISCAL_PERIOD_UPDATE_LOCKED')
  })

  it('409 FISCAL_PERIOD_UPDATE_CLOSED for a closed year', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        fiscal_periods: { data: periodRow({ is_closed: true, locked_at: '2028-01-10T00:00:00Z' }), error: null },
      }),
    )
    const res = await updatePeriod(
      request(`${BASE}/${PERIOD_ID}`, { method: 'PATCH', body: '{"name":"X"}' }),
      periodParams,
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('FISCAL_PERIOD_UPDATE_CLOSED')
  })

  it('409 FISCAL_PERIOD_HAS_POSTED_ENTRIES when dates move under posted verifikat', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: { data: periodRow(), error: null },
      journal_entries: { count: 3, data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updatePeriod(
      request(`${BASE}/${PERIOD_ID}`, { method: 'PATCH', body: '{"period_end":"2027-06-30"}' }),
      periodParams,
    )
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error.code).toBe('FISCAL_PERIOD_HAS_POSTED_ENTRIES')
    expect(json.error.details.entry_count).toBe(3)
    expect(writesTo(client, ['fiscal_periods'])).toHaveLength(0)
  })

  it('a dry run of a re-date runs every check and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: [
        { data: periodRow(), error: null }, // the period
        { count: 1, data: null, error: null }, // earlier periods
        { data: [], error: null }, // overlap
      ],
      journal_entries: { count: 0, data: null, error: null },
      companies: { data: { entity_type: 'aktiebolag' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updatePeriod(
      request(`${BASE}/${PERIOD_ID}?dry_run=true`, { method: 'PATCH', body: '{"period_end":"2027-06-30"}' }),
      periodParams,
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.preview).toMatchObject({ fiscal_period_id: PERIOD_ID, changes: { period_end: '2027-06-30' } })
    expect(writesTo(client, ['fiscal_periods', 'audit_log'])).toHaveLength(0)
  })
})

describe('POST /api/v1/companies/:companyId/fiscal-periods/:id/unlock', () => {
  it('unlocks a locked year and writes the audit row', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: [
        { data: periodRow({ locked_at: '2028-01-10T00:00:00Z' }), error: null },
        { data: periodRow({ locked_at: null }), error: null },
      ],
      audit_log: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await unlockPeriod(request(`${BASE}/${PERIOD_ID}/unlock`, { method: 'POST' }), periodParams)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toMatchObject({ id: PERIOD_ID, locked_at: null })
    expect(json.data.company_id).toBeUndefined()
    expect(client.calls.some((c) => c.table === 'audit_log' && c.method === 'insert')).toBe(true)
  })

  it('409 PERIOD_UNLOCK_CLOSED for a closed year', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        fiscal_periods: { data: periodRow({ is_closed: true, locked_at: '2028-01-10T00:00:00Z' }), error: null },
      }),
    )
    const res = await unlockPeriod(request(`${BASE}/${PERIOD_ID}/unlock`, { method: 'POST' }), periodParams)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('PERIOD_UNLOCK_CLOSED')
  })

  it('a dry run checks the lock and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: { data: periodRow({ locked_at: '2028-01-10T00:00:00Z' }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await unlockPeriod(
      request(`${BASE}/${PERIOD_ID}/unlock?dry_run=true`, { method: 'POST' }),
      periodParams,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ fiscal_period_id: PERIOD_ID, will_set_locked_at: null })
    expect(writesTo(client, ['fiscal_periods', 'audit_log'])).toHaveLength(0)
  })

  it('a dry run of an unlocked year answers 409 PERIOD_UNLOCK_NOT_LOCKED', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, fiscal_periods: { data: periodRow(), error: null } }))
    const res = await unlockPeriod(
      request(`${BASE}/${PERIOD_ID}/unlock?dry_run=true`, { method: 'POST' }),
      periodParams,
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('PERIOD_UNLOCK_NOT_LOCKED')
  })
})

describe('POST /api/v1/companies/:companyId/fiscal-periods/:id/close-external', () => {
  const ENDED = { period_start: '2024-01-01', period_end: '2024-12-31', name: 'Räkenskapsår 2024' }

  it('409 FISCAL_PERIOD_CLOSE_EXTERNAL_NOT_ENDED for a running year', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: { data: periodRow({ period_start: '2099-01-01', period_end: '2099-12-31' }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await closeExternal(request(`${BASE}/${PERIOD_ID}/close-external`, { method: 'POST' }), periodParams)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('FISCAL_PERIOD_CLOSE_EXTERNAL_NOT_ENDED')
    expect(writesTo(client, ['fiscal_periods', 'audit_log'])).toHaveLength(0)
  })

  it('a dry run refuses a year bookkept here with result accounts, writing nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: { data: periodRow(ENDED), error: null },
      journal_entries: [
        { count: 0, data: null, error: null }, // imported verifikat
        { data: [{ id: 'je-1' }], error: null }, // every verifikat in the year
      ],
      journal_entry_lines: { count: 4, data: null, error: null }, // lines on 3xxx-8xxx
    })
    mockServiceClient.mockReturnValue(client)
    const res = await closeExternal(
      request(`${BASE}/${PERIOD_ID}/close-external?dry_run=true`, { method: 'POST' }),
      periodParams,
    )
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error.code).toBe('FISCAL_PERIOD_CLOSE_EXTERNAL_NATIVE_BOOKKEEPING')
    expect(json.error.details.reason).toMatch(/resultatkonton/)
    expect(writesTo(client, ['fiscal_periods', 'audit_log'])).toHaveLength(0)
  })

  it('404 PERIOD_NOT_FOUND', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, fiscal_periods: { data: null, error: null } }))
    const res = await closeExternal(request(`${BASE}/${PERIOD_ID}/close-external`, { method: 'POST' }), periodParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PERIOD_NOT_FOUND')
  })
})

describe('POST /api/v1/companies/:companyId/fiscal-periods/:id/reopen-external', () => {
  const KLARMARKERAD = {
    name: 'Räkenskapsår 2024',
    period_start: '2024-01-01',
    period_end: '2024-12-31',
    is_closed: true,
    closed_at: '2026-09-01T00:00:00Z',
    closed_externally: true,
    locked_at: '2026-09-01T00:00:00Z',
  }

  it('reopens and unlocks a year closed by klarmarkera', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: [
        { data: periodRow(KLARMARKERAD), error: null },
        {
          data: periodRow({ ...KLARMARKERAD, is_closed: false, closed_at: null, closed_externally: false, locked_at: null }),
          error: null,
        },
      ],
      audit_log: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await reopenExternal(request(`${BASE}/${PERIOD_ID}/reopen-external`, { method: 'POST' }), periodParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ is_closed: false, closed_externally: false, locked_at: null })
    expect(client.calls.some((c) => c.table === 'audit_log' && c.method === 'insert')).toBe(true)
  })

  it('409 PERIOD_REOPEN_NOT_EXTERNAL for a year closed by a year-end run here', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: { data: periodRow({ ...KLARMARKERAD, closed_externally: false, closing_entry_id: 'je-close' }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await reopenExternal(request(`${BASE}/${PERIOD_ID}/reopen-external`, { method: 'POST' }), periodParams)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('PERIOD_REOPEN_NOT_EXTERNAL')
    expect(writesTo(client, ['fiscal_periods', 'audit_log'])).toHaveLength(0)
  })

  it('a dry run previews the reopen and writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER, fiscal_periods: { data: periodRow(KLARMARKERAD), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await reopenExternal(
      request(`${BASE}/${PERIOD_ID}/reopen-external?dry_run=true`, { method: 'POST' }),
      periodParams,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ fiscal_period_id: PERIOD_ID, will_reopen: true })
    expect(writesTo(client, ['fiscal_periods', 'audit_log'])).toHaveLength(0)
  })
})
