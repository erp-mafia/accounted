import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const auth = vi.fn()
const write = vi.fn()
const browser = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => auth(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => write(...args),
}))
vi.mock('@/lib/bank-browser/client', () => ({ bankBrowserConfigured: () => true,
  bankBrowserOriginAllowed: (request: Request) => request.headers.get('origin') === 'https://accounted-dev.example.test',
  bankBrowserRequest: (...args: unknown[]) => browser(...args),
}))
import { GET as available, POST as start } from '../route'
import { GET as status, DELETE as cancel } from '../[id]/route'
import { GET as resource, POST as action } from '../[id]/[resource]/route'

const id = '11111111-1111-4111-8111-111111111111'
const origin = 'https://accounted-dev.example.test'
const params = (resource?: string, value = id) => ({ params: Promise.resolve({ id: value, ...(resource ? { resource } : {}) }) })
const request = (method = 'GET', body?: unknown, requestOrigin = origin) => new Request(`${origin}/api/import/northmill`, {
  method, headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})
beforeEach(() => {
  vi.clearAllMocks(); reset()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', origin)
  auth.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  write.mockResolvedValue({ ok: true })
  browser.mockImplementation(() => Promise.resolve(Response.json({ id })))
})
describe('Northmill browser routes', () => {
  it('requires an authenticated session', async () => {
    auth.mockResolvedValue({ error: Response.json({ error: 'unauthorized' }, { status: 401 }) })
    expect((await available(request(), params())).status).toBe(401)
    expect(browser).not.toHaveBeenCalled()
  })
  it('refuses viewers even on screenshot and file reads', async () => {
    write.mockResolvedValue({ ok: false, response: Response.json({ error: 'forbidden' }, { status: 403 }) })
    expect((await resource(request(), params('screen'))).status).toBe(403)
    expect((await resource(request(), params('file'))).status).toBe(403)
    expect(browser).not.toHaveBeenCalled()
  })
  it('starts with the resolved user, company and stored organization number', async () => {
    enqueue({ data: { org_number: '556677-8899' }, error: null })
    expect((await start(request('POST'), params())).status).toBe(200)
    expect(browser).toHaveBeenCalledWith('company-1', 'user-1', '/sessions', 'POST', { organizationNumber: '5566778899' })
  })
  it('refuses a foreign origin before creating a bank session', async () => {
    expect((await start(request('POST', {}, 'https://evil.test'), params())).status).toBe(403)
    expect(browser).not.toHaveBeenCalled()
  })
  it('requires a known organization number', async () => {
    enqueue({ data: { org_number: null }, error: null })
    expect((await start(request('POST'), params())).status).toBe(400)
    expect(browser).not.toHaveBeenCalled()
  })
  it('refuses malformed session ids and unsupported resources', async () => {
    expect((await status(request(), params(undefined, '../other'))).status).toBe(400)
    expect((await resource(request(), params('cookies'))).status).toBe(404)
    expect(browser).not.toHaveBeenCalled()
  })
  it('forwards scoped reads and cancellation without trusting request identity', async () => {
    await status(request(), params())
    expect(browser).toHaveBeenLastCalledWith('company-1', 'user-1', `/sessions/${id}`)
    await resource(request(), params('screen'))
    expect(browser).toHaveBeenLastCalledWith('company-1', 'user-1', `/sessions/${id}/screen`)
    await cancel(request('DELETE'), params())
    expect(browser).toHaveBeenLastCalledWith('company-1', 'user-1', `/sessions/${id}`, 'DELETE')
  })
  it('does not accept arbitrary browser commands, selectors or URLs', async () => {
    for (const body of [{ type: 'click', x: 1, y: 2 }, { type: 'navigate', id: 'a'.repeat(24), url: 'https://evil.test' }, { type: 'export', companyId: 'foreign' }]) {
      expect((await action(request('POST', body), params('action'))).status).toBe(400)
    }
    expect(browser).not.toHaveBeenCalled()
  })
  it('forwards the permitted export action and preserves a missing session', async () => {
    browser.mockResolvedValue(Response.json({ error: 'NOT_FOUND' }, { status: 404 }))
    expect((await action(request('POST', { type: 'export' }), params('action'))).status).toBe(404)
    expect(browser).toHaveBeenLastCalledWith('company-1', 'user-1', `/sessions/${id}/action`, 'POST', { type: 'export' })
  })
})
