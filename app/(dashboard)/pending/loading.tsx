import { Skeleton } from '@/components/ui/skeleton'

export default function PendingLoading() {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-36 rounded-full" />
      </div>
      <div className="rounded-lg border border-border">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-border/60 px-4 py-4 last:border-b-0"
          >
            <Skeleton className="h-7 w-7 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-3 w-40" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-24 rounded-full" />
              <Skeleton className="h-8 w-24 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
