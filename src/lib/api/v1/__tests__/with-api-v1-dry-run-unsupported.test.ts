/**
 * A dry run asked of a write that cannot simulate is refused, never ignored.
 *
 * The docs promise that `?dry_run=true` (or `X-Dry-Run: true`) previews a
 * write. A handler registered with `dryRunSupported: false` never reads the
 * flag, so before this guard the write ran for real: a year-end, a period
 * lock, the approval of a pending operation. Three handlers refused the flag
 * themselves; the rule now lives in the wrapper for every write.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})

import { createTableMockSupabase } from '@/tests/helpers'
import { createServiceClientNoCookies, validateApiKey } from '@/lib/auth/api-keys'
import { withApiV1 } from '../with-api-v1'
import { dryRunPreview } from '../dry-run'
import { ok } from '../response'
import { registerEndpoint } from '../registry'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'c0ffee01-0000-4000-8000-000000000001'
const PERIOD_ID = 'c0ffee01-0000-4000-8000-0000000000aa'
const LOCK_URL = `https://x.test/api/v1/companies/${COMPANY_ID}/fiscal-periods/${PERIOD_ID}/lock`
const CUSTOMERS_URL = `https://x.test/api/v1/companies/${COMPANY_ID}/customers`

const FIXTURE = {
  summary: 'Test fixture.',
  description: 'Fixture registration used by the unsupported dry-run tests.',
  useWhen: 'never: test fixture',
  doNotUseFor: 'anything outside this test file',
  pitfalls: [],
  example: { response: {} },
  risk: 'medium' as const,
  idempotent: true,
  reversible: false,
  response: { success: z.object({}) },
}

// Module state is per test file, so these registrations reach no other suite.
registerEndpoint({
  ...FIXTURE,
  operation: 'fiscal-periods.lock',
  method: 'POST',
  path: '/api/v1/companies/:companyId/fiscal-periods/:id/lock',
  scope: 'bookkeeping:write',
  dryRunSupported: false,
})
registerEndpoint({
  ...FIXTURE,
  operation: 'customers.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/customers',
  scope: 'customers:write',
  dryRunSupported: true,
})

/** A service client where the key's user is a member of the company. */
function makeClient() {
  return createTableMockSupabase({ company_members: { data: { company_id: COMPANY_ID, role: 'member' } } }).supabase
}

/** A handler that, like the real lock handler, never reads ctx.dryRun. */
const locked = vi.fn()
const lockRoute = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'fiscal-periods.lock',
  async (_request, ctx) => {
    locked()
    return ok({ locked: true }, { requestId: ctx.requestId })
  },
)

const created = vi.fn()
const createRoute = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'customers.create',
  async (_request, ctx) => {
    if (ctx.dryRun) return dryRunPreview({ name: 'Acme' }, { requestId: ctx.requestId, log: ctx.log })
    created()
    return ok({ name: 'Acme' }, { requestId: ctx.requestId })
  },
)

const lockParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: PERIOD_ID }) }
const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function post(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key', ...headers },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockServiceClient.mockReturnValue(makeClient())
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_live',
    apiKeyName: 'live key',
    scopes: ['bookkeeping:write', 'customers:write'],
    mode: 'live',
  })
})

describe('withApiV1: dry run on a write that cannot simulate', () => {
  it('refuses ?dry_run=true with 400 and never reaches the handler', async () => {
    const res = await lockRoute(post(`${LOCK_URL}?dry_run=true`), lockParams)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('dry_run')
    expect(locked).not.toHaveBeenCalled()
  })

  it('refuses the X-Dry-Run header the same way', async () => {
    const res = await lockRoute(post(LOCK_URL, { 'X-Dry-Run': 'true' }), lockParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.details.field).toBe('dry_run')
    expect(locked).not.toHaveBeenCalled()
  })

  it('runs the write when no dry run is asked for', async () => {
    const res = await lockRoute(post(LOCK_URL), lockParams)
    expect(res.status).toBe(200)
    expect(locked).toHaveBeenCalledTimes(1)
  })

  it('still answers a test key with TEST_KEY_WRITE_BLOCKED', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_test',
      apiKeyName: 'test key',
      scopes: ['bookkeeping:write'],
      mode: 'test',
    })
    const res = await lockRoute(post(`${LOCK_URL}?dry_run=true`), lockParams)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('TEST_KEY_WRITE_BLOCKED')
    expect(locked).not.toHaveBeenCalled()
  })

  it('leaves a write that supports a dry run alone: it previews', async () => {
    const res = await createRoute(post(`${CUSTOMERS_URL}?dry_run=true`), companyParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(created).not.toHaveBeenCalled()
  })
})
