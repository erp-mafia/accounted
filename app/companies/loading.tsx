import { Skeleton } from '@/components/ui/skeleton'

export default function CompaniesLoading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4" aria-busy="true">
      <div className="w-full max-w-lg space-y-6 rounded-lg border bg-card p-6">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="ml-auto h-10 w-32" />
      </div>
    </main>
  )
}
