import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('../lib/bankid-client', () => ({
  startBankIdAuth: vi.fn(),
  pollBankIdSession: vi.fn(),
  collectBankIdResult: vi.fn(),
  cancelBankIdSession: vi.fn(),
  requestEnrichment: vi.fn().mockResolvedValue({ status: 'failed', completedTypes: [] }),
  fetchEnrichmentData: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

import { collectBankIdResult } from '../lib/bankid-client'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { ticExtension } from '../index'
import {
  BANKID_FLOW_COOKIE,
  BANKID_FLOW_ID_HEADER,
  signBankIdFlow,
  type BankIdFlowMode,
} from '../lib/bankid-flow-cookie'

const TEST_KEY = 'a'.repeat(64)
const TEST_FLOW_ID = 'flow-1'

/** Linking reads its session from the signed flow cookie, not the body. */
async function flowCookie(
  mode: BankIdFlowMode,
  sessionId = 'test-session',
  userId = 'user-1',
): Promise<Record<string, string>> {
  const value = await signBankIdFlow({
    version: 1,
    sessionId,
    flowId: TEST_FLOW_ID,
    mode,
    // A link flow is owned by the user who opened it; login/signup have none.
    userId: mode === 'link' ? userId : undefined,
    startedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  return {
    cookie: `${BANKID_FLOW_COOKIE}=${encodeURIComponent(value)}`,
    [BANKID_FLOW_ID_HEADER]: TEST_FLOW_ID,
  }
}

function findRoute(method: string, path: string) {
  const route = ticExtension.apiRoutes!.find((r) => r.method === method && r.path === path)
  if (!route) throw new Error(`${method} ${path} route not found in ticExtension.apiRoutes`)
  return route
}

function findHandler(method: string, path: string) {
  return findRoute(method, path).handler
}

function mockAuthenticated(userId = 'user-1') {
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: userId },
    supabase: {},
    error: null,
  } as unknown as Awaited<ReturnType<typeof requireAuth>>)
}

function mockUnauthenticated() {
  vi.mocked(requireAuth).mockResolvedValue({
    user: null,
    supabase: {},
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  } as unknown as Awaited<ReturnType<typeof requireAuth>>)
}

type QueuedResult = { data?: unknown; error?: unknown }

/** Minimal chainable service-client mock (same pattern as bankid-complete.test.ts). */
function mockServiceClient(
  fromResults: QueuedResult[],
  appMetadata: Record<string, unknown>,
  // Single-use claim; `{ error: { code: '23505' } }` means another tab won.
  consumed: QueuedResult = { error: null },
) {
  const queue = [...fromResults]

  const chain = (): unknown => {
    const result = queue.shift() ?? { data: null, error: null }
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
        return () => chain2(result)
      },
    }
    return new Proxy({}, handler)
  }
  const chain2 = (result: QueuedResult): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
        return () => chain2(result)
      },
    }
    return new Proxy({}, handler)
  }

  const admin = {
    updateUserById: vi.fn().mockResolvedValue({ data: {}, error: null }),
    getUserById: vi.fn().mockResolvedValue({
      data: { user: { id: 'user-1', app_metadata: appMetadata } },
    }),
  }

  const client = {
    from: vi.fn().mockImplementation((table: string) =>
      table === 'bankid_consumed_sessions' ? chain2(consumed) : chain()
    ),
    auth: { admin },
  }

  vi.mocked(createServiceClient).mockReturnValue(
    client as unknown as ReturnType<typeof createServiceClient>
  )

  return { admin, client }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BANKID_ENCRYPTION_KEY', TEST_KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('route flags', () => {
  // These routes are user-level: a zero-company user (fresh BankID signup,
  // pre-onboarding) must be able to manage the connection from settings.
  // Without skipCompanyContext the dispatcher throws 'No company context'.
  it('link and unlink skip company context', () => {
    expect(findRoute('POST', '/bankid/link').skipCompanyContext).toBe(true)
    expect(findRoute('POST', '/bankid/unlink').skipCompanyContext).toBe(true)
  })

  it('link and unlink still require auth', () => {
    expect(findRoute('POST', '/bankid/link').skipAuth).toBeUndefined()
    expect(findRoute('POST', '/bankid/unlink').skipAuth).toBeUndefined()
  })
})

