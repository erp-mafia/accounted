/**
 * Emailed auth links spend their one-time token on a click, never on a fetch.
 *
 * Mail scanners and link checkers open the links in an email before the user
 * does: on delivery, and again at the moment of the click (some send a HEAD
 * first). A link that verified its token on arrival was used up by the first
 * of those fetches, and the user's own click then failed as an expired link
 * (Supabase documents this as email prefetching). So GET /auth/callback only
 * holds an emailed token_hash in a cookie and redirects to /auth/confirm,
 * whose button posts back to the callback; that POST is the one place the
 * token is verified. Scanners fetch pages, they do not submit forms.
 *
 * The token travels in the cookie, not in the confirm page's URL: a page URL
 * is recorded by analytics pageviews and session replay and kept in browser
 * history, and an unspent token_hash is a sign-in.
 */

export const CONFIRM_LINK_COOKIE = 'accounted-confirm-link'

/** Sent only to the callback, the one reader. */
export const CONFIRM_LINK_COOKIE_PATH = '/auth/callback'

/**
 * Far longer than landing on the confirm page and clicking takes, and short
 * enough that an unused token does not linger in the browser.
 */
export const CONFIRM_LINK_MAX_AGE_SECONDS = 60 * 60

/**
 * Where the confirm button posts: the callback, with the link's own query
 * (type, next, flow) so the callback and the middleware read the parameters
 * the emailed link carried. Never the token itself.
 */
export function confirmFormAction(query: URLSearchParams): string {
  const params = new URLSearchParams(query)
  params.delete('token_hash')
  const search = params.toString()
  return search ? `${CONFIRM_LINK_COOKIE_PATH}?${search}` : CONFIRM_LINK_COOKIE_PATH
}
