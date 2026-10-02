import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthError } from '../lib/errors.mjs'
import { createSession } from '../lib/session.mjs'
import { createStore } from '../lib/store.mjs'
import { ORIGIN, fakeSend, json, rpcResult, tempDir, type RpcBody, type Sent } from './helpers'

const TOKEN_URL = `${ORIGIN}/api/mcp-oauth/token`
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

function saved(access: string, refresh: string) {
  return {
    access_token: access,
    refresh_token: refresh,
    token_endpoint: TOKEN_URL,
    issuer: ORIGIN,
    scope: 'invoices:read',
    created_at: '2026-10-02T10:00:00.000Z',
    updated_at: '2026-10-02T10:00:00.000Z',
  }
}

const bearer = (req: Sent) => req.headers.Authorization?.replace('Bearer ', '')

let tmp: ReturnType<typeof tempDir>
let store: ReturnType<typeof createStore>

beforeEach(() => {
  tmp = tempDir()
  store = createStore({ dir: path.join(tmp.dir, 'accounted'), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
})

afterEach(() => {
  fs.chmodSync(tmp.dir, 0o700)
  tmp.cleanup()
})

function session(send: ReturnType<typeof fakeSend>['send'], envKey?: string) {
  return createSession({ origin: ORIGIN, company: undefined, envKey, store, send, headers: { 'X-Accounted-Client': 'accounted-cli-test' } })
}

describe('credential choice', () => {
  it('sends no Authorization header when signed out', async () => {
    const { send, calls } = fakeSend((_req, body) => rpcResult(body, { tools: [] }))
    await session(send).rpc('tools/list')
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(calls[0].headers['X-Accounted-Client']).toBe('accounted-cli-test')
    expect(calls[0].url).toBe(`${ORIGIN}/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted`)
  })

  it('prefers ACCOUNTED_API_KEY over a saved sign-in', async () => {
    await store.write(ORIGIN, saved('gnubok_sk_saved', 'gnubok_rt_1'))
    const { send, calls } = fakeSend((_req, body) => rpcResult(body, { tools: [] }))
    await session(send, 'gnubok_sk_env').rpc('tools/list')
    expect(bearer(calls[0])).toBe('gnubok_sk_env')
  })

  it('never renews an API key from the environment', async () => {
    const { send, calls } = fakeSend(() => ({ status: 401, text: 'Unauthorized' }))
    await expect(session(send, 'gnubok_sk_env').rpc('tools/list')).rejects.toThrow(/ACCOUNTED_API_KEY was refused/)
    expect(calls).toHaveLength(1)
  })

  it('tells a signed-out caller to log in when a tool needs it', async () => {
    const { send } = fakeSend(() => ({ status: 401, text: 'Unauthorized' }))
    await expect(session(send).rpc('tools/call', { name: 'accounted_list_invoices', arguments: {} })).rejects.toThrow(
      /Not signed in/
    )
  })
})

describe('renewal after a 401', () => {
  it('first retries with a token another process saved meanwhile', async () => {
    await store.write(ORIGIN, saved('gnubok_sk_old', 'gnubok_rt_1'))
    const { send, calls } = fakeSend(async (req, body) => {
      if (bearer(req) === 'gnubok_sk_old') {
        // Another process renews while this request is in flight.
        await store.write(ORIGIN, saved('gnubok_sk_new', 'gnubok_rt_2'))
        return { status: 401, text: 'Unauthorized' }
      }
      return rpcResult(body, { ok: true })
    })
    expect(await session(send).rpc('tools/list')).toEqual({ ok: true })
    expect(calls.map((c) => c.url)).not.toContain(TOKEN_URL)
    expect(calls.map(bearer)).toEqual(['gnubok_sk_old', 'gnubok_sk_new'])
  })

  it('renews with the refresh token, saves the rotated pair, and retries once', async () => {
    await store.write(ORIGIN, saved('gnubok_sk_old', 'gnubok_rt_1'))
    const { send, calls } = fakeSend((req, body) => {
      if (req.url === TOKEN_URL) {
        expect(req.body).toContain('grant_type=refresh_token')
        expect(req.body).toContain('refresh_token=gnubok_rt_1')
        return json(200, { access_token: 'gnubok_sk_new', refresh_token: 'gnubok_rt_2', token_type: 'Bearer', scope: 'invoices:read' })
      }
      return bearer(req) === 'gnubok_sk_new' ? rpcResult(body, { ok: true }) : { status: 401, text: 'Unauthorized' }
    })
    expect(await session(send).rpc('tools/list')).toEqual({ ok: true })
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1)
    const after = await store.read(ORIGIN)
    expect(after?.access_token).toBe('gnubok_sk_new')
    expect(after?.refresh_token).toBe('gnubok_rt_2')
  })

  it('renews only once when two calls hit a 401 together', async () => {
    await store.write(ORIGIN, saved('gnubok_sk_old', 'gnubok_rt_1'))
    let tokenCalls = 0
    const handler = async (req: Sent, body: RpcBody) => {
      if (req.url === TOKEN_URL) {
        tokenCalls++
        await new Promise((r) => setTimeout(r, 20))
        return json(200, { access_token: 'gnubok_sk_new', refresh_token: 'gnubok_rt_2', scope: 'invoices:read' })
      }
      return bearer(req) === 'gnubok_sk_new' ? rpcResult(body, { ok: true }) : { status: 401, text: 'Unauthorized' }
    }
    const a = session(fakeSend(handler).send)
    const b = session(fakeSend(handler).send)
    const results = await Promise.all([a.rpc('tools/list'), b.rpc('tools/list')])
    expect(results).toEqual([{ ok: true }, { ok: true }])
    expect(tokenCalls).toBe(1)
  })

  it('forgets the sign-in when the server says it has ended', async () => {
    await store.write(ORIGIN, saved('gnubok_sk_old', 'gnubok_rt_1'))
    const { send } = fakeSend((req) =>
      req.url === TOKEN_URL
        ? json(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' })
        : { status: 401, text: 'Unauthorized' }
    )
    await expect(session(send).rpc('tools/list')).rejects.toThrow(AuthError)
    expect(await store.read(ORIGIN)).toBeNull()
  })

  it.runIf(process.platform !== 'win32' && !isRoot)(
    'does not spend the refresh token when the new one could not be saved',
    async () => {
      await store.write(ORIGIN, saved('gnubok_sk_old', 'gnubok_rt_1'))
      fs.chmodSync(path.join(tmp.dir, 'accounted'), 0o500)
      const { send, calls } = fakeSend(() => ({ status: 401, text: 'Unauthorized' }))
      await expect(session(send).rpc('tools/list')).rejects.toThrow(/cannot be written here/)
      expect(calls.map((c) => c.url)).not.toContain(TOKEN_URL)
      fs.chmodSync(path.join(tmp.dir, 'accounted'), 0o700)
    }
  )
})
