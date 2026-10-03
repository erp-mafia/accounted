import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../lib/cli.mjs'
import { CALLBACK_PATH, PASTE_PORT, readPastedLine } from '../lib/oauth.mjs'
import { CLIENT_NAME } from '../lib/version.mjs'
import { ORIGIN, fakeSend, json, rpcResult, sink, stdinFrom, tempDir, toolResult, type Reply, type RpcBody, type Sent } from './helpers'

const DISCOVERY = {
  issuer: ORIGIN,
  authorization_endpoint: `${ORIGIN}/api/mcp-oauth/authorize`,
  token_endpoint: `${ORIGIN}/api/mcp-oauth/token`,
  code_challenge_methods_supported: ['S256'],
}
const ACCESS = 'gnubok_sk_ABCDEFGHabcdefgh12345678'
const LOOPBACK = `http://127.0.0.1:5555${CALLBACK_PATH}`

let tmp: ReturnType<typeof tempDir>
const credentialsFile = () => path.join(tmp.dir, 'accounted', 'credentials.json')

beforeEach(() => {
  tmp = tempDir()
})

afterEach(() => {
  tmp.cleanup()
})

type RunOptions = {
  handler?: (req: Sent, body: RpcBody) => Reply | Promise<Reply>
  env?: Record<string, string>
  stdin?: ReturnType<typeof stdinFrom>
  openBrowser?: (url: string) => boolean
  startLoopback?: () => Promise<{ redirectUri: string; result: Promise<string>; close: () => void }>
  sleep?: (ms: number) => Promise<void>
  randomBytes?: (size: number) => Buffer
  loginTimeoutMs?: number
}

async function run(argv: string[], options: RunOptions = {}) {
  const stdout = sink()
  const stderr = sink()
  const { send, calls } = fakeSend(
    options.handler ??
      (() => {
        throw new Error('unexpected network call')
      })
  )
  const code = await main(argv, {
    env: { XDG_CONFIG_HOME: tmp.dir, ...options.env },
    stdout,
    stderr,
    stdin: options.stdin ?? stdinFrom(''),
    platform: 'linux',
    homedir: tmp.dir,
    send,
    openBrowser: options.openBrowser ?? (() => true),
    startLoopback:
      options.startLoopback ??
      (async () => {
        throw Object.assign(new Error('no loopback in this test'), { code: 'EACCES' })
      }),
    readPastedLine,
    sleep: options.sleep ?? (async () => {}),
    randomBytes: options.randomBytes ?? ((size: number) => crypto.randomBytes(size)),
    loginTimeoutMs: options.loginTimeoutMs ?? 2000,
  })
  return { code, stdout: stdout.text, stderr: stderr.text, calls }
}

const withKey = { ACCOUNTED_API_KEY: ACCESS }
const out = (text: string) => JSON.parse(text)

function saveLogin(access = ACCESS) {
  fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true })
  fs.writeFileSync(
    credentialsFile(),
    JSON.stringify({
      version: 1,
      servers: {
        [ORIGIN]: {
          access_token: access,
          refresh_token: 'gnubok_rt_1',
          token_endpoint: DISCOVERY.token_endpoint,
          issuer: ORIGIN,
          scope: 'invoices:read',
          created_at: '2026-10-02T10:00:00.000Z',
          updated_at: '2026-10-02T10:00:00.000Z',
        },
      },
    })
  )
}

