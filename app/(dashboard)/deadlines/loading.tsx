import { Skeleton } from '@/components/ui/skeleton'

export default function DeadlinesLoading() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-8 w-44" />
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="flex items-start gap-4 rounded-lg border border-border p-4"
          >
            <div className="w-12 space-y-1">
              <Skeleton className="h-6 w-10" />
              <Skeleton className="h-3 w-12" />
            </div>
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-72" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}
