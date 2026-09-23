/**
 * Integration tests for GET + PATCH /api/v1/companies/:companyId/salary/settings.
 *
 * Modeled on the v1 settings and salary-runs route tests: mocked API-key auth
 * plus a flexible Supabase proxy mock with per-table response queues and
 * captured write payloads; no real network or database access.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  // Belt-and-braces: ensure we never reach a real DB from this test suite.
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `salary settings route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { STANDARD_VOUCHER_SERIES_MAP } from '@/lib/bookkeeping/voucher-series-resolver'
import { GET as getSalarySettings, PATCH as updateSalarySettings } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/**
 * Per-table response queues (an array is consumed one entry per awaited
 * chain, the last entry sticks) plus captured update/insert payloads and
 * .select() projections keyed by table, so tests can assert what the route
 * writes. Keyed by table because the wrapper's idempotency layer writes its
 * own rows through the same client; only company_settings writes are the
 * route's.
 */
function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const captured: {
    updates: Record<string, unknown[]>
    inserts: Record<string, unknown[]>
    selects: Record<string, string[]>
  } = { updates: {}, inserts: {}, selects: {} }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (...args: unknown[]) => {
          if (prop === 'update') (captured.updates[table] ??= []).push(args[0])
          if (prop === 'insert') (captured.inserts[table] ??= []).push(args[0])
          if (prop === 'select' && typeof args[0] === 'string') {
            ;(captured.selects[table] ??= []).push(args[0])
          }
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return {
    from: vi.fn((table: string) => buildChain(table)),
    captured,
    settingsUpdates: () => captured.updates['company_settings'] ?? [],
    settingsInserts: () => captured.inserts['company_settings'] ?? [],
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'user-1'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/salary/settings`
const IDEMPOTENCY_KEY = 'abcd1234-4444-4abc-8def-1234567890ab'

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function makeGetRequest(url: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      ...extraHeaders,
    },
  })
}

function makePatchRequest(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': IDEMPOTENCY_KEY,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
}

function withScopes(scopes: string[]) {
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes,
    mode: 'live',
  })
}

const MEMBER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }

const SAMPLE_ROW = {
  salary_pay_day: 25,
  salary_deviation_period: 'previous_month',
  preferred_payment_format: 'pain001',
  salary_default_bank: 'swedbank',
  salary_net_rounding: true,
  default_voucher_series_per_source_type: {
    manual: 'A',
    invoice_created: 'B',
    salary_payment: 'K',
  },
}

const SALARY_SETTINGS_SELECT =
  'salary_pay_day, salary_deviation_period, preferred_payment_format, salary_default_bank, salary_net_rounding, salary_calculation_policy, default_voucher_series_per_source_type'

/** What a row that never touched the conventions ({} or missing) reads as. */
const DEFAULT_POLICY = {
  partial_month: 'workdays',
  sick_rate: 'daily_divisor',
  long_leave: 'workdays',
  leave_context: 'all_registered',
  net_rounding: 'up',
  one_off_tax_rounding: 'truncate',
}

beforeEach(() => {
  vi.clearAllMocks()
  withScopes(['payroll:read', 'payroll:write'])
})

describe('GET /api/v1/companies/:companyId/salary/settings', () => {
  it('returns 401 UNAUTHORIZED without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await getSalarySettings(new Request(URL, { method: 'GET' }), companyParams(COMPANY_ID))

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockValidate).not.toHaveBeenCalled()
  })

  it('rejects keys without the payroll:read scope', async () => {
    withScopes(['invoices:read'])
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await getSalarySettings(makeGetRequest(URL), companyParams(COMPANY_ID))

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details.required_scope).toBe('payroll:read')
  })

  it('returns 404 when the caller is not a member of the company in the URL', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ company_members: { data: null, error: null } }),
    )

    const res = await getSalarySettings(makeGetRequest(URL), companyParams(COMPANY_ID))

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns the settings resource with the voucher series resolved from the per-source-type map', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: { data: SAMPLE_ROW, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await getSalarySettings(makeGetRequest(URL), companyParams(COMPANY_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      company_id: COMPANY_ID,
      salary_pay_day: 25,
      salary_deviation_period: 'previous_month',
      preferred_payment_format: 'pain001',
      salary_default_bank: 'swedbank',
      salary_net_rounding: true,
      salary_calculation_policy: DEFAULT_POLICY,
      salary_voucher_series: 'K',
    })
    expect(body.meta.request_id).toBeTruthy()
    expect(supabaseMock.captured.selects['company_settings']?.[0]).toBe(SALARY_SETTINGS_SELECT)
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it('answers with the engine defaults when the company has no settings row', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await getSalarySettings(makeGetRequest(URL), companyParams(COMPANY_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      company_id: COMPANY_ID,
      salary_pay_day: 25,
      salary_deviation_period: 'same_month',
      preferred_payment_format: 'pain001',
      salary_default_bank: null,
      salary_net_rounding: false,
      salary_calculation_policy: DEFAULT_POLICY,
      salary_voucher_series: 'A',
    })
  })

  it('falls back to series A when the map has no salary_payment key', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: MEMBER,
        company_settings: {
          data: { ...SAMPLE_ROW, default_voucher_series_per_source_type: { manual: 'A' } },
          error: null,
        },
      }),
    )

    const res = await getSalarySettings(makeGetRequest(URL), companyParams(COMPANY_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.salary_voucher_series).toBe('A')
  })

  it('returns the error envelope when the settings read fails', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: MEMBER,
        company_settings: { data: null, error: { message: 'boom', code: 'XX000' } },
      }),
    )

    const res = await getSalarySettings(makeGetRequest(URL), companyParams(COMPANY_ID))

    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.error.code).toBeTruthy()
  })
})

describe('PATCH /api/v1/companies/:companyId/salary/settings', () => {
  it('returns 401 UNAUTHORIZED without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const req = new Request(URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: JSON.stringify({ salary_pay_day: 27 }),
    })
    const res = await updateSalarySettings(req, companyParams(COMPANY_ID))

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('rejects keys without the payroll:write scope', async () => {
    withScopes(['invoices:read'])
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_pay_day: 27 }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details.required_scope).toBe('payroll:write')
  })

  it('rejects a read-only payroll key', async () => {
    withScopes(['payroll:read'])
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_pay_day: 27 }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
  })

  it('rejects requests without an Idempotency-Key header', async () => {
    const supabaseMock = makeFlexibleSupabase({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(supabaseMock)

    const req = new Request(URL, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ salary_pay_day: 27 }),
    })
    const res = await updateSalarySettings(req, companyParams(COMPANY_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it('returns 400 for a body that is not valid JSON', async () => {
    const supabaseMock = makeFlexibleSupabase({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(supabaseMock)

    const req = new Request(URL, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
      body: '{"salary_pay_day": not-json',
    })
    const res = await updateSalarySettings(req, companyParams(COMPANY_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toEqual({ field: 'body', message: 'Body is not valid JSON.' })
  })

  it.each([
    ['a bare array', [{ salary_pay_day: 27 }]],
    ['a bare string', 'salary_pay_day=27'],
    ['null', null],
  ])('returns 400 for a JSON body that is not an object (%s)', async (_label, jsonBody) => {
    const supabaseMock = makeFlexibleSupabase({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(makePatchRequest(URL, jsonBody), companyParams(COMPANY_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toEqual({ field: 'body', message: 'Body must be a JSON object.' })
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it('rejects an empty body (at least one field required)', async () => {
    const supabaseMock = makeFlexibleSupabase({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(makePatchRequest(URL, {}), companyParams(COMPANY_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toEqual({
      field: 'body',
      message: 'At least one field must be supplied.',
    })
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it('rejects salary_pay_day 29 (must exist in every month)', async () => {
    const supabaseMock = makeFlexibleSupabase({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_pay_day: 29 }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    const fields = body.error.details.issues.map((i: { field: string }) => i.field)
    expect(fields).toContain('salary_pay_day')
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it.each([
    ['a lowercase voucher series', { salary_voucher_series: 'k' }, 'salary_voucher_series'],
    ['a two-letter voucher series', { salary_voucher_series: 'KL' }, 'salary_voucher_series'],
    ['an unknown deviation period', { salary_deviation_period: 'next_month' }, 'salary_deviation_period'],
    ['an unknown payment format', { preferred_payment_format: 'sepa' }, 'preferred_payment_format'],
    ['an unknown bank', { salary_default_bank: 'danske' }, 'salary_default_bank'],
    ['a non-boolean rounding flag', { salary_net_rounding: 'yes' }, 'salary_net_rounding'],
  ])('returns 400 for %s', async (_label, body, field) => {
    const supabaseMock = makeFlexibleSupabase({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(makePatchRequest(URL, body), companyParams(COMPANY_ID))

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('VALIDATION_ERROR')
    const fields = json.error.details.issues.map((i: { field: string }) => i.field)
    expect(fields).toContain(field)
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it('rejects unknown fields, including the internal map column name', async () => {
    const supabaseMock = makeFlexibleSupabase({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, {
        default_voucher_series_per_source_type: { salary_payment: 'K' },
        vat_registered: true,
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it('updates the existing row, merges the voucher series into the map and returns the full resource', async () => {
    const updatedRow = {
      ...SAMPLE_ROW,
      salary_pay_day: 27,
      default_voucher_series_per_source_type: {
        manual: 'A',
        invoice_created: 'B',
        salary_payment: 'L',
      },
    }
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      // First read: the current row. Second: what the update returns.
      company_settings: [
        { data: SAMPLE_ROW, error: null },
        { data: updatedRow, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_pay_day: 27, salary_voucher_series: 'L' }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      company_id: COMPANY_ID,
      salary_pay_day: 27,
      salary_deviation_period: 'previous_month',
      preferred_payment_format: 'pain001',
      salary_default_bank: 'swedbank',
      salary_net_rounding: true,
      salary_calculation_policy: DEFAULT_POLICY,
      salary_voucher_series: 'L',
    })

    expect(supabaseMock.settingsInserts()).toHaveLength(0)
    expect(supabaseMock.settingsUpdates()).toHaveLength(1)
    const payload = supabaseMock.settingsUpdates()[0] as Record<string, unknown>
    expect(payload.salary_pay_day).toBe(27)
    // The map is MERGED: the other source types keep their letters.
    expect(payload.default_voucher_series_per_source_type).toEqual({
      manual: 'A',
      invoice_created: 'B',
      salary_payment: 'L',
    })
    // The public alias never reaches the DB.
    expect(payload.salary_voucher_series).toBeUndefined()
    // Unsupplied columns are undefined (dropped by JSON serialization),
    // never null: a null would clear the stored value.
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      salary_pay_day: 27,
      default_voucher_series_per_source_type: {
        manual: 'A',
        invoice_created: 'B',
        salary_payment: 'L',
      },
    })
    // The write reads the row back with the same projection as GET.
    expect(supabaseMock.captured.selects['company_settings']).toEqual([
      SALARY_SETTINGS_SELECT,
      SALARY_SETTINGS_SELECT,
    ])
  })

  it('leaves the voucher series map untouched when salary_voucher_series is not supplied', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        { data: SAMPLE_ROW, error: null },
        { data: { ...SAMPLE_ROW, salary_net_rounding: false }, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_net_rounding: false }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const payload = supabaseMock.settingsUpdates()[0] as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ salary_net_rounding: false })
    const body = await res.json()
    expect(body.data.salary_net_rounding).toBe(false)
    expect(body.data.salary_voucher_series).toBe('K')
  })

  it('writes an explicit null for salary_default_bank (clears the bank)', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        { data: SAMPLE_ROW, error: null },
        { data: { ...SAMPLE_ROW, salary_default_bank: null }, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_default_bank: null }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const payload = supabaseMock.settingsUpdates()[0] as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ salary_default_bank: null })
    const body = await res.json()
    expect(body.data.salary_default_bank).toBeNull()
  })

  it('starts the map from scratch when the existing row has no map', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        { data: { ...SAMPLE_ROW, default_voucher_series_per_source_type: null }, error: null },
        {
          data: { ...SAMPLE_ROW, default_voucher_series_per_source_type: { salary_payment: 'L' } },
          error: null,
        },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_voucher_series: 'L' }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const payload = supabaseMock.settingsUpdates()[0] as Record<string, unknown>
    expect(payload.default_voucher_series_per_source_type).toEqual({ salary_payment: 'L' })
  })

  it('dry-run merges the proposed changes with the current row and writes nothing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: { data: SAMPLE_ROW, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(`${URL}?dry_run=true`, {
        salary_deviation_period: 'same_month',
        salary_voucher_series: 'L',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toEqual({
      company_id: COMPANY_ID,
      salary_pay_day: 25,
      salary_deviation_period: 'same_month',
      preferred_payment_format: 'pain001',
      salary_default_bank: 'swedbank',
      salary_net_rounding: true,
      salary_calculation_policy: DEFAULT_POLICY,
      salary_voucher_series: 'L',
    })
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it('dry-run for a company without a row previews the defaults plus the changes', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(`${URL}?dry_run=true`, { salary_pay_day: 27 }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toEqual({
      company_id: COMPANY_ID,
      salary_pay_day: 27,
      salary_deviation_period: 'same_month',
      preferred_payment_format: 'pain001',
      salary_default_bank: null,
      salary_net_rounding: false,
      // The insert leaves the map to the DB default (the standard set), so
      // the preview says what the created row will say: K, not the no-row
      // fallback A.
      salary_calculation_policy: DEFAULT_POLICY,
      salary_voucher_series: 'K',
    })
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it('inserts a settings row (company_id + user_id + supplied columns) when none exists', async () => {
    const insertedRow = {
      salary_pay_day: 27,
      salary_deviation_period: 'previous_month',
      preferred_payment_format: 'pain001',
      salary_default_bank: null,
      salary_net_rounding: false,
      default_voucher_series_per_source_type: STANDARD_VOUCHER_SERIES_MAP,
    }
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        { data: null, error: null },
        { data: insertedRow, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_pay_day: 27, salary_deviation_period: 'previous_month' }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      company_id: COMPANY_ID,
      salary_pay_day: 27,
      salary_deviation_period: 'previous_month',
      preferred_payment_format: 'pain001',
      salary_default_bank: null,
      salary_net_rounding: false,
      salary_calculation_policy: DEFAULT_POLICY,
      salary_voucher_series: 'K',
    })

    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(1)
    const payload = supabaseMock.settingsInserts()[0] as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      company_id: COMPANY_ID,
      user_id: USER_ID,
      salary_pay_day: 27,
      salary_deviation_period: 'previous_month',
    })
  })

  it('applies the changes as an update when the insert races a concurrent create (23505)', async () => {
    const winnerRow = {
      salary_pay_day: 25,
      salary_deviation_period: 'same_month',
      preferred_payment_format: 'pain001',
      salary_default_bank: null,
      salary_net_rounding: false,
      default_voucher_series_per_source_type: { ...STANDARD_VOUCHER_SERIES_MAP, salary_payment: 'L' },
    }
    const updatedRow = { ...winnerRow, salary_pay_day: 27, salary_deviation_period: 'previous_month' }
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        // 1. first read: no row yet
        { data: null, error: null },
        // 2. insert: the other request won the unique index
        { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "company_settings_company_id_key"' } },
        // 3. re-read: the winner's row
        { data: winnerRow, error: null },
        // 4. update on that row
        { data: updatedRow, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_pay_day: 27, salary_deviation_period: 'previous_month' }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      salary_pay_day: 27,
      salary_deviation_period: 'previous_month',
      // The winner's series map is kept, not the fresh-company default.
      salary_calculation_policy: DEFAULT_POLICY,
      salary_voucher_series: 'L',
    })
    expect(supabaseMock.settingsInserts()).toHaveLength(1)
    expect(supabaseMock.settingsUpdates()).toHaveLength(1)
  })

  it('inserts the standard series set with the requested salary letter when provisioning with a series', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        { data: null, error: null },
        {
          data: {
            salary_pay_day: 25,
            salary_deviation_period: 'same_month',
            preferred_payment_format: 'pain001',
            salary_default_bank: null,
            salary_net_rounding: false,
            default_voucher_series_per_source_type: {
              ...STANDARD_VOUCHER_SERIES_MAP,
              salary_payment: 'L',
            },
          },
          error: null,
        },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_voucher_series: 'L' }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.salary_voucher_series).toBe('L')

    expect(supabaseMock.settingsInserts()).toHaveLength(1)
    const payload = supabaseMock.settingsInserts()[0] as Record<string, unknown>
    // Every other source type keeps the standard letter the DB default would
    // have given it; only salary_payment differs.
    expect(payload.default_voucher_series_per_source_type).toEqual({
      ...STANDARD_VOUCHER_SERIES_MAP,
      salary_payment: 'L',
    })
    expect(payload.company_id).toBe(COMPANY_ID)
    expect(payload.user_id).toBe(USER_ID)
  })

  it('returns 404 when the row disappears between the read and the update', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        { data: SAMPLE_ROW, error: null },
        { data: null, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_pay_day: 27 }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.details).toEqual({ resource: 'company_settings' })
  })

  it('returns the error envelope when the write fails', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        { data: SAMPLE_ROW, error: null },
        { data: null, error: { message: 'boom', code: 'XX000' } },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_pay_day: 27 }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.error.code).toBeTruthy()
  })
})

describe('PATCH salary_calculation_policy', () => {
  it('merges a partial policy into the stored one and writes the full object', async () => {
    const currentRow = { ...SAMPLE_ROW, salary_calculation_policy: { sick_rate: 'annual_hourly' } }
    const written = {
      partial_month: 'annual_calendar_days',
      sick_rate: 'annual_hourly',
      long_leave: 'workdays',
      leave_context: 'all_registered',
      net_rounding: 'up',
      one_off_tax_rounding: 'truncate',
    }
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        { data: currentRow, error: null },
        { data: { ...currentRow, salary_calculation_policy: written }, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(URL, { salary_calculation_policy: { partial_month: 'annual_calendar_days' } }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.salary_calculation_policy).toEqual(written)
    const payload = supabaseMock.settingsUpdates()[0] as Record<string, unknown>
    // The stored sick_rate survives; the untouched keys take their defaults;
    // no other column is touched.
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ salary_calculation_policy: written })
  })

  it('leaves the policy column alone when the body does not mention it', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: [
        { data: SAMPLE_ROW, error: null },
        { data: { ...SAMPLE_ROW, salary_pay_day: 27 }, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(makePatchRequest(URL, { salary_pay_day: 27 }), companyParams(COMPANY_ID))

    expect(res.status).toBe(200)
    const payload = supabaseMock.settingsUpdates()[0] as Record<string, unknown>
    expect(payload.salary_calculation_policy).toBeUndefined()
  })

  it('reports a stored partial policy with every convention filled in on GET', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: { data: { ...SAMPLE_ROW, salary_calculation_policy: { net_rounding: 'nearest' } }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await getSalarySettings(makeGetRequest(URL), companyParams(COMPANY_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.salary_calculation_policy).toEqual({ ...DEFAULT_POLICY, net_rounding: 'nearest' })
  })

  it('rejects an unknown convention key and a misspelled value (strict body)', async () => {
    const supabaseMock = makeFlexibleSupabase({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(supabaseMock)

    for (const policy of [{ partial_month: 'calender' }, { unknown: 'workdays' }]) {
      const res = await updateSalarySettings(
        makePatchRequest(URL, { salary_calculation_policy: policy }),
        companyParams(COMPANY_ID),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('VALIDATION_ERROR')
    }
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
    expect(supabaseMock.settingsInserts()).toHaveLength(0)
  })

  it('previews the merged policy on dry run without writing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: MEMBER,
      company_settings: { data: { ...SAMPLE_ROW, salary_calculation_policy: { sick_rate: 'annual_hourly' } }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSalarySettings(
      makePatchRequest(`${URL}?dry_run=true`, { salary_calculation_policy: { long_leave: 'calendar_after_five_workdays' } }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.salary_calculation_policy).toEqual({
      ...DEFAULT_POLICY,
      sick_rate: 'annual_hourly',
      long_leave: 'calendar_after_five_workdays',
    })
    expect(supabaseMock.settingsUpdates()).toHaveLength(0)
  })
})
