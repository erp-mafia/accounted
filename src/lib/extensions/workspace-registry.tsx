import type { ComponentType } from 'react'
import { WORKSPACES } from './_generated/workspace-map'

export interface WorkspaceComponentProps {
  userId: string
}

export function getWorkspaceComponent(
  sector: string,
  slug: string
): ComponentType<WorkspaceComponentProps> | null {
  return WORKSPACES[`${sector}/${slug}`] ?? null
}
