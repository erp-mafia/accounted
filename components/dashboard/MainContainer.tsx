'use client'

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import type { ReactNode } from 'react'

/**
 * Picks the dashboard chrome container based on route. Extension workspaces
 * (/e/*) and the /chat app shell want the full viewport for their own
 * multi-pane layouts; everything else gets the padded full-bleed canvas.
 *
 * Lives in a client component because the parent (dashboard) layout is
 * shared across all dashboard routes. Server-side pathname checks done in
 * the layout don't re-evaluate reliably on soft navigation between sibling
 * routes, so the wrapper class would otherwise stick on whichever branch
 * the first render picked.
 */
export function MainContainer({
  companyId,
  children,
}: {
  companyId: string | null
  children: ReactNode
}) {
  const pathname = usePathname()

  // The panel (<main>) is its own scroll container on desktop, so Next's
  // built-in scroll-to-top on navigation (which targets the window) never
  // fires for it. Reset the panel scroll on every route change; hash-anchor
  // scrolling still works because pages call scrollIntoView themselves.
  useEffect(() => {
    document.getElementById('main-content')?.scrollTo(0, 0)
  }, [pathname])

  // Full-bleed routes own their own padding + multi-pane layout. They
  // shouldn't sit inside any horizontal padding: that's what causes a
  // visible gap between the dashboard sidebar and the chat-sidebar pane on
  // wide viewports.
  const isFullBleed = pathname.startsWith('/e/') || pathname.startsWith('/chat')

  if (isFullBleed) {
    return <div key={companyId ?? ''} className="h-full">{children}</div>
  }

  // The panel is the canvas (founder decision 2026-09-07, PR #2390): no
  // max-width, 24px side padding, and PageHeader restyled into the panel's
  // top bar by the .page-header rules in globals.css. The 16px top padding
  // is what the sticky top bar pulls itself back over (negative margin), so
  // the two numbers must stay in step with the CSS.
  return (
    <div key={companyId ?? ''} className="px-4 pb-8 pt-4 md:px-6">
      {children}
    </div>
  )
}