describe('POST /bankid/unlink', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticated()
    mockServiceClient([], {})
    const req = createMockRequest('/api/extensions/ext/tic/bankid/unlink', { method: 'POST' })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/unlink')(req))
    expect(status).toBe(401)
  })

  it('merges app_metadata instead of replacing it: has_password must survive unlink', async () => {
    // A BankID-only user: has_password false. Wiping it would make
    // userHasPassword() infer TRUE (bankid_linked false ⇒ password assumed),
    // hiding the set-password escape hatch from a user with no login method.
    mockAuthenticated()
    const { admin } = mockServiceClient(
      [{ error: null }], // bankid_identities delete OK
      { has_password: false, bankid_linked: true, provider: 'email' }
    )

    const req = createMockRequest('/api/extensions/ext/tic/bankid/unlink', { method: 'POST' })
    const { status, body } = await parseJsonResponse<{ data?: { unlinked?: boolean } }>(
      await findHandler('POST', '/bankid/unlink')(req)
    )

    expect(status).toBe(200)
    expect(body.data?.unlinked).toBe(true)
    expect(admin.updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: false, provider: 'email', bankid_linked: false },
    })
  })

  it('returns 500 when the identity delete fails and does not touch app_metadata', async () => {
    mockAuthenticated()
    const { admin } = mockServiceClient(
      [{ error: { message: 'delete boom', code: 'XX000' } }],
      { has_password: false, bankid_linked: true }
    )

    const req = createMockRequest('/api/extensions/ext/tic/bankid/unlink', { method: 'POST' })
    const { status } = await parseJsonResponse(
      await findHandler('POST', '/bankid/unlink')(req)
    )

    expect(status).toBe(500)
    expect(admin.updateUserById).not.toHaveBeenCalled()
  })
})

describe('POST /bankid/start, link mode', () => {
  it('requires a signed-in caller, so a link flow always has an owner', async () => {
    // An anonymous link flow would have no userId to check at /bankid/link,
    // which is what lets an abandoned flow bind to the next person to sign in.
    mockUnauthenticated()
    const req = createMockRequest('/api/extensions/ext/tic/bankid/start', {
      method: 'POST',
      body: { mode: 'link' },
    })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/start')(req))

    expect(status).toBe(401)
  })

  it('does not require auth for login or signup, which have no user yet', async () => {
    mockUnauthenticated()
    const req = createMockRequest('/api/extensions/ext/tic/bankid/start', {
      method: 'POST',
      body: { mode: 'login' },
    })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/start')(req))

    expect(status).not.toBe(401)
  })
})

