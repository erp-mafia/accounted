import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { bankBrowserConfigured, bankBrowserRequest } from '../client'

afterEach(() => vi.unstubAllEnvs())
it('keeps the worker optional', async () => {
  vi.stubEnv('NORTHMILL_BROWSER_SOCKET', '')
  expect(bankBrowserConfigured()).toBe(false)
  expect((await bankBrowserRequest('company', 'user', '/sessions')).status).toBe(503)
})
it('sends identity over a private socket and only forwards safe response headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'accounted-northmill-'))
  const socket = join(dir, 'worker.sock')
  const token = 'a'.repeat(40)
  let owner: string | string[] | undefined
  let authorization: string | undefined
  const server = createServer((req, res) => {
    owner = req.headers['x-session-owner']; authorization = req.headers.authorization
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Set-Cookie': 'forbidden=1', Location: 'https://evil.test' })
    res.end('fixture CSV')
  })
  server.listen(socket); await once(server, 'listening')
  vi.stubEnv('NORTHMILL_BROWSER_SOCKET', socket)
  vi.stubEnv('NORTHMILL_BROWSER_TOKEN', token)
  try {
    const result = await bankBrowserRequest('company', 'user', '/sessions/id/file')
    expect(result.status).toBe(200)
    expect(await result.text()).toBe('fixture CSV')
    expect(owner).toBe('company:user')
    expect(authorization).toBe(`Bearer ${token}`)
    expect(result.headers.get('set-cookie')).toBeNull()
    expect(result.headers.get('location')).toBeNull()
    expect(result.headers.get('cache-control')).toBe('no-store, private')
    expect(result.headers.get('content-disposition')).toContain('northmill.csv')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) }
})
it('returns a stable error if the worker cannot be reached', async () => {
  vi.stubEnv('NORTHMILL_BROWSER_SOCKET', '/nonexistent/accounted-northmill.sock')
  vi.stubEnv('NORTHMILL_BROWSER_TOKEN', 'a'.repeat(40))
  const response = await bankBrowserRequest('company', 'user', '/sessions')
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ error: 'BROWSER_UNAVAILABLE' })
})
