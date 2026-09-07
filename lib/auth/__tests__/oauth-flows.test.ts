/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockResolveBrandByHost } = vi.hoisted(() => ({ mockResolveBrandByHost: vi.fn() }))
vi.mock('@/lib/branding/resolve', () => ({ resolveBrandByHost: mockResolveBrandByHost }))

import {
  consumeOAuthFlowHandoff,
  consumeOAuthFlowState,
  createOAuthFlow,
  mintOAuthFlowHandoff,
  newOAuthFlowId,
  purgeExpiredOAuthFlows,
  requestHost,
  requestMatchesOrigin,
  resolveOAuthOrigin,
  type OAuthFlow,
} from '../oauth-flows'
import { decryptOAuthFlowValue, encryptOAuthFlowValue } from '../oauth-flow-crypto'

/**
 * Chainable Supabase mock that records every builder call. Awaiting the
 * chain (insert / delete without select) resolves `terminal`; maybeSingle()
 * resolves it too.
 */
function makeDb(terminal: { data?: any; error?: any } = { data: null, error: null }) {
  const calls: Array<[string, unknown[]]> = []
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: any, reject: any) => Promise.resolve(terminal).then(resolve, reject)
        }
        if (prop === 'maybeSingle') return vi.fn(async () => terminal)
        return (...args: unknown[]) => {
          calls.push([prop, args])
          return chain
        }
      },
    },
  )
  const db = { from: vi.fn(() => chain) }
  const call = (name: string) => calls.find(([n]) => n === name)?.[1]
  const payload = (name: string) => call(name)?.[0] as Record<string, any>
  return { db: db as any, calls, call, payload }
}

const FLOW: OAuthFlow = {
  id: 'state-1',
  kind: 'skatteverket',
  companyId: 'company-1',
  userId: 'user-1',
  origin: 'https://brand.example',
  redirectUri: 'https://oauth.example/cb',
  codeVerifier: 'verifier-1',
  connectorState: null,
  returnTo: '/settings/tax',
}

