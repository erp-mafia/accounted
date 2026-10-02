import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'

const { serviceRpc, capability, rateLimit, steps } = vi.hoisted(() => ({
  serviceRpc: vi.fn(), capability: vi.fn(), rateLimit: vi.fn(), steps: [] as string[],
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: async () => ({ rpc: serviceRpc }) }))
vi.mock('@/lib/entitlements/has-capability', () => ({ requireCapability: capability }))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: rateLimit }))
vi.mock('../lib/api-client', () => ({
  startAuthorization: vi.fn(), getASPSPs: vi.fn(), getPreferredAuthMethodDetails: vi.fn(),
  isSandboxMode: () => true, SessionExpiredError: class extends Error {},
}))
import { enableBankingExtension } from '../index'
const route = enableBankingExtension.apiRoutes!.find(r => r.method === 'POST' && r.path === '/attach')!
const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const receipt = { connection_id: 'new-connection', account_count: 2, bank_name: 'Test bank', consent_expires: '2027-01-01T00:00:00Z' }
function setup(user = true) {
  const ctx = { companyId: 'company', userId: 'user', extensionId: 'enable-banking', requestId: 'test',
    supabase: { auth: { getUser: vi.fn(async () => ({ data: { user: user ? { id: 'user' } : null } })) },
      from: vi.fn(() => { throw new Error('Attachment must use the checked transaction') }) },
    emit: vi.fn(async () => { steps.push('emit') }), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as ExtensionContext
  return ctx
}
function request(body: unknown = { connection_id: sourceId }) {
  return new Request('http://localhost/attach', { method: 'POST', body: JSON.stringify(body) })
}
beforeEach(() => {
  vi.clearAllMocks(); steps.length = 0; capability.mockResolvedValue(null); rateLimit.mockResolvedValue({ ok: true })
  serviceRpc.mockImplementation(async () => { steps.push('commit'); return { data: receipt, error: null } })
})
describe('checked shared-session attachment route', () => {
  it('inserts through one actor-scoped transaction and emits only after its receipt', async () => {
    const ctx = setup(); const response = await route.handler(request(), ctx)
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ connection_id: 'new-connection', account_count: 2 })
    expect(serviceRpc).toHaveBeenCalledExactlyOnceWith('attach_shared_bank_session', {
      p_company_id: 'company', p_user_id: 'user', p_source_connection_id: sourceId,
    })
    expect(ctx.supabase.from).not.toHaveBeenCalled(); expect(steps).toEqual(['commit','emit'])
    expect(ctx.emit).toHaveBeenCalledWith({ type: 'bank_connection.consent_granted', payload: {
      connectionId: receipt.connection_id, bankName: receipt.bank_name, accountCount: 2,
      consentExpiresAt: receipt.consent_expires, userId: 'user', companyId: 'company',
    } })
  })
  it.each([['P0002',404],['PT409',409],['42501',403],['XX000',500]])('maps %s refusal without success events', async (code, status) => {
    serviceRpc.mockResolvedValue({ data: null, error: { code, message: 'Attachment refused' } })
    const ctx = setup(); expect((await route.handler(request(), ctx)).status).toBe(status); expect(ctx.emit).not.toHaveBeenCalled()
  })
  it('returns 401 before any business read when anonymous', async () => {
    expect((await route.handler(request(), setup(false))).status).toBe(401)
    expect(capability).not.toHaveBeenCalled(); expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('requires company context', async () => {
    const ctx = setup(); ctx.companyId = ''
    expect((await route.handler(request(), ctx)).status).toBe(400); expect(serviceRpc).not.toHaveBeenCalled()
  })
  it.each([{}, null, { connection_id: 1 }, { connection_id: 'invalid' }])('rejects invalid input %j', async body => {
    expect((await route.handler(request(body), setup())).status).toBe(400); expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('rejects malformed JSON', async () => {
    expect((await route.handler(new Request('http://localhost/attach', { method: 'POST', body: '{' }), setup())).status).toBe(400)
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it.each(['capability', 'rate-limit'])('honors the %s gate before attachment', async gate => {
    if (gate === 'capability') capability.mockResolvedValue(new Response(null, { status: 403 }))
    else rateLimit.mockResolvedValue({ ok: false, response: new Response(null, { status: 429 }) })
    expect((await route.handler(request(), setup())).status).toBe(gate === 'capability' ? 403 : 429)
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('rejects a missing receipt without emitting success', async () => {
    serviceRpc.mockResolvedValue({ data: null, error: null }); const ctx = setup()
    expect((await route.handler(request(), ctx)).status).toBe(500); expect(ctx.emit).not.toHaveBeenCalled()
  })
  it('keeps committed attachment successful when the audit handler fails', async () => {
    const ctx = setup(); vi.mocked(ctx.emit).mockRejectedValue(new Error('Audit unavailable'))
    expect((await route.handler(request(), ctx)).status).toBe(200); expect(ctx.log.error).toHaveBeenCalled()
  })
})
