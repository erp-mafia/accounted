import { headers } from 'next/headers'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getExtensionDefinition } from '@/lib/extensions/sectors'

// Mirror of FULLSCREEN_WORKSPACES in ExtensionWorkspaceLoader. loading.tsx
// can't read route params, so we inspect the forwarded x-pathname header to
// branch the skeleton shape: the parent dashboard loading.tsx renders a
// metrics dashboard shape that has nothing to do with extension workspaces.
const FULLSCREEN_WORKSPACES = new Set(['general/invoice-inbox'])

export default async function ExtensionWorkspaceLoading() {
  const h = await headers()
  const pathname = h.get('x-pathname') ?? ''
  const match = pathname.match(/^\/e\/([^/]+)\/([^/]+)/)
  const sector = match?.[1] ?? ''
  const slug = match?.[2] ?? ''
  const key = `${sector}/${slug}`

  if (FULLSCREEN_WORKSPACES.has(key)) {
    return <FullScreenWorkspaceSkeleton />
  }

  const definition = sector && slug ? getExtensionDefinition(sector, slug) : undefined
  return (
    <div className="max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10 space-y-8">
      {definition ? (
        <PageHeader title={definition.name} />
      ) : (
        <Skeleton className="h-9 md:h-10 w-64" />
      )}
      <ShellWorkspaceBody workspaceKey={key} />
    </div>
  )
}

function ShellWorkspaceBody({ workspaceKey }: { workspaceKey: string }) {
  if (workspaceKey === 'general/tic') {
    return <TicSkeleton />
  }
  return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full rounded-lg" />
      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  )
}

function TicSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3.5 w-40" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-start gap-2">
              <Skeleton className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <Skeleton className="h-3.5 flex-1 max-w-[260px]" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0" />
              <Skeleton className="h-3.5 w-48" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0" />
              <Skeleton className="h-3.5 w-36" />
            </div>
            <div className="pt-2 border-t space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-44" />
            </div>
            <div className="pt-2 border-t space-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
            <Skeleton className="h-3 w-32 mt-2" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-44" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function FullScreenWorkspaceSkeleton() {
  return (
    <div className="h-[calc(100vh-1px)] p-4 md:p-6">
      <div className="h-full flex flex-col rounded-lg border bg-card overflow-hidden">
        <header className="flex items-center justify-between gap-4 border-b px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <Skeleton className="h-4 w-4 shrink-0" />
            <Skeleton className="h-4 w-32 shrink-0" />
            <Skeleton className="hidden md:block h-3 w-56" />
          </div>
          <Skeleton className="h-8 w-28 shrink-0" />
        </header>
        <div className="flex-1 grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)_340px] min-h-0">
          <aside className="border-b xl:border-b-0 xl:border-r overflow-hidden bg-muted/20 pt-3">
            <div className="px-3 pb-3 space-y-2 border-b">
              <Skeleton className="h-8 w-full" />
              <div className="flex flex-wrap gap-1">
                <Skeleton className="h-5 w-10 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-8 rounded-full" />
              </div>
            </div>
            <ul>
              {Array.from({ length: 7 }).map((_, i) => (
                <li key={i} className="border-b px-3 py-2 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-3 shrink-0" />
                    <Skeleton className="h-3.5 flex-1 max-w-[180px]" />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                </li>
              ))}
            </ul>
          </aside>
          <main className="overflow-hidden bg-muted/10 hidden xl:block" />
          <aside className="border-l overflow-hidden hidden xl:block" />
        </div>
      </div>
    </div>
  )
}
