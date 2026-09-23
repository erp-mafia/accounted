/**
 * POST /api/v1/companies/:companyId/salary-runs/:id/payment-file
 *
 * The real generators run here (pain.001 and Bankgirot LB): the assertions
 * on `content` are the contract an external payroll operator uploads to the
 * bank, so stubbing them would test nothing. Only auth and the Supabase
 * client are mocked.
 */

import { createHash } from 'crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `payment-file route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as paymentFile } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

interface RecordedCall {
  table: string
  method: string
  args: unknown[]
}

/**
 * Per-table result queues (a single entry repeats, a list is consumed in
 * order) plus a passive recording of every builder call, so a test can assert
 * that the stamp UPDATE did or did not happen.
 */
function makeRecordingSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const calls: RecordedCall[] = []
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve({ data: next.data ?? null, error: next.error ?? null })
          }
        }
        return (...args: unknown[]) => {
          calls.push({ table, method: String(prop), args })
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  const supabase = {
    from: vi.fn((table: string) => buildChain(table)),
  }
  return { supabase, calls }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EMPLOYEE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const USER_ID = 'user-1'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/payment-file`

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    method: 'POST',
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const approvedRun = {
  id: RUN_ID,
  status: 'approved',
  period_year: 2026,
  period_month: 5,
  payment_date: '2026-05-25',
}

const company = { name: 'Bolaget AB', org_number: '556000-0000' }

const settingsWithEverything = {
  company_name: 'Bolaget AB',
  iban: 'SE45 5000 0000 0583 9825 7466',
  bic: 'ESSESESS',
  clearing_number: '5000',
  bank_name: 'SEB',
  bankgiro: '5050-1055',
  preferred_payment_format: 'pain001',
}

function employee(overrides: Partial<{
  employee_id: string
  net_salary: number
  tax_withheld: number
  tax_withheld_override: number | null
  first_name: string
  clearing_number: string | null
  bank_account_number: string | null
}> = {}) {
  return {
    employee_id: overrides.employee_id ?? EMPLOYEE_ID,
    net_salary: overrides.net_salary ?? 25000,
    tax_withheld: overrides.tax_withheld ?? 7500,
    tax_withheld_override: overrides.tax_withheld_override ?? null,
    employee: {
      first_name: overrides.first_name ?? 'Anna',
      last_name: 'Andersson',
      clearing_number: 'clearing_number' in overrides ? overrides.clearing_number : '6000',
      bank_account_number: 'bank_account_number' in overrides ? overrides.bank_account_number : '1234567',
    },
  }
}

function happyTables(overrides: Record<string, TableResp | TableResp[]> = {}) {
  return {
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' } },
    idempotency_keys: { data: null },
    salary_runs: { data: approvedRun },
    companies: { data: company },
    company_settings: { data: settingsWithEverything },
    salary_run_employees: { data: [employee()] },
    ...overrides,
  }
}

function stampCalls(calls: RecordedCall[]) {
  return calls.filter((c) => c.table === 'salary_runs' && c.method === 'update')
}

function archiveCalls(calls: RecordedCall[]) {
  return calls.filter((c) => c.table === 'salary_payment_files' && c.method === 'insert')
}

/** SHA-256 hex over `content` encoded the way the download sends it. */
function digest(content: string, encoding: 'utf8' | 'latin1'): string {
  return createHash('sha256').update(Buffer.from(content, encoding)).digest('hex')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Payroll operator',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
})

describe('POST /salary-runs/:id/payment-file', () => {
  it('returns 401 without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeRecordingSupabase({}).supabase)

    const res = await paymentFile(
      new Request(URL, { method: 'POST', headers: { 'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }),
      detailParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(401)
    expect(mockValidate).not.toHaveBeenCalled()
  })

  it('returns 401 UNAUTHORIZED for an invalid API key', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeRecordingSupabase({}).supabase)

    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 403 INSUFFICIENT_SCOPE without payroll:write', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'Read-only',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeRecordingSupabase(happyTables()).supabase)

    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('returns 400 when Idempotency-Key is missing', async () => {
    mockServiceClient.mockReturnValue(makeRecordingSupabase(happyTables()).supabase)

    const req = new Request(URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'pain001' }),
    })
    const res = await paymentFile(req, detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 VALIDATION_ERROR for an unknown format', async () => {
    const { supabase, calls } = makeRecordingSupabase(happyTables())
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(
      makeRequest(URL, { body: JSON.stringify({ format: 'csv' }) }),
      detailParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0].field).toBe('format')
    expect(stampCalls(calls)).toHaveLength(0)
  })

  it('returns 400 for an execution_date: the file always uses the run payment_date', async () => {
    mockServiceClient.mockReturnValue(makeRecordingSupabase(happyTables()).supabase)

    const res = await paymentFile(
      makeRequest(URL, { body: JSON.stringify({ execution_date: '2026-05-27' }) }),
      detailParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 SALARY_RUN_NOT_FOUND when the run is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeRecordingSupabase(happyTables({ salary_runs: { data: null } })).supabase,
    )

    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('returns 409 SALARY_RUN_PAYMENT_FILE_NOT_READY for a draft run', async () => {
    const { supabase, calls } = makeRecordingSupabase(
      happyTables({ salary_runs: { data: { ...approvedRun, status: 'draft' } } }),
    )
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_PAYMENT_FILE_NOT_READY')
    expect(body.error.details.current_status).toBe('draft')
    expect(body.error.details.allowed_statuses).toEqual(['approved', 'paid', 'booked'])
    expect(stampCalls(calls)).toHaveLength(0)
  })

  it('returns 422 SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS when the company IBAN is missing', async () => {
    const { supabase, calls } = makeRecordingSupabase(
      happyTables({
        company_settings: { data: { ...settingsWithEverything, iban: null } },
      }),
    )
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(
      makeRequest(URL, { body: JSON.stringify({ format: 'pain001' }) }),
      detailParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS')
    expect(body.error.details.problem).toBe('iban_missing')
    expect(body.error.details.format).toBe('pain001')
    expect(body.error.message).toContain('Inställningar')
    expect(stampCalls(calls)).toHaveLength(0)
  })

  it('returns 422 MISSING_BANK_DETAILS with problem bankgiro_missing for bg_lb without a bankgiro', async () => {
    mockServiceClient.mockReturnValue(
      makeRecordingSupabase(
        happyTables({
          company_settings: { data: { ...settingsWithEverything, bankgiro: null } },
        }),
      ).supabase,
    )

    const res = await paymentFile(
      makeRequest(URL, { body: JSON.stringify({ format: 'bg_lb' }) }),
      detailParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS')
    expect(body.error.details.problem).toBe('bankgiro_missing')
  })

  it('returns 422 SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING naming the employee', async () => {
    const { supabase, calls } = makeRecordingSupabase(
      happyTables({
        salary_run_employees: { data: [employee({ bank_account_number: null })] },
      }),
    )
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING')
    expect(body.error.details.employee_count).toBe(1)
    expect(body.error.details.employees).toEqual([{ employee_id: EMPLOYEE_ID, name: 'Anna Andersson' }])
    expect(stampCalls(calls)).toHaveLength(0)
  })

  it('returns 422 SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_INVALID naming the employee, never the account number', async () => {
    // Invented number. A 5-digit clearing with a 10-digit account needs 11
    // positions in the 10-wide Bankgirot LB account field.
    const { supabase, calls } = makeRecordingSupabase(
      happyTables({
        salary_run_employees: {
          data: [employee({ clearing_number: '8327-9', bank_account_number: '9612345678' })],
        },
      }),
    )
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(
      makeRequest(URL, { body: JSON.stringify({ format: 'bg_lb' }) }),
      detailParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(422)
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.error.code).toBe('SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_INVALID')
    expect(body.error.details.format).toBe('bg_lb')
    expect(body.error.details.employee_count).toBe(1)
    expect(body.error.details.employees).toEqual([
      { employee_id: EMPLOYEE_ID, name: 'Anna Andersson', problem: 'bg_lb_account_too_long' },
    ])
    expect(body.error.details.message).toContain('Anna Andersson')
    expect(body.error.details.message).toContain('pain.001')
    expect(text).not.toContain('9612345678')
    expect(text).not.toContain('996')
    expect(stampCalls(calls)).toHaveLength(0)
  })

  it('carries the same employee in a pain001 file', async () => {
    const { supabase } = makeRecordingSupabase(
      happyTables({
        salary_run_employees: {
          data: [employee({ clearing_number: '8327-9', bank_account_number: '9612345678' })],
        },
      }),
    )
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(
      makeRequest(URL, { body: JSON.stringify({ format: 'pain001' }) }),
      detailParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(200)
  })

  it('does not require bank details for a zero-net employee and warns that they are left out', async () => {
    const { supabase } = makeRecordingSupabase(
      happyTables({
        salary_run_employees: {
          data: [
            employee(),
            employee({
              employee_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              first_name: 'Noll',
              net_salary: 0,
              tax_withheld: 0,
              clearing_number: null,
              bank_account_number: null,
            }),
          ],
        },
      }),
    )
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.employee_count).toBe(1)
    expect(body.data.total_amount).toBe(25000)
    expect(body.data.warnings.some((w: string) => w.includes('0 kr'))).toBe(true)
  })

  it('generates a real pain.001 file, defaults the format from settings and stamps the run', async () => {
    const { supabase, calls } = makeRecordingSupabase(happyTables())
    mockServiceClient.mockReturnValue(supabase)

    // No body at all: format comes from preferred_payment_format (pain001).
    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data.salary_run_id).toBe(RUN_ID)
    expect(body.data.format).toBe('pain001')
    expect(body.data.filename).toBe('pain001_lon_2026-05.xml')
    expect(body.data.content_type).toBe('application/xml')
    expect(body.data.payment_date).toBe('2026-05-25')
    expect(body.data.employee_count).toBe(1)
    expect(body.data.total_amount).toBe(25000)
    expect(body.data.currency).toBe('SEK')
    expect(typeof body.data.generated_at).toBe('string')

    // The real generator ran: debtor IBAN (whitespace stripped), SALA batch,
    // the employee's clearing as SESBA member id and the account as BBAN.
    const xml: string = body.data.content
    expect(xml).toContain('<Document')
    expect(xml).toContain('<IBAN>SE4550000000058398257466</IBAN>')
    expect(xml).toContain('<BIC>ESSESESS</BIC>')
    expect(xml).toContain('<CtgyPurp><Cd>SALA</Cd></CtgyPurp>')
    expect(xml).toContain('<ReqdExctnDt>2026-05-25</ReqdExctnDt>')
    expect(xml).toContain('<MmbId>6000</MmbId>')
    expect(xml).toContain('<Id>1234567</Id>')
    expect(xml).toContain('<InstdAmt Ccy="SEK">25000.00</InstdAmt>')

    // Stamped: payment_file_format + payment_file_generated_at on the run.
    const stamps = stampCalls(calls)
    expect(stamps).toHaveLength(1)
    const payload = stamps[0].args[0] as Record<string, unknown>
    expect(payload.payment_file_format).toBe('pain001')
    expect(typeof payload.payment_file_generated_at).toBe('string')

    // Archived (BFL 7 kap. 1 §): one salary_payment_files row with the exact
    // content, before the stamp; the response identifies it.
    expect(body.data.payment_file_id).toMatch(UUID)
    expect(body.data.sha256).toBe(digest(xml, 'utf8'))
    const archives = archiveCalls(calls)
    expect(archives).toHaveLength(1)
    expect(archives[0].args[0]).toMatchObject({
      id: body.data.payment_file_id,
      company_id: COMPANY_ID,
      salary_run_id: RUN_ID,
      user_id: USER_ID,
      format: 'pain001',
      filename: 'pain001_lon_2026-05.xml',
      content_type: 'application/xml',
      charset: 'utf-8',
      content: xml,
      sha256: body.data.sha256,
      byte_size: Buffer.byteLength(xml, 'utf8'),
      payment_date: '2026-05-25',
      employee_count: 1,
      total_amount: 25000,
      generated_at: body.data.generated_at,
    })
    // Archive before stamp (the trailing idempotency_keys insert is the
    // wrapper's response cache, not part of the file flow).
    const writeOrder = calls
      .filter((c) => ['salary_payment_files', 'salary_runs'].includes(c.table))
      .filter((c) => c.method === 'insert' || c.method === 'update')
      .map((c) => `${c.table}.${c.method}`)
    expect(writeOrder).toEqual(['salary_payment_files.insert', 'salary_runs.update'])
  })

  it('withholds the file and does not stamp when the archive insert fails', async () => {
    const { supabase, calls } = makeRecordingSupabase(
      happyTables({
        salary_payment_files: { data: null, error: { code: '42501', message: 'permission denied' } },
      }),
    )
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.error).toBeDefined()
    expect(body.data).toBeUndefined()
    expect(archiveCalls(calls)).toHaveLength(1)
    expect(stampCalls(calls)).toHaveLength(0)
  })

  it('honors a tax_withheld_override in the paid amount', async () => {
    mockServiceClient.mockReturnValue(
      makeRecordingSupabase(
        happyTables({
          // Calculated tax 7500, overridden to 7000: the payout rises by 500.
          salary_run_employees: { data: [employee({ tax_withheld_override: 7000 })] },
        }),
      ).supabase,
    )

    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.total_amount).toBe(25500)
    expect(body.data.content).toContain('<InstdAmt Ccy="SEK">25500.00</InstdAmt>')
  })

  it('generates a real Bankgirot LB file when format is bg_lb and stamps bg_lb', async () => {
    const { supabase, calls } = makeRecordingSupabase(happyTables())
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(
      makeRequest(URL, { body: JSON.stringify({ format: 'bg_lb' }) }),
      detailParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data.format).toBe('bg_lb')
    expect(body.data.filename).toBe('bg_lb_lon_2026-05.txt')
    expect(body.data.content_type).toBe('text/plain')
    expect(body.data.total_amount).toBe(25000)

    const lb: string = body.data.content
    // Öppningspost (TK 11) with the sender bankgiro, one TK 54 payment record
    // carrying the employee's clearing + account, slutpost (TK 29), CRLF.
    expect(lb.startsWith('11')).toBe(true)
    expect(lb).toContain('50501055')
    // TK 54: 4-digit clearing followed by the account zero-padded to 10 digits.
    expect(lb).toContain('\r\n5460000001234567')
    expect(lb).toContain('\r\n29')
    expect(lb.endsWith('\r\n')).toBe(true)

    // The retirement notice travels with every LB file.
    expect(body.data.warnings.some((w: string) => w.includes('fasas ut'))).toBe(true)

    const stamps = stampCalls(calls)
    expect(stamps).toHaveLength(1)
    expect((stamps[0].args[0] as Record<string, unknown>).payment_file_format).toBe('bg_lb')

    // The LB archive digest is over ISO 8859-1 bytes, the encoding the
    // dashboard download re-encodes to, not over the UTF-8 form.
    expect(body.data.payment_file_id).toMatch(UUID)
    expect(body.data.sha256).toBe(digest(lb, 'latin1'))
    const archives = archiveCalls(calls)
    expect(archives).toHaveLength(1)
    expect(archives[0].args[0]).toMatchObject({
      format: 'bg_lb',
      filename: 'bg_lb_lon_2026-05.txt',
      content_type: 'text/plain',
      charset: 'iso-8859-1',
      content: lb,
      sha256: body.data.sha256,
      byte_size: Buffer.byteLength(lb, 'latin1'),
    })
  })

  it('dry run returns the preview without content and performs no write', async () => {
    const { supabase, calls } = makeRecordingSupabase(happyTables())
    mockServiceClient.mockReturnValue(supabase)

    const res = await paymentFile(
      makeRequest(`${URL}?dry_run=true`, { body: JSON.stringify({ format: 'pain001' }) }),
      detailParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.format).toBe('pain001')
    expect(body.data.preview.filename).toBe('pain001_lon_2026-05.xml')
    expect(body.data.preview.employee_count).toBe(1)
    expect(body.data.preview.total_amount).toBe(25000)
    expect(Array.isArray(body.data.preview.warnings)).toBe(true)
    expect(body.data.preview).not.toHaveProperty('content')
    expect(body.data.preview).not.toHaveProperty('generated_at')

    expect(stampCalls(calls)).toHaveLength(0)
    const writes = calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))
    expect(writes).toHaveLength(0)
  })

  it('surfaces a DB error on the run lookup through the generic v1 envelope', async () => {
    mockServiceClient.mockReturnValue(
      makeRecordingSupabase(
        happyTables({
          salary_runs: { data: null, error: { code: 'XX000', message: 'connection reset' } },
        }),
      ).supabase,
    )

    const res = await paymentFile(makeRequest(URL), detailParams(COMPANY_ID, RUN_ID))
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.error.code).not.toBe('SALARY_RUN_NOT_FOUND')
  })
})
