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
