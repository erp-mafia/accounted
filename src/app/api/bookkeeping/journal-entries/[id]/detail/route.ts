import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { getJournalEntryChain } from '@/lib/core/bookkeeping/journal-entry-chain'
import { getJournalEntryUnderlagReferences } from '@/lib/core/bookkeeping/journal-entry-references'
import { getJournalEntryRattelseLog } from '@/lib/core/bookkeeping/journal-entry-corrections'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/** Read the voucher's initial view through one authenticated request. */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.detail',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!z.uuid().safeParse(id).success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    }
    const chain = await getJournalEntryChain(supabase, companyId, id)
    if (!chain) return errorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', log, { requestId })

    // Optional history can fail independently. Unknown period status keeps
    // inline corrections gated until the server can confirm an open period.
    const [references, retag, rattelse, period] = await Promise.all([
      getJournalEntryUnderlagReferences(supabase, companyId, id).catch(() => null),
      supabase.from('dimension_retag_log')
        .select('id, line_id, old_dimensions, new_dimensions, actor, reason, created_at')
        .eq('company_id', companyId).eq('journal_entry_id', id)
        .order('created_at', { ascending: false }),
      getJournalEntryRattelseLog(
        { supabase, companyId, userId: user.id, log }, id, () => createServiceClient(),
      ).catch(() => null),
      resolvePeriodStatusForDate(supabase, companyId, chain.entry.entry_date).catch(() => null),
    ])
    if (!references || retag.error || !rattelse?.ok || !period) {
      log.warn('Optional journal detail metadata unavailable', {
        references: references !== null, retag: !retag.error,
        rattelse: !!rattelse?.ok, period: period !== null,
      })
    }
    return NextResponse.json({ data: {
      ...chain,
      references: references ?? [],
      retag_log: retag.error ? [] : retag.data ?? [],
      rattelse_log: rattelse?.ok && !rattelse.dryRun ? rattelse.data : [],
      period_status: period?.status ?? null,
    } }, { headers: { 'Cache-Control': 'private, no-store' } })
  },
)
