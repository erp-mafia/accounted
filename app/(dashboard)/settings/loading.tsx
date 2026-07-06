import { Skeleton } from '@/components/ui/skeleton'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'

export default function SettingsLoading() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-8 w-44" />
      <div className="grid gap-8 md:grid-cols-[220px_1fr]">
        <aside className="hidden space-y-2 md:block">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </aside>
        <div className="min-w-0">
          <SettingsLoadingSkeleton />
        </div>
      </div>
    </div>
  )
}
