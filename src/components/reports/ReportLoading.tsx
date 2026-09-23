import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * One silhouette for every stage a report loads through: the route
 * fallback, the lazy view import and the view's own fetch. The same shape
 * three times reads as one wait; three shapes read as three pages. The
 * shape is the report's own: a row of controls, then rows of label and
 * figure, edge to edge like the report that replaces it.
 */
export function ReportBodyLoading() {
  return (
    <div className="space-y-6" aria-busy>
      <div className="flex items-center gap-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3 w-48" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center justify-between border-b border-border/60 py-2">
            <Skeleton className="h-3.5 w-56" />
            <Skeleton className="h-3.5 w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** With the title bar, for the stages before the page's own header exists. */
export function ReportPageLoading() {
  return (
    <div className="space-y-8">
      <PageHeader title={<Skeleton className="h-4 w-28" />} />
      <ReportBodyLoading />
    </div>
  )
}
