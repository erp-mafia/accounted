import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'

export default function PendingLoading() {
  return (
    <div className="space-y-8">
      {/* Title (24px) + conditional "Godkänn alla" action (pill) */}
      <PageHeader title={<Skeleton className="h-4 w-40" />} action={<Skeleton className="h-9 w-36 rounded-full" />} />

      {/* Toolbar: segmented tabs + source picker */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-44 rounded-full" />
        <Skeleton className="h-9 w-28 rounded-full" />
      </div>

      {/* Hairline operation rows (kicker, title, approve/reject pills),
          the shape the list renders: no boxed cards. */}
      <div>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-start gap-3 border-b border-border px-1 py-4">
            <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-4 w-64" />
              <div className="flex items-center gap-2 pt-1">
                <Skeleton className="h-6 w-24 rounded-full" />
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
