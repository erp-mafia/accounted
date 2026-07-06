import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

import { collectBankIdResult } from '../lib/bankid-client'
import { createServiceClient } from '@/lib/supabase/server'
import { ticExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

const TEST_KEY = 'a'.repeat(64)

function findHandler(method: string, path: string) {
  const route = ticExtension.apiRoutes!.find((r) => r.method === method && r.path === path)
  if (!route) throw new Error(`${method} ${path} route not found in ticExtension.apiRoutes`)
  return route.handler
}

type QueuedResult = { data?: unknown; error?: unknown }

/** Minimal chainable service-client mock (same pattern as bankid-complete.test.ts). */
function mockServiceClient(fromResults: QueuedResult[], appMetadata: Record<string, unknown>) {
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
    from: vi.fn().mockImplementation(() => chain()),
    auth: { admin },
  }

  vi.mocked(createServiceClient).mockReturnValue(
    client as unknown as ReturnType<typeof createServiceClient>
  )

  return { admin, client }
}

const ctx = { userId: 'user-1' } as unknown as ExtensionContext

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BANKID_ENCRYPTION_KEY', TEST_KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /bankid/unlink', () => {
  it('returns 401 without an authenticated context', async () => {
    mockServiceClient([], {})
    const req = createMockRequest('/api/extensions/ext/tic/bankid/unlink', { method: 'POST' })
    const { status } = await parseJsonResponse(await findHandler('POST', '/bankid/unlink')(req))
    expect(status).toBe(401)
  })

  it('merges app_metadata instead of replacing it — has_password must survive unlink', async () => {
    // A BankID-only user: has_password false. Wiping it would make
    // userHasPassword() infer TRUE (bankid_linked false ⇒ password assumed),
    // hiding the set-password escape hatch from a user with no login method.
    const { admin } = mockServiceClient(
      [{ error: null }], // bankid_identities delete OK
      { has_password: false, bankid_linked: true, provider: 'email' }
    )

    const req = createMockRequest('/api/extensions/ext/tic/bankid/unlink', { method: 'POST' })
    const { status, body } = await parseJsonResponse<{ data?: { unlinked?: boolean } }>(
      await findHandler('POST', '/bankid/unlink')(req, ctx)
    )

    expect(status).toBe(200)
    expect(body.data?.unlinked).toBe(true)
    expect(admin.updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: false, provider: 'email', bankid_linked: false },
    })
  })

  it('returns 500 when the identity delete fails and does not touch app_metadata', async () => {
    const { admin } = mockServiceClient(
      [{ error: { message: 'delete boom', code: 'XX000' } }],
      { has_password: false, bankid_linked: true }
    )

    const req = createMockRequest('/api/extensions/ext/tic/bankid/unlink', { method: 'POST' })
    const { status } = await parseJsonResponse(
      await findHandler('POST', '/bankid/unlink')(req, ctx)
    )

    expect(status).toBe(500)
    expect(admin.updateUserById).not.toHaveBeenCalled()
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

  it('merges app_metadata so an existing has_password: true survives linking', async () => {
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
      body: { sessionId: 'test-session' },
    })
    const { status, body } = await parseJsonResponse<{ data?: { linked?: boolean } }>(
      await findHandler('POST', '/bankid/link')(req, ctx)
    )

    expect(status).toBe(200)
    expect(body.data?.linked).toBe(true)
    expect(admin.updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { has_password: true, bankid_linked: true },
    })
  })

  it('returns 409 already_linked when the personnummer belongs to another user', async () => {
    vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
    const { admin } = mockServiceClient(
      [{ data: { user_id: 'someone-else' } }],
      { has_password: true }
    )

    const req = createMockRequest('/api/extensions/ext/tic/bankid/link', {
      method: 'POST',
      body: { sessionId: 'test-session' },
    })
    const { status, body } = await parseJsonResponse<{ error?: string }>(
      await findHandler('POST', '/bankid/link')(req, ctx)
    )

    expect(status).toBe(409)
    expect(body.error).toBe('already_linked')
    expect(admin.updateUserById).not.toHaveBeenCalled()
  })
})
