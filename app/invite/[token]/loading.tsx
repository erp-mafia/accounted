import { Skeleton } from '@/components/ui/skeleton'

export default function InviteLoading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4" aria-busy="true">
      <div className="w-full max-w-md space-y-5 rounded-lg border bg-card p-6">
        <Skeleton className="mx-auto h-12 w-12 rounded-full" />
        <Skeleton className="mx-auto h-7 w-56" />
        <Skeleton className="mx-auto h-4 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </main>
  )
}
