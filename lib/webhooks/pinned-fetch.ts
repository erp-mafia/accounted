/**
 * Pinned-IP HTTPS POST for webhook dispatch.
 *
 * Closes the DNS-rebinding window between url-guard validation and the
 * actual HTTPS request. The previous shape was:
 *
 *   1. validateWebhookUrl()  → DNS resolves to [public IP], returns ok
 *   2. fetch(webhook_url)    → re-resolves DNS; an attacker who flipped
 *                              the A record in the interval gets a
 *                              private-IP socket
 *
 * The new shape pins the request to the IP validated in step 1, with the
 * original hostname carried in:
 *   - the TLS SNI extension (so the receiver's cert continues to match)
 *   - the HTTP Host header (so vhost routing on the receiver continues to
 *     work)
 *
 * The request socket therefore never re-resolves DNS, foreclosing the
 * rebind race. Documented openly per the url-guard.ts file header
 * ("closing that requires a custom HTTPS agent that pins the resolved IP").
 *
 * Built on `node:https.request` rather than undici's Agent because (a) the
 * project doesn't take a dependency on undici, (b) the stdlib API is more
 * explicit about the SNI / Host / IP split, (c) https.request is enough
 * for HTTP/1.1 + TLS, which every webhook receiver supports.
 *
 * Inversion seam: `httpsRequest` injectable for tests so we don't need to
 * stand up an HTTPS server to verify the pinning / SNI / Host shape. The
 * dispatcher's tests pass a stub through `pinnedFetchImpl`.
 */

import {
  request as httpsRequestDefault,
  type RequestOptions as HttpsRequestOptions,
} from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { validateWebhookUrl as validateWebhookUrlDefault } from './url-guard'

export type PinnedFetchResult =
  | {
      kind: 'ok'
      status: number
      headers: Record<string, string>
      body: string
      bodyTruncated: boolean
      pinnedAddress: string
    }
  | { kind: 'unsafe_url'; reason: string; detail: string; pinnedAddress: null }
  | { kind: 'redirect_blocked'; status: number; detail: string; pinnedAddress: string }
  | { kind: 'timeout'; detail: string; pinnedAddress: string }
  | { kind: 'transport_error'; detail: string; pinnedAddress: string | null }

export interface PinnedFetchInit {
  method: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  /** Max bytes captured from response body: receivers returning long error pages get truncated. */
  maxResponseBytes: number
}

export interface PinnedFetchDeps {
  /** DNS validation seam. Defaults to url-guard's validateWebhookUrl. */
  validateUrl?: typeof validateWebhookUrlDefault
  /** Raw HTTPS request seam. Defaults to node:https.request. */
  httpsRequest?: (
    options: HttpsRequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => ClientRequest
}

export async function pinnedHttpsFetch(
  rawUrl: string,
  init: PinnedFetchInit,
  deps: PinnedFetchDeps = {},
): Promise<PinnedFetchResult> {
  const validateUrl = deps.validateUrl ?? validateWebhookUrlDefault
  const httpsRequest = deps.httpsRequest ?? httpsRequestDefault

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return {
      kind: 'unsafe_url',
      reason: 'invalid_url',
      detail: 'URL did not parse.',
      pinnedAddress: null,
    }
  }

  const validation = await validateUrl(rawUrl)
  if (!validation.ok) {
    return {
      kind: 'unsafe_url',
      reason: validation.reason,
      detail: validation.detail,
      pinnedAddress: null,
    }
  }

  // Pick the first vetted address. validateWebhookUrl rejects the whole
  // set when ANY entry is unsafe, so the first is safe by construction.
  // Deterministic choice keeps log output stable across retries.
  const pinnedAddress = validation.resolvedAddresses[0]
  if (!pinnedAddress) {
    // Defensive: validateWebhookUrl returns ok only when there's at least
    // one address, but a future refactor could regress this and we want
    // the failure to be loud, not a silent DNS-lookup-by-empty-host.
    return {
      kind: 'transport_error',
      detail: 'No resolved address from validateWebhookUrl',
      pinnedAddress: null,
    }
  }

  const port = parsed.port ? Number(parsed.port) : 443

