import type { SupabaseClient } from '@supabase/supabase-js'
import {
  WORKSPACE_STALE_DAYS,
  type WorkspaceItem,
  type WorkspaceListResult,
} from '@/lib/workspace/types'

function daysSince(iso: string): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000))
}

function isStale(iso: string): boolean {
  return daysSince(iso) > WORKSPACE_STALE_DAYS
}

function draftTitle(description: string | null, entryDate: string): string {
  const d = description?.trim()
  if (d) return d
  return `Utkast ${entryDate}`
}

/**
 * Aggregate Att bokföra sources: agent pending_ops + journal drafts.
 * Does not mutate ledger state.
 */
export async function listWorkspaceItems(
  supabase: SupabaseClient,
  companyId: string,
): Promise<WorkspaceListResult> {
  const [settingsRes, pendingRes, draftsRes] = await Promise.all([
    supabase
      .from('company_settings')
      .select('is_sandbox, posting_mode')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('pending_operations')
      .select('id, operation_type, status, created_at, preview_data, title')
      .eq('company_id', companyId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('journal_entries')
      .select('id, description, entry_date, created_at, source_type, lines:journal_entry_lines(debit_amount)')
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(200),
  ])

  if (pendingRes.error) throw new Error(pendingRes.error.message)
  if (draftsRes.error) throw new Error(draftsRes.error.message)

  const postingModeRaw = (settingsRes.data as { posting_mode?: string } | null)?.posting_mode
  const postingMode =
    postingModeRaw === 'workspace_first' ? 'workspace_first' : 'direct'
  const isSandbox = Boolean((settingsRes.data as { is_sandbox?: boolean } | null)?.is_sandbox)

  const pendingItems: WorkspaceItem[] = (pendingRes.data ?? []).map((row) => {
    const preview = (row.preview_data ?? {}) as Record<string, unknown>
    const title =
      (typeof row.title === 'string' && row.title) ||
      (typeof preview.title === 'string' && preview.title) ||
      row.operation_type
    return {
      kind: 'pending_op' as const,
      id: row.id,
      title,
      createdAt: row.created_at,
      businessDate: typeof preview.entry_date === 'string' ? preview.entry_date : null,
      amountOre: typeof preview.amount_ore === 'number' ? preview.amount_ore : null,
      stale: isStale(row.created_at),
      typeLabel: row.operation_type,
      href: null,
    }
  })

  const draftItems: WorkspaceItem[] = (draftsRes.data ?? []).map((row) => {
    const lines = (row.lines ?? []) as Array<{ debit_amount?: number | null }>
    const debitSum = lines.reduce((s, l) => s + (Number(l.debit_amount) || 0), 0)
    const amountOre = debitSum > 0 ? Math.round(debitSum * 100) : null
    const businessDate = row.entry_date as string
    return {
      kind: 'journal_draft' as const,
      id: row.id,
      title: draftTitle(row.description, businessDate),
      createdAt: row.created_at,
      businessDate,
      amountOre,
      // Prefer affärshändelsedatum for BFL timing warnings
      stale: isStale(businessDate || row.created_at),
      typeLabel: row.source_type || 'manual',
      href: `/bookkeeping/${row.id}`,
    }
  })

  const items = [...draftItems, ...pendingItems].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )

  return {
    items,
    staleCount: items.filter((i) => i.stale).length,
    draftCount: draftItems.length,
    pendingOpCount: pendingItems.length,
    postingMode,
    isSandbox,
  }
}
