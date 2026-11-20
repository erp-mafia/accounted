import { after } from 'next/server'
import { createLogger } from '@/lib/logger'

const log = createLogger('collections/forward-hook')

/**
 * Companies with a drain scheduled in this instance that has not started
 * yet, and when it was scheduled. A payment writer called once per row (a
 * batch commit, a Stripe sync, a bulk match) schedules one drain, not one
 * per row: the scheduled drain claims every row written before it starts.
 */
const scheduled = new Map<string, number>()

/**
 * A scheduled drain that has not started after this long (the request never
 * finished) no longer stands in for a new one.
 */
export const FORWARD_DRAIN_SCHEDULE_STALE_MS = 30_000

/**
 * Report a company's waiting payment and credit-note forwards to the
 * collections provider right after the current request answers, instead of
 * at the next sync run (up to ten minutes later, while the provider may be
 * about to send the next letter).
 *
 * Called wherever a payment row is written or removed or a credit note is
 * issued. Cheap when there is nothing to send: the drain's first call is one
 * indexed claim that comes back empty, and the heavy modules load only then.
 * Called again for the same company before that drain starts, it does
 * nothing: the drain forgets the company before it claims, so a row written
 * before then is claimed by it and a row written after schedules its own.
 * Outside a request (scripts, unit tests) `after` is unavailable and this
 * does nothing: the sync cron drains the outbox anyway.
 */
export function scheduleCollectionForwardDrain(companyId: string | null | undefined): void {
  if (!companyId) return
  const at = scheduled.get(companyId)
  if (at !== undefined && Date.now() - at < FORWARD_DRAIN_SCHEDULE_STALE_MS) return
  try {
    after(async () => {
      scheduled.delete(companyId)
      try {
        const [{ createServiceClient }, { drainCollectionForwards }] = await Promise.all([
          import('@/lib/supabase/server'),
          import('./forwarding'),
        ])
        await drainCollectionForwards({ db: createServiceClient(), budgetMs: 60_000 }, { companyId })
      } catch (err) {
        log.warn('collection forward drain after the request failed; the sync cron retries', {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
    scheduled.set(companyId, Date.now())
  } catch {
    // No request scope: the sync cron drains the outbox.
  }
}