function rowFor(flow: OAuthFlow, extra: Record<string, unknown> = {}) {
  return {
    id: flow.id,
    kind: flow.kind,
    company_id: flow.companyId,
    user_id: flow.userId,
    origin: flow.origin,
    redirect_uri: flow.redirectUri,
    code_verifier:
      flow.codeVerifier === null
        ? null
        : encryptOAuthFlowValue(
            flow.codeVerifier,
            JSON.stringify([flow.id, flow.userId, flow.origin, 'code_verifier']),
          ),
    connector_state: flow.connectorState,
    return_to: flow.returnTo,
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-secret')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example')
  mockResolveBrandByHost.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('oauth-flow-crypto', () => {
  it('round-trips under the same context and refuses another', () => {
    const ct = encryptOAuthFlowValue('secret', 'ctx-a')
    expect(ct.startsWith('v1:')).toBe(true)
    expect(ct).not.toContain('secret')
    expect(decryptOAuthFlowValue(ct, 'ctx-a')).toBe('secret')
    expect(() => decryptOAuthFlowValue(ct, 'ctx-b')).toThrow()
  })

  it('never accepts a plaintext value as a decryption', () => {
    expect(() => decryptOAuthFlowValue('secret', 'ctx')).toThrow(/ciphertext/)
  })
})

describe('requestHost', () => {
  it('prefers the Host header over the reconstructed URL and normalises it', () => {
    const req = new Request('https://internal.example/cb', { headers: { host: 'Brand.Example.' } })
    expect(requestHost(req)).toBe('brand.example')
  })

  it('falls back to the URL host for a malformed Host header', () => {
    const req = new Request('https://app.example/cb', { headers: { host: 'evil.example/path' } })
    expect(requestHost(req)).toBe('app.example')
  })

  it('matches an origin by host regardless of the scheme the proxy reported', () => {
    // A TLS-terminating proxy that drops x-forwarded-proto makes Next
    // reconstruct request.url as http://; the host is what identifies the hop.
    const req = new Request('http://app.example/cb')
    expect(requestMatchesOrigin(req, 'https://app.example')).toBe(true)
    expect(requestMatchesOrigin(req, 'https://oauth.example')).toBe(false)
  })
})

describe('resolveOAuthOrigin', () => {
  it('returns the app origin for the app host without a brand lookup, whatever scheme the proxy reported', async () => {
    expect(await resolveOAuthOrigin(new Request('https://app.example/x'))).toBe('https://app.example')
    expect(await resolveOAuthOrigin(new Request('http://app.example/x'))).toBe('https://app.example')
    expect(await resolveOAuthOrigin(new Request('http://APP.example./x'))).toBe('https://app.example')
    expect(mockResolveBrandByHost).not.toHaveBeenCalled()
  })

  it('treats an internal proxy upstream host as the app origin', async () => {
    // nginx defaults: Host rewritten to the upstream address, no proto header.
    expect(await resolveOAuthOrigin(new Request('http://127.0.0.1:3000/x'))).toBe('https://app.example')
    expect(mockResolveBrandByHost).not.toHaveBeenCalled()
  })

  it('returns a brand origin only when the brands table resolves the exact host', async () => {
    mockResolveBrandByHost.mockResolvedValue({ domain: 'brand.example' })
    expect(await resolveOAuthOrigin(new Request('https://brand.example/x'))).toBe('https://brand.example')

    mockResolveBrandByHost.mockResolvedValue({ domain: 'other.example' })
    expect(await resolveOAuthOrigin(new Request('https://brand.example/x'))).toBe('https://app.example')

    mockResolveBrandByHost.mockResolvedValue(null)
    expect(await resolveOAuthOrigin(new Request('https://stranger.example/x'))).toBe('https://app.example')
  })

  it('always answers a known brand as HTTPS and never a non-default port', async () => {
    mockResolveBrandByHost.mockResolvedValue({ domain: 'brand.example' })
    expect(await resolveOAuthOrigin(new Request('http://brand.example/x'))).toBe('https://brand.example')
    expect(await resolveOAuthOrigin(new Request('https://brand.example:8443/x'))).toBe('https://app.example')
  })
})

describe('createOAuthFlow', () => {
  it('stores the verifier encrypted and bound to the row identity', async () => {
    const { db, payload } = makeDb({ error: null })
    await createOAuthFlow(db, {
      id: 'state-1',
      kind: 'skatteverket',
      companyId: 'company-1',
      userId: 'user-1',
      origin: 'https://brand.example',
      redirectUri: 'https://oauth.example/cb',
      codeVerifier: 'verifier-1',
      connectorState: 'cs',
      returnTo: '/settings/tax',
    })
    const row = payload('insert')
    expect(row).toMatchObject({
      id: 'state-1',
      kind: 'skatteverket',
      company_id: 'company-1',
      user_id: 'user-1',
      origin: 'https://brand.example',
      redirect_uri: 'https://oauth.example/cb',
      connector_state: 'cs',
      return_to: '/settings/tax',
    })
    expect(row.code_verifier).not.toContain('verifier-1')
    expect(
      decryptOAuthFlowValue(
        row.code_verifier,
        JSON.stringify(['state-1', 'user-1', 'https://brand.example', 'code_verifier']),
      ),
    ).toBe('verifier-1')
    const ttl = new Date(row.expires_at).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(9 * 60 * 1000)
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000)
  })

  it('throws when the insert fails', async () => {
    const { db } = makeDb({ error: { message: 'boom' } })
    await expect(
      createOAuthFlow(db, {
        id: 's',
        kind: 'skatteverket',
        companyId: 'c',
        userId: 'u',
        origin: 'https://app.example',
        redirectUri: 'https://app.example/cb',
      }),
    ).rejects.toThrow(/boom/)
  })

  it('mints unguessable ids', () => {
    const a = newOAuthFlowId()
    expect(a).toHaveLength(43)
    expect(newOAuthFlowId()).not.toBe(a)
  })
})

