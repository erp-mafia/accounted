'use client'

import { useTranslations } from 'next-intl'
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
  const t = useTranslations('extensions')
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
          title={t('workspace_background_title')}
          description={t('workspace_background_description', { name: definition.name })}
        />
      )}
    </ExtensionWorkspaceShell>
  )
}
