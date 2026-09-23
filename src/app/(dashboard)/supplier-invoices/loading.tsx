import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'

export default function SupplierInvoicesLoading() {
  return (
    <div className="space-y-8">
      {/* Title (24px) + single "Registrera" action (pill) */}
      <PageHeader title={<Skeleton className="h-4 w-48" />} action={<Skeleton className="h-9 w-36 rounded-full" />} />

      {/* Toolbar: status picker chip + search + fiscal-year picker */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-28 rounded-full" />
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-28 rounded-full" />
      </div>

      {/* Borderless table: header row + single-line rows */}
      <div>
        <div className="flex h-10 items-center gap-4 border-b border-border px-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-4 w-44" />
            <div className="flex items-center gap-6">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
