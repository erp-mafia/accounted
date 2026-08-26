import { Skeleton } from '@/components/ui/skeleton'

export function AuthPageSkeleton() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-frame p-4" aria-busy="true">
      <div className="w-full max-w-sm">
        <Skeleton className="mx-auto mb-8 h-12 w-48" />
        <div className="space-y-4 rounded-xl border border-border bg-background p-6">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </main>
  )
}
