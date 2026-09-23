import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createQueuedMockSupabase } from '@/tests/helpers'
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ rpc }) }))
import { invoiceCompletionRoutes } from '../invoice-completion-routes'

const consentId = '12c476cf-8852-4010-b42e-23cb568ab1de'
const blockId = 'c2599eb7-ae64-4b39-89e5-86d5aef75256'
const route = (method: string) => invoiceCompletionRoutes.find(r => r.method === method)!.handler
const request = (body: unknown) => new Request('https://example.test/retry', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
function context(role: string | null = 'owner') {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: role ? { role } : null })
  return { ...mock, ctx: { supabase: mock.supabase, companyId: 'company', userId: 'user', log: { error: vi.fn() } } as unknown as ExtensionContext }
}
beforeEach(() => vi.resetAllMocks())
describe('invoice completion recovery API', () => {
  it.each(['GET', 'POST'])('requires an authenticated company for %s', async method => {
    expect((await route(method)(request({ consentId, blockId }))).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })
  it.each([{ consentId }, { consentId, blockId: 'invalid' }, { consentId, blockId, companyId: 'foreign' }])('rejects invalid or extended input', async body => {
    expect((await route('POST')(request(body), context().ctx)).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('returns 404 for an inaccessible consent', async () => {
    const { ctx, enqueue } = context(); enqueue({ data: null })
    expect((await route('POST')(request({ consentId, blockId }), ctx)).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
  it.each(['viewer', null])('rejects a caller without write access (%s) before looking up credentials', async role => {
    const { ctx, findCall, findCalls } = context(role)
    expect((await route('POST')(request({ consentId, blockId }), ctx)).status).toBe(403)
    expect(findCalls('company_members', 'eq')).toEqual([['company_id', 'company'], ['user_id', 'user']])
    expect(findCall('provider_consents', 'select')).toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('queues only the saved completion work using the server company', async () => {
    const { ctx, enqueue } = context(); enqueue({ data: { id: consentId } })
    rpc.mockResolvedValue({ data: true, error: null })
    expect((await route('POST')(request({ consentId, blockId }), ctx)).status).toBe(202)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('retry_invoice_completion_work', {
      p_company_id: 'company', p_consent_id: consentId, p_block_id: blockId,
    })
  })
  it('does not report a stale retry as queued', async () => {
    const { ctx, enqueue } = context(); enqueue({ data: { id: consentId } })
    rpc.mockResolvedValue({ data: false, error: null })
    expect((await route('POST')(request({ consentId, blockId }), ctx)).status).toBe(409)
  })
  it('returns the persisted company status without caching it', async () => {
    rpc.mockResolvedValue({ data: { consentId, blockId, reason: 'PROVIDER_LICENSE_MISSING' }, error: null })
    const response = await route('GET')(new Request('https://example.test/status'), context().ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('invoice_completion_block_status', { p_company_id: 'company' })
  })
})
