import 'server-only'

import { z } from 'zod'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'
import { getJournalEntryDetail } from '@/lib/core/bookkeeping/journal-entry-detail'
import { createLogger } from '@/lib/logger'

const log = createLogger('bookkeeping.journal_entry.initial')

/** Start alongside the dashboard layout, before client JavaScript is loaded. */
export async function getInitialJournalEntryDetail(id: string) {
  if (!z.uuid().safeParse(id).success) return undefined
  try {
    const [{ supabase, user }, companyId] = await Promise.all([
      getDashboardAuthContext(), getDashboardCompanyId(),
    ])
    if (!user || !companyId) return undefined
    const data = await getJournalEntryDetail({ supabase, companyId, userId: user.id, log }, id)
    return data ? { companyId, data } : undefined
  } catch (error) {
    // Preserve the client error/retry path if the initial read is unavailable.
    log.warn('Initial voucher read unavailable', error)
    return undefined
  }
}