  return new Promise<PinnedFetchResult>((resolve) => {
    let settled = false
    const settle = (r: PinnedFetchResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    // The HTTP Host header must carry the original hostname (vhost routing
    // on the receiver). Include the port only when non-default: RFC 7230
    // §5.4 says the port is omitted when it matches the scheme default.
    const hostHeader = port === 443 ? parsed.hostname : `${parsed.hostname}:${port}`

    const requestOptions: HttpsRequestOptions = {
      protocol: 'https:',
      // Pin the socket to the validated IP. node:https accepts the
      // address directly: no further DNS lookup happens.
      host: pinnedAddress,
      port,
      path: parsed.pathname + parsed.search,
      method: init.method,
      // SNI carries the original hostname so the receiver's TLS cert
      // (which is issued for the hostname, not the IP) validates.
      //
      // Cert-vs-hostname verification: Node's default checkServerIdentity
      // matches the cert's SAN/CN against `servername` (or `host` when
      // servername is unset). Because `servername` is set to the original
      // hostname, the IP substitution above does NOT weaken the hostname-
      // verification step: a forged endpoint at the pinned IP presenting
      // a valid cert for a DIFFERENT hostname would fail the handshake.
      // No explicit checkServerIdentity override is needed; relying on
      // the default is the documented contract.
      servername: parsed.hostname,
      headers: {
        ...init.headers,
        // Lowercase 'host': Node's https.request would synthesise one
        // from `host` (the pinned IP) if we didn't set it explicitly,
        // which would break vhost routing on the receiver.
        host: hostHeader,
      },
      // Fresh socket per call: webhook delivery doesn't benefit from
      // Keep-Alive (the dispatcher serializes and the IP changes per
      // dispatch from re-validation). agent:false also forecloses any
      // accidental pool-level reuse across pinned IPs.
      agent: false,
    }

    let absoluteTimer: NodeJS.Timeout | null = null

    const req = httpsRequest(requestOptions, (res) => {
      // Receivers MUST return a non-redirect. Following a 3xx would let
      // them bounce the dispatcher to a private address AFTER the SSRF
      // guard cleared. We don't follow redirects; treat as terminal here
      // and let the dispatcher mark the row dead with reason='redirect_
      // blocked' for consistency with the old fetch path's behavior.
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        // Drain body so the socket cleans up; ignore errors.
        res.resume()
        req.destroy()
        if (absoluteTimer) clearTimeout(absoluteTimer)
        return settle({
          kind: 'redirect_blocked',
          status,
          detail: `Receiver returned ${status}; redirects are refused.`,
          pinnedAddress,
        })
      }

      const chunks: Buffer[] = []
      let total = 0
      let truncated = false

      res.on('data', (chunk: Buffer) => {
        if (truncated) return
        if (total + chunk.length > init.maxResponseBytes) {
          const remaining = init.maxResponseBytes - total
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
          total = init.maxResponseBytes
          truncated = true
          // Destroy the stream: no point pulling the rest over the wire.
          res.destroy()
        } else {
          chunks.push(chunk)
          total += chunk.length
        }
      })

      const finalize = () => {
        if (absoluteTimer) clearTimeout(absoluteTimer)
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k] = v
          else if (Array.isArray(v)) headers[k] = v.join(', ')
        }
        settle({
          kind: 'ok',
          status,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
          bodyTruncated: truncated,
          pinnedAddress,
        })
      }

      // Two completion paths to handle: 'end' (normal completion) and
      // 'close' (when we destroyed the stream for size truncation, where
      // 'end' does not fire). Node emits BOTH 'end' and 'close' on normal
      // completions, so `once()` + a self-removing pair keeps finalize
      // single-shot without relying on the outer `settled` guard to
      // squash duplicate header reconstruction.
      const finalizeOnce = () => {
        res.removeListener('end', finalizeOnce)
        res.removeListener('close', finalizeOnce)
        finalize()
      }
      res.once('end', finalizeOnce)
      res.once('close', finalizeOnce)
      res.on('error', (err) => {
        if (absoluteTimer) clearTimeout(absoluteTimer)
        settle({ kind: 'transport_error', detail: err.message, pinnedAddress })
      })
    })

    // Two-layer timeout: socket-idle timeout via Node's built-in, plus a
    // wall-clock absolute timeout. node:https `timeout` is idle-only and
    // wouldn't fire if a slow receiver dribbles bytes; the absolute timer
    // is the hard cap.
    req.setTimeout(init.timeoutMs)
    req.on('timeout', () => {
      req.destroy()
      if (absoluteTimer) clearTimeout(absoluteTimer)
      settle({
        kind: 'timeout',
        detail: `Socket idle for ${init.timeoutMs} ms`,
        pinnedAddress,
      })
    })

    absoluteTimer = setTimeout(() => {
      req.destroy()
      settle({
        kind: 'timeout',
        detail: `Request exceeded ${init.timeoutMs} ms wall-clock`,
        pinnedAddress,
      })
    }, init.timeoutMs)

    req.on('error', (err) => {
      if (absoluteTimer) clearTimeout(absoluteTimer)
      settle({ kind: 'transport_error', detail: err.message, pinnedAddress })
    })

    if (init.body) req.write(init.body)
    req.end()
  })
}
