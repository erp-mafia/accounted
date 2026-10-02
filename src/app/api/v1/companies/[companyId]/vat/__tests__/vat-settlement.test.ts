/**
 * Momsredovisning through the v1 door of the operation registry
 * (src/lib/operations/vat-settlement.ts via lib/operations/v1.ts):
 *   GET  /api/v1/companies/:companyId/reports/vat-declaration/settlement-proposal
 *   POST /api/v1/companies/:companyId/vat/settlement
 *
 * The rules under test are the service's (lib/reports/vat-settlement-booking.ts):
 * the booking posts exactly the proposal's lines through the engine with
 * source_type vat_settlement; a posted settlement, an empty period, a changed
 * proposal (fingerprint), a locked date and a missing fiscal year all refuse;
 * a dry run writes nothing. The proposal builder is mocked (it is the
 * dashboard's own, with its own tests).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

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
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, createJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args) }
})
const buildProposalMock = vi.fn()
vi.mock('@/lib/reports/vat-settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/vat-settlement')>()),
  buildVatSettlementProposal: (...args: unknown[]) => buildProposalMock(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { proposalFingerprint } from '@/lib/reports/vat-settlement-booking'
import { GET as getProposal } from '../../reports/vat-declaration/settlement-proposal/route'
import { POST as bookSettlement } from '../settlement/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

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
const BOOKS = new Set(['journal_entries', 'journal_entry_lines'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ENTRY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const V1 = `https://x.test/api/v1/companies/${COMPANY_ID}`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

const LINES = [
  { account_number: '2611', debit_amount: 25000, credit_amount: 0 },
  { account_number: '2641', debit_amount: 0, credit_amount: 6250.4 },
  { account_number: '2650', debit_amount: 0, credit_amount: 18749, line_description: 'Moms att betala' },
  { account_number: '3740', debit_amount: 0, credit_amount: 0.6, line_description: 'Öres- och kronutjämning' },
]

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    period: { type: 'quarterly', year: 2026, period: 1, start: '2026-01-01', end: '2026-03-31' },
    period_label: 'Kvartal 1 2026',
    entry_date: '2026-03-31',
    description: 'Momsredovisning Kvartal 1 2026',
    lines: LINES,
    filed_net: 18749,
    rounding_amount: 0.6,
    is_empty: false,
    existing_entries: [],
    ...overrides,
  }
}

/** An open, unlocked 2026: checkPeriodLock's row, then findFiscalPeriod's list. */
const OPEN_YEAR = [
  { data: { id: FY_ID, is_closed: false, locked_at: null }, error: null },
  { data: [{ id: FY_ID }], error: null },
]
const NO_LOCK = { data: { bookkeeping_locked_through: null }, error: null }

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

const book = (body: unknown, query = '') =>
  bookSettlement(request(`${V1}/vat/settlement${query}`, { method: 'POST', body: JSON.stringify(body) }), params)
const Q1 = { period_type: 'quarterly', year: 2026, period: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  buildProposalMock.mockResolvedValue(proposal())
  createJournalEntryMock.mockResolvedValue({
    id: ENTRY_ID,
    voucher_series: 'A',
    voucher_number: 57,
    entry_date: '2026-03-31',
  })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
})

describe('GET /reports/vat-declaration/settlement-proposal', () => {
  const read = (query: string) =>
    getProposal(request(`${V1}/reports/vat-declaration/settlement-proposal${query}`), params)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await read('?period_type=quarterly&year=2026&period=1')).status).toBe(401)
  })

  it('403 without reports:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['bookkeeping:write'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await read('?period_type=quarterly&year=2026&period=1')).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for yearly with period 2', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await read('?period_type=yearly&year=2026&period=2')).status).toBe(400)
  })

  it('404 for a fiscal_period_id that is not the company\'s', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, fiscal_periods: { data: null, error: null } }))
    const res = await read(`?period_type=yearly&year=2026&period=1&fiscal_period_id=${FY_ID}`)
    expect(res.status).toBe(404)
    expect(buildProposalMock).not.toHaveBeenCalled()
  })

  it('names an existing settlement journal_entry_id, not a bare id', async () => {
    buildProposalMock.mockResolvedValue(
      proposal({
        existing_entries: [
          { id: ENTRY_ID, status: 'posted', entry_date: '2026-03-31', source_type: 'vat_settlement', voucher_series: 'A', voucher_number: 40 },
        ],
      }),
    )
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const body = await (await read('?period_type=quarterly&year=2026&period=1')).json()
    expect(body.data.booking_status).toBe('booked')
    expect(body.data.existing_entries[0]).toMatchObject({ journal_entry_id: ENTRY_ID, status: 'posted' })
    expect(body.data.existing_entries[0].id).toBeUndefined()
  })

  it('200 with the proposal, its booking status and fingerprint', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await read('?period_type=quarterly&year=2026&period=1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.lines).toEqual(LINES)
    expect(body.data.booking_status).toBe('none')
    expect(body.data.fingerprint).toBe(proposalFingerprint(proposal() as never))
    expect(buildProposalMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'quarterly', 2026, 1, { fiscalPeriodId: undefined })
  })
})

