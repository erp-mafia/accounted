/**
 * The rules the local stack scripts (scripts/local/) rely on: one stack per
 * checkout, free ports, a dev server env that can only reach the local
 * stack, and the findings local:check fails on.
 */
import { describe, expect, it } from 'vitest'
import {
  ENV_MARKER,
  PORT_SLOTS,
  PROD_PG_MAJOR,
  classifyConsoleError,
  classifyServerLogLine,
  dedupeFindings,
  devServerEnv,
  dockerPublishedPorts,
  findFreePorts,
  isLoopbackUrl,
  parseEnvLines,
  portsAt,
  projectIdFor,
  renderDevEnv,
  renderSupabaseConfig,
  screenshotName,
  summarize,
} from '../lib'

describe('projectIdFor', () => {
  it('is stable for a checkout and differs between checkouts with the same folder name', () => {
    expect(projectIdFor('/home/a/wt/fix-x')).toBe(projectIdFor('/home/a/wt/fix-x/'))
    expect(projectIdFor('/home/a/wt/fix-x')).not.toBe(projectIdFor('/home/b/wt/fix-x'))
  })

  it('yields a Docker-safe name', () => {
    expect(projectIdFor('/tmp/My Worktree (2)')).toMatch(/^local-my-worktree-2-[0-9a-f]{6}$/)
    expect(projectIdFor('/')).toMatch(/^local-checkout-[0-9a-f]{6}$/)
  })
})

describe('findFreePorts', () => {
  it('returns the first block whose every port is free', async () => {
    const taken = new Set([64503, 64515])
    const ports = await findFreePorts(async (port) => !taken.has(port), { from: 64500, to: 64600 })
    expect(ports).toEqual(portsAt(64520))
    expect(Object.keys(ports)).toEqual([...PORT_SLOTS])
  })

  it('fails when no block fits', async () => {
    await expect(findFreePorts(async () => false, { from: 64500, to: 64530 })).rejects.toThrow(/No 9 consecutive free ports/)
  })
})

describe('dockerPublishedPorts', () => {
  it('reads single ports and ranges on every address family', () => {
    const ps = [
      '127.0.0.1:55461->5432/tcp',
      '0.0.0.0:54321->8000/tcp, [::]:54321->8000/tcp',
      '0.0.0.0:7000-7002->7000-7002/tcp',
      '',
    ].join('\n')
    expect([...dockerPublishedPorts(ps)].sort()).toEqual([54321, 55461, 7000, 7001, 7002])
  })
})

describe('renderSupabaseConfig', () => {
  const config = renderSupabaseConfig('local-x-abc123', portsAt(64500), 'http://localhost:64508')

  it("runs prod's Postgres major and the services pages reach, and skips the CLI's migration step", () => {
    expect(config).toContain('project_id = "local-x-abc123"')
    expect(config).toContain(`major_version = ${PROD_PG_MAJOR}`)
    expect(config).toMatch(/\[db\.migrations\]\nenabled = false/)
    expect(config).toMatch(/\[realtime\]\nenabled = true/)
    expect(config).toMatch(/\[storage\]\nenabled = true/)
    expect(config).toMatch(/\[studio\]\nenabled = false/)
    expect(config).toContain('max_rows = 1000')
    expect(config).toContain('enable_confirmations = false')
  })

  it('puts every service on its own port of the block', () => {
    expect(config).toMatch(/\[api\]\nenabled = true\nport = 64500/)
    expect(config).toMatch(/\[db\]\nport = 64501\nshadow_port = 64502/)
    expect(config).toContain('site_url = "http://localhost:64508"')
  })
})

describe('parseEnvLines', () => {
  it('reads supabase status -o env output', () => {
    const out = parseEnvLines('API_URL="http://127.0.0.1:64500"\nANON_KEY="eyJ.a.b"\nnoise line\nEMPTY=""\n')
    expect(out).toEqual({ API_URL: 'http://127.0.0.1:64500', ANON_KEY: 'eyJ.a.b', EMPTY: '' })
  })
})

