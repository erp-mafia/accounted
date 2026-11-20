/**
 * POST /api/v1/companies/{companyId}/salary/vacation-liability/reconcile:
 * the door of the operation salary.vacation-liability.reconcile. The service
 * is mocked: auth, scope, validation, the dry run and the error mapping.
 * The rules are covered in lib/salary/__tests__/vacation-liability-reconcile.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
const mockReconcile = vi.fn()
vi.mock('@/lib/salary/vacation-liability-reconcile', () => ({
  reconcileVacationLiability: (...a: unknown[]) => mockReconcile(...a),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/salary/vacation-liability/reconcile`

const RESULT = {
  as_of: '2026-10-25',
  adjusted: true,
  journal_entry_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  voucher_series: 'K',
  voucher_number: 41,
  booked_2920: 10000,
  booked_2940: 3142,
  computed_liability: 14000,
  computed_avgifter: 4398.8,
  difference_2920: 4000,
  difference_2940: 1256.8,
}

function request(url: string, body: unknown, auth = true): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      ...(auth ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {}),
      'Idempotency-Key': 'c1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    body: JSON.stringify(body),
  })
}
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(
    createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      idempotency_keys: { data: null, error: null },
    }).supabase,
  )
})

describe('POST /salary/vacation-liability/reconcile', () => {
  it('401 without an API key', async () => {
    mockValidate.mockResolvedValue(null)
    const res = await POST(request(URL_BASE, { as_of: '2026-10-25' }, false), params)
    expect(res.status).toBe(401)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('403 for a key without payroll:write', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'read key',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    const res = await POST(request(URL_BASE, { as_of: '2026-10-25' }), params)
    expect(res.status).toBe(403)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('400 on a malformed date', async () => {
    const res = await POST(request(URL_BASE, { as_of: '25/10/2026' }), params)
    expect(res.status).toBe(400)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('books the difference and answers the verifikat', async () => {
    mockReconcile.mockResolvedValue({ ok: true, data: RESULT })
    const res = await POST(request(URL_BASE, { as_of: '2026-10-25' }), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(RESULT)
    expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID }), { as_of: '2026-10-25' }, { dryRun: false })
  })

  it('dry_run previews with a preview token and books nothing', async () => {
    mockReconcile.mockResolvedValue({ ok: true, dryRun: true, preview: { as_of: '2026-10-25', would_post: true, lines: [] } })
    const res = await POST(request(`${URL_BASE}?dry_run=true`, { as_of: '2026-10-25' }), params)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.would_post).toBe(true)
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    expect(mockReconcile.mock.calls[0][2]).toEqual({ dryRun: true })
  })

  it('a locked period answers 400 PERIOD_LOCKED', async () => {
    mockReconcile.mockResolvedValue({ ok: false, code: 'PERIOD_LOCKED', details: { entry_date: '2025-12-31' } })
    const res = await POST(request(URL_BASE, { as_of: '2025-12-31' }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('PERIOD_LOCKED')
  })
})
