/**
 * withApiV1's package start gate: a v1 write that starts new work in a
 * package (lib/modules/package-doors.ts) answers PACKAGE_OFF while the
 * company has the package switched off or winding down, before the
 * idempotency claim; settling writes and reads never ask.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTableMockSupabase } from '@/tests/helpers'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn(async () => ({ state: 'entitled', graceEndsAt: null })) }
})
vi.mock('@/lib/api/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/idempotency')>('@/lib/api/idempotency')
  return { ...actual, claimIdempotencyKey: vi.fn(), checkIdempotencyKey: vi.fn(), storeIdempotencyResponse: vi.fn() }
})

import { createServiceClientNoCookies, validateApiKey } from '@/lib/auth/api-keys'
import { claimIdempotencyKey } from '@/lib/api/idempotency'
import { packageOffRefusal, packageStartRefusal } from '@/lib/modules/package-gate'
import { ok } from '../response'
import { registerEndpoint } from '../registry'
import { withApiV1 } from '../with-api-v1'

for (const [operation, method, path] of [
  ['salary-runs.create', 'POST', '/api/v1/companies/:companyId/salary-runs'],
  ['salary-runs.book', 'POST', '/api/v1/companies/:companyId/salary-runs/:id/book'],
] as const) {
  registerEndpoint({
    operation,
    method,
    path,
    summary: `${operation} (test fixture).`,
    description: 'Fixture registration for the package gate tests.',
    useWhen: 'never: test fixture',
    doNotUseFor: 'anything outside this test file',
    pitfalls: [],
    example: { response: {} },
    scope: 'payroll:write',
    risk: 'medium',
    idempotent: true,
    reversible: false,
    dryRunSupported: false,
    response: { success: z.object({}) },
  })
}

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

function membershipStub() {
  return createTableMockSupabase({ company_members: { data: { company_id: COMPANY_ID, role: 'owner' } } }).supabase
}

function post(url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer gnubok_sk_x', 'Idempotency-Key': 'key-1', 'Content-Type': 'application/json' },
    body: '{}',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    scopes: ['payroll:write'],
    mode: 'live',
  } as never)
  vi.mocked(createServiceClientNoCookies).mockReturnValue(membershipStub() as never)
  vi.mocked(claimIdempotencyKey).mockResolvedValue({ status: 'claimed' } as never)
})

describe('withApiV1 package start gate', () => {
  it('refuses a start endpoint with PACKAGE_OFF before claiming the idempotency key', async () => {
    vi.mocked(packageStartRefusal).mockResolvedValueOnce(packageOffRefusal('payroll', 'turned_off_by_company'))
    const handler = vi.fn(async (_req: Request, ctx: { requestId: string }) => ok({}, { requestId: ctx.requestId }))
    const route = withApiV1<{ params: Promise<{ companyId: string }> }>('salary-runs.create', handler, {
      requireScope: 'payroll:write',
      requireIdempotencyKey: true,
    })

    const res = await route(post(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs`), {
      params: Promise.resolve({ companyId: COMPANY_ID }),
    })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toMatchObject({ code: 'PACKAGE_OFF', details: { package_id: 'payroll', resolution: 'Slå på Lön under Anpassa.' } })
    expect(body.error.message).toMatch(/Slå på Lön under Anpassa\.$/)
    expect(body.error.message_en).toMatch(/switched off/)
    expect(handler).not.toHaveBeenCalled()
    expect(claimIdempotencyKey).not.toHaveBeenCalled()
  })

  it('never asks for a write that settles open work', async () => {
    const handler = vi.fn(async (_req: Request, ctx: { requestId: string }) => ok({}, { requestId: ctx.requestId }))
    const route = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>('salary-runs.book', handler, {
      requireScope: 'payroll:write',
      requireIdempotencyKey: true,
    })
    await route(post(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/run-1/book`), {
      params: Promise.resolve({ companyId: COMPANY_ID, id: 'run-1' }),
    })
    expect(packageStartRefusal).not.toHaveBeenCalled()
  })
})
