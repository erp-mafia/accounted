import { Skeleton } from '@/components/ui/skeleton'

export default function KpiLoading() {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-9 w-44 rounded-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="rounded-lg border border-border p-4">
            <Skeleton className="mb-3 h-3 w-24" />
            <Skeleton className="mb-2 h-7 w-32" />
            <Skeleton className="h-3 w-40" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border p-6">
        <Skeleton className="mb-4 h-4 w-40" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  )
}
