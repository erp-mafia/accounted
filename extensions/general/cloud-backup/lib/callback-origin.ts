/**
 * Resolve the origin used to build OAuth redirect URIs.
 *
 * Single source of truth for BOTH legs of each provider's flow: the
 * redirect_uri sent in the authorization request and the one sent in the
 * token exchange must be byte-identical or the provider rejects the exchange
 * (RFC 6749 4.1.3). It also pins the value to the canonical app origin
 * (NEXT_PUBLIC_APP_URL) rather than whatever host the request arrived on:
 * Google and Dropbox only accept redirect URIs that are pre-registered on the
 * OAuth client, and exactly one origin per provider is registered. Deriving
 * the URI from the request meant every non-canonical host (an old app domain
 * still serving traffic, a deployment preview URL) generated an unregistered
 * redirect_uri and the provider refused the flow before the consent screen.
 *
 * Deployments without NEXT_PUBLIC_APP_URL (self-hosted) fall back to the
 * request origin, which is also the registered one there since the operator
 * registers their own OAuth apps.
 */
export function resolveCallbackOrigin(requestOrigin: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl && appUrl.trim().length > 0) {
    try {
      // `.origin` normalizes trailing slashes and strips any path, so an env
      // value like "https://app.example.se/" cannot produce a redirect_uri
      // that differs by one byte from the registered value.
      return new URL(appUrl).origin
    } catch {
      return requestOrigin
    }
  }
  return requestOrigin
}
