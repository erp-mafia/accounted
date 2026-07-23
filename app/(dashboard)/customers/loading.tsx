import { Skeleton } from '@/components/ui/skeleton'

export default function CustomersLoading() {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-32" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28 rounded-full" />
          <Skeleton className="h-9 w-28 rounded-full" />
        </div>
      </div>
      <Skeleton className="h-10 w-full" />
      <div className="rounded-lg border border-border">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between border-b border-border/60 px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-4 w-40" />
            <div className="flex items-center gap-6">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
