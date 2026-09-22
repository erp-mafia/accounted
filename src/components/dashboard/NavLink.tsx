'use client'

import Link, { type LinkProps } from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, type ComponentProps } from 'react'
import { shouldWarmNavRoute } from './nav-prefetch'

type Props = Omit<ComponentProps<typeof Link>, 'prefetch'> & { href: LinkProps['href'] }

/**
 * Sidebar / rail / mobile nav link with hover-intent prefetching.
 *
 * Why not the default viewport prefetch: the dashboard nav renders ~45
 * links, every one of which is a dynamic route with a loading boundary, so
 * Next prefetched all of them the moment the nav mounted. Each prefetch is
 * a full request through the auth proxy (Supabase Auth round trip, the
 * active-company RPC, the MFA check) whose only payload is the shared
 * loading skeleton. Prod logs showed 1,000 to 1,300 such hits per nav route
 * per day. Warming on hover/focus/touch keeps the perceived-instant click
 * for the one or two links a user is about to use and drops the other ~43.
 *
 * `prefetch={false}` also disables Link's own hover prefetch (next/link only
 * hover-prefetches when viewport prefetch is enabled), so the warm-up is an
 * explicit router.prefetch. onFocus covers keyboard users; onTouchStart
 * gives the mobile bottom nav a ~100 ms head start before the tap lands.
 */
export function NavLink({ href, onMouseEnter, onFocus, onTouchStart, children, ...rest }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const hrefString = typeof href === 'string' ? href : (href.pathname ?? '')

  const warm = useCallback(() => {
    if (shouldWarmNavRoute(hrefString, pathname)) router.prefetch(hrefString)
  }, [hrefString, pathname, router])

  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={(e) => {
        warm()
        onMouseEnter?.(e)
      }}
      onFocus={(e) => {
        warm()
        onFocus?.(e)
      }}
      onTouchStart={(e) => {
        warm()
        onTouchStart?.(e)
      }}
      {...rest}
    >
      {children}
    </Link>
  )
}
