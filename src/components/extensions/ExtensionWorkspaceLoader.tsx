'use client'

import type { ExtensionDefinition } from '@/lib/extensions/types'
import { getWorkspaceComponent } from '@/lib/extensions/workspace-registry'
import ExtensionWorkspaceShell from './ExtensionWorkspaceShell'
import EmptyExtensionState from './shared/EmptyExtensionState'

// Full-screen workspaces render their own chrome (top bar, title) and opt
// out of the shared ExtensionWorkspaceShell header.
const FULLSCREEN_WORKSPACES = new Set(['general/invoice-inbox'])

export default function ExtensionWorkspaceLoader({
  sector,
  slug,
  definition,
  userId,
}: {
  sector: string
  slug: string
  definition: ExtensionDefinition
  userId: string
}) {
  const WorkspaceComponent = getWorkspaceComponent(sector, slug)
  const isFullScreen = FULLSCREEN_WORKSPACES.has(`${sector}/${slug}`)

  if (isFullScreen && WorkspaceComponent) {
    return <WorkspaceComponent userId={userId} />
  }

  return (
    <ExtensionWorkspaceShell definition={definition}>
      {WorkspaceComponent ? (
        <WorkspaceComponent userId={userId} />
      ) : (
        <EmptyExtensionState
          title="Bakgrundstjänst"
          description={`${definition.name} körs i bakgrunden och har ingen egen vy. Du kan hantera inställningar under Inställningar.`}
        />
      )}
    </ExtensionWorkspaceShell>
  )
}
