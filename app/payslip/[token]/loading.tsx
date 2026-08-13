import { Skeleton } from '@/components/ui/skeleton'

export default function PayslipLoading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5" aria-busy="true">
      <div className="w-full max-w-2xl space-y-6 rounded-lg border bg-card p-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    </main>
  )
}
