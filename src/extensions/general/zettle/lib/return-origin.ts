import { resolveBrandByHost } from '@/lib/branding/resolve'

/**
 * Re-validate the origin stored on a pending connection before redirecting
 * to it. The connect route stores a validated value, but company members can
 * UPDATE zettle_connections through RLS, so the column is not an authorization
 * boundary: an edited row must never turn the OAuth callback into an open
 * redirect. Accepted: the canonical app origin, or an https origin whose host
 * resolves to a brand in the brands table. Anything else falls back to the
 * app origin.
 */
export async function validateReturnOrigin(
  stored: string | null | undefined,
  appOrigin: string,
): Promise<string> {
  if (!stored) return appOrigin
  let url: URL
  try {
    url = new URL(stored)
  } catch {
    return appOrigin
  }
  if (url.origin === new URL(appOrigin).origin) return appOrigin
  if (url.protocol !== 'https:' || url.port) return appOrigin
  const brand = await resolveBrandByHost(url.hostname)
  if (!brand || brand.domain.toLowerCase() !== url.hostname.toLowerCase()) return appOrigin
  return `https://${url.hostname}`
}
