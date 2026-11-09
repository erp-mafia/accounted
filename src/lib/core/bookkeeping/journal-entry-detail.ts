import { createServiceClient } from '@/lib/supabase/server'
import { getJournalEntryChain } from './journal-entry-chain'
import { getJournalEntryUnderlagReferences } from './journal-entry-references'
import { getJournalEntryRattelseLog } from './journal-entry-corrections'
import { resolvePeriodStatusForDate } from './period-service'
import type { OperationContext } from '@/lib/operations/types'
import type { JournalEntryDetailRead } from '@/lib/bookkeeping/journal-entry-detail-types'

/** One company-scoped reader for server-rendered vouchers and API refreshes. */
export async function getJournalEntryDetail(ctx: OperationContext, id: string): Promise<JournalEntryDetailRead | null> {
  const { supabase, companyId, log } = ctx
  const chain = await getJournalEntryChain(supabase, companyId, id)
  if (!chain) return null

  // Optional history can fail independently. Unknown period status keeps
  // inline corrections gated until the server can confirm an open period.
  const [references, retag, rattelse, period] = await Promise.all([
    getJournalEntryUnderlagReferences(supabase, companyId, id).catch(() => null),
    supabase.from('dimension_retag_log')
      .select('id, line_id, old_dimensions, new_dimensions, actor, reason, created_at')
      .eq('company_id', companyId).eq('journal_entry_id', id)
      .order('created_at', { ascending: false }),
    getJournalEntryRattelseLog(
      ctx, id, () => createServiceClient(),
    ).catch(() => null),
    resolvePeriodStatusForDate(supabase, companyId, chain.entry.entry_date).catch(() => null),
  ])
  if (!references || retag.error || !rattelse?.ok || !period) {
    log.warn('Optional journal detail metadata unavailable', {
      references: references !== null, retag: !retag.error,
      rattelse: !!rattelse?.ok, period: period !== null,
    })
  }
  return {
    ...chain,
    references,
    retag_log: retag.error ? [] : retag.data ?? [],
    rattelse_log: rattelse?.ok && !rattelse.dryRun ? rattelse.data as JournalEntryDetailRead['rattelse_log'] : [],
    period_status: period?.status ?? null,
  }
}