describe('POST /vat/settlement', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await book(Q1)).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    const client = makeClient({ company_members: OWNER })
    mockServiceClient.mockReturnValue(client)
    expect((await book(Q1)).status).toBe(403)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR for a quarter above 4 or a malformed fingerprint', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await book({ ...Q1, period: 5 })).status).toBe(400)
    expect((await book({ ...Q1, expected_fingerprint: 'abc' })).status).toBe(400)
    expect(buildProposalMock).not.toHaveBeenCalled()
  })

  it('404 for a fiscal_period_id that is not the company\'s', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, fiscal_periods: { data: null, error: null } }))
    const res = await book({ period_type: 'yearly', year: 2026, period: 1, fiscal_period_id: FY_ID })
    expect(res.status).toBe(404)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('409 VAT_SETTLEMENT_ALREADY_BOOKED when a settlement is posted in the period, writing nothing', async () => {
    buildProposalMock.mockResolvedValue(
      proposal({
        existing_entries: [
          { id: ENTRY_ID, status: 'posted', entry_date: '2026-03-31', source_type: 'vat_settlement', voucher_series: 'A', voucher_number: 40 },
        ],
      }),
    )
    const client = makeClient({ company_members: OWNER, company_settings: NO_LOCK, fiscal_periods: OPEN_YEAR })
    mockServiceClient.mockReturnValue(client)
    const res = await book(Q1)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('VAT_SETTLEMENT_ALREADY_BOOKED')
    expect(body.error.details.journal_entry_id).toBe(ENTRY_ID)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('a manual momsomföring recognised by shape gates it too', async () => {
    buildProposalMock.mockResolvedValue(
      proposal({
        existing_entries: [
          { id: ENTRY_ID, status: 'posted', entry_date: '2026-03-31', source_type: 'manual', voucher_series: 'A', voucher_number: 41 },
        ],
      }),
    )
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await book(Q1)).status).toBe(409)
  })

  it('400 VAT_SETTLEMENT_EMPTY for a period with nothing to clear', async () => {
    buildProposalMock.mockResolvedValue(proposal({ lines: [], is_empty: true, filed_net: 0, rounding_amount: 0 }))
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await book(Q1)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VAT_SETTLEMENT_EMPTY')
  })

  it('409 VAT_SETTLEMENT_PROPOSAL_CHANGED when the reviewed fingerprint no longer matches', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, company_settings: NO_LOCK, fiscal_periods: OPEN_YEAR }))
    const res = await book({ ...Q1, expected_fingerprint: 'f'.repeat(64) })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('VAT_SETTLEMENT_PROPOSAL_CHANGED')
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('400 PERIOD_LOCKED when the company lock date covers the period end', async () => {
    const client = makeClient({
      company_members: OWNER,
      company_settings: { data: { bookkeeping_locked_through: '2026-03-31' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book(Q1)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details.reason).toBe('company_lock_date_covers')
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('400 VAT_SETTLEMENT_NO_FISCAL_PERIOD when no open year covers the date', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        company_settings: NO_LOCK,
        fiscal_periods: [{ data: null, error: null }, { data: [], error: null }],
      }),
    )
    const res = await book(Q1)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VAT_SETTLEMENT_NO_FISCAL_PERIOD')
  })

  it('dry run previews the exact verifikat and writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, company_settings: NO_LOCK, fiscal_periods: OPEN_YEAR })
    mockServiceClient.mockReturnValue(client)
    const res = await book(Q1, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.fingerprint).toBe(proposalFingerprint(proposal() as never))
    expect(body.data.preview.journal_entry).toMatchObject({
      fiscal_period_id: FY_ID,
      entry_date: '2026-03-31',
      total_debit: 25000,
      total_credit: 25000,
      balanced: true,
    })
    expect(body.data.preview.journal_entry.lines).toHaveLength(4)
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('201 posts exactly the proposal lines through the engine as vat_settlement', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, company_settings: NO_LOCK, fiscal_periods: OPEN_YEAR }))
    const res = await book({ ...Q1, expected_fingerprint: proposalFingerprint(proposal() as never) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toEqual({
      journal_entry_id: ENTRY_ID,
      voucher_series: 'A',
      voucher_number: 57,
      entry_date: '2026-03-31',
      period_label: 'Kvartal 1 2026',
      filed_net: 18749,
      rounding_amount: 0.6,
    })
    expect(createJournalEntryMock).toHaveBeenCalledTimes(1)
    const [, companyId, userId, input] = createJournalEntryMock.mock.calls[0]
    expect(companyId).toBe(COMPANY_ID)
    expect(userId).toBe('user-1')
    expect(input).toEqual({
      fiscal_period_id: FY_ID,
      entry_date: '2026-03-31',
      description: 'Momsredovisning Kvartal 1 2026',
      source_type: 'vat_settlement',
      lines: LINES,
    })
  })

  it('warns, but books, when only a draft settlement exists', async () => {
    buildProposalMock.mockResolvedValue(
      proposal({
        existing_entries: [
          { id: ENTRY_ID, status: 'draft', entry_date: '2026-03-31', source_type: 'vat_settlement', voucher_series: null, voucher_number: null },
        ],
      }),
    )
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, company_settings: NO_LOCK, fiscal_periods: OPEN_YEAR }))
    const res = await book(Q1)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.meta.warnings[0].code).toBe('VAT_SETTLEMENT_DRAFT_EXISTS')
  })

  it('a bookkeeping error from the engine is answered as the engine\'s code', async () => {
    const { AccountsNotInChartError } = await import('@/lib/bookkeeping/errors')
    createJournalEntryMock.mockRejectedValue(new AccountsNotInChartError(['3740']))
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, company_settings: NO_LOCK, fiscal_periods: OPEN_YEAR }))
    const res = await book(Q1)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect((await res.json()).error.code).toBe('ACCOUNTS_NOT_IN_CHART')
  })
})
