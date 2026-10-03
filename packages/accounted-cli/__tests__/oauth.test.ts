import crypto from 'node:crypto'
import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { AuthError, UnavailableError } from '../lib/errors.mjs'
import {
  CALLBACK_PATH,
  authorizeUrl,
  createPkce,
  discover,
  exchangeCode,
  parseCallback,
  refreshTokens,
  startLoopback,
} from '../lib/oauth.mjs'
import { ORIGIN, fakeSend, json } from './helpers'

const DISCOVERY = {
  issuer: ORIGIN,
  authorization_endpoint: `${ORIGIN}/api/mcp-oauth/authorize`,
  token_endpoint: `${ORIGIN}/api/mcp-oauth/token`,
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['mcp'],
}

describe('discover', () => {
  it('reads the endpoints from the well-known document', async () => {
    const { send, calls } = fakeSend(() => json(200, DISCOVERY))
    expect(await discover(send, ORIGIN, {})).toEqual({
      issuer: ORIGIN,
      authorizationEndpoint: DISCOVERY.authorization_endpoint,
      tokenEndpoint: DISCOVERY.token_endpoint,
    })
    expect(calls[0].url).toBe(`${ORIGIN}/.well-known/oauth-authorization-server`)
  })

  it('refuses a server without usable endpoints or without S256', async () => {
    await expect(discover(fakeSend(() => json(404, {})).send, ORIGIN, {})).rejects.toThrow(UnavailableError)
    await expect(discover(fakeSend(() => json(200, { issuer: ORIGIN })).send, ORIGIN, {})).rejects.toThrow(
      /missing its endpoints/
    )
    await expect(
      discover(fakeSend(() => json(200, { ...DISCOVERY, code_challenge_methods_supported: ['plain'] })).send, ORIGIN, {})
    ).rejects.toThrow(/PKCE S256/)
  })
})

describe('PKCE and the authorize URL', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = createPkce((n) => crypto.randomBytes(n))
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'))
  })

  it('asks for no scope, so the consent page offers what the connectors get', () => {
    const url = new URL(
      authorizeUrl({
        authorizationEndpoint: DISCOVERY.authorization_endpoint,
        redirectUri: `http://127.0.0.1:5555${CALLBACK_PATH}`,
        state: 'st',
        challenge: 'ch',
        resource: `${ORIGIN}/api/extensions/ext/mcp-server/mcp`,
      })
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'accounted-cli',
      redirect_uri: `http://127.0.0.1:5555${CALLBACK_PATH}`,
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/api/extensions/ext/mcp-server/mcp`,
    })
    expect(url.searchParams.has('scope')).toBe(false)
  })
})

describe('parseCallback', () => {
  const expected = { state: 'st', issuer: ORIGIN }
  const cb = (query: string) => `http://127.0.0.1:5555${CALLBACK_PATH}?${query}`
  const iss = `iss=${encodeURIComponent(ORIGIN)}`

  it('returns the code when state and issuer match', () => {
    expect(parseCallback(cb(`code=abc&state=st&${iss}`), expected)).toBe('abc')
    expect(parseCallback(`  ${cb(`code=abc&state=st&${iss}`)}\n`, expected)).toBe('abc')
  })

  it('refuses an answer from another login or another issuer', () => {
    expect(() => parseCallback(cb(`code=abc&state=other&${iss}`), expected)).toThrow(/another login attempt/)
    expect(() => parseCallback(cb('code=abc&state=st&iss=https%3A%2F%2Fevil.example'), expected)).toThrow(
      /names https:\/\/evil\.example/
    )
    expect(() => parseCallback(cb('code=abc&state=st'), expected)).toThrow(/names no issuer/)
  })

  it('reports a cancelled or failed consent', () => {
    expect(() => parseCallback(cb(`error=access_denied&state=st&${iss}`), expected)).toThrow('Sign-in was cancelled in the browser.')
    expect(() =>
      parseCallback(cb(`error=invalid_request&error_description=Bad+redirect&state=st&${iss}`), expected)
    ).toThrow('Sign-in failed: Bad redirect')
  })

  it('refuses something that is not the callback address', () => {
    expect(() => parseCallback('hello', expected)).toThrow(AuthError)
    expect(() => parseCallback(`https://app.accounted.se/settings?code=abc&state=st&${iss}`, expected)).toThrow(AuthError)
  })
})

describe('token endpoint', () => {
  const tokenEndpoint = DISCOVERY.token_endpoint

  it('exchanges the code with the verifier and the same redirect URI', async () => {
    const { send, calls } = fakeSend(() =>
      json(200, { access_token: 'gnubok_sk_x', refresh_token: 'gnubok_rt_x', token_type: 'Bearer', scope: 'a b' })
    )
    const tokens = await exchangeCode(send, {
      tokenEndpoint,
      code: 'abc',
      verifier: 'ver',
      redirectUri: `http://127.0.0.1:5555${CALLBACK_PATH}`,
      headers: {},
    })
    expect(tokens).toEqual({ accessToken: 'gnubok_sk_x', refreshToken: 'gnubok_rt_x', scope: 'a b' })
    expect(calls[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      code_verifier: 'ver',
      redirect_uri: `http://127.0.0.1:5555${CALLBACK_PATH}`,
      client_id: 'accounted-cli',
    })
  })

  it('turns a refused exchange into a sign-in error', async () => {
    const { send } = fakeSend(() => json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }))
    await expect(
      exchangeCode(send, { tokenEndpoint, code: 'abc', verifier: 'v', redirectUri: 'x', headers: {} })
    ).rejects.toThrow('Sign-in failed: PKCE verification failed')
  })

  it('tells an ended grant apart from a server problem on refresh', async () => {
    expect(
      await refreshTokens(fakeSend(() => json(400, { error: 'invalid_grant' })).send, { tokenEndpoint, refreshToken: 'r', headers: {} })
    ).toEqual({ invalidGrant: true })
    await expect(
      refreshTokens(fakeSend(() => json(500, { error: 'server_error' })).send, { tokenEndpoint, refreshToken: 'r', headers: {} })
    ).rejects.toThrow(UnavailableError)
  })
})

describe('startLoopback', () => {
  it('serves one callback on 127.0.0.1 and hands back the full address', async () => {
    const loopback = await startLoopback()
    try {
      const redirect = new URL(loopback.redirectUri)
      expect(redirect.hostname).toBe('127.0.0.1')
      expect(redirect.pathname).toBe(CALLBACK_PATH)

      const other = await get(`http://127.0.0.1:${redirect.port}/favicon.ico`)
      expect(other.status).toBe(404)

      const page = await get(`${loopback.redirectUri}?code=abc&state=st`)
      expect(page.status).toBe(200)
      expect(page.body).toContain('close this tab')
      expect(await loopback.result).toBe(`${loopback.redirectUri}?code=abc&state=st`)
    } finally {
      loopback.close()
    }
  })
})

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on('error', reject)
  })
}
