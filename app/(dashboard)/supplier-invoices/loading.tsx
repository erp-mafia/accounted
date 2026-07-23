import { Skeleton } from '@/components/ui/skeleton'

export default function SupplierInvoicesLoading() {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-9 w-36 rounded-full" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-9 flex-1" />
      </div>
      <div className="rounded-lg border border-border">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between border-b border-border/60 px-4 py-3 last:border-b-0"
          >
            <div className="space-y-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-28" />
            </div>
            <div className="flex items-center gap-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-5 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
