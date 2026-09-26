/**
 * POST /api/v1/companies/:companyId/imports/skattekonto-file through the v1
 * door of the operation registry (src/lib/operations/skattekonto-file.ts).
 *
 * The rules under test are the service's
 * (lib/import/skattekonto-file/import-file.ts): the file gate, the duplicate
 * refusal, the two confirmations the dashboard preview asks for (another
 * organisation number, a statement that does not sum), server-side dedup, and
 * a dry run that writes nothing. Nothing here books: rows land in
 * skattekonto_transactions only.
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST } from '../route'

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
const BOOKS = new Set(['skattekonto_file_imports', 'skattekonto_transactions', 'journal_entries'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/imports/skattekonto-file`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const FILENAME = 'Kontoutdrag 556677-8899 2026-05-03--2026-08-01.csv'
const COMPANY_ORG = { data: { org_number: '556677-8899' }, error: null }

/** The modern export (see lib/import/skattekonto-file/__tests__/parser.test.ts): opening + events = closing. */
function statement(closing = '35 087', org = '556677-8899'): string {
  return [
    `"Testbolaget AB";"${org}";""`,
    '"";"";""',
    '"";"Ingående saldo 2026-05-03";"-500"',
    '"2026-06-06";"Kostnadsränta";"-10"',
    '"2026-07-04";"Kostnadsränta";"-5"',
    '"2026-07-11";"Inbetalning bokförd 260710";"24 000"',
    '"2026-07-13";"Arbetsgivaravgift juni 2026";"-15 000"',
    '"2026-07-13";"Avdragen skatt juni 2026";"-9 000"',
    '"2026-07-23";"Inbetalning bokförd 260722";"600"',
    '"2026-07-28";"Inbetalning bokförd 260727";"35 000"',
    '"2026-08-01";"Kostnadsränta";"-5"',
    '"2026-08-01";"Intäktsränta";"7"',
    `"";"Utgående saldo 2026-08-01";"${closing}"`,
    '',
  ].join('\r\n')
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

function request(body: unknown, query = ''): Request {
  return new Request(`${URL_BASE}${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

const post = (body: unknown, query = '') => POST(request(body, query), params)

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/imports/skattekonto-file', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ filename: FILENAME, content_base64: b64(statement()) })).status).toBe(401)
  })

  it('403 without transactions:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ filename: FILENAME, content_base64: b64(statement()) })).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a missing file or content that is not base64', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ filename: FILENAME })).status).toBe(400)
    const bad = await post({ filename: FILENAME, content_base64: 'not base64 at all!' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('400 SKATTEKONTO_FILE_NOT_RECOGNIZED for a bank CSV, writing nothing', async () => {
    const client = makeClient({ company_members: OWNER, skattekonto_file_imports: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const bank = ['Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo', '2024-01-15;2024-01-15;12345;SPOTIFY AB;-99,00;12345,67'].join('\n')
    const res = await post({ filename: 'seb.csv', content_base64: b64(bank) })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SKATTEKONTO_FILE_NOT_RECOGNIZED')
    expect(wrote(client)).toBe(false)
  })

  it('409 SKATTEKONTO_FILE_DUPLICATE for a file already imported', async () => {
    const client = makeClient({
      company_members: OWNER,
      skattekonto_file_imports: { data: { id: 'imp-0', status: 'completed', imported_count: 10, created_at: '2026-08-02' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ filename: FILENAME, content_base64: b64(statement()) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SKATTEKONTO_FILE_DUPLICATE')
    expect(body.error.details.import_id).toBe('imp-0')
    expect(wrote(client)).toBe(false)
  })

  it('409 SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH unless confirmed', async () => {
    const client = () =>
      makeClient({
        company_members: OWNER,
        skattekonto_file_imports: { data: null, error: null },
        company_settings: COMPANY_ORG,
        skattekonto_transactions: { data: [], error: null },
      })
    mockServiceClient.mockReturnValue(client())
    const refused = await post({ filename: FILENAME, content_base64: b64(statement('35 087', '559900-1122')) })
    expect(refused.status).toBe(409)
    expect((await refused.json()).error.code).toBe('SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH')

    mockServiceClient.mockReturnValue(client())
    const confirmed = await post(
      { filename: FILENAME, content_base64: b64(statement('35 087', '559900-1122')), confirm_org_number_mismatch: true },
      '?dry_run=true',
    )
    expect(confirmed.status).toBe(200)
    expect((await confirmed.json()).data.preview.org_number_mismatch).toBe(true)
  })

  it('409 SKATTEKONTO_FILE_SUM_MISMATCH for a statement that does not sum, unless confirmed', async () => {
    const client = () =>
      makeClient({
        company_members: OWNER,
        skattekonto_file_imports: { data: null, error: null },
        company_settings: COMPANY_ORG,
        skattekonto_transactions: { data: [], error: null },
      })
    mockServiceClient.mockReturnValue(client())
    const refused = await post({ filename: FILENAME, content_base64: b64(statement('35 000')) })
    expect(refused.status).toBe(409)
    const body = await refused.json()
    expect(body.error.code).toBe('SKATTEKONTO_FILE_SUM_MISMATCH')
    expect(body.error.details.sum_difference).toBe(-87)

    mockServiceClient.mockReturnValue(client())
    const confirmed = await post(
      { filename: FILENAME, content_base64: b64(statement('35 000')), confirm_sum_mismatch: true },
      '?dry_run=true',
    )
    expect(confirmed.status).toBe(200)
  })

  it('a dry run parses and counts against the stored rows, and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      skattekonto_file_imports: { data: null, error: null },
      company_settings: COMPANY_ORG,
      skattekonto_transactions: {
        data: [
          // Already stored as booked: a duplicate.
          { id: 's1', dedup_key: 'id:1', status: 'booked', transaktionsdatum: '2026-06-06', transaktionstext: 'Kostnadsränta', belopp_skatteverket: -10 },
          // Stored as upcoming: the statement proves it settled.
          { id: 's2', dedup_key: 'id:2', status: 'upcoming', transaktionsdatum: '2026-07-13', transaktionstext: 'Avdragen skatt juni 2026', belopp_skatteverket: -9000 },
        ],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ filename: FILENAME, content_base64: b64(statement()) }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      variant: 'csv',
      row_count: 9,
      date_from: '2026-06-06',
      date_to: '2026-08-01',
      sum_valid: true,
      org_number_mismatch: false,
      would_import: 7,
      would_skip_duplicates: 1,
      would_promote: 1,
    })
    expect(body.data.preview.file_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(wrote(client)).toBe(false)
  })

  it('201 records the import and stores the new rows as file_import rows, booking nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      skattekonto_file_imports: [
        { data: null, error: null }, // duplicate check
        { data: { id: 'imp-1' }, error: null }, // upsert
        { data: null, error: null }, // finalize
      ],
      company_settings: COMPANY_ORG,
      skattekonto_transactions: [
        { data: [], error: null }, // existing rows
        { data: null, error: null }, // insert
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ filename: FILENAME, content_base64: b64(statement()) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({
      import_id: 'imp-1',
      imported: 9,
      duplicates: 0,
      promoted: 0,
      errors: 0,
      date_from: '2026-06-06',
      date_to: '2026-08-01',
      closing_saldo: 35087,
      variant: 'csv',
      row_count: 9,
    })

    const upsert = client.calls.find((c) => c.table === 'skattekonto_file_imports' && c.method === 'upsert')
    expect(upsert?.args[0]).toMatchObject({ company_id: COMPANY_ID, user_id: 'user-1', filename: FILENAME, file_variant: 'csv', row_count: 9 })
    const insert = client.calls.find((c) => c.table === 'skattekonto_transactions' && c.method === 'insert')
    const rows = insert?.args[0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(9)
    expect(rows[0]).toMatchObject({ company_id: COMPANY_ID, source: 'file_import', file_import_id: 'imp-1', status: 'booked' })
    const finalize = client.calls.find((c) => c.table === 'skattekonto_file_imports' && c.method === 'update')
    expect(finalize?.args[0]).toMatchObject({ imported_count: 9, status: 'completed' })
    expect(client.calls.some((c) => c.table === 'journal_entries')).toBe(false)
    expect(client.rpc).not.toHaveBeenCalled()
  })
})
