/**
 * Whether hovering/focusing a nav link should warm its route.
 *
 * The link to the page you are already on has nothing to warm, and a
 * hash-only or external href is not a route. Pure so it can be unit tested.
 */
export function shouldWarmNavRoute(href: string, currentPathname: string | null): boolean {
  if (!href.startsWith('/')) return false
  if (href.startsWith('//')) return false
  const path = href.split(/[?#]/)[0]
  return path !== currentPathname
}

/**
 * Whether a nav link points at exactly the page already showing (same path,
 * same query, no hash), so a plain click should re-render it from the server
 * instead of navigating. Next's router serves that click from its cache
 * (staleTimes.dynamic in next.config.ts), so without this the click does
 * nothing visible: on Att göra, people clicked "Att göra" to see the latest
 * list and got the same one. A link that differs only in its query (clearing
 * a filter) is a real navigation and stays one. Pure so it can be unit tested.
 */
export function isCurrentPageHref(href: string, currentPathname: string, currentSearch: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false
  if (href.includes('#')) return false
  const [path, query = ''] = href.split('?')
  const hrefSearch = query ? `?${query}` : ''
  return path === currentPathname && hrefSearch === currentSearch
}
