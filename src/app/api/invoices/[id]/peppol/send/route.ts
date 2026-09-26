import { NextResponse } from 'next/server'
import { z } from 'zod'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import type { PeppolDeliverySummary } from '@/lib/invoices/peppol-delivery'
import { peppolSendFailureMessageEn, sendInvoiceViaPeppol } from '@/lib/invoices/peppol-send-service'
import { createServiceClient } from '@/lib/supabase/server'

// Registers the configured Access Point adapter and wires the event bus that
// issueAndBookInvoice() emits on.
ensureInitialized()

const paramsSchema = z.object({ id: z.uuid() })

function summaryPayload(delivery: PeppolDeliverySummary) {
  return {
    id: delivery.id,
    idempotency_key: delivery.idempotency_key,
    recipient_scheme: delivery.recipient_scheme,
    recipient_identifier: delivery.recipient_identifier,
    xml_sha256: delivery.xml_sha256,
    provider: delivery.provider,
    provider_submission_id: delivery.provider_submission_id,
    status: delivery.status,
    status_at: delivery.status_at,
    status_detail: delivery.status_detail,
    submitted_at: delivery.submitted_at,
    terminal_at: delivery.terminal_at,
  }
}

/**
 * POST /api/invoices/[id]/peppol/send. The gates, the lifecycle events and
 * the issuance of a draft live in lib/invoices/peppol-send-service.ts, shared
 * with the v1 operation invoices.send-peppol and gnubok_send_invoice_peppol.
 * The response shapes are the ones the invoice page has always read.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.peppol.send',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const parsedParams = paramsSchema.safeParse(await params)
    if (!parsedParams.success) {
      return privateNoStore(errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { fields: parsedParams.error.flatten().fieldErrors },
      }))
    }

    const outcome = await sendInvoiceViaPeppol(
      { supabase, companyId, userId: user.id, log },
      parsedParams.data.id,
      { service: createServiceClient() },
    )
    if (!outcome.ok) {
      if (outcome.error) return privateNoStore(errorResponse(outcome.error, log, { requestId }))
      const messageEn = peppolSendFailureMessageEn(outcome)
      return privateNoStore(errorResponseFromCode(outcome.code, log, {
        requestId,
        details: outcome.details,
        ...(outcome.messageSv ? { messageSv: outcome.messageSv } : {}),
        ...(messageEn ? { messageEn } : {}),
      }))
    }
    if (outcome.dryRun) return privateNoStore(NextResponse.json({ data: outcome.preview }))

    const result = outcome.data
    if (result.already_submitted) {
      return privateNoStore(NextResponse.json({
        data: {
          delivery: summaryPayload(result.delivery),
          network_submitted: true,
          already_submitted: true,
          invoice_status: result.invoice_status,
        },
      }))
    }
    return privateNoStore(NextResponse.json({
      data: {
        delivery: summaryPayload(result.delivery),
        network_submitted: true,
        already_submitted: false,
        recipient: result.recipient,
        invoice_status: result.invoice_status,
        journal_entry_id: result.journal_entry_id,
        issuance: result.issuance,
      },
    }, { status: 201 }))
  },
  { requireWrite: true },
)
