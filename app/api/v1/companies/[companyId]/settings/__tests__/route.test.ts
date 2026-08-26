/**
 * Integration tests for PATCH /api/v1/companies/:companyId/settings.
 *
 * Modeled on the v1 customers route tests: mocked API-key auth + a flexible
 * Supabase proxy mock; no real network or database access.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  // Belt-and-braces: ensure we never reach a real DB from this test suite.
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `settings route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { PATCH as updateSettings } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

function makeFlexibleSupabase(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  // Records update payloads and .select() projection strings so tests can
  // assert what the route writes and which columns it fetches back.
  const captured: {
    update: unknown[]
    selects: Record<string, string[]>
  } = { update: [], selects: {} }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
        }
        return (...args: unknown[]) => {
          if (prop === 'update') captured.update.push(args[0])
          if (prop === 'select' && typeof args[0] === 'string') {
            ;(captured.selects[table] ??= []).push(args[0])
          }
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)), captured }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER_ID = 'user-1'

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function makePatchRequest(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'abcd1234-4444-4abc-8def-1234567890ab',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
}

function withWriteScope() {
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['companies:write'],
    mode: 'live',
  })
}

const SAMPLE_SETTINGS = {
  bank_name: 'Testbanken',
  clearing_number: null,
  account_number: null,
  // '991-2346' passes the Bankgiro Luhn check (see lib/bankgiro Luhn tests).
  bankgiro: '991-2346',
  plusgiro: null,
  swish: null,
  iban: null,
  bic: null,
  default_our_reference: 'Anna Andersson',
  email: 'faktura@acme.test',
  phone: null,
  website: null,
  invoice_email_texts: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  withWriteScope()
})

describe('PATCH /api/v1/companies/:companyId/settings', () => {
  it('returns 401 UNAUTHORIZED for an invalid API key', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
        bank_name: 'X',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('rejects keys without the companies:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['companies:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
        bank_name: 'X',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details.required_scope).toBe('companies:write')
  })

  it('returns 404 when the caller is not a member of the company in the URL', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: null, error: null },
      }),
    )

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
        bank_name: 'X',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 404 when the company has no settings row', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        company_settings: { data: null, error: null },
      }),
    )

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
        bank_name: 'X',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.details).toEqual({ resource: 'company_settings' })
  })

  it('rejects requests without an Idempotency-Key header', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const req = new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bank_name: 'X' }),
    })

    const res = await updateSettings(req, companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for a body that is not valid JSON', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const req = new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'abcd1234-4444-4abc-8def-1234567890ab',
      },
      body: '{"bank_name": not-json',
    })

    const res = await updateSettings(req, companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toEqual({ field: 'body', message: 'Body is not valid JSON.' })
    expect(supabaseMock.captured.update).toHaveLength(0)
  })

  it.each([
    ['a bare array', [{ bank_name: 'X' }]],
    ['a bare string', 'bank_name=X'],
    ['a bare number', 42],
    ['null', null],
  ])('returns 400 for a JSON body that is not an object (%s)', async (_label, jsonBody) => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, jsonBody),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toEqual({ field: 'body', message: 'Body must be a JSON object.' })
    expect(supabaseMock.captured.update).toHaveLength(0)
  })

  it('rejects an empty body (at least one field required)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {}),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects unknown fields, including the internal column name default_our_reference', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
        default_our_reference: 'Sneaky',
        vat_registered: true,
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    const fields = body.error.details.issues.map((i: { field: string }) => i.field)
    expect(fields).toContain('default_our_reference')
    expect(fields).toContain('vat_registered')
  })

  it('returns 400 for a bankgiro that fails the Luhn check', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
        // Right shape (regex passes) but wrong check digit: 991-2346 is valid.
        bankgiro: '991-2345',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    const issue = body.error.details.issues.find((i: { field: string }) => i.field === 'bankgiro')
    expect(issue).toBeTruthy()
    expect(issue.message).toBe('Invalid Bankgiro number')
    // Nothing was written.
    expect(supabaseMock.captured.update).toHaveLength(0)
  })

  it('returns 400 for an unknown invoice email placeholder', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
        invoice_email_texts: { sv: { body: 'Hej! Se faktura {faktura_nr}.' } },
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    const issue = body.error.details.issues.find(
      (i: { field: string }) => i.field === 'invoice_email_texts.sv.body',
    )
    expect(issue).toBeTruthy()
    expect(issue.message).toContain('{faktura_nr}')
    expect(supabaseMock.captured.update).toHaveLength(0)
  })

  it('updates settings and maps contact_person onto default_our_reference', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      company_settings: { data: SAMPLE_SETTINGS, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
        contact_person: 'Anna Andersson',
        bankgiro: '991-2346',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // The response uses the public field name, mapped from the DB column.
    expect(body.data.company_id).toBe(COMPANY_ID)
    expect(body.data.contact_person).toBe('Anna Andersson')
    expect(body.data.bankgiro).toBe('991-2346')
    // The update payload carries the DB column name, not contact_person.
    const updatePayload = supabaseMock.captured.update[0] as Record<string, unknown>
    expect(updatePayload.default_our_reference).toBe('Anna Andersson')
    expect(updatePayload.bankgiro).toBe('991-2346')
    expect(updatePayload.contact_person).toBeUndefined()
    // The response projection reads the column back.
    expect(supabaseMock.captured.selects['company_settings']?.[0]).toContain('default_our_reference')
  })

  it('keeps unsupplied fields undefined (never null) in the update payload', async () => {
    // The route builds a literal 13-column update payload where unsupplied
    // fields are undefined; supabase-js JSON serialization drops them, so
    // the stored values survive a partial PATCH. A future `?? null` on that
    // payload would silently CLEAR every column the caller did not send
    // (null is a real write that empties the column). This test pins the
    // undefined-not-null contract and fails on any such regression.
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      company_settings: { data: { ...SAMPLE_SETTINGS, bank_name: 'Nya Banken' }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSettings(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/settings`, {
        bank_name: 'Nya Banken',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(supabaseMock.captured.update).toHaveLength(1)
    const updatePayload = supabaseMock.captured.update[0] as Record<string, unknown>
    expect(updatePayload.bank_name).toBe('Nya Banken')

    const unsuppliedKeys = Object.keys(updatePayload).filter((key) => key !== 'bank_name')
    // Guard the guard: the literal payload declares every column, so the
    // unsupplied set must be non-empty for the loop below to prove anything.
    expect(unsuppliedKeys.length).toBeGreaterThan(0)
    for (const key of unsuppliedKeys) {
      expect(
        updatePayload[key],
        `unsupplied column "${key}" must be undefined in the update payload, never null`,
      ).toBeUndefined()
    }
    // What actually reaches PostgREST after JSON serialization: only the
    // supplied column remains.
    expect(JSON.parse(JSON.stringify(updatePayload))).toEqual({ bank_name: 'Nya Banken' })
  })

  it('dry-run merges the proposed changes with the current row and writes nothing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      company_settings: { data: SAMPLE_SETTINGS, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateSettings(
      makePatchRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/settings?dry_run=true`,
        { contact_person: 'Bo Berg' },
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.contact_person).toBe('Bo Berg')
    // Unchanged fields from the current record are preserved.
    expect(body.data.preview.bank_name).toBe('Testbanken')
    expect(supabaseMock.captured.update).toHaveLength(0)
  })
})
