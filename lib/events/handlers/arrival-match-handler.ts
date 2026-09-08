/**
 * Re-run the arrival matcher when the bank feed brings new transactions.
 *
 * A receipt often arrives before the card transaction posts (a day or two
 * for cards, longer for invoices), so the match that failed at arrival is
 * retried every time the company's transactions change, for as long as the
 * document stays in the arrival window.
 */
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runArrivalMatch } from '@/lib/underlag/arrival-match'

const log = createLogger('events/arrival-match')

export function registerArrivalMatchHandler(): () => void {
  return eventBus.on('transaction.synced', async (payload) => {
    const companyId = (payload as { companyId?: string }).companyId
    const count = ((payload as { transactions?: unknown[] }).transactions ?? []).length
    if (!companyId || count === 0) return
    try {
      const supabase = createServiceClientNoCookies()
      const summary = await runArrivalMatch(supabase, companyId, { trigger: 'bank_sync' })
      if (summary.items > 0) {
        log.info('arrival match after bank sync', {
          companyId,
          items: summary.items,
          linked: summary.linked,
          proposed: summary.proposed,
          skipped: summary.skipped,
        })
      }
    } catch (err) {
      // The sync itself has succeeded; a matching failure must not undo it.
      log.error('arrival match after bank sync failed', err as Error, { companyId })
    }
  })
}
