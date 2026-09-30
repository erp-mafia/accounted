/**
 * v1 journal-entry reads carry each line's whole dimensions bag.
 *
 * journal_entry_lines.dimensions ({"<sie_dim_no>": "<code>"}) is the source
 * of truth; cost_center and project are generated mirrors of keys '1' and
 * '6' only. The v1 reads selected the two mirrors and never the bag, so a
 * line tagged on dimension 2, 7-9 or 20+ read as untagged over the API while
 * the docs promised "all lines, dimensions". Pinned here: the detail GET and
 * the create refetch select the bag, the dry-run echo shows the bag the
 * engine will store, and the registered response schemas document it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

beforeAll(() => {
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
vi.mock('@/lib/api/v1/owns-fiscal-period', () => ({
  ownsFiscalPeriod: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))
vi.mock('@/lib/bookkeeping/account-validation', () => ({
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, createDraftEntry: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createDraftEntry } from '@/lib/bookkeeping/engine'
import { listEndpoints } from '@/lib/api/v1/registry'
import { GET as getEntry } from '../[id]/route'
import { POST as createEntry } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreateDraft = createDraftEntry as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FISCAL_PERIOD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/** A posted verifikat whose cost line carries a cost centre, a project and a custom dimension. */
const ENTRY_ROW = {
  id: ENTRY_ID,
  fiscal_period_id: FISCAL_PERIOD_ID,
  voucher_series: 'A',
  voucher_number: 142,
  entry_date: '2026-05-12',
  description: 'Konsultarvode maj',
  status: 'posted',
  source_type: 'manual',
  source_id: null,
  notes: null,
  reverses_id: null,
  reversed_by_id: null,
  correction_of_id: null,
  created_at: '2026-05-12T09:00:00Z',
  updated_at: '2026-05-12T09:00:00Z',
  lines: [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      account_number: '6550',
      debit_amount: 5000,
      credit_amount: 0,
      line_description: null,
      currency: 'SEK',
      amount_in_currency: null,
      exchange_rate: null,
      tax_code: null,
      dimensions: { '1': 'KS01', '2': 'AVD3', '6': 'P001', '20': 'SYD' },
      cost_center: 'KS01',
      project: 'P001',
      sort_order: 0,
    },
    {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      account_number: '1930',
      debit_amount: 0,
      credit_amount: 5000,
      line_description: null,
      currency: 'SEK',
      amount_in_currency: null,
      exchange_rate: null,
      tax_code: null,
      dimensions: {},
      cost_center: null,
      project: null,
      sort_order: 1,
    },
  ],
}

/**
 * company_members proves the key may touch this company; journal_entries
 * answers `entryRow`. Every select() is recorded per table so a test can
 * assert what the route asked the database for.
 */
function makeSupabase(entryRow: unknown) {
  const selects: Array<{ table: string; columns: string }> = []
  const build = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          const row =
            table === 'company_members'
              ? { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' }
              : table === 'journal_entries'
                ? entryRow
                : null
          return () => Promise.resolve({ data: row, error: null })
        }
        return (...args: unknown[]) => {
          if (prop === 'select') selects.push({ table, columns: String(args[0]) })
          return build(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { selects, from: vi.fn((table: string) => build(table)) }
}

function getRequest({ auth = true, id = ENTRY_ID } = {}): Request {
  const headers: Record<string, string> = {}
  if (auth) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  return new Request(`http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries/${id}`, { headers })
}

function postRequest(body: unknown, { dryRun = false } = {}): Request {
  return new Request(
    `http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries${dryRun ? '?dry_run=true' : ''}`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    },
  )
}

const entryParams = (id = ENTRY_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })
const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

/** The embedded line select inside `lines:journal_entry_lines(...)`. */
function lineColumns(selects: Array<{ table: string; columns: string }>): string[] {
  const embed = selects
    .filter((s) => s.table === 'journal_entries')
    .map((s) => s.columns.match(/journal_entry_lines\(([^)]*)\)/)?.[1])
    .find(Boolean)
  return (embed ?? '').split(',').map((c) => c.trim())
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
})

