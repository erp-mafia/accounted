import type { SupabaseClient } from '@supabase/supabase-js'
import { getLedgerMode } from '@/lib/obx/ledger-mode'

export type PostingMode = 'direct' | 'workspace_first'

/**
 * Per-company posting mode.
 * Default: workspace_first for hybrid/local workshop (ADR 013); direct for hosted SoR
 * unless company_settings overrides.
 */
export async function getPostingMode(
  supabase: SupabaseClient,
  companyId: string,
): Promise<PostingMode> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('posting_mode')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    console.warn('[workspace] getPostingMode failed, using ledger-mode default:', error.message)
    return defaultPostingModeForLedger()
  }

  if (data?.posting_mode === 'workspace_first' || data?.posting_mode === 'direct') {
    return data.posting_mode
  }

  return defaultPostingModeForLedger()
}

function defaultPostingModeForLedger(): PostingMode {
  const mode = getLedgerMode()
  return mode === 'hosted' ? 'direct' : 'workspace_first'
}

export function isWorkspaceFirst(mode: PostingMode): boolean {
  return mode === 'workspace_first'
}
