'use client'

import { usePathname } from 'next/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Shared loading fallback for the dashboard segment. It is the Suspense
 * fallback for Hem (app/(dashboard)/page.tsx) and for every child route that
 * has no loading.tsx of its own. The top bar carries the title, so the
 * fallback is the bar plus hairline-separated rows: the silhouette of every
 * list page, and neutral enough on the pages that are not lists.
 *
 * /chat is the exception: MainContainer renders it full-bleed (no padding),
 * so the rows would stretch edge-to-edge and read broken. The chat branch
 * mirrors the two-pane chat shell instead: conversation sidebar + empty
 * conversation pane (see ChatLayout/ChatSidebar).
 */
export default function DashboardLoading() {
  const pathname = usePathname()

  if (pathname.startsWith('/chat')) {
    return (
      <div className="flex h-full">
        {/* Desktop mounts ChatSidebar COLLAPSED (a 48px rail), so the skeleton
            must be a rail too: a 320px skeleton that snapped to 48px on hydrate
            was a visible layout jump on every /chat load. Mobile mounts the
            full-width list, so that shape stays there. */}
        <aside className="hidden md:flex md:w-12 shrink-0 flex-col items-center border-r border-border bg-card/40 py-3 gap-2">
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-8 w-8" />
        </aside>
        <aside className="flex w-full flex-col border-r border-border bg-card/40 md:hidden shrink-0">
          <div className="space-y-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            </div>
            <Skeleton className="h-8 w-full" />
          </div>
          <div className="space-y-1 p-3">
            {['w-40', 'w-48', 'w-36', 'w-44'].map((w, i) => (
              <div key={i} className="space-y-1.5 px-2 py-2.5">
                <Skeleton className={`h-3.5 ${w}`} />
                <Skeleton className="h-2.5 w-24" />
              </div>
            ))}
          </div>
        </aside>
        <div className="hidden min-w-0 flex-1 bg-background md:block" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader title={<Skeleton className="h-4 w-24" />} />
      <div>
        {['w-44', 'w-52', 'w-40', 'w-48', 'w-44', 'w-56'].map((w, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-border px-1 py-3.5">
            <Skeleton className={`h-3.5 ${w}`} />
            <Skeleton className="ml-auto h-3.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}
