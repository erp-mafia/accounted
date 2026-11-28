import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@/lib/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
    child: (): unknown => logger,
  }
  return { createLogger: () => logger }
})

vi.mock('../api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api-keys')>()
  return { ...actual, createServiceClientNoCookies: () => mocks.serviceClient() }
})

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  authenticateGrantClient,
  clientAuthenticationError,
  hashClientSecret,
  readClientCredentials,
  refuseForeignPartnerClientId,
} from '../oauth-client-auth'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function headers(authorization?: string): Headers {
  return new Headers(authorization ? { Authorization: authorization } : {})
}

function basic(raw: string): string {
  return `Basic ${Buffer.from(raw).toString('base64')}`
}

function rpcClient(answer: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(answer)
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

describe('readClientCredentials (RFC 6749 section 2.3.1)', () => {
  it('reads HTTP Basic, form-decoding both halves', () => {
    // A client_id and secret with characters the form encoding changes.
    const raw = `${encodeURIComponent('acme co')}:${encodeURIComponent('s3cr:t/+=')}`.replace(/%20/g, '+')
    expect(readClientCredentials(headers(basic(raw)), new URLSearchParams())).toEqual({
      kind: 'secret',
      method: 'client_secret_basic',
      clientId: 'acme co',
      secretHash: sha('s3cr:t/+='),
    })
  })

  it('accepts the scheme in any case and a client_id in the body that names the same client', () => {
    expect(readClientCredentials(headers(`bAsIc ${Buffer.from('acme:pw').toString('base64')}`), new URLSearchParams('client_id=acme'))).toMatchObject({
      kind: 'secret',
      method: 'client_secret_basic',
      clientId: 'acme',
    })
  })

  it('reads client_id and client_secret from the body', () => {
    expect(readClientCredentials(headers(), new URLSearchParams('client_id=acme&client_secret=pw'))).toEqual({
      kind: 'secret',
      method: 'client_secret_post',
      clientId: 'acme',
      secretHash: sha('pw'),
    })
  })

  it.each([
    ['nothing', undefined, ''],
    ['a client_id alone, as a public client sends it', undefined, 'client_id=b9f6a1e2-1111-4222-8333-944455556666'],
    ['an empty client_secret', undefined, 'client_id=acme&client_secret='],
    ['a Basic header with an empty password', basic('acme:'), ''],
    ['another scheme', 'Bearer gnubok_sk_abc', ''],
  ])('reads %s as no credentials', (_name, authorization, body) => {
    expect(readClientCredentials(headers(authorization), new URLSearchParams(body))).toEqual({ kind: 'none' })
  })

  it.each([
    ['Basic and a body secret at once', basic('acme:pw'), 'client_secret=pw', 'invalid_request'],
    ['a body client_id that is not the Basic one', basic('acme:pw'), 'client_id=other', 'invalid_request'],
    ['a client_secret without client_id', undefined, 'client_secret=pw', 'invalid_request'],
    ['Basic without a colon', basic('acmepw'), '', 'invalid_client'],
    ['Basic that is not Base64', 'Basic not*base64', '', 'invalid_client'],
    ['Basic with a broken escape', basic('acme:%zz'), '', 'invalid_client'],
    ['Basic with an empty client_id', basic(':pw'), '', 'invalid_client'],
    ['an empty Basic header', 'Basic', '', 'invalid_client'],
  ])('reads %s as malformed (%s)', (_name, authorization, body, error) => {
    expect(readClientCredentials(headers(authorization), new URLSearchParams(body))).toMatchObject({ kind: 'malformed', error })
  })

  it('hashes the secret as oauth_partner_client_secrets stores it', () => {
    expect(hashClientSecret('accounted_cs_00')).toBe(sha('accounted_cs_00'))
    expect(hashClientSecret('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('authenticateGrantClient', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([['claude'], ['gemini'], ['registered:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], [null]])(
    'answers public for %s without asking the database',
    async (client) => {
      const { client: supabase, rpc } = rpcClient({ data: 'refused', error: null })
      expect(await authenticateGrantClient(supabase, client, { kind: 'none' })).toBe('public')
      expect(rpc).not.toHaveBeenCalled()
    },
  )

  it('asks the database for a partner client, with the presented client_id and secret hash', async () => {
    const { client: supabase, rpc } = rpcClient({ data: 'authenticated', error: null })
    const presented = { kind: 'secret', method: 'client_secret_basic', clientId: 'acme', secretHash: sha('pw') } as const
    expect(await authenticateGrantClient(supabase, 'partner:acme', presented)).toBe('authenticated')
    expect(rpc).toHaveBeenCalledWith('oauth_client_authentication', {
      p_client: 'partner:acme',
      p_client_id: 'acme',
      p_client_secret_hash: sha('pw'),
    })
  })

  it('sends no credentials for a request without readable ones', async () => {
    const { client: supabase, rpc } = rpcClient({ data: 'refused', error: null })
    const presented = { kind: 'malformed', error: 'invalid_client', description: 'x' } as const
    expect(await authenticateGrantClient(supabase, 'partner:acme', presented)).toBe('refused')
    expect(rpc).toHaveBeenCalledWith('oauth_client_authentication', {
      p_client: 'partner:acme',
      p_client_id: null,
      p_client_secret_hash: null,
    })
  })

  it('reads an answer it does not know as refused, and a failed lookup as unavailable', async () => {
    expect(await authenticateGrantClient(rpcClient({ data: null, error: null }).client, 'partner:acme', { kind: 'none' })).toBe('refused')
    expect(await authenticateGrantClient(rpcClient({ data: 'yes', error: null }).client, 'partner:acme', { kind: 'none' })).toBe('refused')
    expect(
      await authenticateGrantClient(rpcClient({ data: null, error: { code: '57014', message: 'timeout' } }).client, 'partner:acme', { kind: 'none' }),
    ).toBe('unavailable')
    expect(mocks.logError).toHaveBeenCalledWith('client authentication lookup failed', { client: 'partner:acme', code: '57014' })
  })
})

describe('clientAuthenticationError (RFC 6749 section 5.2)', () => {
  it('answers 401 invalid_client with a Basic challenge', async () => {
    for (const presented of [
      { kind: 'none' } as const,
      { kind: 'secret', method: 'client_secret_post', clientId: 'acme', secretHash: sha('x') } as const,
      { kind: 'malformed', error: 'invalid_client', description: 'x' } as const,
    ]) {
      const res = clientAuthenticationError(presented)
      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="oauth"')
      expect(await res.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' })
    }
  })

  it('answers 400 invalid_request for credentials sent two ways at once', async () => {
    const res = clientAuthenticationError({ kind: 'malformed', error: 'invalid_request', description: 'Use one client authentication method, not two' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_request', error_description: 'Use one client authentication method, not two' })
  })
})

describe('refuseForeignPartnerClientId (RFC 6749 section 4.1.2.1)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lets the partner\'s own client_id through without a lookup', async () => {
    const { client, rpc } = rpcClient({ data: true, error: null })
    expect(await refuseForeignPartnerClientId('acme', 'acme', client)).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses another client_id when the partner holds a secret', async () => {
    const { client, rpc } = rpcClient({ data: true, error: null })
    const res = await refuseForeignPartnerClientId('acme', 'b9f6a1e2-1111-4222-8333-944455556666', client)
    expect(rpc).toHaveBeenCalledWith('oauth_client_has_secret', { p_client: 'partner:acme' })
    expect(res?.status).toBe(400)
    expect(await res?.json()).toEqual({
      error: 'invalid_request',
      error_description: 'client_id is not the client this redirect_uri belongs to',
    })
    expect(await refuseForeignPartnerClientId('acme', null, client)).not.toBeNull()
  })

  it('lets any client_id through for a partner without a secret (a public client)', async () => {
    const { client } = rpcClient({ data: false, error: null })
    expect(await refuseForeignPartnerClientId('acme', 'b9f6a1e2-1111-4222-8333-944455556666', client)).toBeNull()
  })

  it('refuses nothing when the lookup fails or no client can be built: the token endpoint still demands the secret', async () => {
    const { client } = rpcClient({ data: null, error: { code: 'PGRST202', message: 'missing' } })
    expect(await refuseForeignPartnerClientId('acme', 'other', client)).toBeNull()
    expect(mocks.logWarn).toHaveBeenCalledWith('partner secret lookup failed at authorize', { slug: 'acme', code: 'PGRST202' })

    mocks.serviceClient.mockImplementation(() => {
      throw new Error('supabaseUrl is required.')
    })
    expect(await refuseForeignPartnerClientId('acme', 'other')).toBeNull()
  })
})