describe('GET /journal-entries/:id: line dimensions', () => {
  it('401 without an API key', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(ENTRY_ROW))
    expect((await getEntry(getRequest({ auth: false }), entryParams())).status).toBe(401)
  })

  it('400 VALIDATION_ERROR for an id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(ENTRY_ROW))
    const res = await getEntry(getRequest({ id: 'nope' }), entryParams('nope'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 JOURNAL_ENTRY_NOT_FOUND for an entry outside the company', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(null))
    const res = await getEntry(getRequest(), entryParams())
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })

  it('selects the dimensions bag and answers every key, not only the 1/6 mirrors', async () => {
    const client = makeSupabase(ENTRY_ROW)
    mockServiceClient.mockReturnValue(client)

    const res = await getEntry(getRequest(), entryParams())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(lineColumns(client.selects)).toEqual(expect.arrayContaining(['dimensions', 'cost_center', 'project']))
    expect(body.data.lines[0].dimensions).toEqual({ '1': 'KS01', '2': 'AVD3', '6': 'P001', '20': 'SYD' })
    expect(body.data.lines[0]).toMatchObject({ cost_center: 'KS01', project: 'P001' })
    expect(body.data.lines[1].dimensions).toEqual({})
  })
})

describe('POST /journal-entries: line dimensions', () => {
  const BODY = {
    fiscal_period_id: FISCAL_PERIOD_ID,
    entry_date: '2026-05-12',
    description: 'Konsultarvode maj',
    lines: [
      // The explicit bag wins per key over the deprecated alias; the alias
      // fills the key the bag leaves open.
      { account_number: '6550', debit_amount: 5000, credit_amount: 0, cost_center: 'KS99', project: 'P009', dimensions: { '1': 'KS01', '20': 'SYD' } },
      { account_number: '1930', debit_amount: 0, credit_amount: 5000 },
    ],
  }

  it('the dry-run echo shows the bag the engine will store, and the mirrors read from it', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(null))

    const res = await createEntry(postRequest(BODY, { dryRun: true }), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    const [tagged, untagged] = body.data.preview.lines

    expect(tagged.dimensions).toEqual({ '1': 'KS01', '6': 'P009', '20': 'SYD' })
    expect(tagged).toMatchObject({ cost_center: 'KS01', project: 'P009' })
    expect(untagged).toMatchObject({ dimensions: {}, cost_center: null, project: null })
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('the created draft is refetched with the dimensions bag on its lines', async () => {
    const client = makeSupabase({ ...ENTRY_ROW, status: 'draft', voucher_number: 0 })
    mockServiceClient.mockReturnValue(client)
    mockCreateDraft.mockResolvedValue({ id: ENTRY_ID })

    const res = await createEntry(postRequest(BODY), companyParams)
    expect(res.status).toBe(201)
    const body = await res.json()

    expect(lineColumns(client.selects)).toEqual(expect.arrayContaining(['dimensions']))
    expect(body.data.lines[0].dimensions).toEqual({ '1': 'KS01', '2': 'AVD3', '6': 'P001', '20': 'SYD' })
  })
})

describe('the registered response schemas document the bag', () => {
  /** The line object schema under data.lines of an endpoint's success envelope. */
  function lineShape(operation: string): Record<string, unknown> {
    const ep = listEndpoints().find((e) => e.operation === operation)
    expect(ep, operation).toBeDefined()
    const envelope = ep!.response.success as z.ZodObject<z.ZodRawShape>
    const data = envelope.shape.data as z.ZodObject<z.ZodRawShape>
    const lines = data.shape.lines as z.ZodArray<z.ZodObject<z.ZodRawShape>>
    return lines.element.shape
  }

  it.each(['journal-entries.get', 'journal-entries.create-draft'])('%s lines carry dimensions next to the mirrors', (operation) => {
    const shape = lineShape(operation)
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(['dimensions', 'cost_center', 'project']))
  })
})
