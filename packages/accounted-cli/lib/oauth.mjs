import crypto from 'node:crypto'
import http from 'node:http'
import readline from 'node:readline'
import { AuthError, UnavailableError } from './errors.mjs'
import { AUTH_TIMEOUT_MS } from './http.mjs'

// The server allows any loopback port and path without registration. The
// fixed path lets the server tell this CLI apart from other local clients.
export const CALLBACK_PATH = '/accounted-cli/callback'
export const CLIENT_ID = 'accounted-cli'
// Used when nothing can listen locally: nobody answers on this port, so the
// browser stops on an error page whose address holds the code to paste.
export const PASTE_PORT = 47913
// The authorization code lives five minutes on the server.
export const LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * RFC 8414 discovery. The endpoints may sit on another host than --url (an
 * unknown host is answered with the canonical one), so they are used as given.
 *
 * @param {typeof import('./http.mjs').send} send
 * @param {string} origin
 * @param {Record<string, string>} headers
 */
export async function discover(send, origin, headers) {
  const url = new URL('/.well-known/oauth-authorization-server', origin).toString()
  const res = await send({ method: 'GET', url, headers: { Accept: 'application/json', ...headers }, timeoutMs: AUTH_TIMEOUT_MS })
  if (res.status !== 200) {
    throw new UnavailableError(`Sign-in is not available: ${url} answered HTTP ${res.status}`)
  }
  let doc
  try {
    doc = JSON.parse(res.text)
  } catch {
    throw new UnavailableError(`Sign-in is not available: ${url} did not answer JSON`)
  }
  const issuer = doc?.issuer
  const authorizationEndpoint = doc?.authorization_endpoint
  const tokenEndpoint = doc?.token_endpoint
  if (typeof issuer !== 'string' || !isHttpUrl(authorizationEndpoint) || !isHttpUrl(tokenEndpoint)) {
    throw new UnavailableError(`Sign-in is not available: ${url} is missing its endpoints`)
  }
  const methods = doc.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new UnavailableError('Sign-in is not available: the server does not support PKCE S256')
  }
  return { issuer, authorizationEndpoint, tokenEndpoint }
}

/** @param {unknown} value */
function isHttpUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** @param {(size: number) => Buffer} randomBytes */
export function createPkce(randomBytes) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * No `scope` parameter on purpose: like the Claude and ChatGPT connectors,
 * the consent page then pre-ticks every permission the user's role allows
 * except Approve, pending_operations:approve (founder decisions 2026-08-26
 * and 2026-10-03), and the user can untick rows, choose read only or tick
 * Approve there. Writes always stage as proposals; only with Approve can the
 * agent approve them itself.
 *
 * @param {{ authorizationEndpoint: string, redirectUri: string, state: string, challenge: string, resource: string }} p
 */
export function authorizeUrl({ authorizationEndpoint, redirectUri, state, challenge, resource }) {
  const url = new URL(authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', resource)
  return url.toString()
}

/**
 * The code from the address the browser was sent back to. `state` ties the
 * answer to this login; `iss` (RFC 9207) to the server we asked.
 *
 * @param {string} raw
 * @param {{ state: string, issuer: string }} expected
 */
export function parseCallback(raw, { state, issuer }) {
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    throw new AuthError('That is not the address from the browser. Copy the whole address it ended on.')
  }
  if (url.pathname !== CALLBACK_PATH) {
    throw new AuthError('That is not the address the sign-in ended on. Copy the whole address from the browser.')
  }
  const params = url.searchParams
  if (params.get('state') !== state) {
    throw new AuthError('That sign-in answer belongs to another login attempt. Run `accounted login` again.')
  }
  const iss = params.get('iss')
  if (iss !== issuer) {
    throw new AuthError(`The sign-in answer names ${iss ?? 'no issuer'} instead of ${issuer}; not using it.`)
  }
  const error = params.get('error')
  if (error) {
    throw new AuthError(
      error === 'access_denied'
        ? 'Sign-in was cancelled in the browser.'
        : `Sign-in failed: ${params.get('error_description') || error}`
    )
  }
  const code = params.get('code')
  if (!code) throw new AuthError('The sign-in answer has no code. Run `accounted login` again.')
  return code
}

const DONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Accounted</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Done</h1>
<p>You can close this tab and go back to the terminal.</p>
<p lang="sv">Klart. Du kan st&auml;nga fliken och g&aring; tillbaka till terminalen.</p>
</body></html>`

/**
 * A one-shot callback server on 127.0.0.1 and an ephemeral port. Resolves
 * once listening; `result` settles with the full callback address.
 *
 * @returns {Promise<{ redirectUri: string, result: Promise<string>, close: () => void }>}
 */
export function startLoopback() {
  return new Promise((resolve, reject) => {
    /** @type {(url: string) => void} */
    let deliver = () => {}
    /** @type {Promise<string>} */
    const result = new Promise((r) => {
      deliver = r
    })
    let port = 0
    const server = http.createServer((req, res) => {
      const requested = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (requested.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { Connection: 'close' }).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
      res.end(DONE_PAGE)
      deliver(`http://127.0.0.1:${port}${req.url}`)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      port = typeof address === 'object' && address ? address.port : 0
      resolve({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        result,
        close: () => {
          server.close()
          server.closeAllConnections()
        },
      })
    })
  })
}

/**
 * One line from a terminal, with a way to give up on it when the browser
 * answered first.
 *
 * @param {NodeJS.ReadableStream} input
 * @returns {{ line: Promise<string>, cancel: () => void }}
 */
export function readPastedLine(input) {
  const rl = readline.createInterface({ input, terminal: false })
  const line = new Promise((resolve) => {
    rl.once('line', (text) => resolve(text))
  })
  return {
    line,
    cancel: () => {
      rl.close()
      if (typeof input.pause === 'function') input.pause()
    },
  }
}

/**
 * @param {typeof import('./http.mjs').send} send
 * @param {string} tokenEndpoint
 * @param {Record<string, string>} form
 * @param {Record<string, string>} headers
 */
async function tokenRequest(send, tokenEndpoint, form, headers) {
  const res = await send({
    method: 'POST',
    url: tokenEndpoint,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
    body: new URLSearchParams(form).toString(),
    timeoutMs: AUTH_TIMEOUT_MS,
  })
  let body
  try {
    body = JSON.parse(res.text)
  } catch {
    body = undefined
  }
  return { status: res.status, body }
}

/** @param {any} body */
function tokensFrom(body) {
  if (!body || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw new UnavailableError('The sign-in server answered without tokens')
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: typeof body.scope === 'string' ? body.scope : '',
  }
}

/**
 * @param {typeof import('./http.mjs').send} send
 * @param {{ tokenEndpoint: string, code: string, verifier: string, redirectUri: string, headers: Record<string, string> }} p
 */
export async function exchangeCode(send, { tokenEndpoint, code, verifier, redirectUri, headers }) {
  const { status, body } = await tokenRequest(
    send,
    tokenEndpoint,
    { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: CLIENT_ID },
    headers
  )
  if (status !== 200) {
    throw new AuthError(`Sign-in failed: ${body?.error_description ?? body?.error ?? `HTTP ${status}`}`)
  }
  return tokensFrom(body)
}

/**
 * @param {typeof import('./http.mjs').send} send
 * @param {{ tokenEndpoint: string, refreshToken: string, headers: Record<string, string> }} p
 * @returns {Promise<{ invalidGrant: true } | { invalidGrant: false, tokens: ReturnType<typeof tokensFrom> }>}
 */
export async function refreshTokens(send, { tokenEndpoint, refreshToken, headers }) {
  const { status, body } = await tokenRequest(
    send,
    tokenEndpoint,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
    headers
  )
  if (status === 200) return { invalidGrant: false, tokens: tokensFrom(body) }
  if (body?.error === 'invalid_grant') return { invalidGrant: true }
  throw new UnavailableError(`Could not renew the sign-in: ${body?.error_description ?? body?.error ?? `HTTP ${status}`}`)
}
