'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { AlertCircle, FileText } from 'lucide-react'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionFilterValue } from '@/components/reports/DimensionFilter'

// Shared shells for the report bodies, so all views read as the same
// instrument: Skeleton while loading, EmptyState when the period has no data,
// a quiet destructive card on fetch errors (design.md primitives).
export function ReportLoadingCard() {
  return (
    <Card>
      <CardContent className="p-6 space-y-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}

export function ReportErrorCard({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="p-8 text-center text-destructive">
        <AlertCircle className="h-6 w-6 mx-auto mb-2" />
        {message}
      </CardContent>
    </Card>
  )
}

export function ReportEmptyState({ title, description }: { title: string; description: string }) {
  return <EmptyState icon={FileText} title={title} description={description} />
}

/** Encode the shared period, date and dimension filters for report requests and exports. */
export function reportQuery(
  periodId: string,
  range?: DateRangeValue,
  dimensionFilter?: DimensionFilterValue | null,
): string {
  const params = new URLSearchParams({ period_id: periodId })
  if (range?.fromDate) params.set('from_date', range.fromDate)
  if (range?.toDate) params.set('to_date', range.toDate)
  if (dimensionFilter) {
    params.set('dim_no', dimensionFilter.dimNo)
    params.set('dim_code', dimensionFilter.code)
  }
  return params.toString()
}
