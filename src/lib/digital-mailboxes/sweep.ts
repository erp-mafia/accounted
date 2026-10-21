/**
 * The cron's pass over every connected mailbox: a pending Kivra connection
 * is looked up (the activation webhook may never have reached us), and every
 * active one is read. The webhooks make arrival prompt; this sweep makes it
 * certain. Bounded by a time budget so one slow provider never runs the
 * function past its limit: what is left waits for the next run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { activatePendingKivra, loadCompanyIdentity } from './connect'
import { listReceivingConnections, type DigitalMailboxConnection } from './connections'
import { getDigitalMailboxProviders } from './providers'
import { InboxUnavailableError, syncConnection } from './receive'

export interface SweepSummary {
  connections: number
  activated: number
  filed: number
  failed: number
  /** Connections not reached in this run's budget. */
  deferred: number
  errors: Array<{ companyId: string; provider: string; reason: string }>
  skipped?: 'not_configured' | 'inbox_unavailable'
}

export async function sweepDigitalMailboxes(
  service: SupabaseClient,
  args: { log: Logger; budgetMs?: number; now?: () => number },
): Promise<SweepSummary> {
  const now = args.now ?? Date.now
  const deadline = now() + (args.budgetMs ?? 240_000)
  const providers = getDigitalMailboxProviders()
  const summary: SweepSummary = { connections: 0, activated: 0, filed: 0, failed: 0, deferred: 0, errors: [] }
  if (!providers.kivra?.receiver && !providers.billo?.receiver) return { ...summary, skipped: 'not_configured' }

  const rows = await listReceivingConnections(service)
  summary.connections = rows.length
  for (let index = 0; index < rows.length; index++) {
    if (now() > deadline) {
      summary.deferred = rows.length - index
      break
    }
    let connection: DigitalMailboxConnection | null = rows[index]!
    const receiver = providers[connection.provider]?.receiver ?? null
    if (!receiver) continue
    try {
      if (connection.provider === 'kivra' && connection.receive_state === 'pending' && providers.kivra) {
        const identity = await loadCompanyIdentity(service, connection.company_id)
        if (!identity?.orgNumber) continue
        connection = await activatePendingKivra(service, providers.kivra, connection, identity.orgNumber, args.log)
        if (!connection) continue
        summary.activated++
      }
      const result = await syncConnection(service, {
        connection,
        receiver,
        actor: { type: 'cron', label: connection.provider === 'kivra' ? 'Kivra' : 'Billo' },
        log: args.log,
      })
      summary.filed += result.filed
      summary.failed += result.failed
    } catch (err) {
      if (err instanceof InboxUnavailableError) return { ...summary, skipped: 'inbox_unavailable' }
      const reason = err instanceof Error ? err.message : String(err)
      summary.errors.push({ companyId: rows[index]!.company_id, provider: rows[index]!.provider, reason })
    }
  }
  return summary
}
