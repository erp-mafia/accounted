import { Skeleton } from '@/components/ui/skeleton'

/** The add-company journey while it loads: the question, its line and the choices (no card). */
export default function CompaniesLoading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4" aria-busy="true">
      <div className="w-full max-w-lg space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-full" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
    </main>
  )
}
