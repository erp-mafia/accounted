'use client'

import { usePathname } from 'next/navigation'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/ui/page-header'
import { PADDED_CANVAS_CLASS } from '@/components/dashboard/MainContainer'
import { cn } from '@/lib/utils'
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

  if (FULLSCREEN_WORKSPACES.has(`${sector}/${slug}`)) {
    return <InvoiceInboxSkeleton />
  }

  const definition = sector && slug ? getExtensionDefinition(sector, slug) : undefined
  // ExtensionWorkspaceShell's frame: the top bar, then the workspace's rows.
  return (
    <div className={cn(PADDED_CANVAS_CLASS, 'space-y-8')}>
      <PageHeader title={definition ? definition.name : <Skeleton className="h-4 w-44" />} />
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </div>
  )
}
