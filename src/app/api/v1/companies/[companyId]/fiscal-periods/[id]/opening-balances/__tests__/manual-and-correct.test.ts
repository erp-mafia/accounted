/**
 * Ingående balanser typed in by hand, through the v1 door of the operation
 * registry (src/lib/operations/opening-balances.ts via lib/operations/v1.ts):
 *   POST /api/v1/companies/:companyId/fiscal-periods/:id/opening-balances/manual
 *   POST /api/v1/companies/:companyId/fiscal-periods/:id/opening-balances/correct
 *
 * The rules under test are the service's (lib/import/opening-balance/service.ts):
 * the year's state, an existing IB, the company lock date, balance sheet
 * accounts only, balance, the storno-then-relink correction (never an edit of
 * the posted IB), and a dry run that writes nothing and spends no voucher.
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

const createJournalEntryMock = vi.fn()
const reverseEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return {
    ...actual,
    createJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args),
    reverseEntry: (...args: unknown[]) => reverseEntryMock(...args),
  }
})

const fetchOriginalLinesMock = vi.fn()
const cascadeMock = vi.fn()
vi.mock('@/lib/import/opening-balance/cascade', async () => {
  const actual = await vi.importActual<typeof import('@/lib/import/opening-balance/cascade')>(
    '@/lib/import/opening-balance/cascade',
  )
  return {
    ...actual,
    fetchEntryOpeningBalanceLines: (...args: unknown[]) => fetchOriginalLinesMock(...args),
    cascadeOpeningBalanceCorrection: (...args: unknown[]) => cascadeMock(...args),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as setManual } from '../manual/route'
import { POST as correct } from '../correct/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

/** Per-table queue mock (the last response repeats) that records every (table, method, args). */
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
  const rpc = vi.fn((...args: unknown[]) => {
    calls.push({ table: 'rpc', method: 'rpc', args })
    return buildChain('rpc')
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const BOOKS = new Set(['fiscal_periods', 'chart_of_accounts', 'journal_entries', 'journal_entry_lines'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OLD_ENTRY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NEW_ENTRY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/fiscal-periods/${PERIOD_ID}/opening-balances`
const params = { params: Promise.resolve({ companyId: COMPANY_ID, id: PERIOD_ID }) }

const CHART = { data: [{ account_number: '1930' }, { account_number: '2081' }, { account_number: '2099' }], error: null }
const OPEN_YEAR = {
  id: PERIOD_ID,
  period_start: '2026-01-01',
  is_closed: false,
  locked_at: null,
  opening_balances_set: false,
  opening_balance_entry_id: null,
}
const YEAR_WITH_IB = {
  ...OPEN_YEAR,
  opening_balances_set: true,
  opening_balance_entry_id: OLD_ENTRY_ID,
  opening_balance_entry: { voucher_series: 'A', voucher_number: 1 },
}
const NO_LOCK = { data: { bookkeeping_locked_through: null }, error: null }

const LINES = [
  { account_number: '1930', amount: 60000.004 },
  { account_number: '1510', debit_amount: 15000 },
  { account_number: '2081', amount: -25000 },
  { account_number: '2099', amount: -50000 },
]

function request(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  })
  createJournalEntryMock.mockResolvedValue({ id: NEW_ENTRY_ID, voucher_series: 'A', voucher_number: 7 })
  reverseEntryMock.mockResolvedValue({ id: 'storno-1' })
})

describe('POST .../opening-balances/manual', () => {
  const post = (body: unknown, query = '') => setManual(request(`${BASE}/manual${query}`, body), params)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ lines: LINES })).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['bookkeeping:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ lines: LINES })).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a numeric account, both amount and debit, or one line', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    for (const lines of [
      [{ account_number: 1930, amount: 1 }, { account_number: '2099', amount: -1 }],
      [{ account_number: '1930', amount: 1, debit_amount: 1 }, { account_number: '2099', amount: -1 }],
      [{ account_number: '1930', debit_amount: 1, credit_amount: 1 }, { account_number: '2099', amount: -1 }],
      [{ account_number: '1930', amount: 1 }],
    ]) {
      const res = await post({ lines })
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('404 OB_PERIOD_NOT_FOUND for a year outside the company', async () => {
    const client = makeClient({ company_members: OWNER, fiscal_periods: { data: null, error: { message: 'no rows' } } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ lines: LINES })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('OB_PERIOD_NOT_FOUND')
    const scoped = client.calls.filter((c) => c.table === 'fiscal_periods' && c.method === 'eq')
    expect(scoped.map((c) => c.args)).toContainEqual(['company_id', COMPANY_ID])
  })

  it('409 OB_PERIOD_ALREADY_HAS_BALANCES names the existing IB and writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, fiscal_periods: { data: YEAR_WITH_IB, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ lines: LINES })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('OB_PERIOD_ALREADY_HAS_BALANCES')
    expect(body.error.details.existingEntryId).toBe(OLD_ENTRY_ID)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('400 OB_PERIOD_LOCKED for a locked year', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, fiscal_periods: { data: { ...OPEN_YEAR, locked_at: '2026-02-01T00:00:00Z' }, error: null } }),
    )
    const res = await post({ lines: LINES })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('OB_PERIOD_LOCKED')
  })

  it('409 OB_SET_COMPANY_LOCK_DATE when the lock date covers the year start', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        fiscal_periods: { data: OPEN_YEAR, error: null },
        company_settings: { data: { bookkeeping_locked_through: '2026-01-31' }, error: null },
      }),
    )
    const res = await post({ lines: LINES })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('OB_SET_COMPANY_LOCK_DATE')
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('400 OB_PNL_ACCOUNT for a resultatkonto, OB_NON_BALANCE_SHEET_ACCOUNT for class 9', async () => {
    const client = () =>
      makeClient({ company_members: OWNER, fiscal_periods: { data: OPEN_YEAR, error: null }, company_settings: NO_LOCK })
    mockServiceClient.mockReturnValue(client())
    const pnl = await post({ lines: [{ account_number: '3001', amount: -100 }, { account_number: '1930', amount: 100 }] })
    expect(pnl.status).toBe(400)
    expect((await pnl.json()).error.code).toBe('OB_PNL_ACCOUNT')

    mockServiceClient.mockReturnValue(client())
    const internal = await post({ lines: [{ account_number: '9999', amount: -100 }, { account_number: '1930', amount: 100 }] })
    expect(internal.status).toBe(400)
    const body = await internal.json()
    expect(body.error.code).toBe('OB_NON_BALANCE_SHEET_ACCOUNT')
    expect(body.error.details.accounts).toEqual(['9999'])
  })

  it('400 OB_UNBALANCED with the difference', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, fiscal_periods: { data: OPEN_YEAR, error: null }, company_settings: NO_LOCK }),
    )
    const res = await post({ lines: [{ account_number: '1930', amount: 100 }, { account_number: '2099', amount: -90 }] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('OB_UNBALANCED')
    expect(body.error.details.diff).toBe(10)
  })

  it('a dry run previews the verifikat and the accounts to activate, and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      fiscal_periods: { data: OPEN_YEAR, error: null },
      company_settings: NO_LOCK,
      chart_of_accounts: CHART,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ lines: LINES }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      fiscal_period_id: PERIOD_ID,
      entry_date: '2026-01-01',
      total_debit: 75000,
      total_credit: 75000,
      accounts_to_activate: ['1510'],
      journal_entry: { total_debit: 75000, balanced: true },
    })
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('201 posts the IB through the engine on the year start, activates missing accounts and links the year', async () => {
    const client = makeClient({
      company_members: OWNER,
      fiscal_periods: { data: OPEN_YEAR, error: null },
      company_settings: NO_LOCK,
      chart_of_accounts: CHART,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ lines: LINES })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toEqual({
      journal_entry_id: NEW_ENTRY_ID,
      voucher_series: 'A',
      voucher_number: 7,
      fiscal_period_id: PERIOD_ID,
      entry_date: '2026-01-01',
      lines_created: 4,
      total_debit: 75000,
      total_credit: 75000,
    })

    expect(createJournalEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({
        fiscal_period_id: PERIOD_ID,
        entry_date: '2026-01-01',
        source_type: 'opening_balance',
        voucher_series: 'A',
        description: 'Ingående balanser',
        lines: [
          // Signed amounts become one side each, rounded to öre.
          { account_number: '1930', debit_amount: 60000, credit_amount: 0, line_description: 'IB 1930' },
          { account_number: '1510', debit_amount: 15000, credit_amount: 0, line_description: 'IB 1510' },
          { account_number: '2081', debit_amount: 0, credit_amount: 25000, line_description: 'IB 2081' },
          { account_number: '2099', debit_amount: 0, credit_amount: 50000, line_description: 'IB 2099' },
        ],
      }),
    )
    const activation = client.calls.find((c) => c.table === 'chart_of_accounts' && c.method === 'insert')
    expect((activation?.args[0] as Array<{ account_number: string }>).map((a) => a.account_number)).toEqual(['1510'])
    const link = client.calls.find((c) => c.table === 'fiscal_periods' && c.method === 'update')
    expect(link?.args[0]).toEqual({ opening_balance_entry_id: NEW_ENTRY_ID, opening_balances_set: true })
  })
})

describe('POST .../opening-balances/correct', () => {
  const post = (body: unknown, query = '') => correct(request(`${BASE}/correct${query}`, body), params)
  const CORRECTED = [
    { account_number: '1930', amount: 61000 },
    { account_number: '2081', amount: -25000 },
    { account_number: '2099', amount: -36000 },
  ]

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ lines: CORRECTED })).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['bookkeeping:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ lines: CORRECTED })).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a non-boolean cascade', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ lines: CORRECTED, cascade: 'yes' })).status).toBe(400)
  })

  it('404 OB_PERIOD_NOT_FOUND', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, fiscal_periods: { data: null, error: { message: 'no rows' } } }),
    )
    expect((await post({ lines: CORRECTED })).status).toBe(404)
  })

  it('409 OB_CORRECT_NO_EXISTING for a year without an IB', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, fiscal_periods: { data: OPEN_YEAR, error: null }, company_settings: NO_LOCK }),
    )
    const res = await post({ lines: CORRECTED })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('OB_CORRECT_NO_EXISTING')
  })

  it('409 OB_COMPANY_LOCK_DATE before anything is booked', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        fiscal_periods: { data: YEAR_WITH_IB, error: null },
        company_settings: { data: { bookkeeping_locked_through: '2026-03-31' }, error: null },
      }),
    )
    const res = await post({ lines: CORRECTED })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('OB_COMPANY_LOCK_DATE')
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('409 OB_CORRECT_YEAR_END_EXISTS when a bokslut is posted on top', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        fiscal_periods: { data: YEAR_WITH_IB, error: null },
        company_settings: NO_LOCK,
        journal_entries: { data: null, error: null, count: 1 },
      }),
    )
    const res = await post({ lines: CORRECTED })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('OB_CORRECT_YEAR_END_EXISTS')
  })

  it('a dry run previews the storno correction and per-account change, and writes nothing', async () => {
    fetchOriginalLinesMock.mockResolvedValue([
      { account_number: '1930', debit_amount: 60000, credit_amount: 0, line_description: 'IB 1930', dimensions: null },
      { account_number: '2081', debit_amount: 0, credit_amount: 25000, line_description: 'IB 2081', dimensions: null },
      { account_number: '2099', debit_amount: 0, credit_amount: 35000, line_description: 'IB 2099', dimensions: null },
    ])
    const client = makeClient({
      company_members: OWNER,
      fiscal_periods: { data: YEAR_WITH_IB, error: null },
      company_settings: NO_LOCK,
      journal_entries: { data: null, error: null, count: 0 },
      chart_of_accounts: CHART,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ lines: CORRECTED, cascade: true }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      method: 'storno',
      reverses_journal_entry_id: OLD_ENTRY_ID,
      reverses_voucher: 'A1',
      total_debit: 61000,
      cascade: true,
      accounts_to_activate: [],
      journal_entry: { description: 'Ingående balanser (korrigerade, rättelse av A1)', total_debit: 61000 },
    })
    expect(body.data.preview.account_changes).toEqual(
      expect.arrayContaining([
        { account_number: '1930', delta: 1000 },
        { account_number: '2099', delta: -1000 },
      ]),
    )
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(cascadeMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('201 books the corrected IB, stornoes the old one and relinks the year: the posted IB is never updated', async () => {
    const client = makeClient({
      company_members: OWNER,
      fiscal_periods: { data: YEAR_WITH_IB, error: null },
      company_settings: NO_LOCK,
      journal_entries: { data: null, error: null, count: 0 },
      chart_of_accounts: CHART,
      rpc: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ lines: CORRECTED })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({
      journal_entry_id: NEW_ENTRY_ID,
      reversed_entry_id: OLD_ENTRY_ID,
      fiscal_period_id: PERIOD_ID,
      total_debit: 61000,
    })
    expect(body.data.cascade).toBeUndefined()

    // Book first, then storno the old IB, then relink.
    expect(createJournalEntryMock.mock.invocationCallOrder[0]).toBeLessThan(reverseEntryMock.mock.invocationCallOrder[0])
    expect(reverseEntryMock).toHaveBeenCalledTimes(1)
    expect(reverseEntryMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', OLD_ENTRY_ID)
    expect(client.rpc).toHaveBeenCalledWith('replace_period_opening_balance_link', {
      p_company_id: COMPANY_ID,
      p_period_id: PERIOD_ID,
      p_new_entry_id: NEW_ENTRY_ID,
    })
    // Hard rule 1: no write to journal_entries / journal_entry_lines.
    expect(client.calls.some((c) => c.table.startsWith('journal_entr') && WRITES.has(c.method))).toBe(false)
  })

  it('a failed relink stornoes the new IB again and answers OB_CORRECT_FAILED with both ids', async () => {
    const client = makeClient({
      company_members: OWNER,
      fiscal_periods: { data: YEAR_WITH_IB, error: null },
      company_settings: NO_LOCK,
      journal_entries: { data: null, error: null, count: 0 },
      chart_of_accounts: CHART,
      rpc: { data: null, error: { message: 'boom' } },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ lines: CORRECTED })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('OB_CORRECT_FAILED')
    expect(body.error.details).toMatchObject({ newEntryId: NEW_ENTRY_ID, oldEntryId: OLD_ENTRY_ID })
    expect(reverseEntryMock).toHaveBeenNthCalledWith(2, expect.anything(), COMPANY_ID, 'user-1', NEW_ENTRY_ID)
  })

  it('cascade carries the per-account delta into later years and reports the result', async () => {
    fetchOriginalLinesMock.mockResolvedValue([
      { account_number: '1930', debit_amount: 60000, credit_amount: 0, line_description: null, dimensions: null },
      { account_number: '2081', debit_amount: 0, credit_amount: 25000, line_description: null, dimensions: null },
      { account_number: '2099', debit_amount: 0, credit_amount: 35000, line_description: null, dimensions: null },
    ])
    cascadeMock.mockResolvedValue({ corrected: [], skipped: [{ fiscal_period_id: 'p2', period_name: '2027', reason: 'locked' }] })
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        fiscal_periods: { data: YEAR_WITH_IB, error: null },
        company_settings: NO_LOCK,
        journal_entries: { data: null, error: null, count: 0 },
        chart_of_accounts: CHART,
        rpc: { data: null, error: null },
      }),
    )
    const res = await post({ lines: CORRECTED, cascade: true })
    expect(res.status).toBe(201)
    expect((await res.json()).data.cascade.skipped[0].reason).toBe('locked')
    const [, , , options] = cascadeMock.mock.calls[0] as [unknown, unknown, unknown, { deltas: Map<string, number>; basePeriodStart: string }]
    expect(options.basePeriodStart).toBe('2026-01-01')
    expect(Object.fromEntries(options.deltas)).toEqual({ '1930': 1000, '2099': -1000 })
  })
})
