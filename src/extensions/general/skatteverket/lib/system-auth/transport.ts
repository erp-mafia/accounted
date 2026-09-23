import crypto from 'crypto'
import https from 'node:https'
import {
  getSystemAuthMechanism,
  getSystemCaPem,
  getSystemCertPem,
  getSystemClientId,
  getSystemKeyPassphrase,
  getSystemKeyPem,
  getSystemTokenUrl,
} from './config'

/**
 * Token transport seam for the system (Client Credentials) flow.
 *
 * The exact mechanism Skatteverket uses for the org flow is pending their
 * CCG documentation: it is either mTLS at the token endpoint (client
 * certificate on the TLS handshake) or RFC 7523 private_key_jwt (a signed
 * client_assertion over plain TLS). Both are implemented behind one
 * interface so switching is an env var, not a refactor. The stub transport
 * exists for tests and local development without certificate material.
 *
 * The repo deliberately avoids undici (see lib/webhooks/pinned-fetch.ts);
 * the mTLS variant uses node:https.request, which accepts cert/key options
 * and works on both the Vercel Node runtime and Docker self-host.
 */

export interface SystemTokenResult {
  accessToken: string
  /** Unix ms timestamp when the token expires. */
  expiresAt: number
}

export interface SystemAuthTransport {
  fetchToken(scopes: string[]): Promise<SystemTokenResult>
}

class SystemTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SystemTransportError'
  }
}

interface TokenEndpointResponse {
  access_token?: string
  expires_in?: number
}

function parseTokenResponse(status: number, body: string): SystemTokenResult {
  if (status < 200 || status >= 300) {
    throw new SystemTransportError(`Skatteverket token endpoint svarade med ${status}: ${body.slice(0, 200)}`)
  }
  let parsed: TokenEndpointResponse
  try {
    parsed = JSON.parse(body) as TokenEndpointResponse
  } catch {
    throw new SystemTransportError('Skatteverket token endpoint returnerade ogiltig JSON.')
  }
  if (!parsed.access_token) {
    throw new SystemTransportError('Skatteverket token endpoint returnerade ingen access_token.')
  }
  const expiresInSec = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600
  return { accessToken: parsed.access_token, expiresAt: Date.now() + expiresInSec * 1000 }
}

/** Client Credentials over mTLS: the org certificate rides the TLS handshake. */
export const mtlsTransport: SystemAuthTransport = {
  async fetchToken(scopes: string[]): Promise<SystemTokenResult> {
    const tokenUrl = getSystemTokenUrl()
    const cert = getSystemCertPem()
    const key = getSystemKeyPem()
    if (!tokenUrl || !cert || !key) {
      throw new SystemTransportError(
        'System auth (mtls) saknar konfiguration: SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL, _CERT_PEM_B64 och _KEY_PEM_B64 krävs.'
      )
    }

    const params = new URLSearchParams({ grant_type: 'client_credentials' })
    if (scopes.length > 0) params.set('scope', scopes.join(' '))
    const clientId = getSystemClientId()
    if (clientId) params.set('client_id', clientId)
    const bodyString = params.toString()

    const url = new URL(tokenUrl)
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = https.request(
          {
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(bodyString),
            },
            cert,
            key,
            passphrase: getSystemKeyPassphrase() ?? undefined,
            ca: getSystemCaPem() ?? undefined,
            timeout: 15_000,
          },
          (res) => {
            const chunks: Buffer[] = []
            // Mid-body failures (after headers) emit 'error' on the response
            // stream, not the request: without this listener the promise
            // stays pending and the unhandled 'error' event crashes Node.
            res.on('error', reject)
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
            )
          }
        )
        req.on('timeout', () => req.destroy(new SystemTransportError('Token endpoint timeout.')))
        req.on('error', reject)
        req.write(bodyString)
        req.end()
      }
    )

    return parseTokenResponse(status, body)
  },
}

/** Client Credentials with an RFC 7523 signed client_assertion (plain TLS). */
export const privateKeyJwtTransport: SystemAuthTransport = {
  async fetchToken(scopes: string[]): Promise<SystemTokenResult> {
    const tokenUrl = getSystemTokenUrl()
    const key = getSystemKeyPem()
    const clientId = getSystemClientId()
    if (!tokenUrl || !key || !clientId) {
      throw new SystemTransportError(
        'System auth (private_key_jwt) saknar konfiguration: SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL, _KEY_PEM_B64 och _CLIENT_ID krävs.'
      )
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        iss: clientId,
        sub: clientId,
        aud: tokenUrl,
        jti: crypto.randomUUID(),
        iat: nowSec,
        exp: nowSec + 300,
      })
    ).toString('base64url')
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    const signature = signer
      .sign({ key, passphrase: getSystemKeyPassphrase() ?? undefined })
      .toString('base64url')
    const assertion = `${header}.${payload}.${signature}`

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    })
    if (scopes.length > 0) params.set('scope', scopes.join(' '))

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.text()
    return parseTokenResponse(response.status, body)
  },
}

/** Deterministic fake for tests and local development. */
export const stubTransport: SystemAuthTransport = {
  async fetchToken(): Promise<SystemTokenResult> {
    return { accessToken: 'stub-system-token', expiresAt: Date.now() + 3600 * 1000 }
  },
}

export function getSystemAuthTransport(): SystemAuthTransport {
  switch (getSystemAuthMechanism()) {
    case 'stub':
      return stubTransport
    case 'private_key_jwt':
      return privateKeyJwtTransport
    case 'mtls':
    default:
      return mtlsTransport
  }
}
