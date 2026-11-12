'use client'

import type Link from 'next/link'
import type { LinkProps } from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import type { ComponentProps } from 'react'
import { IntentLink } from '@/components/ui/intent-link'
import { isCurrentPageHref, shouldWarmNavRoute } from './nav-prefetch'

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
 * The warm-up itself is IntentLink (components/ui/intent-link.tsx), which
 * list rows share; the sidebar adds that a link to the page already showing
 * is not warmed, and the click rule below.
 *
 * A plain click on the link to the page already showing refreshes that page
 * from the server (isCurrentPageHref): the router would otherwise serve it
 * from its cache and nothing would change. Modified clicks (new tab, etc.)
 * and string-less hrefs keep the browser's and Link's own behaviour.
 */
export function NavLink({ href, onClick, children, ...rest }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const hrefString = typeof href === 'string' ? href : (href.pathname ?? '')

  return (
    <IntentLink
      href={href}
      warmWhen={() => shouldWarmNavRoute(hrefString, pathname)}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        if (typeof href !== 'string' || (rest.target && rest.target !== '_self')) return
        if (!isCurrentPageHref(href, window.location.pathname, window.location.search)) return
        e.preventDefault()
        router.refresh()
      }}
      {...rest}
    >
      {children}
    </IntentLink>
  )
}
