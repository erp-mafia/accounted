'use client'

import { usePathname } from 'next/navigation'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { getExtensionDefinition } from '@/lib/extensions/sectors'
import InvoiceInboxSkeleton from '@/components/extensions/general/InvoiceInboxSkeleton'

// Mirror of FULLSCREEN_WORKSPACES in ExtensionWorkspaceLoader. loading.tsx
// can't read route params, so we branch on the client pathname: the parent
// dashboard loading.tsx renders a metrics dashboard shape that has nothing
// to do with extension workspaces. (This must stay a client component: the
// x-pathname header middleware sets goes on the response, so headers() in a
// server loading file never sees it and the fullscreen branch went dead.)
const FULLSCREEN_WORKSPACES = new Set(['general/invoice-inbox'])

export default function ExtensionWorkspaceLoading() {
  const pathname = usePathname()
  const match = pathname.match(/^\/e\/([^/]+)\/([^/]+)/)
  const sector = match?.[1] ?? ''
  const slug = match?.[2] ?? ''
  const key = `${sector}/${slug}`

  if (FULLSCREEN_WORKSPACES.has(key)) {
    return <InvoiceInboxSkeleton />
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
