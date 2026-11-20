'use client'

import type { ExtensionDefinition } from '@/lib/extensions/types'
import { PageHeader } from '@/components/ui/page-header'
import { PADDED_CANVAS_CLASS } from '@/components/dashboard/MainContainer'
import { cn } from '@/lib/utils'

/** An extension's own page: /e/* is full-bleed (MainContainer), so the shell brings the padded canvas the top bar is tuned to. */
export default function ExtensionWorkspaceShell({
  definition,
  children,
}: {
  definition: ExtensionDefinition
  children: React.ReactNode
}) {
  return (
    <div className={cn(PADDED_CANVAS_CLASS, 'space-y-8')}>
      <PageHeader title={definition.name} />
      {children}
    </div>
  )
}
