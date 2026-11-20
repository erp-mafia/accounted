import { createServiceClient } from '@/lib/supabase/server'
import { filedVatPeriodsOfDates } from '@/lib/vat/filed-period-for-date'
import { voucherOwnerOrNull } from '@/lib/core/bookkeeping/voucher-owner'
import { getJournalEntryChain } from '@/lib/core/bookkeeping/journal-entry-chain'
import { getJournalEntryUnderlagReferences } from '@/lib/core/bookkeeping/journal-entry-references'
import { getJournalEntryRattelseLog } from '@/lib/core/bookkeeping/journal-entry-corrections'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import type { OperationContext } from '@/lib/operations/types'
import type { JournalEntryDetailRead } from '@/lib/bookkeeping/journal-entry-detail-types'

/** One company-scoped reader for server-rendered vouchers and API refreshes. */
export async function getJournalEntryDetail(ctx: OperationContext, id: string): Promise<JournalEntryDetailRead | null> {
  const { supabase, companyId, log } = ctx
  const optionalReadFailed = (error: unknown) => { log.warn("Optional voucher metadata unavailable",{error});return null }
  const chain = await getJournalEntryChain(supabase, companyId, id)
  if (!chain) return null

  // Optional history can fail independently. Unknown period status keeps
  // inline corrections gated until the server can confirm an open period.
  const [references, retag, rattelse, period, owner, filedVat] = await Promise.all([
    getJournalEntryUnderlagReferences(supabase, companyId, id).catch(optionalReadFailed),
    supabase.from('dimension_retag_log')
      .select('id, line_id, old_dimensions, new_dimensions, actor, reason, created_at')
      .eq('company_id', companyId).eq('journal_entry_id', id)
      .order('created_at', { ascending: false }),
    getJournalEntryRattelseLog(
      ctx, id, () => createServiceClient(),
    ).catch(optionalReadFailed),
    resolvePeriodStatusForDate(supabase, companyId, chain.entry.entry_date).catch(optionalReadFailed),
    voucherOwnerOrNull(supabase, companyId, {id}),
    filedVatPeriodsOfDates(supabase,companyId,[chain.entry.entry_date]).then(rows=>rows.get(chain.entry.entry_date) ?? null).catch(optionalReadFailed),
  ])
  if (!references || retag.error || !rattelse?.ok || !period) {
    log.warn('Optional journal detail metadata unavailable', {
      references: references !== null, retag: !retag.error,
      rattelse: !!rattelse?.ok, period: period !== null,
    })
  }
  return {
    ...chain,
    owned_by:owner, period:period ? {...period,filed_vat:filedVat} : null,
    references,
    retag_log: retag.error ? [] : retag.data ?? [],
    rattelse_log: rattelse?.ok && !rattelse.dryRun ? rattelse.data as JournalEntryDetailRead['rattelse_log'] : [],
    period_status: period?.status ?? null,
  }
}
