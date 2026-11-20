/**
 * The cron's pass over every connected mailbox: a pending Kivra connection
 * is looked up (the activation webhook may never have reached us), and every
 * active one is read. The webhooks make arrival prompt; this sweep makes it
 * certain. Bounded by a time budget so one slow provider never runs the
 * function past its limit: what is left waits for the next run.
 *
 * An active Kivra mailbox the webhook is proven to carry is read about once a
 * day instead of every run: Kivra retries an undelivered webhook for about a
 * week, so a daily read is the safety net they advise (crm#1524).
 *
 * A connection that fails is retried on every run, which heals a provider's
 * bad hour and nothing else. One failing for more than a day is reported to
 * the team, once per failure: until then the only trace was a warning per
 * run that reaches nobody. When the failure began is kept in provider_meta
 * (connections.ts, failureBookkeeping): last_error_at is the latest failed
 * contact, and the Inkorg shows it as that.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { activatePendingKivra, loadCompanyIdentity } from './connect'
import {
  failureBookkeeping,
  listReceivingConnections,
  writeProviderMetaIfUnchanged,
  type DigitalMailboxConnection,
} from './connections'
import { getDigitalMailboxProviders } from './providers'
import { InboxUnavailableError, syncConnection } from './receive'

export interface SweepSummary {
  connections: number
  activated: number
  filed: number
  failed: number
  /** Connections not reached in this run's budget. */
  deferred: number
  /** Kivra connections the webhook carries, not due for their daily read. */
  resting: number
  /** Connections reported in this run for having failed for more than a day. */
  stuck: number
  errors: Array<{ companyId: string; provider: string; reason: string }>
  skipped?: 'not_configured' | 'inbox_unavailable'
}

/**
 * How long a Kivra mailbox the webhook carries rests between reads: a day,
 * less half a sweep interval, so the read keeps its ten-minute slot instead
 * of drifting one slot later every day.
 */
export const KIVRA_SAFETY_NET_MS = (24 * 60 - 5) * 60 * 1000

/** Whether the connection's daily safety-net read is due (never read counts as due). */
export function kivraDailyReadDue(connection: Pick<DigitalMailboxConnection, 'last_synced_at'>, nowMs: number): boolean {
  const last = connection.last_synced_at ? Date.parse(connection.last_synced_at) : Number.NaN
  return !Number.isFinite(last) || nowMs - last >= KIVRA_SAFETY_NET_MS
}

/**
 * Whether Kivra's webhook carries this connection: it is active and the newest
 * document the company has from Kivra was filed by the webhook. Proven by
 * delivery, not assumed from configuration. A document the webhook missed is
 * filed by a sweep or a person, which puts the connection back on every run
 * until the webhook delivers again; so does a mailbox the webhook has not
 * delivered to yet. A failed lookup reads as not carried: when in doubt, read.
 */
export async function kivraWebhookCarries(
  service: SupabaseClient,
  connection: Pick<DigitalMailboxConnection, 'company_id' | 'receive_state'>,
): Promise<boolean> {
  if (connection.receive_state !== 'active') return false
  const { data, error } = await service
    .from('arrivals')
    .select('fetched_by')
    .eq('company_id', connection.company_id)
    .eq('source', 'kivra')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return false
  return (data as { fetched_by: { type?: unknown } | null }).fetched_by?.type === 'webhook'
}

export async function sweepDigitalMailboxes(
  service: SupabaseClient,
  args: { log: Logger; budgetMs?: number; now?: () => number },
): Promise<SweepSummary> {
  const now = args.now ?? Date.now
  const deadline = now() + (args.budgetMs ?? 240_000)
  const providers = getDigitalMailboxProviders()
  const summary: SweepSummary = {
    connections: 0,
    activated: 0,
    filed: 0,
    failed: 0,
    deferred: 0,
    resting: 0,
    stuck: 0,
    errors: [],
  }
  if (!providers.kivra?.receiver && !providers.billo?.receiver) return { ...summary, skipped: 'not_configured' }

  const rows = await listReceivingConnections(service)
  summary.connections = rows.length

  // Before any row is written in this run: each write is guarded on the row
  // as it was just read, and at most one is made per row and failure stage
  // (started, reported, healed), not one per run.
  const stuck: Array<{ companyId: string; provider: string; failingSince: unknown; reason: string }> = []
  for (const row of rows) {
    const bookkeeping = failureBookkeeping(row, now())
    if (!bookkeeping) continue
    try {
      const written = await writeProviderMetaIfUnchanged(service, row, bookkeeping.providerMeta)
      if (written && bookkeeping.report) {
        stuck.push({
          companyId: row.company_id,
          provider: row.provider,
          failingSince: bookkeeping.providerMeta.failing_since,
          reason: (row.last_error ?? '').slice(0, 200),
        })
      }
    } catch (err) {
      // Nothing recorded, so nothing reported: the next run tries again.
      args.log.warn('digital mailbox failure state could not be recorded', {
        companyId: row.company_id,
        provider: row.provider,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (stuck.length > 0) {
    summary.stuck = stuck.length
    args.log.error('digital mailbox connections have failed for more than a day', {
      count: stuck.length,
      connections: stuck.slice(0, 20),
    })
  }
  for (let index = 0; index < rows.length; index++) {
    if (now() > deadline) {
      summary.deferred = rows.length - index
      break
    }
    let connection: DigitalMailboxConnection | null = rows[index]!
    const receiver = providers[connection.provider]?.receiver ?? null
    if (!receiver) continue
    try {
      if (
        connection.provider === 'kivra' &&
        providers.kivra?.config.webhookSecret &&
        !kivraDailyReadDue(connection, now()) &&
        (await kivraWebhookCarries(service, connection))
      ) {
        summary.resting++
        continue
      }
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
