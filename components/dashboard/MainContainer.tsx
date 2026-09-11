'use client'

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { DashboardShell } from '@/types'
import { SIEImportHoldBanner } from '@/components/import/SIEImportHoldBanner'

/**
 * Picks the dashboard chrome container based on route. Extension workspaces
 * (/e/*) and the /chat app shell want the full viewport for their own
 * multi-pane layouts; everything else gets the centered max-w-5xl card.
 *
 * Lives in a client component because the parent (dashboard) layout is
 * shared across all dashboard routes. Server-side pathname checks done in
 * the layout don't re-evaluate reliably on soft navigation between sibling
 * routes, so the wrapper class would otherwise stick on whichever branch
 * the first render picked.
 */
export function MainContainer({
  companyId,
  shell = 'v1',
  children,
}: {
  companyId: string | null
  /**
   * Dashboard shell (user_preferences.ui_state.shell). 'v2' is the full-bleed
   * frame: no max-width, 24px side padding, and PageHeader restyled into a
   * top bar by the [data-shell="v2"] rules in globals.css. 'v1' is the
   * centered max-w-5xl card. Founder decision 2026-09-07; see
   * dev_docs/ui_v2_build_plan.md.
   */
  shell?: DashboardShell
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
  // shouldn't sit inside max-w-5xl or any horizontal padding: that's what
  // causes a visible gap between the dashboard sidebar and the chat-sidebar
  // pane on wide viewports.
  const isFullBleed = pathname.startsWith('/e/') || pathname.startsWith('/chat')

  // The salary run detail page drives a wide, horizontal-flow layout (progress
  // band + 5-up KPIs + full-width employee ledger) that the standard max-w-5xl
  // column squeezes. It opts into a wider canvas — a deliberate, scoped
  // exception to the locked container token. Match only /salary/runs/{id}, not
  // its nested employee sub-pages.
  const isWide = /^\/salary\/runs\/[^/]+$/.test(pathname)

  if (isFullBleed) {
    return <div key={companyId ?? ''} className="h-full"><SIEImportHoldBanner companyId={companyId}/>{children}</div>
  }

  // Shell v2: the panel is the canvas. The 16px top padding is what the
  // sticky PageHeader top bar pulls itself back over (negative margin), so
  // the two numbers must stay in step with the CSS.
  if (shell === 'v2') {
    return (
      <div key={companyId ?? ''} className="px-4 pb-8 pt-4 md:px-6">
        <SIEImportHoldBanner companyId={companyId}/>
        {children}
      </div>
    )
  }

  return (
    <div
      key={companyId ?? ''}
      className={
        isWide
          ? 'max-w-7xl mx-auto px-5 py-8 md:px-8 md:py-10'
          : 'max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10'
      }
    >
      <SIEImportHoldBanner companyId={companyId}/>
      {children}
    </div>
  )
}
