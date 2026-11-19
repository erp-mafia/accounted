/**
 * Typed handles through the v1 wrapper (./handles.ts): a handle in the path,
 * query or body reaches the company gate and the handler as its UUID, a
 * wrong-type handle is refused with HANDLE_TYPE_MISMATCH before anything is
 * read, a request with plain UUIDs passes through untouched, and a covered
 * endpoint's response gains `handle` next to its unchanged id.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const externalReportGuard = vi.hoisted(() => vi.fn())
vi.mock('@/lib/import/sie-period-read', () => ({ withSIEExternalReport: externalReportGuard }))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})

const getMultiUserStateMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: (...args: unknown[]) => getMultiUserStateMock(...args) }
})

vi.mock('@/lib/api/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/idempotency')>('@/lib/api/idempotency')
  return { ...actual, claimIdempotencyKey: vi.fn(), checkIdempotencyKey: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { claimIdempotencyKey } from '@/lib/api/idempotency'
import { withApiV1 } from '../with-api-v1'
import { ok, paginated } from '../response'
import { registerEndpoint } from '../registry'

const COMPANY = '8fd5b1f4-0000-4000-8000-000000000001'
const CMP = 'cmp_8fd5b1f4000040008000000000000001'
const JE_ID = '0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b'
const JE = 'je_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b'
const INV = 'inv_7b3a0000111142228333444455556666'

// Fixture registrations under operation ids V1_HANDLE_COVERAGE covers, so
// the response layer stamps them exactly as it stamps the real routes.
for (const [operation, method, path, scope] of [
  ['journal-entries.list', 'GET', '/api/v1/companies/:companyId/journal-entries', 'reports:read'],
  ['journal-entries.get', 'GET', '/api/v1/companies/:companyId/journal-entries/:id', 'reports:read'],
  ['journal-entries.create-draft', 'POST', '/api/v1/companies/:companyId/journal-entries', 'bookkeeping:write'],
] as const) {
  registerEndpoint({
    operation,
    method,
    path,
    summary: `${operation} (test fixture).`,
    description: 'Fixture registration for the handle tests.',
    useWhen: 'never: test fixture',
    doNotUseFor: 'anything outside this test file',
    pitfalls: [],
    example: { response: {} },
    scope,
    risk: 'low',
    idempotent: method === 'GET',
    reversible: false,
    dryRunSupported: method !== 'GET',
    response: { success: z.object({}) },
  })
}

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockClaim = claimIdempotencyKey as ReturnType<typeof vi.fn>

/** A membership stub that records the company id the gate looked up. */
function membershipStub(seen: string[]) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation((_col: string, companyId: string) => {
            seen.push(companyId)
            return {
              is: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { company_id: companyId, role: 'owner' }, error: null }),
              }),
            }
          }),
        }),
      }),
    }),
  }
}

const auth = { Authorization: 'Bearer gnubok_sk_x' }
let gateCompanyIds: string[]

beforeEach(() => {
  vi.clearAllMocks()
  externalReportGuard.mockImplementation((_s, _c, _op, read) => read())
  getMultiUserStateMock.mockResolvedValue({ state: 'entitled', graceEndsAt: null })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY,
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
  gateCompanyIds = []
  mockServiceClient.mockReturnValue(membershipStub(gateCompanyIds))
})

type DetailRoute = { params: Promise<{ companyId: string; id: string }> }
type CompanyRoute = { params: Promise<{ companyId: string }> }

