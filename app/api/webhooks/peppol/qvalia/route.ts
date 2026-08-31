import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import {
  persistPeppolEvidence,
  persistVerifiedPeppolEvent,
} from '@/lib/invoices/peppol-delivery'
import { isPeppolTransportError, type PeppolTransport } from '@/lib/invoices/peppol-transport'
import {
  QVALIA_PROVIDER,
  createQvaliaTransport,
  readQvaliaConfigFromEnv,
} from '@/lib/invoices/transports/qvalia'
import { createLogger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'

ensureInitialized()

const log = createLogger('peppol.qvalia.webhook')

/** Statuses worth fetching the provider's message record for. */
const EVIDENCE_STATUSES = new Set([
  'transport_succeeded',
  'recipient_acknowledged',
  'business_accepted',
  'business_rejected',
  'failed',
])

/**
 * POST /api/webhooks/peppol/qvalia
 *
 * Unauthenticated by design: Qvalia does not sign webhooks, so authenticity
 * comes from the shared secret Accounted configured as Qvalia's outbound auth
 * header (`QVALIA_WEBHOOK_SECRET`), checked constant-time in the adapter. The
 * raw body is hashed before parsing so every verified event keeps an exact
 * fingerprint.
 *
 * Delivery is at-least-once; the append-only event table dedupes on the
 * provider event id, so replays are harmless. Unknown submissions answer 200:
 * they are logged, and a retry would not make them known.
 */
export async function POST(request: Request) {
  const config = readQvaliaConfigFromEnv()
  if (!config || !config.webhookSecret) {
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 })
  }
  const transport: PeppolTransport = createQvaliaTransport(config)

  const rawBody = new Uint8Array(await request.arrayBuffer())
  let events
  try {
    events = await transport.verifyWebhook({ headers: request.headers, rawBody })
  } catch (err) {
    if (isPeppolTransportError(err) && /secret/i.test(err.message)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    log.warn('Qvalia webhook rejected', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  }

  const service = createServiceClient()
  let recorded = 0
  let unmatched = 0
  let failed = 0

  for (const event of events) {
    if (!event.providerSubmissionId) {
      unmatched += 1
      continue
    }
    const { data: delivery, error } = await service
      .from('peppol_deliveries')
      .select('company_id, idempotency_key')
      .eq('provider', QVALIA_PROVIDER)
      .eq('provider_submission_id', event.providerSubmissionId)
      .maybeSingle()
    if (error) {
      failed += 1
      log.error('Qvalia webhook delivery lookup failed', error, {
        providerSubmissionId: event.providerSubmissionId,
      })
      continue
    }
    if (!delivery) {
      unmatched += 1
      log.warn('Qvalia webhook for unknown submission', {
        providerSubmissionId: event.providerSubmissionId,
        eventCode: event.eventCode,
      })
      continue
    }

    try {
      await persistVerifiedPeppolEvent({
        supabase: service,
        companyId: delivery.company_id as string,
        event: { ...event, idempotencyKey: delivery.idempotency_key as string },
      })
      recorded += 1
    } catch (err) {
      failed += 1
      log.error('Qvalia webhook event persistence failed', err as Error, {
        providerSubmissionId: event.providerSubmissionId,
        eventCode: event.eventCode,
      })
      continue
    }

    if (EVIDENCE_STATUSES.has(event.normalizedStatus)) {
      try {
        const evidence = await transport.retrieveEvidence(event.providerSubmissionId)
        for (const item of evidence) {
          await persistPeppolEvidence({
            supabase: service,
            companyId: delivery.company_id as string,
            idempotencyKey: delivery.idempotency_key as string,
            evidence: item,
          })
        }
      } catch (err) {
        // Evidence is best-effort: the verified event is already on record.
        log.warn('Qvalia evidence retrieval failed', {
          providerSubmissionId: event.providerSubmissionId,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // A persistence failure is ours, not Qvalia's: answer 500 so they retry.
  if (failed > 0 && recorded === 0) {
    return NextResponse.json({ received: true, recorded, unmatched, failed }, { status: 500 })
  }
  return NextResponse.json({ received: true, recorded, unmatched, failed })
}