describe('POST /bankid/link', () => {
  function makeSession() {
    return {
      sessionId: 'test-session',
      status: 'complete',
      user: {
        personalNumber: '199001011234',
        givenName: 'Anna',
        surname: 'Andersson',
        name: 'Anna Andersson',
      },
    } as unknown as Awaited<ReturnType<typeof collectBankIdResult>>
  }

  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticated()
    mockServiceClient([], {})
    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      headers: await flowCookie('link'),
    })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/link')(req))
    expect(status).toBe(401)
  })

  it('returns 400 when the browser holds no flow', async () => {
    mockAuthenticated()
    mockServiceClient([], {})
    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      body: {},
    })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/link')(req))
    expect(status).toBe(400)
  })

  it('refuses a session that was not opened as a link flow', async () => {
    // A session started to sign someone IN must not be redirectable into
    // binding their personnummer to whoever happens to be logged in here.
    mockAuthenticated()
    const { admin, client } = mockServiceClient([], {})
    vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())

    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      headers: await flowCookie('login'),
      body: {},
    })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/link')(req))

    expect(status).toBe(400)
    expect(collectBankIdResult).not.toHaveBeenCalled()
    expect(client.from).not.toHaveBeenCalled()
    expect(admin.updateUserById).not.toHaveBeenCalled()
  })

  it('refuses a link flow that another user opened', async () => {
    // The shared-browser takeover: A starts "Koppla BankID" and authenticates
    // but never finishes; B signs in on the same machine and clicks the same
    // button. Without the owner check, A's personnummer is written against B's
    // user_id, and A can then sign in as B with their own BankID.
    mockAuthenticated('user-b')
    const { admin, client } = mockServiceClient([], {})
    vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())

    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      headers: await flowCookie('link', 'test-session', 'user-a'),
    })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/link')(req))

    expect(status).toBe(400)
    expect(collectBankIdResult).not.toHaveBeenCalled()
    expect(client.from).not.toHaveBeenCalled()
    expect(admin.updateUserById).not.toHaveBeenCalled()
  })

  it('refuses a stale tab after a newer link flow replaced the shared cookie', async () => {
    mockAuthenticated()
    const { client } = mockServiceClient([], {})
    vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
    const headers = await flowCookie('link')
    headers[BANKID_FLOW_ID_HEADER] = 'older-flow'

    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      headers,
    })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/link')(req))

    expect(status).toBe(400)
    expect(collectBankIdResult).not.toHaveBeenCalled()
    expect(client.from).not.toHaveBeenCalled()
  })

  it('refuses to link twice off one identification', async () => {
    mockAuthenticated()
    const { admin, client } = mockServiceClient(
      [{ data: null }], // pnr not linked to anyone yet
      {},
      { error: { code: '23505', message: 'duplicate key' } }, // another tab claimed it first
    )
    vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())

    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      headers: await flowCookie('link'),
    })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/link')(req))

    expect(status).toBe(400)
    // The identity insert never ran, so nothing was bound twice.
    const inserts = vi.mocked(client.from).mock.calls.filter((c) => c[0] === 'bankid_identities')
    expect(inserts).toHaveLength(1) // the pnr lookup only
    expect(admin.updateUserById).not.toHaveBeenCalled()
  })

  it('refuses a forged flow cookie', async () => {
    mockAuthenticated()
    const { client } = mockServiceClient([], {})
    vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())

    // Same shape, no valid signature: what a same-origin script could plant.
    const forged = Buffer.from(
      JSON.stringify({ version: 1, sessionId: 'attacker-session', mode: 'link', startedAt: Date.now() }),
    ).toString('base64url')
    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      headers: { cookie: `${BANKID_FLOW_COOKIE}=${forged}.not-a-signature` },
      body: {},
    })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/link')(req))

    expect(status).toBe(400)
    expect(client.from).not.toHaveBeenCalled()
  })

  it('merges app_metadata so an existing has_password: true survives linking', async () => {
    mockAuthenticated()
    vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
    const { admin } = mockServiceClient(
      [
        { data: null }, // pnr lookup → not linked anywhere
        { error: null }, // bankid_identities insert OK
      ],
      { has_password: true }
    )

    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      headers: await flowCookie('link'),
    })
    const { status, body } = await parseJsonResponse<{ data?: { linked?: boolean } }>(
      await findHandler('POST', '/bankid/link')(req)
    )

    expect(status).toBe(200)
    expect(body.data?.linked).toBe(true)
    expect(admin.updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: true, bankid_linked: true },
    })
  })

  it('returns 409 already_linked when the personnummer belongs to another user', async () => {
    mockAuthenticated()
    vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
    const { admin } = mockServiceClient(
      [{ data: { user_id: 'someone-else' } }],
      { has_password: true }
    )

    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      headers: await flowCookie('link'),
    })
    const { status, body } = await parseJsonResponse<{ error?: string }>(
      await findHandler('POST', '/bankid/link')(req)
    )

    expect(status).toBe(409)
    expect(body.error).toBe('already_linked')
    expect(admin.updateUserById).not.toHaveBeenCalled()
  })
})
