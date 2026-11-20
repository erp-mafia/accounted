/**
 * Request headers for the TIC company-data proxy (TIC_API_PROXY_URL).
 *
 * The proxy adds the Lens API key server-side, so anyone who knows its URL
 * spends our quota. With TIC_API_PROXY_SECRET set, every request carries it in
 * `x-proxy-secret`; the proxy (not in this repository) then refuses requests
 * without it. Unset, requests go out as before, so the client can ship before
 * the proxy starts enforcing.
 */
export const TIC_PROXY_SECRET_HEADER = 'x-proxy-secret'

export function ticProxyHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const secret = process.env.TIC_API_PROXY_SECRET
  if (secret && secret.trim() !== '') headers[TIC_PROXY_SECRET_HEADER] = secret.trim()
  return headers
}
