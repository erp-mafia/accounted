import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/api-client', () => ({
  startAuthorization: vi.fn(), getASPSPs: vi.fn(), getPreferredAuthMethod: vi.fn(),
  getPreferredAuthMethodDetails: vi.fn(), deleteSession: vi.fn().mockResolvedValue(undefined),
  isSandboxMode: vi.fn(() => true), SessionExpiredError: class SessionExpiredError extends Error {},
}))
const { serviceRpc, steps } = vi.hoisted(() => ({ serviceRpc: vi.fn(), steps: [] as string[] }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(), createServiceClient: vi.fn(async () => ({ rpc: serviceRpc })),
}))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }))

import { enableBankingExtension } from '../index'
import { deleteSession } from '../lib/api-client'
import type { ExtensionContext } from '@/lib/extensions/types'

const route = enableBankingExtension.apiRoutes!.find(r => r.method === 'DELETE' && r.path === '/disconnect')!
const connectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const receipt = { connection_id: connectionId, session_id: 'released-session', bank_name: 'Test bank', released_cash_accounts: 2 }

function setup(options: { user?: boolean; readError?: object; disconnectError?: object; noSession?: boolean; status?: string } = {}) {
  const rpc = vi.fn(async (name: string) => {
    steps.push(name)
    if (name === 'read_bank_configuration') return {
      data: { token: 'checked-token', connection: { id: connectionId, session_id: 'observed-session', status: options.status ?? 'active', bank_name: 'Test bank' } },
      error: options.readError ?? null,
    }
    if (name === 'disconnect_bank_connection') return {
      data: { ...receipt, ...(options.noSession ? { session_id: null } : {}) }, error: options.disconnectError ?? null,
    }
    throw new Error(`Unexpected RPC ${name}`)
  })
  const supabase = {
    auth: { getUser: vi.fn(async () => ({ data: { user: options.user === false ? null : { id: 'user-1' } } })) },
    rpc, from: vi.fn(() => { throw new Error('Disconnect must use one atomic RPC') }),
  }
  const ctx = {
    userId: 'user-1', companyId: 'company-1', extensionId: 'enable-banking', requestId: 'test', supabase,
    emit: vi.fn(async () => { steps.push('emit') }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as ExtensionContext
  return { rpc, ctx }
}
function request(body: unknown = { connection_id: connectionId }) {
  return new Request('http://localhost/disconnect', { method: 'DELETE', body: JSON.stringify(body) })
}

beforeEach(() => {
  vi.clearAllMocks(); steps.length = 0
  vi.mocked(deleteSession).mockImplementation(async () => { steps.push('provider') })
  serviceRpc.mockImplementation(async (name: string) => {
    steps.push(name)
    return { data: name === 'claim_bank_session_revocation' ? { claimed: true, token: 'claim-token' } : true, error: null }
  })
})

describe('atomic disconnect route', () => {
  it('commits both database changes before claiming and revoking the exact released consent', async () => {
    const { rpc, ctx } = setup()
    const result = await route.handler(request(), ctx)
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ success: true })
    expect(rpc).toHaveBeenNthCalledWith(2, 'disconnect_bank_connection', {
      p_company_id: 'company-1', p_user_id: 'user-1', p_connection_id: connectionId, p_expected_token: 'checked-token',
    })
    expect(deleteSession).toHaveBeenCalledWith('released-session')
    expect(steps).toEqual(['read_bank_configuration', 'disconnect_bank_connection',
      'claim_bank_session_revocation', 'provider', 'finish_bank_session_revocation', 'emit'])
    expect(ctx.emit).toHaveBeenCalledWith({ type: 'bank_connection.revoked', payload: {
      connectionId, bankName: 'Test bank', userId: 'user-1', companyId: 'company-1',
    } })
  })

  it.each([
    ['stale configuration', { code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED' }, 409],
    ['cash release failure', { code: 'XX000', message: 'release failed' }, 500],
    ['actor denial', { code: '42501', message: 'BANK_DISCONNECT_ACTOR_DENIED' }, 403],
  ])('refuses %s without provider calls or events', async (_label, error, status) => {
    const { ctx } = setup({ disconnectError: error })
    expect((await route.handler(request(), ctx)).status).toBe(status)
    expect(serviceRpc).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalled()
    expect(ctx.emit).not.toHaveBeenCalled()
  })

  it('returns 401 before reading when unauthenticated', async () => {
    const { rpc, ctx } = setup({ user: false })
    expect((await route.handler(request(), ctx)).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([{}, { connection_id: 1 }, { connection_id: 'invalid' }, null])('returns 400 for invalid input %j', async body => {
    const { rpc, ctx } = setup()
    expect((await route.handler(request(body), ctx)).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON', async () => {
    const { rpc, ctx } = setup()
    expect((await route.handler(new Request('http://localhost/disconnect', { method: 'DELETE', body: '{' }), ctx)).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 400 without company context', async () => {
    const { rpc, ctx } = setup(); ctx.companyId = ''
    expect((await route.handler(request(), ctx)).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing or invisible connection', async () => {
    const { ctx } = setup({ readError: { code: 'P0002', message: 'BANK_CONNECTION_NOT_FOUND' } })
    expect((await route.handler(request(), ctx)).status).toBe(404)
    expect(serviceRpc).not.toHaveBeenCalled()
  })

  it('does not disguise a failed snapshot read as missing', async () => {
    const { ctx } = setup({ readError: { code: 'XX000', message: 'read failed' } })
    expect((await route.handler(request(), ctx)).status).toBe(500)
    expect(serviceRpc).not.toHaveBeenCalled()
  })

  it.each(['shared', 'in-progress'])('leaves a %s consent untouched after committing the local disconnect', async reason => {
    serviceRpc.mockResolvedValue({ data: { claimed: false, reason }, error: null })
    const { ctx } = setup()
    expect((await route.handler(request(), ctx)).status).toBe(200)
    expect(deleteSession).not.toHaveBeenCalled()
    expect(ctx.emit).toHaveBeenCalledOnce()
  })

  it('keeps a pending-selection disconnect when the provider session is already closed', async () => {
    vi.mocked(deleteSession).mockRejectedValue(new Error('Failed to revoke session (400): CLOSED_SESSION'))
    const { ctx } = setup({ status: 'pending_selection' })
    expect((await route.handler(request(), ctx)).status).toBe(200)
    expect(steps.indexOf('disconnect_bank_connection')).toBeLessThan(steps.indexOf('claim_bank_session_revocation'))
    expect(deleteSession).toHaveBeenCalledWith('released-session')
    expect(ctx.log.warn).toHaveBeenCalledOnce()
    expect(ctx.log.error).not.toHaveBeenCalled()
  })

  it('keeps the committed disconnect when the provider fails and records that failure', async () => {
    vi.mocked(deleteSession).mockRejectedValue(new Error('provider unavailable'))
    const { ctx } = setup()
    expect((await route.handler(request(), ctx)).status).toBe(200)
    expect(serviceRpc).toHaveBeenLastCalledWith('finish_bank_session_revocation', {
      p_provider: 'enablebanking', p_session_id: 'released-session', p_claim_token: 'claim-token', p_succeeded: false,
    })
    expect(ctx.log.warn).toHaveBeenCalledOnce()
    expect(ctx.emit).toHaveBeenCalledOnce()
  })

  it('never calls the provider if the all-company claim fails', async () => {
    serviceRpc.mockResolvedValue({ data: null, error: { code: 'PT409', message: 'BANK_SESSION_BUSY' } })
    const { ctx } = setup()
    expect((await route.handler(request(), ctx)).status).toBe(200)
    expect(deleteSession).not.toHaveBeenCalled()
    expect(ctx.log.warn).toHaveBeenCalledOnce()
  })

  it('skips upstream work when the committed disconnect released no session', async () => {
    const { ctx } = setup({ noSession: true })
    expect((await route.handler(request(), ctx)).status).toBe(200)
    expect(serviceRpc).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalled()
  })
})
