import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * One silhouette for every stage a report loads through: the route
 * fallback, the lazy view import and the view's own fetch. The same shape
 * three times reads as one wait; three shapes read as three pages.
 */
export function ReportBodyLoading() {
  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-64" />
      </CardContent>
    </Card>
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
