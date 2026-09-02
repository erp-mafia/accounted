/**
 * Integration tests for POST /api/v1/companies/:companyId/invoices/:id/quote-status.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `quote-status route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { POST as setQuoteStatus } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
type RecordedCall = { table: string; method: string; args: unknown[] }
function makeFlexibleSupabase(
  byTable: Record<string, MockResult | MockResult[]>,
  calls?: RecordedCall[],
) {
  // Per-table queue: arrays return results in order across multiple calls
  // to .from('table'); single values return the same result every time.
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
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
          calls?.push({ table, method: String(prop), args })
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const QUOTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

function makeRequest(
  body: unknown,
  opts: { auth?: boolean; idempotencyKey?: boolean; dryRun?: boolean; id?: string } = {},
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== false) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  if (opts.idempotencyKey !== false) headers['Idempotency-Key'] = 'idem1234-7777-4abc-8def-1234567890ab'
  const id = opts.id ?? QUOTE_ID
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${id}/quote-status${opts.dryRun ? '?dry_run=true' : ''}`
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const MEMBER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }

const OPEN_QUOTE = {
  id: QUOTE_ID,
  invoice_number: 'OF-007',
  document_type: 'quote',
  status: 'sent',
  quote_status: 'open',
  quote_decided_at: null,
  valid_until: '2099-12-31',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/invoices/:id/quote-status', () => {
  it('returns 401 without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await setQuoteStatus(
      makeRequest({ status: 'accepted' }, { auth: false }),
      detailParams(COMPANY_ID, QUOTE_ID),
    )

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 400 VALIDATION_ERROR for an unknown status', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: MEMBER }))

    const res = await setQuoteStatus(
      makeRequest({ status: 'expired' }),
      detailParams(COMPANY_ID, QUOTE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 VALIDATION_ERROR for a non-UUID id', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: MEMBER }))

    const res = await setQuoteStatus(
      makeRequest({ status: 'accepted' }, { id: 'not-a-uuid' }),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('id')
  })

  it('returns 404 NOT_FOUND when the quote does not exist in the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: MEMBER,
        invoices: { data: null, error: null },
      }),
    )

    const res = await setQuoteStatus(
      makeRequest({ status: 'accepted' }),
      detailParams(COMPANY_ID, QUOTE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 400 INVOICE_NOT_A_QUOTE for a regular invoice', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: MEMBER,
        invoices: { data: { ...OPEN_QUOTE, document_type: 'invoice', quote_status: null }, error: null },
      }),
    )

    const res = await setQuoteStatus(
      makeRequest({ status: 'accepted' }),
      detailParams(COMPANY_ID, QUOTE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_NOT_A_QUOTE')
    expect(body.error.details.document_type).toBe('invoice')
  })

  it('returns 400 INVOICE_QUOTE_NOT_DECIDABLE for a cancelled quote', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: MEMBER,
        invoices: { data: { ...OPEN_QUOTE, status: 'cancelled' }, error: null },
      }),
    )

    const res = await setQuoteStatus(
      makeRequest({ status: 'declined' }),
      detailParams(COMPANY_ID, QUOTE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_QUOTE_NOT_DECIDABLE')
  })

  it('returns 409 INVOICE_QUOTE_ALREADY_INVOICED once an active invoice was converted from it', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: MEMBER,
        invoices: [
          { data: { ...OPEN_QUOTE, quote_status: 'accepted' }, error: null },
          // converted_from_id lookup: an active invoice exists.
          { data: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', invoice_number: '2026-0042' }, error: null },
        ],
      }),
    )

    const res = await setQuoteStatus(
      makeRequest({ status: 'declined' }),
      detailParams(COMPANY_ID, QUOTE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_QUOTE_ALREADY_INVOICED')
    expect(body.error.details.invoice_number).toBe('2026-0042')
  })

  it('records the decision and returns the effective status', async () => {
    const calls: RecordedCall[] = []
    const decidedAt = '2026-09-02T09:14:33.000Z'
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: MEMBER,
          invoices: [
            { data: OPEN_QUOTE, error: null },
            // converted_from_id lookup: nothing converted yet.
            { data: null, error: null },
            { data: { ...OPEN_QUOTE, quote_status: 'accepted', quote_decided_at: decidedAt }, error: null },
          ],
        },
        calls,
      ),
    )

    const res = await setQuoteStatus(
      makeRequest({ status: 'accepted' }),
      detailParams(COMPANY_ID, QUOTE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.document_type).toBe('quote')
    expect(body.data.quote_status).toBe('accepted')
    expect(body.data.effective_quote_status).toBe('accepted')
    expect(body.data.quote_decided_at).toBe(decidedAt)
    expect(body.data.invoice_number).toBe('OF-007')

    const update = calls.find((c) => c.table === 'invoices' && c.method === 'update')
    expect(update).toBeDefined()
    expect(update!.args[0]).toMatchObject({ quote_status: 'accepted' })
    expect((update!.args[0] as { quote_decided_at: unknown }).quote_decided_at).toEqual(expect.any(String))
  })

  it('reports expired for an open quote past valid_until (derived, never stored)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: MEMBER,
        invoices: [
          { data: { ...OPEN_QUOTE, valid_until: '2020-01-01' }, error: null },
          { data: null, error: null },
          { data: { ...OPEN_QUOTE, valid_until: '2020-01-01' }, error: null },
        ],
      }),
    )

    const res = await setQuoteStatus(
      makeRequest({ status: 'open' }),
      detailParams(COMPANY_ID, QUOTE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.quote_status).toBe('open')
    expect(body.data.effective_quote_status).toBe('expired')
  })

  it('dry-run previews the decision without writing', async () => {
    const calls: RecordedCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: MEMBER,
          invoices: [
            { data: OPEN_QUOTE, error: null },
            { data: null, error: null },
          ],
        },
        calls,
      ),
    )

    const res = await setQuoteStatus(
      makeRequest({ status: 'declined' }, { dryRun: true }),
      detailParams(COMPANY_ID, QUOTE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.quote_status).toBe('declined')
    expect(body.data.preview.effective_quote_status).toBe('declined')
    expect(calls.some((c) => c.table === 'invoices' && c.method === 'update')).toBe(false)
  })
})
