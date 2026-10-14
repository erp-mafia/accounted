/**
 * POST /api/v1/companies/:companyId/voucher-gap-explanations
 *
 * The rules are the shared service's (lib/core/bookkeeping/voucher-gaps.ts):
 * explanation 1-500 characters (the table's CHECK; v1 allowed 2000, so
 * 501-2000 failed in the database), the company's year, write-once (409), and
 * a dry run that gives the same verdict.
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
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/voucher-gap-explanations`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const BODY = { fiscal_period_id: PERIOD_ID, voucher_series: 'A', gap_start: 142, gap_end: 145, explanation: 'Nummer reserverade i det tidigare systemet.' }
const SAVED = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ...BODY, created_at: '2026-10-13T10:00:00Z' }

function client(byTable: Record<string, TableMockResult | TableMockResult[]>) {
  const mock = createTableMockSupabase({ company_members: OWNER, ...byTable })
  mockServiceClient.mockReturnValue(mock.supabase)
  return mock
}

function request(body: unknown, query = ''): Request {
  return new Request(`${URL_}${query}`, {
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
})

describe('POST .../voucher-gap-explanations', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    client({})
    expect((await POST(request(BODY), params)).status).toBe(401)
  })

  it('400 for an explanation over 500 characters, an unknown key or a reversed range, writing nothing', async () => {
    for (const body of [
      { ...BODY, explanation: 'x'.repeat(501) },
      { ...BODY, surprise: true },
      { ...BODY, gap_start: 150 },
    ]) {
      const mock = client({ fiscal_periods: { data: { id: PERIOD_ID } } })
      const res = await POST(request(body), params)
      expect(res.status).toBe(400)
      expect(mock.findCall('voucher_gap_explanations', 'insert')).toBeUndefined()
    }
  })

  it('404 for a fiscal year outside the company', async () => {
    client({ fiscal_periods: { data: null } })
    const res = await POST(request(BODY), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error.details).toMatchObject({ resource: 'fiscal_period', field: 'fiscal_period_id' })
  })

  it('409 VOUCHER_GAP_ALREADY_EXPLAINED for an explained gap, live and dry run alike', async () => {
    client({
      fiscal_periods: { data: { id: PERIOD_ID } },
      voucher_gap_explanations: { error: { code: '23505', message: 'duplicate key value' } },
    })
    const live = await POST(request(BODY), params)
    expect(live.status).toBe(409)
    expect((await live.json()).error.code).toBe('VOUCHER_GAP_ALREADY_EXPLAINED')

    client({ fiscal_periods: { data: { id: PERIOD_ID } }, voucher_gap_explanations: { data: { id: SAVED.id } } })
    const dry = await POST(request(BODY, '?dry_run=true'), params)
    expect(dry.status).toBe(409)
  })

  it('201 with the saved explanation, trimmed', async () => {
    const mock = client({ fiscal_periods: { data: { id: PERIOD_ID } }, voucher_gap_explanations: { data: SAVED } })

    const res = await POST(request({ ...BODY, explanation: `  ${BODY.explanation}  ` }), params)

    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual(SAVED)
    expect(mock.payloads('voucher_gap_explanations', 'insert')[0]).toMatchObject({
      company_id: COMPANY_ID,
      explanation: BODY.explanation,
    })
  })
})