describe('withApiV1: typed handles in', () => {
  it('passes a plain-UUID request through as the same Request with the same params', async () => {
    let seenRequest: Request | undefined
    let seenParams: unknown
    const handler = withApiV1<DetailRoute>('journal-entries.get', async (request, ctx, params) => {
      seenRequest = request
      seenParams = await params.params
      return ok({ ok: true }, { requestId: ctx.requestId })
    })
    const request = new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries/${JE_ID}`, { headers: auth })
    const params = { params: Promise.resolve({ companyId: COMPANY, id: JE_ID }) }

    const res = await handler(request, params)
    expect(res.status).toBe(200)
    expect(seenRequest).toBe(request)
    expect(seenParams).toEqual({ companyId: COMPANY, id: JE_ID })
  })

  it('reads company and resource handles in the path as their UUIDs, before the company gate', async () => {
    let seen: { companyId?: string; params?: unknown; url?: string } = {}
    const handler = withApiV1<DetailRoute>('journal-entries.get', async (request, ctx, params) => {
      seen = { companyId: ctx.companyId, params: await params.params, url: request.url }
      return ok({ ok: true }, { requestId: ctx.requestId })
    })

    const res = await handler(
      new Request(`https://x.test/api/v1/companies/${CMP}/journal-entries/${JE}`, { headers: auth }),
      { params: Promise.resolve({ companyId: CMP, id: JE }) },
    )
    expect(res.status).toBe(200)
    expect(gateCompanyIds).toEqual([COMPANY])
    expect(seen).toEqual({
      companyId: COMPANY,
      params: { companyId: COMPANY, id: JE_ID },
      url: `https://x.test/api/v1/companies/${COMPANY}/journal-entries/${JE_ID}`,
    })
  })

  it('refuses a wrong-type handle in the path with 400 HANDLE_TYPE_MISMATCH, reading nothing', async () => {
    const run = vi.fn()
    const handler = withApiV1<DetailRoute>('journal-entries.get', run)

    const res = await handler(
      new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries/${INV}`, { headers: auth }),
      { params: Promise.resolve({ companyId: COMPANY, id: INV }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('HANDLE_TYPE_MISMATCH')
    expect(body.error.message).toMatch(/fel sorts post/)
    expect(body.error.details.issues).toEqual([
      expect.objectContaining({
        field: 'path.journal-entries',
        expected_type: 'journal_entry',
        expected_prefix: 'je',
        received_type: 'invoice',
        received_prefix: 'inv',
      }),
    ])
    expect(run).not.toHaveBeenCalled()
    expect(gateCompanyIds).toEqual([])
  })

  it('refuses a wrong-type handle in a JSON body field', async () => {
    const run = vi.fn()
    const handler = withApiV1<CompanyRoute>('journal-entries.create-draft', run)
    const res = await handler(
      new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ fiscal_period_id: JE }),
      }),
      { params: Promise.resolve({ companyId: COMPANY }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('HANDLE_TYPE_MISMATCH')
    expect(body.error.details.issues[0]).toMatchObject({ field: 'fiscal_period_id', expected_prefix: 'fp', received_prefix: 'je' })
    expect(run).not.toHaveBeenCalled()
  })

  it('hashes a handle body and its UUID twin the same, so a retry may spell the id either way', async () => {
    mockClaim.mockResolvedValue({ claim: { complete: vi.fn(), release: vi.fn() } })
    let observed: unknown
    const handler = withApiV1<CompanyRoute>('journal-entries.create-draft', async (request, ctx) => {
      observed = await request.json()
      return ok({ ok: true }, { requestId: ctx.requestId })
    })
    const send = (fiscalPeriod: string) =>
      handler(
        new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries`, {
          method: 'POST',
          headers: { ...auth, 'Idempotency-Key': 'k-1', 'content-type': 'application/json' },
          body: JSON.stringify({ fiscal_period_id: fiscalPeriod, description: 'x' }),
        }),
        { params: Promise.resolve({ companyId: COMPANY }) },
      )

    await send('fp_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b')
    expect(observed).toEqual({ fiscal_period_id: JE_ID, description: 'x' })
    await send(JE_ID)
    const [first, second] = mockClaim.mock.calls.map((c) => (c[1] as { requestHash: string }).requestHash)
    expect(first).toBe(second)
  })
})

describe('withApiV1: typed handles out', () => {
  it('stamps handle next to the unchanged id on a covered endpoint', async () => {
    const rows = [
      { id: JE_ID, voucher_number: 1 },
      { id: 'not-a-uuid', voucher_number: 2 },
    ]
    const handler = withApiV1<CompanyRoute>('journal-entries.list', async (_request, ctx) =>
      paginated(rows, { requestId: ctx.requestId, nextCursor: 'c2' }),
    )
    const res = await handler(
      new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries`, { headers: auth }),
      { params: Promise.resolve({ companyId: COMPANY }) },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/)
    const body = await res.json()
    expect(body.data).toEqual([
      { id: JE_ID, handle: JE, voucher_number: 1 },
      { id: 'not-a-uuid', voucher_number: 2 },
    ])
    expect(Object.keys(body.data[0])).toEqual(['id', 'handle', 'voucher_number'])
    expect(body.meta.next_cursor).toBe('c2')
  })

  it('leaves a dry-run preview alone', async () => {
    const handler = withApiV1<CompanyRoute>('journal-entries.create-draft', async (_request, ctx) =>
      ok({ dry_run: true, preview: { id: JE_ID } }, { requestId: ctx.requestId, dryRun: true }),
    )
    const res = await handler(
      new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries?dry_run=true`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      }),
      { params: Promise.resolve({ companyId: COMPANY }) },
    )
    expect((await res.json()).data).toEqual({ dry_run: true, preview: { id: JE_ID } })
  })
})
