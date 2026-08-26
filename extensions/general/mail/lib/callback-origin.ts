/**
 * Resolve the origin used to build OAuth redirect URIs.
 *
 * Both OAuth legs must send the same redirect_uri. Pinning it to the
 * deployment's canonical app URL also prevents an old domain alias or preview
 * host from generating a callback that is not registered with the provider.
 * Self-hosted deployments without NEXT_PUBLIC_APP_URL fall back to the
 * request origin.
 */
export function resolveCallbackOrigin(requestOrigin: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl && appUrl.trim().length > 0) {
    try {
      // Normalizes trailing slashes and strips paths so the provider receives
      // the same bare origin on the authorization and token-exchange legs.
      const configuredUrl = new URL(appUrl)
      if (
        configuredUrl.protocol !== 'http:' &&
        configuredUrl.protocol !== 'https:'
      ) {
        return requestOrigin
      }
      return configuredUrl.origin
    } catch {
      return requestOrigin
    }
  }
  return requestOrigin
}
