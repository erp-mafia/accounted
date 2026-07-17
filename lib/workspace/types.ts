/** Unified item shown on Att bokföra (/pending). */

export type WorkspaceItemKind = 'pending_op' | 'journal_draft'

export interface WorkspaceItem {
  kind: WorkspaceItemKind
  id: string
  title: string
  createdAt: string
  /** Business date when known (entry_date for drafts). */
  businessDate: string | null
  amountOre: number | null
  stale: boolean
  /** pending_operations.operation_type or journal source_type */
  typeLabel: string
  href: string | null
}

export interface WorkspaceListResult {
  items: WorkspaceItem[]
  staleCount: number
  draftCount: number
  pendingOpCount: number
  postingMode: 'direct' | 'workspace_first'
  isSandbox: boolean
}

export const WORKSPACE_STALE_DAYS = 30
