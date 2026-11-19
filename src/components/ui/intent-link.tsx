'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ComponentProps } from 'react'

type Props = Omit<ComponentProps<typeof Link>, 'prefetch'> & {
  /** Asked at each warm-up; answering false skips it (the sidebar: the page already showing). */
  warmWhen?: () => boolean
}

/**
 * A link that warms its route on intent instead of on sight: for links a
 * page renders many of, or renders on every load, to a route few of those
 * loads go on to open.
 *
 * A default <Link> prefetches its route when it scrolls into view. On a
 * list that is one prefetch per visible row, on every render, page, sort
 * and filter change, and each one is a full request through the auth proxy
 * (a Supabase Auth round trip and the active-company RPC) whose payload is
 * the target page's loading skeleton. In the week before 2026-11-12
 * production served 94 000 requests for /bookkeeping/[id], 20 000 for
 * /invoices/[id] and 14 000 for /supplier-invoices/[id], against a few
 * thousand detail views: the rest were rows nobody opened.
 *
 * No viewport prefetch, and one explicit router.prefetch when the pointer,
 * the keyboard focus or a finger reaches the link, so the click still lands
 * on a warm route. `prefetch={false}` also turns off next/link's own hover
 * prefetch, hence the explicit call. The sidebar's NavLink is this link
 * plus its own rules (components/dashboard/NavLink.tsx).
 */
export function IntentLink({ href, warmWhen, onMouseEnter, onFocus, onTouchStart, children, ...rest }: Props) {
  const router = useRouter()
  const target = typeof href === 'string' ? href : (href.pathname ?? '')
  const warm = () => {
    if (target && (warmWhen?.() ?? true)) router.prefetch(target)
  }

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
