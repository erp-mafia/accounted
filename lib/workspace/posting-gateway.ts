import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createDraftEntry,
  createJournalEntry,
} from '@/lib/bookkeeping/engine'
import { getPostingMode, isWorkspaceFirst } from '@/lib/workspace/posting-mode'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'

export type BookViaGatewayOptions = {
  /**
   * Force draft even when posting_mode is direct (e.g. explicit as_draft=true).
   */
  forceDraft?: boolean
  /**
   * Force posted even when workspace_first (system/bokslut paths).
   */
  forcePosted?: boolean
  commitMethod?: Parameters<typeof createJournalEntry>[4]
  rubricVersion?: Parameters<typeof createJournalEntry>[5]
}

/**
 * Single choke point: workspace_first → draft; direct → posted.
 * System callers pass forcePosted: true to bypass the workspace gate.
 */
export async function bookViaGateway(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateJournalEntryInput,
  opts: BookViaGatewayOptions = {},
): Promise<JournalEntry> {
  if (opts.forceDraft) {
    return createDraftEntry(supabase, companyId, userId, input)
  }
  if (opts.forcePosted) {
    return createJournalEntry(
      supabase,
      companyId,
      userId,
      input,
      opts.commitMethod,
      opts.rubricVersion,
    )
  }

  const mode = await getPostingMode(supabase, companyId)
  if (isWorkspaceFirst(mode)) {
    return createDraftEntry(supabase, companyId, userId, input)
  }

  return createJournalEntry(
    supabase,
    companyId,
    userId,
    input,
    opts.commitMethod,
    opts.rubricVersion,
  )
}