describe('consumeOAuthFlowState', () => {
  it('consumes with the whole check in the predicate and returns the decrypted flow', async () => {
    const { db, calls, call } = makeDb({ data: rowFor(FLOW), error: null })
    const flow = await consumeOAuthFlowState(db, 'state-1', 'skatteverket')
    expect(flow).toEqual(FLOW)
    expect(call('update')?.[0]).toMatchObject({ used_at: expect.any(String) })
    expect(calls).toEqual(
      expect.arrayContaining([
        ['eq', ['id', 'state-1']],
        ['eq', ['kind', 'skatteverket']],
        ['is', ['used_at', null]],
        ['gt', ['expires_at', expect.any(String)]],
      ]),
    )
  })

  it('returns null for no row, a query error, and an unreadable verifier', async () => {
    expect(await consumeOAuthFlowState(makeDb({ data: null, error: null }).db, 's', 'skatteverket')).toBeNull()
    expect(
      await consumeOAuthFlowState(makeDb({ data: null, error: { message: 'x' } }).db, 's', 'skatteverket'),
    ).toBeNull()
    const tampered = rowFor(FLOW, { code_verifier: 'v1:not-really' })
    expect(await consumeOAuthFlowState(makeDb({ data: tampered, error: null }).db, 's', 'skatteverket')).toBeNull()
  })
})

describe('mintOAuthFlowHandoff / consumeOAuthFlowHandoff', () => {
  it('stashes the provider code encrypted under a fresh handoff id, only onto a consumed row', async () => {
    const { db, calls, payload } = makeDb({ data: { id: 'state-1' }, error: null })
    const handoffId = await mintOAuthFlowHandoff(db, FLOW, { providerCode: 'code-1' })
    expect(handoffId).not.toBe(FLOW.id)
    const row = payload('update')
    expect(row.handoff_id).toBe(handoffId)
    expect(row.handoff_error).toBeNull()
    expect(row.handoff_code).not.toContain('code-1')
    expect(
      decryptOAuthFlowValue(
        row.handoff_code,
        JSON.stringify(['state-1', handoffId, 'user-1', 'https://brand.example', 'handoff_code']),
      ),
    ).toBe('code-1')
    const ttl = new Date(row.handoff_expires_at).getTime() - Date.now()
    expect(ttl).toBeLessThanOrEqual(2 * 60 * 1000)
    expect(calls).toEqual(
      expect.arrayContaining([
        ['eq', ['id', 'state-1']],
        ['is', ['handoff_id', null]],
        ['not', ['used_at', 'is', null]],
      ]),
    )
  })

  it('throws when the row was already handed off', async () => {
    const { db } = makeDb({ data: null, error: null })
    await expect(mintOAuthFlowHandoff(db, FLOW, { providerError: 'nej' })).rejects.toThrow(/handed off/)
  })

  it('claims the handoff bound to the origin and returns the decrypted result', async () => {
    const handoffId = 'handoff-1'
    const ctx = (col: string) => JSON.stringify(['state-1', handoffId, 'user-1', 'https://brand.example', col])
    const row = rowFor(FLOW, {
      handoff_code: encryptOAuthFlowValue('code-1', ctx('handoff_code')),
      handoff_error: null,
    })
    const { db, calls } = makeDb({ data: row, error: null })
    const result = await consumeOAuthFlowHandoff(db, handoffId, 'https://brand.example', 'skatteverket')
    expect(result).toEqual({ ...FLOW, providerCode: 'code-1', providerError: null })
    expect(calls[0]?.[0]).toBe('delete')
    expect(calls).toEqual(
      expect.arrayContaining([
        ['eq', ['handoff_id', handoffId]],
        ['eq', ['origin', 'https://brand.example']],
        ['eq', ['kind', 'skatteverket']],
        ['gt', ['handoff_expires_at', expect.any(String)]],
      ]),
    )
  })

  it('returns null for a missing row and for a tampered payload', async () => {
    expect(
      await consumeOAuthFlowHandoff(makeDb({ data: null, error: null }).db, 'h', 'https://brand.example', 'skatteverket'),
    ).toBeNull()
    const row = rowFor(FLOW, { handoff_code: 'v1:garbage', handoff_error: null })
    expect(
      await consumeOAuthFlowHandoff(makeDb({ data: row, error: null }).db, 'h', 'https://brand.example', 'skatteverket'),
    ).toBeNull()
  })
})

describe('purgeExpiredOAuthFlows', () => {
  it('deletes only rows nothing can consume any more', async () => {
    const { db, calls } = makeDb({ error: null })
    await purgeExpiredOAuthFlows(db)
    expect(calls[0]?.[0]).toBe('delete')
    expect(calls).toEqual(
      expect.arrayContaining([
        ['lt', ['expires_at', expect.any(String)]],
        ['or', [expect.stringMatching(/^handoff_expires_at\.is\.null,handoff_expires_at\.lt\./)]],
      ]),
    )
  })
})
