import { beforeEach, describe, expect, it, vi } from 'vitest'

// An Open Payments connection (bank_connections.aggregator = 'open_payments')
// must never reach Enable Banking: not synced, reconfigured, renewed or
// revoked through this extension. Every lookup here filters on the
// aggregator; these tests pin the filter and what an Open Payments row gets.

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }))
vi.mock('../lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('../lib/api-client')>('../lib/api-client')
  return { ...actual, deleteSession: vi.fn(), startAuthorization: vi.fn(), getPreferredAuthMethodDetails: vi.fn() }
})
vi.mock('../lib/sync', () => ({ syncAccountTransactions: vi.fn() }))
const { serviceRpc } = vi.hoisted(() => ({ serviceRpc: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => ({ rpc: serviceRpc })),
}))

import { enableBankingExtension } from '../index'
import { deleteSession, startAuthorization } from '../lib/api-client'
import { syncAccountTransactions } from '../lib/sync'
import { findReusableSessions } from '../lib/session-sharing'
import { triggerConnectionSync } from '../lib/trigger-sync'
import type { ExtensionContext } from '@/lib/extensions/types'

const OP_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  company_id: 'company-1',
  aggregator: 'open_payments',
  status: 'active',
  bank_name: 'SEB',
  provider: 'open_payments',
  session_id: 'consent-1',
  accounts_data: [{ uid: 'ACC003', currency: 'SEK', enabled: true }],
}

/** A query builder that applies .eq() filters to one stored row, like the database would. */
function tableOf(rows: Record<string, unknown>[], calls: Array<[string, unknown]>) {
  return () => {
    const filters: Record<string, unknown> = {}
    const matching = () => rows.filter(row => Object.entries(filters).every(([col, value]) =>
      (col === 'aggregator' ? (row.aggregator ?? 'enable_banking') : row[col]) === value))
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'neq', 'in', 'not', 'gt', 'order', 'limit', 'range', 'is']) chain[m] = vi.fn(() => chain)
    chain.eq = vi.fn((col: string, value: unknown) => {
      calls.push([col, value])
      filters[col] = value
      return chain
    })
    chain.single = vi.fn(async () => {
      const [row] = matching()
      return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    })
    chain.maybeSingle = vi.fn(async () => ({ data: matching()[0] ?? null, error: null }))
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: matching(), error: null }).then(resolve)
    return chain
  }
}

function context(supabase: Record<string, unknown>): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    supabase: supabase as never,
    emit: vi.fn().mockResolvedValue(undefined),
    settings: { get: vi.fn(), set: vi.fn(), getAll: vi.fn() } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    services: {} as never,
  }
}

function route(method: string, path: string) {
  const found = enableBankingExtension.apiRoutes?.find(r => r.method === method && r.path === path)
  if (!found) throw new Error(`${method} ${path} missing`)
  return found
}

function request(method: string, body: unknown) {
  return new Request('http://localhost/api/extensions/ext/enable-banking', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const auth = { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }) }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('enable-banking never handles an Open Payments connection', () => {
  it('POST /sync answers 404 and fetches nothing', async () => {
    const calls: Array<[string, unknown]> = []
    const res = await route('POST', '/sync').handler(request('POST', { connection_id: OP_ROW.id }),
      context({ auth, from: vi.fn(tableOf([OP_ROW], calls)) }))
    expect(res.status).toBe(404)
    expect(calls).toContainEqual(['aggregator', 'enable_banking'])
    expect(syncAccountTransactions).not.toHaveBeenCalled()
  })

  it('POST /connect refuses to renew it', async () => {
    const calls: Array<[string, unknown]> = []
    const res = await route('POST', '/connect').handler(request('POST', { connection_id: OP_ROW.id }),
      context({ auth, from: vi.fn(tableOf([OP_ROW], calls)) }))
    expect(res.status).toBe(404)
    expect(startAuthorization).not.toHaveBeenCalled()
  })

  it('PATCH /accounts answers 404 before saving or backfilling', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'read_bank_configuration') {
        return { data: { token: 't', connection: { ...OP_ROW } }, error: null }
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    const res = await route('PATCH', '/accounts').handler(
      request('PATCH', { connection_id: OP_ROW.id, enabled_uids: ['ACC003'] }),
      context({ auth, rpc, from: vi.fn(() => { throw new Error('no table reads expected') }) }),
    )
    expect(res.status).toBe(404)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(syncAccountTransactions).not.toHaveBeenCalled()
  })

  it('DELETE /disconnect answers 404 and never revokes the consent at Enable Banking', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'read_bank_configuration') {
        return { data: { token: 't', connection: { ...OP_ROW } }, error: null }
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    const res = await route('DELETE', '/disconnect').handler(
      request('DELETE', { connection_id: OP_ROW.id }),
      context({ auth, rpc, from: vi.fn(() => { throw new Error('no table reads expected') }) }),
    )
    expect(res.status).toBe(404)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(serviceRpc).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('the agent-triggered sync reports NOT_FOUND so the core Open Payments runner can take it', async () => {
    const calls: Array<[string, unknown]> = []
    const result = await triggerConnectionSync({ from: vi.fn(tableOf([OP_ROW], calls)) } as never, {
      companyId: 'company-1', userId: 'user-1', connectionId: OP_ROW.id,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND', connection_id: OP_ROW.id })
    expect(calls).toContainEqual(['aggregator', 'enable_banking'])
  })

  it('never offers an Open Payments consent for session sharing', async () => {
    const calls: Array<[string, unknown]> = []
    const other = { ...OP_ROW, company_id: 'company-2', user_id: 'user-1', consent_expires: '2099-01-01T00:00:00Z' }
    const sessions = await findReusableSessions({ from: vi.fn(tableOf([other], calls)) } as never, 'user-1', 'company-1')
    expect(sessions).toEqual([])
    expect(calls).toContainEqual(['aggregator', 'enable_banking'])
  })
})
