import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'

// Nothing may reach the bank or the session RPC while Enable Banking is
// closed to new connections: both are stubbed so the test can prove it.
vi.mock('../lib/jwt', () => ({ getAuthorizationHeader: () => 'Bearer test-token', hasSigningCredentials: () => true }))
vi.mock('@/lib/entitlements/has-capability', () => ({ requireCapability: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('../lib/open-payments-sibling', () => ({
  findOpenPaymentsSibling: vi.fn().mockResolvedValue({ id: 'op-1', bank_name: 'SEB', status: 'active' }),
  openPaymentsSiblingMessage: () => 'SEB läses redan genom den nya kopplingen.',
}))
vi.mock('@/lib/cash-accounts/configuration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cash-accounts/configuration')>()),
  attachSharedBankSession: vi.fn(),
}))

import { enableBankingExtension } from '../index'
import { findOpenPaymentsSibling } from '../lib/open-payments-sibling'
import { attachSharedBankSession } from '@/lib/cash-accounts/configuration'

const connectRoute = enableBankingExtension.apiRoutes!.find((r) => r.method === 'POST' && r.path === '/connect')!
const attachRoute = enableBankingExtension.apiRoutes!.find((r) => r.method === 'POST' && r.path === '/attach')!

function makeContext(row: Record<string, unknown> | null = null): ExtensionContext & { updates: Mock } {
  const updates = vi.fn()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  for (const method of ['select', 'eq', 'neq', 'or', 'in', 'is', 'limit', 'order']) chain[method] = vi.fn(() => chain)
  chain.single = vi.fn().mockResolvedValue({ data: row, error: row ? null : { message: 'not found' } })
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null })
  for (const method of ['update', 'insert', 'delete', 'upsert']) {
    chain[method] = vi.fn((payload: unknown) => {
      updates({ method, payload })
      return chain
    })
  }
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    supabase: { from: vi.fn(() => chain), rpc: vi.fn() } as never,
    emit: vi.fn().mockResolvedValue(undefined),
    settings: { get: vi.fn(), set: vi.fn(), getAll: vi.fn() } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    services: {} as never,
    updates,
  }
}

const post = (path: string, body: Record<string, unknown>) =>
  new Request(`http://localhost/api/extensions/ext/enable-banking${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const fetchSpy = vi.spyOn(globalThis, 'fetch')

describe('Enable Banking takes no new connection once the switch campaign is on', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy.mockImplementation(() => {
      throw new Error('no request may reach Enable Banking')
    })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('refuses a fresh connect to a bank the new provider reaches with 409 ENABLE_BANKING_CLOSED, pointing at Kopplingar', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-11-30')
    const ctx = makeContext()
    const res = await connectRoute.handler(post('/connect', { aspsp_name: 'SEB', aspsp_country: 'SE' }), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      code: 'ENABLE_BANKING_CLOSED',
      error: 'Den gamla bankkopplingen tar inte emot nya kopplingar. Koppla SEB med BankID under Kopplingar i stället, så hämtas transaktionerna genom den nya leverantören.',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ctx.updates).not.toHaveBeenCalled()
  })

  it('refuses a fresh connect to a bank the new provider does not reach, pointing at the file import', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-11-30')
    const res = await connectRoute.handler(post('/connect', { aspsp_name: 'Wise', aspsp_country: 'SE' }), makeContext())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(
      'Den gamla bankkopplingen tar inte emot nya kopplingar. Wise nås inte av den nya leverantören: importera kontoutdrag därifrån som fil under Importera, Bankfil.',
    )
  })

  it('refuses a renewal of an existing row by its stored bank, before its session is touched', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-11-30')
    const ctx = makeContext({ id: 'conn-1', bank_name: 'Handelsbanken', provider: 'handelsbanken-se', session_id: 'sess-1', psu_type: 'business' })
    const res = await connectRoute.handler(post('/connect', { connection_id: 'conn-1' }), ctx)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('ENABLE_BANKING_CLOSED')
    expect(body.error).toContain('Koppla Handelsbanken med BankID under Kopplingar')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ctx.updates).not.toHaveBeenCalled()
  })

  it('refuses reusing a session held for another company', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-11-30')
    const res = await attachRoute.handler(post('/attach', { connection_id: '11111111-1111-4111-8111-111111111111' }), makeContext())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('ENABLE_BANKING_CLOSED')
    expect(attachSharedBankSession).not.toHaveBeenCalled()
  })

  it('lets a connect through to its usual checks while there is no switch campaign', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '')
    const res = await connectRoute.handler(post('/connect', { aspsp_name: 'SEB', aspsp_country: 'SE' }), makeContext())
    // The next check after the closed door: the bank is already read through the new connection.
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('OPEN_PAYMENTS_CONNECTION_EXISTS')
    expect(findOpenPaymentsSibling).toHaveBeenCalled()
  })
})