describe('command line', () => {
  it('prints the version and the help', async () => {
    expect((await run(['--version'])).stdout).toBe('0.1.0\n')
    const help = await run(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('accounted call <tool> [json|@file.json|-]')
  })

  it.each([
    [[], 'no command'],
    [['frobnicate'], 'unknown command'],
    [['status', '--bogus'], 'unknown option'],
    [['status', '--force'], 'login-only flag elsewhere'],
    [['call'], 'call without a tool'],
    [['call', 'list_invoices', '{}', 'extra'], 'call with two argument blobs'],
    [['--company', 'Acme AB', 'status'], 'company that is not an id'],
    [['--url', 'ftp://example.se', 'status'], 'server URL that is not http(s)'],
    [['describe'], 'describe without a tool'],
    [['task'], 'task without an id'],
  ])('exits 2 for usage errors: %j (%s)', async (argv) => {
    expect((await run(argv as string[])).code).toBe(2)
  })
})

describe('call', () => {
  it('sends the canonical tool name, the JSON arguments and the CLI identity', async () => {
    const result = await run(['call', 'list-invoices', '{"limit": 5, "account": "1930"}'], {
      env: withKey,
      handler: (_req, body) => rpcResult(body, toolResult({ invoices: [] }, { _meta: { company: { id: 'c1', name: 'Acme AB' } } })),
    })
    expect(result.code).toBe(0)
    expect(out(result.stdout)).toEqual({ invoices: [] })
    expect(result.stderr).toContain('Company: Acme AB (c1)')

    const request = result.calls[0]
    expect(request.headers.Authorization).toBe(`Bearer ${ACCESS}`)
    expect(request.headers['X-Accounted-Client']).toBe(CLIENT_NAME)
    const body = JSON.parse(request.body!)
    expect(body.method).toBe('tools/call')
    expect(body.params.name).toBe('accounted_list_invoices')
    expect(body.params.arguments).toEqual({ limit: 5, account: '1930' })
    expect(body.params._meta?.['io.modelcontextprotocol/clientCapabilities']).toEqual({
      extensions: { 'io.modelcontextprotocol/tasks': {} },
    })
  })

  it('reads the arguments from standard input with -', async () => {
    const result = await run(['call', 'list_invoices', '-'], {
      env: withKey,
      stdin: stdinFrom('{"status": "sent"}'),
      handler: (_req, body) => {
        expect(body.params.arguments).toEqual({ status: 'sent' })
        return rpcResult(body, toolResult({ invoices: [] }))
      },
    })
    expect(result.code).toBe(0)
  })

  it('pins the company on the request URL', async () => {
    const company = '22222222-2222-4222-8222-222222222222'
    const result = await run(['call', 'list_invoices', '--company', company], {
      env: withKey,
      handler: (_req, body) => rpcResult(body, toolResult({ invoices: [] })),
    })
    expect(result.calls[0].url).toContain(`company=${company}`)
  })

  it('repeats the approve call for a staged write, and stops at nothing being booked', async () => {
    const staged = {
      staged: true,
      operation_id: 'op1',
      risk_level: 'medium',
      approve: { tool: 'accounted_approve_pending_operation', args: { operation_id: 'op1', company_id: 'c1' } },
      preview: {},
    }
    const result = await run(['call', 'categorize_transaction', '{"transaction_id": "t1"}'], {
      env: withKey,
      handler: (_req, body) => rpcResult(body, toolResult(staged)),
    })
    expect(result.code).toBe(0)
    expect(out(result.stdout)).toEqual(staged)
    expect(result.stderr).toContain('Nothing is booked yet.')
    expect(result.stderr).toContain(
      `accounted call approve_pending_operation '{"operation_id":"op1","company_id":"c1"}'`
    )
    expect(result.stderr).toContain(`${ORIGIN}/pending`)
    expect(result.stderr).not.toContain('confirmed')
  })

  it('leaves confirmed out of a high-risk approve and asks for the acknowledgment first', async () => {
    const result = await run(['call', 'create_voucher', '{}'], {
      env: withKey,
      handler: (_req, body) =>
        rpcResult(
          body,
          toolResult({
            staged: true,
            operation_id: 'op2',
            risk_level: 'high',
            approve: { tool: 'gnubok_approve_pending_operation', args: { operation_id: 'op2', company_id: 'c1' } },
          })
        ),
    })
    expect(result.stderr).toContain(`accounted call approve_pending_operation '{"operation_id":"op2","company_id":"c1"}'`)
    expect(result.stderr).toContain('High risk: irreversible once approved')
    expect(result.stderr).toContain('only then add "confirmed": true')
  })

  it('exits 1 with the error object on stderr when the tool fails', async () => {
    const error = { code: 'INSUFFICIENT_SCOPE', message_en: 'Missing invoices:write', retryable: false }
    const result = await run(['call', 'create_invoice', '{}'], {
      env: withKey,
      handler: (_req, body) =>
        rpcResult(body, { resultType: 'complete', isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] }),
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(out(result.stderr)).toEqual({ error })
  })

  it('exits 2 with the suggestions for an unknown tool', async () => {
    const result = await run(['call', 'lst_invoices'], {
      env: withKey,
      handler: (_req, body) =>
        json(200, {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32602, message: 'Unknown tool: "accounted_lst_invoices". Did you mean: accounted_list_invoices? Available tools: x' },
        }),
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Did you mean: accounted_list_invoices?')
  })

  it('exits 4 on a rate limit and says how long to wait', async () => {
    const result = await run(['call', 'list_invoices'], {
      env: withKey,
      handler: () => ({ status: 429, headers: { 'retry-after': '60' }, text: 'Too Many Requests' }),
    })
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('retry after 60 s')
  })

  it('exits 3 when not signed in', async () => {
    const result = await run(['call', 'list_invoices'], { handler: () => ({ status: 401, text: 'Unauthorized' }) })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('accounted login')
  })
})

describe('long-running calls', () => {
  it('prints the task id, polls at the given interval, and prints the result', async () => {
    const polls: string[] = ['working', 'completed']
    const sleep = vi.fn(async () => {})
    const result = await run(['call', 'audit_package', '{"fiscal_year": 2025}'], {
      env: withKey,
      sleep,
      handler: (_req, body) => {
        if (body.method === 'tools/call') {
          return rpcResult(body, { resultType: 'task', task: { taskId: 't1', status: 'working', pollIntervalMs: 2000 } })
        }
        expect(body.method).toBe('tasks/get')
        expect(body.params.taskId).toBe('t1')
        const status = polls.shift()
        return rpcResult(body, {
          resultType: 'complete',
          taskId: 't1',
          status,
          pollIntervalMs: 2000,
          ...(status === 'completed' ? { result: toolResult({ package: 'ready' }) } : {}),
        })
      },
    })
    expect(result.code).toBe(0)
    expect(out(result.stdout)).toEqual({ package: 'ready' })
    expect(result.stderr).toContain('resume with: accounted task t1')
    expect(sleep).toHaveBeenCalledWith(2000)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('resumes a task by id', async () => {
    const result = await run(['task', 't1'], {
      env: withKey,
      handler: (_req, body) =>
        rpcResult(body, { resultType: 'complete', taskId: 't1', status: 'completed', result: toolResult({ package: 'ready' }) }),
    })
    expect(result.code).toBe(0)
    expect(out(result.stdout)).toEqual({ package: 'ready' })
  })

  it('exits 4 when the task failed on the server', async () => {
    const result = await run(['task', 't1'], {
      env: withKey,
      handler: (_req, body) =>
        rpcResult(body, { resultType: 'complete', taskId: 't1', status: 'failed', error: { message: 'storage down' } }),
    })
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('storage down')
  })
})

describe('discovery commands', () => {
  it('guide prints the server instructions as text', async () => {
    const result = await run(['guide'], {
      handler: (_req, body) => {
        expect(body.method).toBe('server/discover')
        return rpcResult(body, { resultType: 'complete', instructions: 'Accounted: Swedish bookkeeping.' })
      },
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('Accounted: Swedish bookkeeping.\n')
  })

  it('tools lists names and first lines', async () => {
    const result = await run(['tools'], {
      handler: (_req, body) =>
        rpcResult(body, {
          tools: [{ name: 'accounted_list_invoices', description: 'List invoices.\nMore detail.', inputSchema: {} }],
        }),
    })
    expect(out(result.stdout)).toEqual([{ name: 'accounted_list_invoices', description: 'List invoices.' }])
    expect(result.stderr).toContain('1 common tools')
  })

  it('tools with words searches every tool', async () => {
    const result = await run(['tools', 'moms', 'deklaration'], {
      env: withKey,
      handler: (_req, body) => {
        expect(body.params).toMatchObject({
          name: 'accounted_search_tools',
          arguments: { query: 'moms deklaration', detail: 'summary', limit: 20 },
        })
        return rpcResult(body, toolResult({ tools: [{ name: 'accounted_get_vat_report' }], count: 1 }))
      },
    })
    expect(out(result.stdout).tools[0].name).toBe('accounted_get_vat_report')
    expect(result.stderr).not.toContain('Not signed in')
  })

  it('describe finds the exact tool among the search hits', async () => {
    const tool = { name: 'accounted_list_invoices', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } }
    const result = await run(['describe', 'list-invoices'], {
      env: withKey,
      handler: (_req, body) =>
        rpcResult(body, toolResult({ tools: [{ name: 'accounted_list_invoice_rows' }, tool], count: 2 })),
    })
    expect(result.code).toBe(0)
    expect(out(result.stdout)).toEqual(tool)
  })

  it('describe exits 2 when no tool has that name', async () => {
    const result = await run(['describe', 'no_such_tool'], {
      env: withKey,
      handler: (_req, body) =>
        body.method === 'tools/list' ? rpcResult(body, { tools: [] }) : rpcResult(body, toolResult({ tools: [], count: 0 })),
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('No tool named accounted_no_such_tool')
  })
})

describe('status', () => {
  it('exits 3 and says so when not signed in', async () => {
    const result = await run(['status'])
    expect(result.code).toBe(3)
    expect(out(result.stdout)).toMatchObject({ server: ORIGIN, signed_in: false, credential: null })
  })

  it('reports the companies a working sign-in reaches', async () => {
    saveLogin()
    const result = await run(['status'], {
      handler: (_req, body) => {
        expect(body.params.name).toBe('accounted_list_companies')
        return rpcResult(body, toolResult({ companies: [{ id: 'c1', name: 'Acme AB' }] }))
      },
    })
    expect(result.code).toBe(0)
    expect(out(result.stdout)).toEqual({
      server: ORIGIN,
      company_pin: null,
      signed_in: true,
      credential: 'login',
      key_prefix: ACCESS.slice(0, 18),
      scopes: ['invoices:read'],
      companies: [{ id: 'c1', name: 'Acme AB' }],
    })
  })
})

describe('login', () => {
  function server(tokenBodies: Record<string, string>[] = []) {
    return (req: Sent): Reply => {
      if (req.method === 'GET') return json(200, DISCOVERY)
      tokenBodies.push(Object.fromEntries(new URLSearchParams(req.body)))
      return json(200, { access_token: ACCESS, refresh_token: 'gnubok_rt_1', token_type: 'Bearer', scope: 'invoices:read invoices:write' })
    }
  }

  it('signs in through the loopback and saves the tokens', async () => {
    const tokenBodies: Record<string, string>[] = []
    let deliver: (url: string) => void = () => {}
    const close = vi.fn()
    const result = await run(['login'], {
      handler: server(tokenBodies),
      startLoopback: async () => ({ redirectUri: LOOPBACK, result: new Promise((r) => (deliver = r)), close }),
      openBrowser: (url) => {
        const authorize = new URL(url)
        expect(authorize.searchParams.get('redirect_uri')).toBe(LOOPBACK)
        expect(authorize.searchParams.has('scope')).toBe(false)
        const state = authorize.searchParams.get('state')!
        deliver(`${LOOPBACK}?code=abc&state=${state}&iss=${encodeURIComponent(ORIGIN)}`)
        return true
      },
    })
    expect(result.code).toBe(0)
    expect(out(result.stdout)).toEqual({
      signed_in: true,
      server: ORIGIN,
      key_prefix: ACCESS.slice(0, 18),
      scopes: ['invoices:read', 'invoices:write'],
    })
    expect(tokenBodies[0]).toMatchObject({ grant_type: 'authorization_code', code: 'abc', redirect_uri: LOOPBACK })
    expect(tokenBodies[0].code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(close).toHaveBeenCalled()
    const stored = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8'))
    expect(stored.servers[ORIGIN]).toMatchObject({ access_token: ACCESS, refresh_token: 'gnubok_rt_1', issuer: ORIGIN })
  })

  it('takes a pasted address when there is no loopback', async () => {
    // Fixed random bytes make the state predictable, so the pasted answer can
    // be written before the run.
    const randomBytes = (size: number) => Buffer.alloc(size, 1)
    const state = Buffer.alloc(16, 1).toString('base64url')
    const pasted = `http://127.0.0.1:${PASTE_PORT}${CALLBACK_PATH}?code=abc&state=${state}&iss=${encodeURIComponent(ORIGIN)}\n`
    const tokenBodies: Record<string, string>[] = []
    const result = await run(['login', '--no-browser'], {
      handler: server(tokenBodies),
      stdin: stdinFrom(pasted, true),
      randomBytes,
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('paste it here')
    expect(tokenBodies[0].redirect_uri).toBe(`http://127.0.0.1:${PASTE_PORT}${CALLBACK_PATH}`)
  })

  it('stops before minting a key when nothing can receive the answer', async () => {
    const result = await run(['login'], { handler: server() })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Run `accounted login` in your own terminal')
  })

  it('times out when the browser never comes back', async () => {
    const result = await run(['login'], {
      handler: server(),
      loginTimeoutMs: 20,
      startLoopback: async () => ({ redirectUri: LOOPBACK, result: new Promise(() => {}), close: () => {} }),
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('timed out')
  })

  it('refuses to sign in over an existing sign-in or an API key', async () => {
    expect((await run(['login'], { env: withKey })).code).toBe(2)
    saveLogin()
    const again = await run(['login'])
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('Already signed in')
  })
})

describe('logout', () => {
  it('removes the sign-in and names the key to disconnect in Settings', async () => {
    saveLogin()
    const result = await run(['logout'])
    expect(result.code).toBe(0)
    expect(out(result.stdout)).toEqual({ signed_out: true, server: ORIGIN, key_prefix: ACCESS.slice(0, 18) })
    expect(result.stderr).toContain(`${ORIGIN}/settings/api`)
    expect(fs.existsSync(credentialsFile())).toBe(false)
  })

  it('says so when there is nothing to remove', async () => {
    const result = await run(['logout'])
    expect(result.code).toBe(0)
    expect(out(result.stdout)).toMatchObject({ signed_out: false })
  })
})
