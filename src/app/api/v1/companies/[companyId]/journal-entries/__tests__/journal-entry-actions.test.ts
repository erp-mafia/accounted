/**
 * Journal-entry actions through the v1 door of the operation registry
 * (src/lib/operations/journal-entries.ts via lib/operations/v1.ts):
 *   POST   /journal-entries/:id/correct-metadata   inline rättelse, text/date
 *   POST   /journal-entries/:id/strike-lines       inline rättelse, lines
 *   POST   /journal-entries/:id/redate             storno + re-post on a new date
 *   PATCH  /journal-entries/:id                    edit a DRAFT
 *   PATCH  /journal-entries/:id/notes              the internal note
 *   POST   /journal-entries/:id/no-document-required (and DELETE)
 *   POST   /journal-entries/no-document-required   batch
 *   GET    /journal-entries/:id/rattelse-log
 *
 * The rules under test are the services' (journal-entry-corrections.ts,
 * journal-entry-edits.ts, no-doc-required.ts). The heart of it: a posted
 * verifikat only changes through the two RPCs or the storno flow, and a dry
 * run calls neither and writes nothing.
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
const recordateEntryMock = vi.fn()
vi.mock('@/lib/core/bookkeeping/storno-service', () => ({
  recordateEntry: (...args: unknown[]) => recordateEntryMock(...args),
}))
const backfillMock = vi.fn().mockResolvedValue([])
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => backfillMock(...args),
}))
const updateDraftEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, updateDraftEntry: (...args: unknown[]) => updateDraftEntryMock(...args) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { TargetPeriodLockedError } from '@/lib/bookkeeping/errors'
import { POST as correctMetadata } from '../[id]/correct-metadata/route'
import { POST as strikeLines } from '../[id]/strike-lines/route'
import { POST as redate } from '../[id]/redate/route'
import { PATCH as updateDraft } from '../[id]/route'
import { PATCH as setNote } from '../[id]/notes/route'
import { POST as setNoDoc, DELETE as clearNoDoc } from '../[id]/no-document-required/route'
import { POST as batchNoDoc } from '../no-document-required/route'
import { GET as rattelseLog } from '../[id]/rattelse-log/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface Resp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock (the last response repeats) that records every call; rpc has its own queue. */
function makeClient(byTable: Record<string, Resp | Resp[]>) {
  const queues = new Map<string, Resp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const chain = (key: string): unknown =>
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
            return chain(key)
          }
        },
      },
    )
  const rpc = vi.fn((fn: string, args: unknown) => {
    calls.push({ table: 'rpc', method: fn, args: [args] })
    return chain(`rpc:${fn}`)
  })
  return { calls, from: vi.fn((table: string) => chain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
/** Business tables only: withApiV1's own bookkeeping (idempotency, usage) is not the operation's. */
const BOOKS = new Set([
  'journal_entries',
  'journal_entry_lines',
  'journal_entry_rattelse_log',
  'journal_entry_no_doc_required',
  'chart_of_accounts',
])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.table === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PERIOD_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const LINE_A = '11111111-1111-4111-8111-111111111111'
const LINE_B = '22222222-2222-4222-8222-222222222222'
const LINE_C = '33333333-3333-4333-8333-333333333333'
const OTHER_ENTRY = '44444444-4444-4444-8444-444444444444'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/journal-entries`

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

const entryParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: ENTRY_ID }) }
const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

const POSTED = {
  id: ENTRY_ID,
  status: 'posted',
  description: 'Programvara',
  entry_date: '2026-09-10',
  source_type: 'manual',
  fiscal_period_id: PERIOD_ID,
  voucher_series: 'A',
  voucher_number: 42,
}
const OPEN_PERIOD = {
  data: { is_closed: false, locked_at: null, period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null },
  error: null,
}
const NO_LOCK = { data: { bookkeeping_locked_through: null }, error: null }
/** A 625 kr purchase booked on 5410 that should have been 5420. */
const LINES = [
  { id: LINE_A, account_number: '5410', debit_amount: 500, credit_amount: 0, line_description: null, currency: 'SEK', dimensions: {}, sort_order: 0 },
  { id: LINE_B, account_number: '2641', debit_amount: 125, credit_amount: 0, line_description: null, currency: 'SEK', dimensions: {}, sort_order: 1 },
  { id: LINE_C, account_number: '1930', debit_amount: 0, credit_amount: 625, line_description: null, currency: 'SEK', dimensions: {}, sort_order: 2 },
]

/** Tables the line-rättelse preview reads, all in the "allowed" state. */
function strikePreviewTables(overrides: Record<string, Resp | Resp[]> = {}) {
  return {
    company_members: OWNER,
    journal_entries: { data: POSTED, error: null },
    fiscal_periods: OPEN_PERIOD,
    company_settings: NO_LOCK,
    journal_entry_lines: { data: LINES, error: null },
    document_attachments: { data: [], error: null },
    chart_of_accounts: { data: [{ account_number: '5420' }], error: null },
    transactions: { data: [], error: null },
    transaction_voucher_links: { data: [], error: null },
    invoice_payments: { data: [], error: null },
    supplier_invoice_payments: { data: [], error: null },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  backfillMock.mockResolvedValue([])
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['bookkeeping:write', 'reports:read'],
    mode: 'live',
  })
})

// ---------------------------------------------------------------------------
// correct-metadata
// ---------------------------------------------------------------------------

describe('POST /journal-entries/:id/correct-metadata', () => {
  const post = (body: unknown, query = '') =>
    correctMetadata(
      request(`${BASE}/${ENTRY_ID}/correct-metadata${query}`, { method: 'POST', body: JSON.stringify(body) }),
      entryParams,
    )

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ description: 'Ny text' })).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ description: 'Ny text' })).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for an empty body or a bad date', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const empty = await post({})
    expect(empty.status).toBe(400)
    expect((await empty.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await post({ entry_date: '10/09/2026' })).status).toBe(400)
  })

  it('404 JOURNAL_ENTRY_NOT_FOUND when the RPC does not find the entry in this company', async () => {
    const client = makeClient({
      company_members: OWNER,
      'rpc:correct_entry_metadata': { data: null, error: { code: 'P0001', message: 'Verifikationen hittades inte.' } },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ description: 'Ny text' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })

  it('commits through correct_entry_metadata only, with the API user as actor', async () => {
    const client = makeClient({
      company_members: OWNER,
      'rpc:correct_entry_metadata': {
        data: { changed: true, log_id: LINE_A, old_description: 'Programvara', new_description: 'Programvara Figma', old_entry_date: '2026-09-10', new_entry_date: '2026-09-10' },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ description: 'Programvara Figma' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ changed: true, log_id: LINE_A, new_description: 'Programvara Figma' })
    expect(client.rpc).toHaveBeenCalledWith('correct_entry_metadata', {
      p_company_id: COMPANY_ID,
      p_entry_id: ENTRY_ID,
      p_description: 'Programvara Figma',
      p_entry_date: null,
      p_user_id: 'user-1',
    })
    // Never a direct write to the posted verifikat.
    expect(client.calls.some((c) => c.table === 'journal_entries' && WRITES.has(c.method))).toBe(false)
  })

  it('409 JOURNAL_RATTELSE_PERIOD_LOCKED when the RPC refuses a locked period', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        'rpc:correct_entry_metadata': {
          data: null,
          error: { code: 'P0001', message: 'Perioden är stängd eller låst: använd rättelseverifikat (storno).' },
        },
      }),
    )
    const res = await post({ description: 'Ny text' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('JOURNAL_RATTELSE_PERIOD_LOCKED')
  })

  it('a dry run previews old and new values and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      journal_entries: { data: POSTED, error: null },
      fiscal_periods: OPEN_PERIOD,
      company_settings: NO_LOCK,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ description: 'Programvara Figma', entry_date: '2026-09-12' }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      voucher: 'A42',
      changed: true,
      old_description: 'Programvara',
      new_description: 'Programvara Figma',
      old_entry_date: '2026-09-10',
      new_entry_date: '2026-09-12',
    })
    expect(wrote(client)).toBe(false)
  })

  it('dry run: a date outside the entry\'s own period is refused (use /redate)', async () => {
    const client = makeClient({
      company_members: OWNER,
      journal_entries: { data: POSTED, error: null },
      fiscal_periods: OPEN_PERIOD,
      company_settings: NO_LOCK,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ entry_date: '2025-12-31' }, '?dry_run=true')
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('JOURNAL_RATTELSE_REFUSED')
    expect(wrote(client)).toBe(false)
  })

  it('dry run: a locked period or a date behind the company lock date points to storno', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        journal_entries: { data: POSTED, error: null },
        fiscal_periods: { data: { ...OPEN_PERIOD.data, locked_at: '2026-10-01T00:00:00Z' }, error: null },
      }),
    )
    expect((await (await post({ description: 'X' }, '?dry_run=true')).json()).error.code).toBe(
      'JOURNAL_RATTELSE_PERIOD_LOCKED',
    )
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        journal_entries: { data: POSTED, error: null },
        fiscal_periods: OPEN_PERIOD,
        company_settings: { data: { bookkeeping_locked_through: '2026-09-30' }, error: null },
      }),
    )
    const res = await post({ description: 'X' }, '?dry_run=true')
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('JOURNAL_RATTELSE_PERIOD_LOCKED')
  })

  it('dry run: a draft is not corrected (400 CANNOT_CORRECT_NON_POSTED), a storno never', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, journal_entries: { data: { ...POSTED, status: 'draft' }, error: null } }),
    )
    expect((await (await post({ description: 'X' }, '?dry_run=true')).json()).error.code).toBe('CANNOT_CORRECT_NON_POSTED')
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, journal_entries: { data: { ...POSTED, source_type: 'storno' }, error: null } }),
    )
    expect((await (await post({ description: 'X' }, '?dry_run=true')).json()).error.code).toBe('JOURNAL_RATTELSE_REFUSED')
  })

  it('dry run: 404 for an entry outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, journal_entries: { data: null, error: null } }))
    const res = await post({ description: 'X' }, '?dry_run=true')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// strike-lines
// ---------------------------------------------------------------------------

describe('POST /journal-entries/:id/strike-lines', () => {
  const post = (body: unknown, query = '') =>
    strikeLines(
      request(`${BASE}/${ENTRY_ID}/strike-lines${query}`, { method: 'POST', body: JSON.stringify(body) }),
      entryParams,
    )
  const SWAP = { strike_line_ids: [LINE_A], lines: [{ account_number: '5420', debit_amount: 500, credit_amount: 0 }] }

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post(SWAP)).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post(SWAP)).status).toBe(403)
  })

  it('400 for an empty rättelse, a numeric account number or a two-sided line', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({})).status).toBe(400)
    expect((await post({ lines: [{ account_number: 5420, debit_amount: 1 }] })).status).toBe(400)
    expect((await post({ lines: [{ account_number: '5420', debit_amount: 1, credit_amount: 1 }] })).status).toBe(400)
  })

  it('commits through backfill + correct_entry_lines_inline, account numbers as strings', async () => {
    const client = makeClient({
      company_members: OWNER,
      'rpc:correct_entry_lines_inline': {
        data: { log_id: LINE_C, struck_count: 1, added_count: 1, total_debit: 625, total_credit: 625 },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(SWAP)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ log_id: LINE_C, struck_count: 1, added_count: 1, total_debit: 625, total_credit: 625 })
    expect(backfillMock).toHaveBeenCalledWith(client, COMPANY_ID, 'user-1', ['5420'])
    expect(client.rpc).toHaveBeenCalledWith('correct_entry_lines_inline', {
      p_company_id: COMPANY_ID,
      p_entry_id: ENTRY_ID,
      p_strike_line_ids: [LINE_A],
      p_new_lines: [{ account_number: '5420', debit_amount: 500, credit_amount: 0, line_description: null, dimensions: {} }],
      p_user_id: 'user-1',
    })
    expect(client.calls.some((c) => c.table === 'journal_entry_lines' && WRITES.has(c.method))).toBe(false)
  })

  it('409 JOURNAL_RATTELSE_REFUSED carries the RPC\'s Swedish rule', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        'rpc:correct_entry_lines_inline': {
          data: null,
          error: { code: 'P0001', message: 'Rader i utländsk valuta kan inte strykas: använd rättelseverifikat (storno).' },
        },
      }),
    )
    const res = await post(SWAP)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('JOURNAL_RATTELSE_REFUSED')
    expect(body.error.details.reason).toContain('utländsk valuta')
  })

  it('a dry run previews the struck, added and resulting lines, prices the change, and calls neither RPC nor backfill', async () => {
    const client = makeClient(strikePreviewTables())
    mockServiceClient.mockReturnValue(client)
    const res = await post(SWAP, '?dry_run=true')
    expect(res.status).toBe(200)
    const { preview } = (await res.json()).data
    expect(preview.voucher).toBe('A42')
    expect(preview.struck_lines).toEqual([expect.objectContaining({ id: LINE_A, account_number: '5410', debit_amount: 500 })])
    expect(preview.added_lines).toEqual([expect.objectContaining({ account_number: '5420', debit_amount: 500 })])
    expect(preview.resulting_lines.map((l: { account_number: string }) => l.account_number)).toEqual(['2641', '1930', '5420'])
    expect(preview).toMatchObject({ total_debit: 625, total_credit: 625, changed_amount_sek: 500, would_seed_accounts: [] })
    expect(wrote(client)).toBe(false)
    expect(backfillMock).not.toHaveBeenCalled()
  })

  it('dry run: an unbalanced result is 400 JOURNAL_ENTRY_NOT_BALANCED with the totals', async () => {
    const client = makeClient(strikePreviewTables())
    mockServiceClient.mockReturnValue(client)
    const res = await post({ strike_line_ids: [LINE_A], lines: [{ account_number: '5420', debit_amount: 400 }] }, '?dry_run=true')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_BALANCED')
    expect(body.error.details).toEqual({ total_debit: 525, total_credit: 625 })
    expect(wrote(client)).toBe(false)
  })

  it('dry run: a line of another verifikat, a line with an underlag, and an identical re-add are refused', async () => {
    mockServiceClient.mockReturnValue(makeClient(strikePreviewTables()))
    expect((await (await post({ strike_line_ids: [OTHER_ENTRY], lines: [] }, '?dry_run=true')).json()).error.code).toBe(
      'JOURNAL_RATTELSE_REFUSED',
    )
    mockServiceClient.mockReturnValue(makeClient(strikePreviewTables({ document_attachments: { data: [{ id: 'doc' }], error: null } })))
    expect((await (await post(SWAP, '?dry_run=true')).json()).error.code).toBe('JOURNAL_RATTELSE_REFUSED')
    mockServiceClient.mockReturnValue(makeClient(strikePreviewTables()))
    const same = await post(
      { strike_line_ids: [LINE_A], lines: [{ account_number: '5410', debit_amount: 500 }] },
      '?dry_run=true',
    )
    expect((await same.json()).error.code).toBe('MEANINGLESS_CORRECTION')
  })

  it('dry run: a non-BAS account missing from the chart is ACCOUNTS_NOT_IN_CHART; a BAS one would be seeded', async () => {
    mockServiceClient.mockReturnValue(makeClient(strikePreviewTables({ chart_of_accounts: { data: [], error: null } })))
    const unknown = await post(
      { strike_line_ids: [LINE_A], lines: [{ account_number: '5499', debit_amount: 500 }] },
      '?dry_run=true',
    )
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    mockServiceClient.mockReturnValue(makeClient(strikePreviewTables({ chart_of_accounts: { data: [], error: null } })))
    const seeded = await post(SWAP, '?dry_run=true')
    expect((await seeded.json()).data.preview.would_seed_accounts).toEqual(['5420'])
  })

  it('dry run: a customer-payment verifikat keeps its 15xx net, a bank-linked 19xx change is flagged for the commit check', async () => {
    const payment = [
      { id: LINE_A, account_number: '1930', debit_amount: 1000, credit_amount: 0, line_description: null, currency: 'SEK', dimensions: {}, sort_order: 0 },
      { id: LINE_B, account_number: '1510', debit_amount: 0, credit_amount: 1000, line_description: null, currency: 'SEK', dimensions: {}, sort_order: 1 },
    ]
    mockServiceClient.mockReturnValue(
      makeClient(
        strikePreviewTables({
          journal_entry_lines: { data: payment, error: null },
          invoice_payments: { data: [{ id: 'p' }], error: null },
          chart_of_accounts: { data: [{ account_number: '1511' }], error: null },
        }),
      ),
    )
    const reskontra = await post(
      { strike_line_ids: [LINE_B], lines: [{ account_number: '1511', credit_amount: 1000 }] },
      '?dry_run=true',
    )
    expect((await reskontra.json()).error.code).toBe('JOURNAL_RATTELSE_REFUSED')

    mockServiceClient.mockReturnValue(
      makeClient(
        strikePreviewTables({
          journal_entry_lines: { data: payment, error: null },
          transactions: { data: [{ id: 't' }], error: null },
          cash_accounts: { data: [{ ledger_account: '1930' }], error: null },
          chart_of_accounts: { data: [{ account_number: '1930' }, { account_number: '6570' }], error: null },
        }),
      ),
    )
    const bank = await post(
      {
        strike_line_ids: [LINE_A],
        lines: [
          { account_number: '1930', debit_amount: 990 },
          { account_number: '6570', debit_amount: 10 },
        ],
      },
      '?dry_run=true',
    )
    expect(bank.status).toBe(200)
    expect((await bank.json()).data.preview.bank_anchor_check.accounts).toEqual(['1930'])
  })
})

// ---------------------------------------------------------------------------
// redate
// ---------------------------------------------------------------------------

describe('POST /journal-entries/:id/redate', () => {
  const post = (body: unknown, query = '') =>
    redate(request(`${BASE}/${ENTRY_ID}/redate${query}`, { method: 'POST', body: JSON.stringify(body) }), entryParams)
  const ORIGINAL = {
    ...POSTED,
    correction_of_id: null,
    reverses_id: null,
    lines: LINES.map(({ id: _id, ...l }) => ({ ...l, amount_in_currency: null })),
  }

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ new_entry_date: '2025-09-10' })).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ new_entry_date: '2025-09-10' })).status).toBe(403)
  })

  it('400 without a valid new_entry_date', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({})).status).toBe(400)
    expect((await post({ new_entry_date: '2025-9-10' })).status).toBe(400)
  })

  it('commits through recordateEntry (storno + re-post) and answers both voucher numbers', async () => {
    const client = makeClient({ company_members: OWNER })
    mockServiceClient.mockReturnValue(client)
    recordateEntryMock.mockResolvedValue({
      reversal: { id: LINE_A, voucher_series: 'A', voucher_number: 88, entry_date: '2026-09-10' },
      corrected: { id: LINE_B, voucher_series: 'A', voucher_number: 12, entry_date: '2025-09-10' },
    })
    const res = await post({ new_entry_date: '2025-09-10' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      original_id: ENTRY_ID,
      reversal_id: LINE_A,
      corrected_id: LINE_B,
      voucher_series: 'A',
      reversal_voucher_number: 88,
      corrected_voucher_number: 12,
      new_entry_date: '2025-09-10',
    })
    expect(recordateEntryMock).toHaveBeenCalledWith(client, COMPANY_ID, 'user-1', ENTRY_ID, '2025-09-10', {
      allowDeepChain: undefined,
    })
  })

  it('maps the storno flow\'s typed refusals (409 TARGET_PERIOD_LOCKED)', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    recordateEntryMock.mockRejectedValue(new TargetPeriodLockedError('2025-09-10', '2025-12-31'))
    const res = await post({ new_entry_date: '2025-09-10' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('TARGET_PERIOD_LOCKED')
  })

  it('a dry run shows the storno and the re-posted copy, prices the entry, and posts nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      journal_entries: { data: ORIGINAL, error: null },
      company_settings: NO_LOCK,
      fiscal_periods: { data: { id: PERIOD_ID, is_closed: false, locked_at: null }, error: null },
      chart_of_accounts: { data: [{ account_number: '5410' }, { account_number: '2641' }, { account_number: '1930' }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ new_entry_date: '2025-09-10' }, '?dry_run=true')
    expect(res.status).toBe(200)
    const { preview } = (await res.json()).data
    expect(preview).toMatchObject({ voucher: 'A42', old_entry_date: '2026-09-10', new_entry_date: '2025-09-10', total_debit: 625 })
    expect(preview.storno.lines[0]).toMatchObject({ account_number: '5410', debit_amount: 0, credit_amount: 500 })
    expect(preview.corrected.lines[0]).toMatchObject({ account_number: '5410', debit_amount: 500, credit_amount: 0 })
    expect(recordateEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('dry run: the same date, a closed target year and a missing entry are refused like the commit', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, journal_entries: { data: ORIGINAL, error: null } }))
    expect((await (await post({ new_entry_date: '2026-09-10' }, '?dry_run=true')).json()).error.code).toBe(
      'MEANINGLESS_CORRECTION',
    )
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        journal_entries: { data: ORIGINAL, error: null },
        company_settings: NO_LOCK,
        fiscal_periods: { data: { id: PERIOD_ID, is_closed: true, locked_at: null }, error: null },
      }),
    )
    const closed = await post({ new_entry_date: '2024-09-10' }, '?dry_run=true')
    expect(closed.status).toBe(409)
    expect((await closed.json()).error.code).toBe('TARGET_PERIOD_CLOSED')
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, journal_entries: { data: null, error: null } }))
    expect((await post({ new_entry_date: '2025-09-10' }, '?dry_run=true')).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// update-draft
// ---------------------------------------------------------------------------

describe('PATCH /journal-entries/:id (draft edit)', () => {
  const patch = (body: unknown, query = '') =>
    updateDraft(request(`${BASE}/${ENTRY_ID}${query}`, { method: 'PATCH', body: JSON.stringify(body) }), entryParams)
  const BODY = {
    fiscal_period_id: PERIOD_ID,
    entry_date: '2026-05-12',
    description: 'Bankavgift maj',
    lines: [
      { account_number: '6570', debit_amount: 60, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 60 },
    ],
  }

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await patch(BODY)).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await patch(BODY)).status).toBe(403)
  })

  it('400 for a single line', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await patch({ ...BODY, lines: [BODY.lines[0]] })).status).toBe(400)
  })

  it('updates the draft through the engine', async () => {
    const client = makeClient({ company_members: OWNER })
    mockServiceClient.mockReturnValue(client)
    updateDraftEntryMock.mockResolvedValue({
      id: ENTRY_ID,
      status: 'draft',
      fiscal_period_id: PERIOD_ID,
      entry_date: '2026-05-12',
      description: 'Bankavgift maj',
      voucher_series: 'A',
      voucher_number: 0,
      notes: null,
      lines: [
        { account_number: '6570', debit_amount: '60.00', credit_amount: '0.00', line_description: null },
        { account_number: '1930', debit_amount: '0.00', credit_amount: '60.00', line_description: null },
      ],
    })
    const res = await patch(BODY)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ id: ENTRY_ID, status: 'draft', voucher_number: 0 })
    expect(body.data.lines[0]).toEqual({ account_number: '6570', debit_amount: 60, credit_amount: 0, line_description: null })
    expect(updateDraftEntryMock).toHaveBeenCalledWith(client, COMPANY_ID, 'user-1', ENTRY_ID, expect.objectContaining({ description: 'Bankavgift maj' }))
  })

  it('dry run: a posted entry is 409 CANNOT_EDIT_NON_DRAFT and nothing is written', async () => {
    const client = makeClient({ company_members: OWNER, journal_entries: { data: { id: ENTRY_ID, status: 'posted', voucher_series: 'A' }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await patch(BODY, '?dry_run=true')
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('CANNOT_EDIT_NON_DRAFT')
    expect(updateDraftEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('dry run: 404 for an unknown entry, balance and period checks, then the preview', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, journal_entries: { data: null, error: null } }))
    expect((await patch(BODY, '?dry_run=true')).status).toBe(404)

    const draft = { data: { id: ENTRY_ID, status: 'draft', voucher_series: 'A' }, error: null }
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, journal_entries: draft }))
    const unbalanced = await patch(
      { ...BODY, lines: [BODY.lines[0], { account_number: '1930', debit_amount: 0, credit_amount: 50 }] },
      '?dry_run=true',
    )
    expect((await unbalanced.json()).error.code).toBe('JOURNAL_ENTRY_NOT_BALANCED')

    const client = makeClient({
      company_members: OWNER,
      journal_entries: draft,
      fiscal_periods: [
        { data: { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }, error: null },
        { data: { id: PERIOD_ID, is_closed: false, locked_at: null }, error: null },
      ],
      company_settings: NO_LOCK,
      chart_of_accounts: { data: [{ account_number: '6570' }, { account_number: '1930' }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch(BODY, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ status: 'draft', total_debit: 60, voucher_series: 'A' })
    expect(wrote(client)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

describe('PATCH /journal-entries/:id/notes', () => {
  const patch = (body: unknown, query = '') =>
    setNote(request(`${BASE}/${ENTRY_ID}/notes${query}`, { method: 'PATCH', body: JSON.stringify(body) }), entryParams)

  it('401, 403 and 400', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await patch({ notes: 'x' })).status).toBe(401)
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await patch({ notes: 'x' })).status).toBe(403)
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['bookkeeping:write'], mode: 'live' })
    expect((await patch({ notes: 'x'.repeat(2001) })).status).toBe(400)
  })

  it('404 when no entry of this company matched', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, journal_entries: { data: null, error: null } }))
    const res = await patch({ notes: 'x' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })

  it('updates only the notes column, a blank note clears it', async () => {
    const client = makeClient({
      company_members: OWNER,
      journal_entries: { data: { id: ENTRY_ID, voucher_series: 'A', voucher_number: 42 }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ notes: '   ' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ journal_entry_id: ENTRY_ID, voucher_series: 'A', voucher_number: 42, notes: null })
    const update = client.calls.find((c) => c.table === 'journal_entries' && c.method === 'update')
    expect(update?.args[0]).toEqual({ notes: null })
  })

  it('a dry run shows old and new note and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      journal_entries: { data: { id: ENTRY_ID, voucher_series: 'A', voucher_number: 42, status: 'posted', notes: 'Gammal' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ notes: 'Ny' }, '?dry_run=true')
    expect((await res.json()).data.preview).toMatchObject({ old_notes: 'Gammal', new_notes: 'Ny' })
    expect(wrote(client)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// no-document-required
// ---------------------------------------------------------------------------

describe('POST and DELETE /journal-entries/:id/no-document-required', () => {
  const post = (body: unknown, query = '') =>
    setNoDoc(request(`${BASE}/${ENTRY_ID}/no-document-required${query}`, { method: 'POST', body: JSON.stringify(body) }), entryParams)
  const del = (query = '') =>
    clearNoDoc(request(`${BASE}/${ENTRY_ID}/no-document-required${query}`, { method: 'DELETE' }), entryParams)

  it('401, 403 and 400', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({})).status).toBe(401)
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({})).status).toBe(403)
    expect((await del()).status).toBe(403)
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['bookkeeping:write'], mode: 'live' })
    expect((await post({ reason: 'x'.repeat(201) })).status).toBe(400)
  })

  it('404 for an entry outside the company, writing nothing', async () => {
    const client = makeClient({ company_members: OWNER, journal_entries: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ reason: 'Avskrivning' })
    expect(res.status).toBe(404)
    expect(wrote(client)).toBe(false)
  })

  it('upserts the sidecar flag, never the verifikat', async () => {
    const client = makeClient({ company_members: OWNER, journal_entries: { data: { ...POSTED }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ reason: 'Avskrivning enligt plan' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ journal_entry_id: ENTRY_ID, exempted: true, reason: 'Avskrivning enligt plan' })
    const upsert = client.calls.find((c) => c.table === 'journal_entry_no_doc_required' && c.method === 'upsert')
    expect(upsert?.args[0]).toEqual({ journal_entry_id: ENTRY_ID, company_id: COMPANY_ID, user_id: 'user-1', reason: 'Avskrivning enligt plan' })
    expect(client.calls.some((c) => c.table === 'journal_entries' && WRITES.has(c.method))).toBe(false)
  })

  it('a dry run writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, journal_entries: { data: { ...POSTED }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({}, '?dry_run=true')
    expect((await res.json()).data.preview).toMatchObject({ journal_entry_id: ENTRY_ID, voucher_number: 42 })
    expect(wrote(client)).toBe(false)
  })

  it('DELETE clears the flag idempotently and reports whether one was removed', async () => {
    const client = makeClient({ company_members: OWNER, journal_entry_no_doc_required: { data: [], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ journal_entry_id: ENTRY_ID, exempted: false, removed: false })
    expect(client.calls).toContainEqual({ table: 'journal_entry_no_doc_required', method: 'eq', args: ['company_id', COMPANY_ID] })

    const dry = makeClient({ company_members: OWNER, journal_entry_no_doc_required: { data: { journal_entry_id: ENTRY_ID }, error: null } })
    mockServiceClient.mockReturnValue(dry)
    expect((await (await del('?dry_run=true')).json()).data.preview).toEqual({ journal_entry_id: ENTRY_ID, currently_exempt: true })
    expect(wrote(dry)).toBe(false)
  })
})

describe('POST /journal-entries/no-document-required (batch)', () => {
  const post = (body: unknown, query = '') =>
    batchNoDoc(request(`${BASE}/no-document-required${query}`, { method: 'POST', body: JSON.stringify(body) }), companyParams)

  it('401, 403 and 400 (empty list, non-uuid, over 500)', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ journal_entry_ids: [ENTRY_ID] })).status).toBe(401)
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ journal_entry_ids: [ENTRY_ID] })).status).toBe(403)
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['bookkeeping:write'], mode: 'live' })
    expect((await post({ journal_entry_ids: [] })).status).toBe(400)
    expect((await post({ journal_entry_ids: ['nope'] })).status).toBe(400)
    expect((await post({ journal_entry_ids: Array.from({ length: 501 }, () => crypto.randomUUID()) })).status).toBe(400)
  })

  it('marks only posted, document-requiring entries of this company and reports the rest as skipped', async () => {
    const client = makeClient({ company_members: OWNER, journal_entries: { data: [{ id: ENTRY_ID }], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ journal_entry_ids: [ENTRY_ID, OTHER_ENTRY], reason: 'Bokslutspost' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ exempted: 1, journal_entry_ids: [ENTRY_ID], skipped_ids: [OTHER_ENTRY] })
    expect(client.calls).toContainEqual({ table: 'journal_entries', method: 'eq', args: ['status', 'posted'] })
    const upsert = client.calls.find((c) => c.table === 'journal_entry_no_doc_required' && c.method === 'upsert')
    expect(upsert?.args[0]).toEqual([{ journal_entry_id: ENTRY_ID, company_id: COMPANY_ID, user_id: 'user-1', reason: 'Bokslutspost' }])
  })

  it('a dry run lists what would be marked and writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, journal_entries: { data: [{ id: ENTRY_ID }], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ journal_entry_ids: [ENTRY_ID, OTHER_ENTRY] }, '?dry_run=true')
    expect((await res.json()).data.preview).toMatchObject({ would_exempt: 1, journal_entry_ids: [ENTRY_ID], skipped_ids: [OTHER_ENTRY] })
    expect(wrote(client)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// rattelse-log
// ---------------------------------------------------------------------------

describe('GET /journal-entries/:id/rattelse-log', () => {
  const get = () => rattelseLog(request(`${BASE}/${ENTRY_ID}/rattelse-log`, { method: 'GET' }), entryParams)

  it('401 and 403 (needs reports:read)', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await get()).status).toBe(401)
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await get()).status).toBe(403)
  })

  it('400 for a path id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await rattelseLog(request(`${BASE}/nope/rattelse-log`, { method: 'GET' }), {
      params: Promise.resolve({ companyId: COMPANY_ID, id: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('404 for an entry outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, journal_entries: { data: null, error: null } }))
    const res = await get()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })

  it('answers the log newest first with the actor label', async () => {
    const client = makeClient({
      company_members: OWNER,
      journal_entries: { data: { id: ENTRY_ID }, error: null },
      journal_entry_rattelse_log: {
        data: [
          {
            id: LINE_A,
            rattelse_type: 'lines',
            old_description: null,
            new_description: null,
            old_entry_date: null,
            new_entry_date: null,
            struck_lines: [{ account_number: '5410', debit_amount: 500, credit_amount: 0 }],
            added_lines: [{ account_number: '5420', debit_amount: 500, credit_amount: 0 }],
            actor: LINE_B,
            created_at: '2026-09-12T08:14:00Z',
            source: null,
            external_signature: null,
          },
        ],
        error: null,
      },
      profiles: { data: [{ id: LINE_B, full_name: 'Anna Svensson', email: 'anna@example.se' }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    // Machine doors answer an object with qualified ids (rattelse_id).
    expect(body.data.entries).toHaveLength(1)
    expect(body.data.entries[0]).toMatchObject({ rattelse_id: LINE_A, rattelse_type: 'lines', actor: LINE_B })
    expect(body.data.entries[0].actor_label).toEqual(expect.any(String))
    expect(client.calls).toContainEqual({ table: 'journal_entry_rattelse_log', method: 'eq', args: ['company_id', COMPANY_ID] })
  })
})
