// AUTO-GENERATED: do not edit. Run `npm run setup:extensions` to regenerate.
import dynamic from 'next/dynamic'
import type { ComponentType } from 'react'
import type { WorkspaceComponentProps } from '../workspace-registry'

export const WORKSPACES: Record<string, ComponentType<WorkspaceComponentProps>> = {
  'general/arcim-migration': dynamic(() => import('@/components/extensions/general/ArcimMigrationWorkspace')),
  'general/invoice-inbox': dynamic(() => import('@/components/extensions/general/InvoiceInboxWorkspace')),
}
