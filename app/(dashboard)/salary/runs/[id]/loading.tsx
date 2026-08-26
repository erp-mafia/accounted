import { Skeleton } from '@/components/ui/skeleton'

/** Route-level fallback for a salary run: mirrors the page's own loading state (wide two-column layout). */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <Skeleton className="h-9 w-60" />
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_280px] gap-8 space-y-6 lg:space-y-0">
        <Skeleton className="rounded-lg h-48" />
        <Skeleton className="rounded-lg h-64 hidden lg:block" />
      </div>
    </div>
  )
}
