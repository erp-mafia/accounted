/**
 * Outbound delivery status by polling. Qvalia's webhook API is not available
 * on its production host yet (2026-08-21: `/webhook/configure` answers 404
 * there while the sandbox answers 204), and webhooks can be missed even when
 * they exist, so the open deliveries are asked about on a schedule. Every
 * event still goes through the same append-only, deduplicated lifecycle RPC
 * as a webhook would.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { persistPeppolEvidence, persistVerifiedPeppolEvent, describeError } from '@/lib/invoices/peppol-delivery'
import {
  isPeppolTransportError,
  type PeppolTransport,
  type PeppolTransportError,
  type PeppolVerifiedEvent,
} from '@/lib/invoices/peppol-transport'

/**
 * Deliveries the provider may still say something new about. A delivered
 * invoice (transport_succeeded) is final for our purposes: Qvalia's status
 * carries no business responses, so asking again only spends the shared
 * Peppol budget.
 */
const OPEN_STATUSES = ['submitting', 'submission_accepted'] as const

/**
 * Transport codes that say the Peppol budget is spent: the connector
 * service's own limit, or a bare 429 the connector transport codes from the
 * status. Every further ask in the same pass would be refused too.
 */
const BUDGET_SPENT_CODES = new Set(['CONNECTOR_RATE_LIMITED', 'HTTP_429'])

function isBudgetSpent(err: unknown): err is PeppolTransportError {
  return isPeppolTransportError(err) && err.code !== null && BUDGET_SPENT_CODES.has(err.code)
}

const EVIDENCE_STATUSES = new Set([
  'transport_succeeded',
  'recipient_acknowledged',
  'business_accepted',
  'business_rejected',
  'failed',
])

export interface OpenPeppolDeliveryRow {
  id: string
  company_id: string
  idempotency_key: string
  provider_submission_id: string
  status: string
  status_at: string
  submitted_at: string | null
  evidence_retrieved_at: string | null
}

export interface PeppolDeliveryPollResult {
  polled: number
  advanced: number
  unchanged: number
  failed: number
  /** Open deliveries left for the next run because the Peppol budget or the run's time ran out. */
  deferred: number
  errors: Array<{ providerSubmissionId: string; reason: string }>
}

/**
 * Open deliveries for a provider, at most `limit`, in id order starting after
 * `pivot` and wrapping round to the start; default horizon 45 days.
 *
 * The start rotates because the pass is bounded (the limit, the Peppol
 * budget, the deadline). The order was oldest status first, and status_at
 * does not move while the access point has nothing new to say, so the same
 * oldest `limit` deliveries were asked about on every run and one sent after
 * them was never asked about at all. Ids are random (uuid v4), so from a
 * random pivot every open delivery has the same chance in every run and none
 * is always last, with nothing stored between runs: peppol_deliveries changes
 * only through its event RPC, which a last-polled stamp would have to join.
 */
export async function listOpenPeppolDeliveries(args: {
  service: SupabaseClient
  provider: string
  limit?: number
  horizonDays?: number
  pivot?: string
}): Promise<OpenPeppolDeliveryRow[]> {
  const since = new Date(Date.now() - (args.horizonDays ?? 45) * 24 * 60 * 60 * 1000).toISOString()
  const limit = args.limit ?? 200
  const pivot = args.pivot ?? randomUUID()
  const read = async (side: 'after' | 'upTo', count: number): Promise<OpenPeppolDeliveryRow[]> => {
    const open = args.service
      .from('peppol_deliveries')
      .select('id, company_id, idempotency_key, provider_submission_id, status, status_at, submitted_at, evidence_retrieved_at')
      .eq('provider', args.provider)
      .in('status', [...OPEN_STATUSES])
      .is('terminal_at', null)
      .not('provider_submission_id', 'is', null)
      .gte('submitted_at', since)
    const { data, error } = await (side === 'after' ? open.gt('id', pivot) : open.lte('id', pivot))
      .order('id', { ascending: true })
      .limit(count)
    if (error) throw new Error(`Failed to list open Peppol deliveries: ${error.message}`)
    return (data ?? []) as OpenPeppolDeliveryRow[]
  }
  const after = await read('after', limit)
  if (after.length >= limit) return after
  return [...after, ...(await read('upTo', limit - after.length))]
}

/**
 * One polling pass over the open deliveries. A delivery whose status the
 * provider moved forward gets the event recorded (and evidence fetched on the
 * states worth keeping); one the provider has nothing new about is left alone.
 * The pass stops at the first ask refused for budget, and at `deadline`
 * (epoch ms, checked before every delivery): that delivery and the rest are
 * counted as deferred, and the next run starts somewhere else in the list
 * (listOpenPeppolDeliveries), so no delivery is deferred every time.
 */
export async function pollOpenPeppolDeliveries(args: {
  service: SupabaseClient
  transport: PeppolTransport
  log: Logger
  limit?: number
  deadline?: number
  /** Where in id order the pass starts; a random point by default. For tests. */
  pivot?: string
}): Promise<PeppolDeliveryPollResult> {
  const { service, transport, log } = args
  const result: PeppolDeliveryPollResult = { polled: 0, advanced: 0, unchanged: 0, failed: 0, deferred: 0, errors: [] }
  if (!transport.pollDeliveryStatus) return result

  const fail = (delivery: OpenPeppolDeliveryRow, err: unknown) => {
    result.failed += 1
    result.errors.push({ providerSubmissionId: delivery.provider_submission_id, reason: describeError(err) })
    log.error('peppol status poll failed', err as Error, { providerSubmissionId: delivery.provider_submission_id })
  }

  const open = await listOpenPeppolDeliveries({
    service, provider: transport.provider, limit: args.limit, pivot: args.pivot,
  })
  for (const [index, delivery] of open.entries()) {
    if (args.deadline !== undefined && Date.now() >= args.deadline) {
      result.deferred = open.length - index
      log.info('peppol status poll stopped at its deadline, the rest waits for the next run', { deferred: result.deferred })
      break
    }
    let events: PeppolVerifiedEvent[]
    try {
      events = await transport.pollDeliveryStatus(delivery.provider_submission_id)
    } catch (err) {
      if (isBudgetSpent(err)) {
        result.deferred = open.length - index
        log.warn('peppol status poll stopped: the Peppol budget is spent, the rest waits for the next run', {
          providerSubmissionId: delivery.provider_submission_id,
          code: err.code,
          deferred: result.deferred,
        })
        break
      }
      fail(delivery, err)
      continue
    }
    try {
      let advanced = false
      for (const event of events) {
        const recorded = await persistVerifiedPeppolEvent({
          supabase: service,
          companyId: delivery.company_id,
          event: { ...event, idempotencyKey: delivery.idempotency_key },
        })
        if (recorded.status !== delivery.status || recorded.status_at !== delivery.status_at) advanced = true

        if (EVIDENCE_STATUSES.has(event.normalizedStatus) && !delivery.evidence_retrieved_at) {
          try {
            const evidence = await transport.retrieveEvidence(delivery.provider_submission_id)
            for (const item of evidence) {
              await persistPeppolEvidence({
                supabase: service,
                companyId: delivery.company_id,
                idempotencyKey: delivery.idempotency_key,
                evidence: item,
              })
            }
          } catch (err) {
            log.warn('peppol evidence retrieval failed during status poll', {
              providerSubmissionId: delivery.provider_submission_id,
              reason: describeError(err),
            })
          }
        }
      }
      if (advanced) result.advanced += 1
      else result.unchanged += 1
    } catch (err) {
      fail(delivery, err)
    }
  }
  result.polled = result.advanced + result.unchanged + result.failed
  return result
}
