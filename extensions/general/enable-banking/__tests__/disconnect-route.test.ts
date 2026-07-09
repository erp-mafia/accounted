import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Enable Banking API client so revoking the PSD2 session never makes
// a network call. SessionExpiredError must stay a real class: index.ts uses it
// in an instanceof check.
vi.mock('../lib/api-client', () => ({
  startAuthorization: vi.fn(),
  getASPSPs: vi.fn(),
  getPreferredAuthMethod: vi.fn(),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  isSandboxMode: vi.fn(() => true),
  SessionExpiredError: class SessionExpiredError extends Error {},
}))

import { enableBankingExtension } from '../index'
import { deleteSession } from '../lib/api-client'
import type { ExtensionContext } from '@/lib/extensions/types'

const mockedDeleteSession = vi.mocked(deleteSession)

const disconnectRoute = enableBankingExtension.apiRoutes?.find(
  r => r.method === 'DELETE' && r.path === '/disconnect'
)

if (!disconnectRoute) {
  throw new Error('DELETE /disconnect route not registered on enable-banking extension')
}

interface DisconnectStub {
  authUser: { id: string } | null
  connectionRow: {
    id: string
    session_id: string | null
    status: string
    bank_name?: string | null
  } | null
  connectionError?: { message: string } | null
  connUpdateError?: { message: string } | null
  cashUpdateError?: { message: string } | null
  /** Captured bank_connections update payloads. */
  connUpdates: Array<Record<string, unknown>>
  /** Captured cash_accounts update payloads + their eq() filters, in order. */
  cashUpdates: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]> }>
}

function makeStub(partial: Partial<DisconnectStub> = {}): DisconnectStub {
  return {
    authUser: { id: 'user-1' },
    connectionRow: {
      id: 'conn-1',
      session_id: 'sess-1',
      status: 'active',
      bank_name: 'Lunar',
    },
    connUpdates: [],
    cashUpdates: [],
    ...partial,
  }
}

function buildSupabase(stub: DisconnectStub) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: stub.authUser }, error: null }),
    },
    from: vi.fn((table: string) => {
      if (table === 'cash_accounts') {
        return {
          update: vi.fn((payload: Record<string, unknown>) => {
            const filters: Array<[string, unknown]> = []
            stub.cashUpdates.push({ payload, filters })
            const result = Promise.resolve({ error: stub.cashUpdateError ?? null })
            const builder = {
              eq: vi.fn((col: string, val: unknown) => {
                filters.push([col, val])
                return builder
              }),
              then: result.then.bind(result),
              catch: result.catch.bind(result),
            }
            return builder
          }),
        }
      }
      // bank_connections
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: stub.connectionRow,
          error: stub.connectionError ?? null,
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
          stub.connUpdates.push(payload)
          return { eq: vi.fn().mockResolvedValue({ error: stub.connUpdateError ?? null }) }
        }),
      }
    }),
  }
}

function makeContext(supabase: ReturnType<typeof buildSupabase>): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    emit: vi.fn().mockResolvedValue(undefined),
    settings: { get: vi.fn(), set: vi.fn(), getAll: vi.fn() } as never,
    storage: {} as never,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    services: {} as never,
  }
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/extensions/ext/enable-banking/disconnect', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('DELETE /disconnect (enable-banking)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedDeleteSession.mockResolvedValue(undefined)
  })

  it('returns 401 when unauthenticated', async () => {
    const stub = makeStub({ authUser: null })
    const ctx = makeContext(buildSupabase(stub))

    const res = await disconnectRoute.handler(makeRequest({ connection_id: 'conn-1' }), ctx)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the connection is not found', async () => {
    const stub = makeStub({ connectionRow: null, connectionError: { message: 'not found' } })
    const ctx = makeContext(buildSupabase(stub))

    const res = await disconnectRoute.handler(makeRequest({ connection_id: 'conn-1' }), ctx)
    expect(res.status).toBe(404)
  })

  it('revokes the connection AND releases its cash_accounts ledger claims (issue #916)', async () => {
    const stub = makeStub()
    const ctx = makeContext(buildSupabase(stub))

    const res = await disconnectRoute.handler(makeRequest({ connection_id: 'conn-1' }), ctx)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // PSD2 consent revoked upstream.
    expect(mockedDeleteSession).toHaveBeenCalledWith('sess-1')

    // Connection marked revoked.
    expect(stub.connUpdates).toEqual([{ status: 'revoked', session_id: null }])

    // The connection's cash_accounts rows are demoted to manual (NOT deleted):
    // transactions and ledger history reference them, and upsertFromPsd2
    // promotes manual holders in place on reconnect so the same bank lands
    // back on its original BAS account.
    expect(stub.cashUpdates).toHaveLength(1)
    expect(stub.cashUpdates[0].payload).toEqual({ bank_connection_id: null })
    expect(stub.cashUpdates[0].filters).toEqual([
      ['company_id', 'company-1'],
      ['bank_connection_id', 'conn-1'],
    ])

    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bank_connection.revoked',
        payload: expect.objectContaining({ connectionId: 'conn-1', companyId: 'company-1' }),
      })
    )
  })

  it('still succeeds when the ledger claim release fails (self-heal covers it)', async () => {
    // The connection is already revoked at that point; the allocator and the
    // picker-save collision guard both skip revoked connections, so orphaned
    // rows recover on the next picker save.
    const stub = makeStub({ cashUpdateError: { message: 'transient' } })
    const ctx = makeContext(buildSupabase(stub))

    const res = await disconnectRoute.handler(makeRequest({ connection_id: 'conn-1' }), ctx)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.stringContaining('release cash_accounts'),
      expect.objectContaining({ connectionId: 'conn-1' })
    )
  })

  it('skips PSD2 session revocation when the connection has no session', async () => {
    const stub = makeStub({
      connectionRow: { id: 'conn-1', session_id: null, status: 'expired', bank_name: 'Lunar' },
    })
    const ctx = makeContext(buildSupabase(stub))

    const res = await disconnectRoute.handler(makeRequest({ connection_id: 'conn-1' }), ctx)

    expect(res.status).toBe(200)
    expect(mockedDeleteSession).not.toHaveBeenCalled()
    // Ledger claims are still released.
    expect(stub.cashUpdates).toHaveLength(1)
  })
})
