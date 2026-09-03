import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { ScbConfig } from './config'

export class ScbApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message)
    this.name = 'ScbApiError'
  }
}

export interface ScbHttpResponse {
  status: number
  body: string
}

/**
 * One HTTPS request with the client certificate. node:https rather than
 * fetch: undici's fetch has no portable client-certificate option inside a
 * Next.js route (same reason the Bolagsverket client does this).
 */
export function scbRequest(config: ScbConfig, method: 'GET' | 'POST', path: string, jsonBody?: unknown): Promise<ScbHttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(config.baseUrl + path)
    const payload = jsonBody === undefined ? null : JSON.stringify(jsonBody)
    const options: RequestOptions = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      pfx: config.pfx,
      passphrase: config.passphrase,
      timeout: config.timeoutMs,
    }
    const req = httpsRequest(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error('SCB svarade inte i tid')))
    req.on('error', (err) => reject(err))
    if (payload) req.write(payload)
    req.end()
  })
}

export async function scbJson<T>(config: ScbConfig, method: 'GET' | 'POST', path: string, jsonBody?: unknown): Promise<T> {
  const res = await scbRequest(config, method, path, jsonBody)
  if (res.status < 200 || res.status >= 300) {
    throw new ScbApiError(`SCB svarade ${res.status} på ${method} ${path}`, res.status, res.body.slice(0, 2000))
  }
  try {
    return JSON.parse(res.body) as T
  } catch {
    throw new ScbApiError(`SCB svarade med något annat än JSON på ${method} ${path}`, res.status, res.body.slice(0, 2000))
  }
}
