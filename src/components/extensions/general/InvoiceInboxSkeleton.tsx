import { Skeleton } from '@/components/ui/skeleton'

// Single source of truth for the Dokumentinkorg loading silhouette, rendered
// by both the route-level loading.tsx and the workspace's own client-fetch
// state so the route fallback, the fetch shell, and the loaded UI are one
// shape with no reflow. Mirrors the live layout: full-bleed top bar +
// 3-pane grid, list pane with search + filter-dropdown trigger (PR #1524
// replaced the old filter-pill row with a single full-width dropdown).
export default function InvoiceInboxSkeleton() {
  return (
    <div className="h-[calc(100vh-1px)] md:h-full">
      <div className="h-full flex flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-4 border-b px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <Skeleton className="h-4 w-4 shrink-0" />
            <Skeleton className="h-4 w-32 shrink-0" />
            <Skeleton className="hidden md:block h-3 w-56" />
          </div>
          <Skeleton className="h-8 w-28 shrink-0" />
        </header>
        <div className="flex-1 grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)_340px] min-h-0">
          <aside className="border-b xl:border-b-0 xl:border-r overflow-hidden bg-muted/20 pt-3">
            <div className="px-3 pb-3 space-y-2 border-b">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
            <ul>
              {Array.from({ length: 7 }).map((_, i) => (
                <li key={i} className="border-b px-3 py-2 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-3 shrink-0" />
                    <Skeleton className="h-3.5 flex-1 max-w-[180px]" />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                </li>
              ))}
            </ul>
          </aside>
          <main className="overflow-hidden bg-muted/10 hidden xl:block" />
          <aside className="border-l overflow-hidden hidden xl:block" />
        </div>
      </div>
    </div>
  )
}
