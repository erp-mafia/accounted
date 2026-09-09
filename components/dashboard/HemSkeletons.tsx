import { Skeleton } from '@/components/ui/skeleton'

/** Suspense fallback for the setup checklist block. */
export function ChecklistSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border border-border p-5" aria-busy="true">
      <Skeleton className="h-4 w-40" />
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <Skeleton className="h-4 w-64" />
        </div>
      ))}
    </div>
  )
}

/** Suspense fallback for the Att göra + Fortsätt panes. */
export function PanesSkeleton() {
  return (
    <div className="grid items-start gap-x-6 gap-y-8 md:grid-cols-2" aria-busy="true">
      {[0, 1].map((col) => (
        <div key={col}>
          <Skeleton className="mb-3 h-4 w-24" />
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4 border-b border-border px-1 py-3 last:border-b-0">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-10" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Suspense fallback for the three-pane Att göra (shell v2): the same grid
 * as AttGoraV2 without notices, so the page settles in place instead of
 * swapping a two-column pane list for three columns.
 */
export function AttGoraSkeleton() {
  return (
    <div
      className="-mx-4 -mt-4 -mb-8 grid md:-mx-6 md:h-[calc(100vh-108px)] md:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_256px]"
      aria-busy="true"
    >
      <aside className="border-b border-border/60 px-2 py-3 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-3 pb-2">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="h-2.5 w-12" />
        </div>
        {['w-36', 'w-32', 'w-40', 'w-28'].map((w, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2">
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <Skeleton className={`h-3.5 ${w}`} />
            <Skeleton className="ml-auto h-3 w-6" />
          </div>
        ))}
      </aside>
      <section className="min-w-0 px-4 py-5 md:px-6">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-2 h-3 w-16" />
        <div className="mt-6">
          {['w-64', 'w-56', 'w-72', 'w-60', 'w-52'].map((w, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border/60 py-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className={`h-3.5 ${w}`} />
              <Skeleton className="ml-auto h-3.5 w-16" />
            </div>
          ))}
        </div>
      </section>
      <aside className="hidden border-l border-border/60 xl:block">
        <div className="space-y-2 border-b border-border/60 px-4 pb-4 pt-3.5">
          <Skeleton className="h-2.5 w-14" />
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-48" />
        </div>
      </aside>
    </div>
  )
}
