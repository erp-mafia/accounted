/**
 * gnubok_reject_pending_operation through the real MCP dispatcher
 * (handleMcpRequest), not execute(): the scope gate with its alternative
 * scopes, the operation-company routing, the company write gate, and the
 * injection of the key's scopes that the tool's per-operation rule reads
 * (founder decision 2026-10-03, follow-up to #3408).
 *
 * The tool refuses an API-key caller whose scopes were not injected, so
 * without the dispatcher's injection every MCP reject would fail, for an
 * approve key as much as for a write key. Tests that call execute() with a
 * hand-filled __keyScopes cannot see that; these can.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  companyId: '11111111-1111-4111-8111-111111111111',
  operation: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  // Fully chainable and awaitable: every call returns the chain, awaiting it
  // resolves to `result()`.
  const chain = (result: () => unknown): unknown => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result())
          return () => proxy
        },
      },
    )
    return proxy
  }
  // pending_operations: a read answers with db.operation (the routing lookup
  // and the reject tool's fetch), an update records its payload and answers
  // with the claimed row.
  const pendingOperations = (): unknown => {
    let updating = false
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              if (updating) resolve({ data: db.operation ? [{ id: db.operation.id }] : [], error: null })
              else if (db.operation) resolve({ data: db.operation, error: null })
              else resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
            }
          }
          return (...args: unknown[]) => {
            if (prop === 'update') {
              updating = true
              db.updates.push(args[0] as Record<string, unknown>)
            }
            return proxy
          }
        },
      },
    )
    return proxy
  }
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(() => ({
      from: (table: string) => {
        if (table === 'company_members') {
          return chain(() => ({ data: { company_id: db.companyId, role: 'owner' }, error: null }))
        }
        if (table === 'pending_operations') return pendingOperations()
        return chain(() => ({ data: [], error: null, count: 0 }))
      },
      rpc: () => chain(() => ({ data: null, error: null })),
    })),
  }
})

import { handleMcpRequest } from '../server'
import { validateApiKey } from '@/lib/auth/api-keys'

const KEY = 'a1a1a1a1-0000-4000-8000-000000000001'
const OTHER_KEY = 'b2b2b2b2-0000-4000-8000-000000000002'
const OPERATION_ID = '0e5f0000-0000-4000-8000-000000000001'

const WRITE_KEY = ['pending_operations:read', 'transactions:read', 'transactions:write']
const APPROVE_KEY = ['pending_operations:read', 'pending_operations:approve']

function useKey(scopes: string[]) {
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: 'user-1',
    companyId: db.companyId,
    scopes,
    apiKeyId: KEY,
    apiKeyName: 'Claude',
  } as never)
}

function stagedBy(actorType: string, actorId: string | null, extra: Record<string, unknown> = {}) {
  db.operation = {
    id: OPERATION_ID,
    company_id: db.companyId,
    status: 'pending',
    operation_type: 'categorize_transaction',
    risk_level: 'low',
    actor_type: actorType,
    actor_id: actorId,
    actor_label: actorType === 'api_key' ? 'Claude' : null,
    ...extra,
  }
}

async function reject(): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown>; error?: Record<string, unknown> }> {
  const request = new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'gnubok_reject_pending_operation', arguments: { operation_id: OPERATION_ID } },
    }),
  })
  const { result } = await (await handleMcpRequest(request)).json()
  if (result.isError) return { isError: true, error: JSON.parse(result.content[0].text).error }
  return { structuredContent: result.structuredContent }
}

describe('gnubok_reject_pending_operation through the dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.operation = null
    db.updates = []
  })

  it('a write key without approve rejects the proposal it staged itself', async () => {
    useKey(WRITE_KEY)
    stagedBy('api_key', KEY)
    const res = await reject()
    expect(res.isError).toBeUndefined()
    expect(res.structuredContent).toMatchObject({ status: 'rejected', operation_id: OPERATION_ID })
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0]).toMatchObject({ status: 'rejected', result_data: { rejected_via: 'api_key', actor_id: KEY } })
  })

  it('the same key is refused on another connection\'s proposal, and nothing is updated', async () => {
    useKey(WRITE_KEY)
    stagedBy('api_key', OTHER_KEY)
    const res = await reject()
    expect(res.isError).toBe(true)
    expect(res.error?.code).toBe('INSUFFICIENT_SCOPE')
    expect(String(res.error?.message_en ?? res.error?.message)).toContain('staged by another connection')
    expect(db.updates).toHaveLength(0)
  })

  it('the same key is refused on a proposal a person made in the app', async () => {
    useKey(WRITE_KEY)
    stagedBy('user', null)
    const res = await reject()
    expect(res.isError).toBe(true)
    expect(res.error?.code).toBe('INSUFFICIENT_SCOPE')
    expect(String(res.error?.message_en ?? res.error?.message)).toContain('a person in Accounted')
    expect(db.updates).toHaveLength(0)
  })

  it('a key with approve still rejects anyone\'s proposal', async () => {
    useKey(APPROVE_KEY)
    stagedBy('user', null)
    const res = await reject()
    expect(res.isError).toBeUndefined()
    expect(res.structuredContent).toMatchObject({ status: 'rejected' })
    expect(db.updates).toHaveLength(1)
  })

  it('a key whose only write scope is agent:write withdraws its own fact proposal', async () => {
    useKey(['agent:read', 'agent:write'])
    stagedBy('api_key', KEY, { operation_type: 'arkiv_propose_fact' })
    const res = await reject()
    expect(res.isError).toBeUndefined()
    expect(res.structuredContent).toMatchObject({ status: 'rejected' })
    expect(db.updates).toHaveLength(1)
  })

  it('a read-only key is refused at the scope gate before the operation is read', async () => {
    useKey(['pending_operations:read'])
    stagedBy('api_key', KEY)
    const res = await reject()
    expect(res.isError).toBe(true)
    expect(res.error?.code).toBe('INSUFFICIENT_SCOPE')
    expect(db.updates).toHaveLength(0)
  })
})
