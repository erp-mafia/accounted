'use client'

import type { ExtensionDefinition } from '@/lib/extensions/types'
import { PageHeader } from '@/components/ui/page-header'

export default function ExtensionWorkspaceShell({
  definition,
  children,
}: {
  definition: ExtensionDefinition
  children: React.ReactNode
}) {
  return (
    <div className="max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10 space-y-8">
      <PageHeader title={definition.name} />
      {children}
    </div>
  )
}
