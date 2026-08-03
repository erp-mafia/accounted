/**
 * Integration tests for POST /api/v1/companies/:companyId/imports/bank.
 *
 * Regression cover for three ways this route diverged from the dashboard
 * import path (app/api/import/bank-file/execute/route.ts) it claims to be
 * equivalent to:
 *
 *  1. It built its ingest payload with a key `source`, but RawTransaction's
 *     provenance field is `import_source`. Rows landed with NULL provenance,
 *     which makes them user-deletable (isImportedTransaction) and disables
 *     every content-dedup mirror in ingestTransactions, so a later PSD2 sync
 *     re-inserts the whole batch as duplicate affärshändelser.
 *  2. The same call site passed `counterparty`, which RawTransaction does not
 *     have; it was silently dropped.
 *  3. Completion was written to `bank_file_imports.imported_at`, a column that
 *     does not exist on that table (it lives on sie_imports). PostgREST
 *     rejected the whole statement and the unchecked result hid it, so the row
 *     stayed `status: 'processing'` with zeroed counters forever.
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

const { ingestMock, startOperationMock, completeOperationMock, failOperationMock } = vi.hoisted(
  () => ({
    ingestMock: vi.fn(),
    startOperationMock: vi.fn(),
    completeOperationMock: vi.fn().mockResolvedValue(undefined),
    failOperationMock: vi.fn().mockResolvedValue(undefined),
  }),
)

vi.mock('@/lib/transactions/ingest', () => ({ ingestTransactions: ingestMock }))
vi.mock('@/lib/api/v1/operations', () => ({
  startOperation: startOperationMock,
  completeOperation: completeOperationMock,
  failOperation: failOperationMock,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import type { RawTransaction } from '@/types'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** SEB CSV: semicolon-delimited, comma decimals. Auto-detects as format `seb`. */
const SEB_CSV = [
  'Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;12345;SPOTIFY AB;-99,00;12345,67',
  '2024-01-14;2024-01-14;12346;HEMKÖP FRIDHEMSPLAN;-432,50;12444,67',
  '2024-01-13;2024-01-13;12347;LÖNEUTBETALNING;25000,00;12877,17',
].join('\n')

const WISE_STATEMENT_CSV = [
  '"TransferWise ID",Date,Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees"',
  'TRANSFER-100,01/08/2026,1250.50,SEK,Received money from Example AB,INV-100,5000.50,,,,Example AB,,,,,,,,0',
].join('\n')

const WISE_TRANSACTION_HISTORY_WITH_UNSAFE_ROW = [
  'ID,Status,Direction,"Created on","Finished on","Source fee amount","Source fee currency","Target fee amount","Target fee currency","Source name","Source amount (after fees)","Source currency","Target name","Target amount (after fees)","Target currency","Exchange rate",Reference,Batch,"Created by",Category,Note',
  'PLAN_ORDER-9,COMPLETED,NEUTRAL,"2026-08-01 10:00:00","2026-08-01 10:00:00",,,,,Wise,100,USD,Wise,900,SEK,9,,,,General,',
  'TRANSFER-2,COMPLETED,IN,"2026-08-02 10:00:00","2026-08-02 10:00:00",,,,,Example AB,100,SEK,Accounted AB,100,SEK,1,,,,General,',
].join('\n')

type MockResult = { data?: unknown; error?: unknown }
type RecordedCall = { table: string; method: string; args: unknown[] }

/**
 * Per-table Supabase double that also records every chained call, so a test
 * can assert on the exact payload handed to `.update()` / `.upsert()`.
 */
function makeSupabase(byTable: Record<string, MockResult>) {
  const calls: RecordedCall[] = []
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
        }
        return (...args: unknown[]) => {
          calls.push({ table, method: String(prop), args })
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)), calls }
}

let supabase: ReturnType<typeof makeSupabase>

function makeRequest(options?: {
  body?: FormData | string
  auth?: boolean
  search?: string
  fileContent?: string
  filename?: string
}): Request {
  const fd = new FormData()
  fd.append(
    'file',
    new File(
      [options?.fileContent ?? SEB_CSV],
      options?.filename ?? 'kontoutdrag.csv',
      { type: 'text/csv' },
    ),
  )
  const init: RequestInit = {
    method: 'POST',
    body: options?.body ?? fd,
    headers: options?.auth === false ? {} : { Authorization: 'Bearer test-fixture-not-a-real-key' },
  }
  return new Request(
    `https://x.test/api/v1/companies/${COMPANY_ID}/imports/bank${options?.search ?? ''}`,
    init,
  )
}

function callRoute(options?: Parameters<typeof makeRequest>[0]) {
  return POST(makeRequest(options), { params: Promise.resolve({ companyId: COMPANY_ID }) })
}

/** The RawTransaction[] the route handed to ingestTransactions. */
function ingestedRows(): RawTransaction[] {
  return ingestMock.mock.calls[0][3] as RawTransaction[]
}

/** Payload of the last `.update()` issued against `bank_file_imports`. */
function bankImportUpdatePayload(): Record<string, unknown> | undefined {
  const updates = supabase.calls.filter(
    (c) => c.table === 'bank_file_imports' && c.method === 'update',
  )
  return updates.at(-1)?.args[0] as Record<string, unknown> | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  })
  startOperationMock.mockResolvedValue({ id: 'op-1' })
  completeOperationMock.mockResolvedValue(undefined)
  failOperationMock.mockResolvedValue(undefined)
  ingestMock.mockResolvedValue({
    imported: 3,
    duplicates: 1,
    reconciled: 0,
    auto_categorized: 0,
    auto_matched_invoices: 2,
    errors: 0,
    transaction_ids: ['t1', 't2', 't3'],
  })
  supabase = makeSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    bank_file_imports: { data: null, error: null },
  })
  mockServiceClient.mockReturnValue(supabase)
})

