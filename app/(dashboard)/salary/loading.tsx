import { Skeleton } from '@/components/ui/skeleton'

export default function SalaryLoading() {
  return (
    <div className="space-y-8">
      {/* Title (24px) + single "Starta körning" action (pill) */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-9 w-40 rounded-full" />
      </div>

      {/* Borderless table of salary runs: header row + single-line rows */}
      <div>
        <div className="flex h-10 items-center gap-4 border-b border-border px-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-4 w-32" />
            <div className="flex items-center gap-6">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
