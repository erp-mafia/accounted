/**
 * Outbound delivery status by polling. Qvalia's webhook API is not available
 * on its production host yet (2026-08-21: `/webhook/configure` answers 404
 * there while the sandbox answers 204), and webhooks can be missed even when
 * they exist, so the open deliveries are asked about on a schedule. Every
 * event still goes through the same append-only, deduplicated lifecycle RPC
 * as a webhook would.
 */

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
  /** Open deliveries left for the next run because the budget ran out. */
  deferred: number
  errors: Array<{ providerSubmissionId: string; reason: string }>
}

/** Open deliveries for a provider, oldest status first; default horizon 45 days. */
export async function listOpenPeppolDeliveries(args: {
  service: SupabaseClient
  provider: string
  limit?: number
  horizonDays?: number
}): Promise<OpenPeppolDeliveryRow[]> {
  const since = new Date(Date.now() - (args.horizonDays ?? 45) * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await args.service
    .from('peppol_deliveries')
    .select('id, company_id, idempotency_key, provider_submission_id, status, status_at, submitted_at, evidence_retrieved_at')
    .eq('provider', args.provider)
    .in('status', [...OPEN_STATUSES])
    .is('terminal_at', null)
    .not('provider_submission_id', 'is', null)
    .gte('submitted_at', since)
    .order('status_at', { ascending: true })
    .limit(args.limit ?? 200)
  if (error) throw new Error(`Failed to list open Peppol deliveries: ${error.message}`)
  return (data ?? []) as OpenPeppolDeliveryRow[]
}

/**
 * One polling pass over the open deliveries. A delivery whose status the
 * provider moved forward gets the event recorded (and evidence fetched on the
 * states worth keeping); one the provider has nothing new about is left alone.
 * The pass stops at the first ask refused for budget: that delivery and the
 * rest are counted as deferred and asked about on the next run.
 */
export async function pollOpenPeppolDeliveries(args: {
  service: SupabaseClient
  transport: PeppolTransport
  log: Logger
  limit?: number
}): Promise<PeppolDeliveryPollResult> {
  const { service, transport, log } = args
  const result: PeppolDeliveryPollResult = { polled: 0, advanced: 0, unchanged: 0, failed: 0, deferred: 0, errors: [] }
  if (!transport.pollDeliveryStatus) return result

  const fail = (delivery: OpenPeppolDeliveryRow, err: unknown) => {
    result.failed += 1
    result.errors.push({ providerSubmissionId: delivery.provider_submission_id, reason: describeError(err) })
    log.error('peppol status poll failed', err as Error, { providerSubmissionId: delivery.provider_submission_id })
  }

  const open = await listOpenPeppolDeliveries({ service, provider: transport.provider, limit: args.limit })
  for (const [index, delivery] of open.entries()) {
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
