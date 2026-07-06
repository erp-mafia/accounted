// AUTO-GENERATED: do not edit. Run `npm run setup:extensions` to regenerate.
import dynamic from 'next/dynamic'
import type { ComponentType } from 'react'
import type { WorkspaceComponentProps } from '../workspace-registry'

export const WORKSPACES: Record<string, ComponentType<WorkspaceComponentProps>> = {
  'general/enable-banking': dynamic(() => import('@/components/extensions/general/EnableBankingWorkspace')),
  'general/arcim-migration': dynamic(() => import('@/components/extensions/general/ArcimMigrationWorkspace')),
  'general/tic': dynamic(() => import('@/components/extensions/general/TicWorkspace')),
  'general/cloud-backup': dynamic(() => import('@/components/extensions/general/CloudBackupWorkspace')),
  'general/invoice-inbox': dynamic(() => import('@/components/extensions/general/InvoiceInboxWorkspace')),
}
