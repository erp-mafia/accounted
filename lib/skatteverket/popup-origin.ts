/**
 * Origins the Skatteverket OAuth popup may post back from.
 *
 * The OAuth callback is served from the host pinned by
 * NEXT_PUBLIC_SKV_OAUTH_BASE_URL: the redirect_uri registered with
 * Skatteverket in Utvecklarportalen, kept on the legacy app.gnubok.se
 * domain after the user-facing app moved to app.accounted.se. The panels
 * that open the popup therefore accept postMessage events from that origin
 * in addition to their own.
 *
 * Origin alone is never sufficient: callers must also verify that
 * event.source is the popup window they themselves opened.
 */
export function isAllowedSkvPopupOrigin(eventOrigin: string, windowOrigin: string): boolean {
  if (eventOrigin === windowOrigin) return true
  const base = process.env.NEXT_PUBLIC_SKV_OAUTH_BASE_URL
  if (!base) return false
  try {
    return eventOrigin === new URL(base).origin
  } catch {
    return false
  }
}