describe('isLoopbackUrl', () => {
  it('accepts this machine only', () => {
    expect(isLoopbackUrl('http://127.0.0.1:64500')).toBe(true)
    expect(isLoopbackUrl('http://localhost:3000')).toBe(true)
    expect(isLoopbackUrl('https://pwxtzglxptnnvjrpixpg.supabase.co')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })
})

describe('renderDevEnv', () => {
  const env = {
    appUrl: 'http://localhost:64508',
    supabaseUrl: 'http://127.0.0.1:64500',
    anonKey: 'anon',
    serviceRoleKey: 'service',
    personnummerKey: 'a'.repeat(64),
    cronSecret: 'b'.repeat(32),
  }

  it('starts with the marker local:down looks for and holds the local keys only', () => {
    const file = renderDevEnv(env)
    expect(file.startsWith(ENV_MARKER)).toBe(true)
    expect(file).toContain('NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:64500')
    expect(file).toContain('SUPABASE_SERVICE_ROLE_KEY=service')
    expect(file).not.toMatch(/POSTHOG|RESEND|STRIPE|ENABLE_BANKING/)
  })

  it('refuses a Supabase URL that is not on this machine', () => {
    expect(() => renderDevEnv({ ...env, supabaseUrl: 'https://pwxtzglxptnnvjrpixpg.supabase.co' })).toThrow(/non-local/)
  })
})

describe('devServerEnv', () => {
  it("passes the shell's basics and drops everything else, keys included", () => {
    const env = devServerEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      SUPABASE_SERVICE_ROLE_KEY: 'prod-key',
      NEXT_PUBLIC_SUPABASE_URL: 'https://prod.supabase.co',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'development', NO_COLOR: '1', NEXT_TELEMETRY_DISABLED: '1' })
  })
})

describe('findings', () => {
  it('tells a missing translation from other console errors', () => {
    expect(classifyConsoleError('IntlError: MISSING_MESSAGE: Could not resolve `auth.x` in messages for locale `en`.')).toBe(
      'missing_translation',
    )
    expect(classifyConsoleError('Warning: Each child in a list should have a unique "key" prop.')).toBe('console_error')
  })

  it("reads the dev server log's error lines and nothing else", () => {
    expect(classifyServerLogLine(' ⨯ Error: boom')).toBe('server_error')
    expect(classifyServerLogLine('Error: MISSING_MESSAGE: Could not resolve `x`')).toBe('missing_translation')
    expect(classifyServerLogLine(' GET /bookkeeping 200 in 812ms')).toBeNull()
    expect(classifyServerLogLine(' ✓ Compiled in 1.2s')).toBeNull()
    // The continuation of a printed error object, and a line copied from the browser console.
    expect(classifyServerLogLine("  code: 'MISSING_MESSAGE',")).toBeNull()
    expect(classifyServerLogLine('[browser] Error: MISSING_MESSAGE: Could not resolve `x`')).toBeNull()
  })

  it('counts a repeated finding once, by kind and first line', () => {
    expect(
      dedupeFindings([
        { kind: 'missing_translation', detail: 'Error: MISSING_MESSAGE: x\nIntlError@http://localhost/a.js' },
        { kind: 'missing_translation', detail: 'Error: MISSING_MESSAGE: x' },
        { kind: 'console_error', detail: 'Error: MISSING_MESSAGE: x' },
        { kind: 'http_5xx', detail: '500 GET /api/x', count: 2 },
        { kind: 'http_5xx', detail: '500 GET /api/x' },
      ]),
    ).toEqual([
      { kind: 'missing_translation', detail: 'Error: MISSING_MESSAGE: x', count: 2 },
      { kind: 'console_error', detail: 'Error: MISSING_MESSAGE: x' },
      { kind: 'http_5xx', detail: '500 GET /api/x', count: 3 },
    ])
  })

  it('summarises pass and fail', () => {
    const page = { path: '/', locale: 'sv', status: 200, finalPath: '/', screenshot: 'x.png' }
    expect(summarize([{ ...page, findings: [] }])).toMatchObject({ ok: true, pages: 1, findings: 0, byKind: {} })
    expect(
      summarize([
        { ...page, findings: [{ kind: 'http_5xx', detail: '500 GET /api/x' }] },
        { ...page, locale: 'en', findings: [{ kind: 'http_5xx', detail: '502 GET /api/y' }, { kind: 'page_error', detail: 'x' }] },
      ]),
    ).toMatchObject({ ok: false, pages: 2, findings: 3, byKind: { http_5xx: 2, page_error: 1 } })
  })

  it('names screenshots by locale and path', () => {
    expect(screenshotName('sv', '/')).toBe('sv-root.png')
    expect(screenshotName('en', '/bookkeeping/year-end?tab=1')).toBe('en-bookkeeping-year-end.png')
  })
})
