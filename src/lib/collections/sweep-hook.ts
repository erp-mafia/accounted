import { after } from 'next/server'
import { createLogger } from '@/lib/logger'

const log = createLogger('collections/sweep-hook')

/**
 * Check newly imported inbound bank rows against the company's invoices
 * under collection right after the current request answers (bank-sweep.ts),
 * instead of at the nightly run: a customer who paid must stop the
 * provider's next letter.
 *
 * Called by the bank ingest for every batch it inserted. Cheap for a company
 * without an open case: the sweep's first query is one indexed lookup that
 * comes back empty, and the heavy modules load only then. Outside a request
 * (scripts, unit tests) `after` is unavailable and this does nothing: the
 * nightly sweep checks every row anyway.
 */
export function scheduleCollectionSweep(companyId: string | null | undefined, transactionIds: readonly string[]): void {
  if (!companyId || transactionIds.length === 0) return
  const ids = [...transactionIds]
  try {
    after(async () => {
      try {
        const [{ createServiceClient }, { sweepCollectionPayments }] = await Promise.all([
          import('@/lib/supabase/server'),
          import('./bank-sweep'),
        ])
        await sweepCollectionPayments({ db: createServiceClient(), budgetMs: 60_000 }, { companyId, transactionIds: ids })
      } catch (err) {
        log.warn('collection sweep after the bank ingest failed; the nightly sweep repeats it', {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  } catch {
    // No request scope: the nightly sweep checks these rows.
  }
}