describe('POST /api/v1/companies/:companyId/imports/bank', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await callRoute({ auth: false })

    expect(res.status).toBe(401)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the multipart body carries no `file` field', async () => {
    const res = await callRoute({ body: new FormData() })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown `format` override', async () => {
    const res = await callRoute({ search: '?format=nordbanken' })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('accepts a forced Wise balance statement and preserves its scoped provenance', async () => {
    const res = await callRoute({
      search: '?format=wise_statement',
      fileContent: WISE_STATEMENT_CSV,
      filename: 'statement_123_SEK_2026.csv',
    })

    expect(res.status).toBe(202)
    expect(ingestedRows()).toHaveLength(1)
    expect(ingestedRows()[0]).toMatchObject({
      import_source: 'csv_wise_statement',
      external_id: 'wise_TRANSFER-100',
      amount: 1250.5,
      currency: 'SEK',
    })
  })

  it('rejects a Wise file when any movement cannot be imported safely', async () => {
    const res = await callRoute({
      search: '?format=wise',
      fileContent: WISE_TRANSACTION_HISTORY_WITH_UNSAFE_ROW,
      filename: 'transaction-history.csv',
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues).toContainEqual(
      expect.objectContaining({ severity: 'error', message: expect.stringMatching(/NEUTRAL/) }),
    )
    expect(body.error.details.issues.length).toBeLessThanOrEqual(20)
    expect(body.error.details.issue_count).toBe(1)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the key user is not a member of the company in the URL', async () => {
    supabase = makeSupabase({ company_members: { data: null, error: null } })
    mockServiceClient.mockReturnValue(supabase)

    const res = await callRoute()

    expect(res.status).toBe(404)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('ingests the parsed file and returns 202 with an operation id', async () => {
    const res = await callRoute()

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.data.operation_id).toBe('op-1')
    expect(body.data.type).toBe('import.bank')

    expect(ingestMock).toHaveBeenCalledTimes(1)
    expect(ingestedRows()).toHaveLength(3)
    expect(completeOperationMock).toHaveBeenCalledTimes(1)
    expect(failOperationMock).not.toHaveBeenCalled()
  })

  it('stamps every ingested row with the dashboard-equivalent import_source', async () => {
    await callRoute()

    const rows = ingestedRows()
    expect(rows).not.toHaveLength(0)
    for (const row of rows) {
      // `csv_<format>` for CSV formats, exactly what
      // app/api/import/bank-file/execute/route.ts writes. A NULL/absent value
      // here is the provenance bug: it makes the row user-deletable and
      // disables ingestTransactions' cross-channel dedup mirrors.
      expect(row.import_source).toBe('csv_seb')
    }
  })

  it('never sends keys RawTransaction does not have (`source`, `counterparty`)', async () => {
    await callRoute()

    for (const row of ingestedRows()) {
      expect(row).not.toHaveProperty('source')
      expect(row).not.toHaveProperty('counterparty')
    }
  })

  it('carries external_id, date, amount, currency and description through', async () => {
    await callRoute()

    const rows = ingestedRows()
    const spotify = rows.find((r) => r.description === 'SPOTIFY AB')
    expect(spotify).toBeDefined()
    expect(spotify!.date).toBe('2024-01-15')
    expect(spotify!.amount).toBe(-99)
    expect(spotify!.currency).toBe('SEK')
    expect(spotify!.external_id).toMatch(/^seb_/)
    // external_id must be unique per row or Layer-1 dedup collapses the batch.
    expect(new Set(rows.map((r) => r.external_id)).size).toBe(rows.length)
  })

  it('marks the bank_file_imports row completed using real columns only', async () => {
    await callRoute()

    const payload = bankImportUpdatePayload()
    expect(payload).toBeDefined()
    expect(payload).toEqual({
      status: 'completed',
      imported_count: 3,
      duplicate_count: 1,
      matched_count: 2,
    })
    // `imported_at` exists on sie_imports, NOT on bank_file_imports. Writing it
    // made PostgREST reject the statement, leaving status 'processing' forever.
    expect(payload).not.toHaveProperty('imported_at')
    // The parsed row count set by the upsert must survive; the imported count
    // belongs in imported_count.
    expect(payload).not.toHaveProperty('transaction_count')
  })

  it('still returns 202 when the completion status write fails', async () => {
    supabase = makeSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      bank_file_imports: { data: null, error: { message: 'permission denied' } },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await callRoute()

    // The transactions are already ingested: a bookkeeping-status write must
    // not fail the request, but it is logged rather than swallowed.
    expect(res.status).toBe(202)
    expect(completeOperationMock).toHaveBeenCalledTimes(1)
  })

  it('fails the operation and returns an error envelope when ingest throws', async () => {
    ingestMock.mockRejectedValue(new Error('ingest exploded'))

    const res = await callRoute()

    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.error.code).toBe('BANK_IMPORT_FAILED')
    expect(failOperationMock).toHaveBeenCalledTimes(1)
    expect(completeOperationMock).not.toHaveBeenCalled()
  })
})
