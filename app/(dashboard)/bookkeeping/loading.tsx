import { Skeleton } from '@/components/ui/skeleton'

export default function BookkeepingLoading() {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-9 w-44" />
        <div className="flex gap-2">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-10 w-44" />
        </div>
      </div>
      <div className="space-y-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}
