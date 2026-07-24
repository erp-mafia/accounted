import { Skeleton } from '@/components/ui/skeleton'

/**
 * Shared loading fallback for the dashboard segment. It is the Suspense
 * fallback for Hem (app/(dashboard)/page.tsx) and for every child route that
 * has no loading.tsx of its own, so it deliberately mirrors Hem's silhouette:
 * a greeting hero (H1 + date line) followed by a single "Att göra"-style pane
 * of list rows (see DashboardContent / AttGoraSection).
 *
 * A greeting + hairline-separated rows reads honestly on Hem and stays neutral
 * on the plain list pages that fall back here (a page title + rows), which is
 * why it is not shaped like any one page's specific grid.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-8">
      {/* Greeting hero (title + date line) */}
      <section>
        <Skeleton className="h-7 w-52" />
        <Skeleton className="mt-2 h-3.5 w-64" />
      </section>

      {/* Single pane: header over a hairline, then list rows */}
      <section>
        <div className="flex items-baseline justify-between border-b border-border px-1 pb-2.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>

        <Skeleton className="ml-1 mt-5 mb-1 h-2.5 w-20" />
        <div>
          {['w-44', 'w-52', 'w-40', 'w-48', 'w-44'].map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-3 border-b border-border px-1 py-3.5"
            >
              <Skeleton className="mt-px h-[15px] w-[15px] shrink-0 rounded" />
              <Skeleton className={`h-3.5 ${w}`} />
              <Skeleton className="ml-auto h-5 w-7 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
