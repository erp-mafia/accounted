import http from 'node:http'
import https from 'node:https'
import { UnavailableError } from './errors.mjs'

// MCP calls can run up to 800 s on the server, and the answer only arrives at
// the end. Node's built-in fetch gives up after 300 s without response
// headers, reports a failure while the server finishes the write anyway, and
// invites a retry that stages it twice. node:http(s) has no such cap.
export const MCP_TIMEOUT_MS = 820_000
export const AUTH_TIMEOUT_MS = 30_000

/**
 * @typedef {{ method: string, url: string, headers?: Record<string, string>, body?: string, timeoutMs: number }} HttpRequest
 * @typedef {{ status: number, headers: Record<string, string | string[] | undefined>, text: string }} HttpResponse
 */

/**
 * One HTTP exchange. Redirects are never followed (the caller sees the 3xx),
 * no Origin header is sent (the MCP server refuses foreign origins), and each
 * request gets its own connection so the process exits as soon as it is done.
 *
 * @param {HttpRequest} req
 * @returns {Promise<HttpResponse>}
 */
export function send(req) {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url)
    const lib = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null
    if (!lib) {
      reject(new UnavailableError(`Unsupported URL: ${req.url}`))
      return
    }
    const body = req.body === undefined ? undefined : Buffer.from(req.body, 'utf8')
    const headers = { ...(req.headers ?? {}) }
    if (body) headers['Content-Length'] = String(body.length)

    const request = lib.request(url, { method: req.method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      )
      res.on('error', (err) => reject(new UnavailableError(`Connection error: ${err.message}`)))
    })
    request.setTimeout(req.timeoutMs, () => {
      request.destroy(new Error(`no answer within ${Math.round(req.timeoutMs / 1000)} s`))
    })
    request.on('error', (err) => {
      reject(new UnavailableError(`Could not reach ${url.host}: ${err.message}`))
    })
    if (body) request.write(body)
    request.end()
  })
}

/**
 * @param {HttpResponse} res
 * @param {string} name lower-case header name
 */
export function header(res, name) {
  const value = res.headers[name]
  return Array.isArray(value) ? value[0] : value
}
