/**
 * The permission shadow at the REST v1 door: withApiV1 tells it what the
 * role and access gates and the handler did, the response is
 * byte-identical with the shadow on and off, and a disagreement schedules
 * exactly one log write.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

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

import { createServiceClientNoCookies, validateApiKey } from '@/lib/auth/api-keys'
import { insertShadowRow } from '@/lib/permissions/shadow-writer'
import { resetPermissionShadowForTests } from '@/lib/permissions/shadow'
import { registerEndpoint } from '../registry'
import { created } from '../response'
import { withApiV1 } from '../with-api-v1'

const COMPANY = 'c0ffee01-0000-4000-8000-000000000001'
const KEY = 'c0ffee02-0000-4000-8000-000000000002'
const IDENTITY = 'c0ffee03-0000-4000-8000-000000000003'
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

registerEndpoint({
  operation: 'journal-entries.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/journal-entries',
  summary: 'Fixture.',
  description: 'Fixture registration for the shadow tests.',
  useWhen: 'never: test fixture',
  doNotUseFor: 'anything outside this test file',
  pitfalls: [],
  example: { response: {} },
  scope: 'bookkeeping:write',
  risk: 'medium',
  idempotent: false,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.object({}) },
})

function membership(role: string) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { company_id: COMPANY, role }, error: null }),
          }),
        }),
      }),
    }),
  }
}

function key(overrides: Record<string, unknown>) {
  return {
    userId: 'user-1',
    companyId: COMPANY,
    apiKeyId: KEY,
    apiKeyName: 'Skript',
    scopes: ['bookkeeping:write'],
    mode: 'live',
    unattendedCommitLimit: null,
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    serviceAccount: null,
    agentIdentityId: IDENTITY,
    client: null,
    ...overrides,
  }
}

async function snapshot(res: Response) {
  // The per-request id and the Server-Timing durations differ per call.
  const strip = (v: string) => v.replace(/req_[0-9a-f-]{36}/g, 'req_X').replace(/dur=\d+/g, 'dur=N')
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'x-request-id').map(([k, v]) => [k, strip(v)])
  return { status: res.status, headers, body: strip(await res.text()) }
}

async function callTwice() {
  const route = withApiV1<{ params: Promise<{ companyId: string }> }>('journal-entries.create', async (_req, ctx) =>
    created({ journal_entry_id: 'je-1' }, { requestId: ctx.requestId }),
  )
  const call = async () =>
    snapshot(
      await route(
        new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries`, {
          method: 'POST',
          headers: { Authorization: 'Bearer gnubok_sk_x', 'Content-Type': 'application/json' },
          body: '{}',
        }),
        { params: Promise.resolve({ companyId: COMPANY }) },
      ),
    )
  process.env.PERMISSIONS_SHADOW = 'off'
  const off = await call()
  await flush()
  expect(insertShadowRow).not.toHaveBeenCalled()
  delete process.env.PERMISSIONS_SHADOW
  const on = await call()
  await flush()
  return { off, on }
}

describe('withApiV1: permission shadow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPermissionShadowForTests()
    delete process.env.PERMISSIONS_SHADOW
  })
  afterEach(() => {
    delete process.env.PERMISSIONS_SHADOW
  })

  it('answers the same and logs one row when an OAuth key commits through a door that cannot stage', async () => {
    vi.mocked(validateApiKey).mockResolvedValue(key({ client: 'claude', apiKeyName: 'MCP-klient (OAuth)' }) as never)
    vi.mocked(createServiceClientNoCookies).mockReturnValue(membership('member') as never)
    const { off, on } = await callTwice()
    expect(on).toEqual(off)
    expect(on.status).toBe(201)
    expect(insertShadowRow).toHaveBeenCalledTimes(1)
    expect(insertShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({
        door: 'v1:journal-entries.create',
        method: 'POST',
        principal_kind: 'agent',
        api_key_id: KEY,
        agent_identity_id: IDENTITY,
        company_id: COMPANY,
        user_id: 'user-1',
        today_outcome: 'allow',
        // A proposing agent at a door that cannot stage is refused.
        decide_outcome: 'deny',
        decide_reason: 'STAGE_REQUIRED',
        expected: false,
      }),
    )
  })

  it("logs nothing for a manual key's commit or a viewer's refusal, and answers the same", async () => {
    vi.mocked(validateApiKey).mockResolvedValue(key({}) as never)
    vi.mocked(createServiceClientNoCookies).mockReturnValue(membership('member') as never)
    let result = await callTwice()
    expect(result.on).toEqual(result.off)
    expect(result.on.status).toBe(201)

    vi.mocked(createServiceClientNoCookies).mockReturnValue(membership('viewer') as never)
    result = await callTwice()
    expect(result.on).toEqual(result.off)
    expect(result.on.status).toBe(403)
    expect(insertShadowRow).not.toHaveBeenCalled()
  })

  it('does not compare a missing scope: scope checks stay at the wire', async () => {
    vi.mocked(validateApiKey).mockResolvedValue(key({ scopes: ['transactions:write'] }) as never)
    vi.mocked(createServiceClientNoCookies).mockReturnValue(membership('member') as never)
    const { off, on } = await callTwice()
    expect(on).toEqual(off)
    expect(on.status).toBe(403)
    expect(insertShadowRow).not.toHaveBeenCalled()
  })
})
