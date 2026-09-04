import { NextResponse } from 'next/server'
import { z } from 'zod'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { issueAndBookInvoice, type IssueAndBookResult } from '@/lib/invoices/issue-and-book-invoice'
import { hasRequiredInvoicePaymentAccount } from '@/lib/invoices/payment-accounts'
import { snapshotInvoicePayee } from '@/lib/invoices/invoice-payee'
import {
  PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
  PEPPOL_BIS_BILLING_PROFILE_ID,
} from '@/lib/invoices/peppol-bis-billing'
import {
  persistVerifiedPeppolEvent,
  sha256Hex,
  stagePeppolDelivery,
  type PeppolDeliverySummary,
} from '@/lib/invoices/peppol-delivery'
import { checkPeppolSendPermission } from '@/lib/invoices/peppol-access'
import { generatePeppolDocumentOrResponse, loadPeppolRecords } from '@/lib/invoices/peppol-document'
import {
  getPeppolTransport,
  getPeppolTransportAvailability,
  isPeppolTransportError,
  type PeppolDeliveryStatus,
  type PeppolTransport,
  type PeppolVerifiedEvent,
} from '@/lib/invoices/peppol-transport'
import { createServiceClient } from '@/lib/supabase/server'
import type { Invoice } from '@/types'

// Registers the configured Access Point adapter and wires the event bus that
// issueAndBookInvoice() emits on.
ensureInitialized()

const paramsSchema = z.object({ id: z.uuid() })

/** Invoice states that may still be handed to the network. */
const SENDABLE_STATUSES = new Set<Invoice['status']>(['draft', 'sent', 'overdue'])

/** Provider-source lifecycle events written by this route (service role). */
function routeEvent(args: {
  provider: string
  tenantId: string
  idempotencyKey: string
  providerSubmissionId: string | null
  code: string
  status: PeppolDeliveryStatus
  terminal: boolean
  statusDetail: string | null
  occurredAt: string
  payload?: Record<string, unknown>
}): PeppolVerifiedEvent {
  return {
    provider: args.provider,
    providerTenantId: args.tenantId,
    providerSubmissionId: args.providerSubmissionId,
    providerEventId: null,
    idempotencyKey: args.idempotencyKey,
    eventCode: args.code,
    normalizedStatus: args.status,
    isTerminal: args.terminal,
    detail: args.statusDetail,
    occurredAt: args.occurredAt,
    rawPayload: { source: 'invoice.peppol.send', ...(args.payload ?? {}) },
    eventSha256: sha256Hex(
      `${args.provider}|${args.idempotencyKey}|${args.code}|${args.status}|${args.occurredAt}|${args.statusDetail ?? ''}`,
    ),
    verificationMethod: 'accounted_route',
  }
}

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

const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'no_route', 'business_rejected'])

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
    const invoiceId = parsedParams.data.id

    const availability = getPeppolTransportAvailability()
    const transport: PeppolTransport | null = availability.available
      ? getPeppolTransport(availability.provider)
      : null
    if (!availability.available || !transport) {
      return privateNoStore(errorResponseFromCode('PEPPOL_TRANSPORT_UNAVAILABLE', log, {
        requestId,
        details: { reason: availability.available ? 'provider_adapter_unavailable' : availability.reason },
      }))
    }

    // Access is granted per company by the operators and capped in sends:
    // refuse before any invoice data is touched.
    const service = createServiceClient()
    const permission = await checkPeppolSendPermission({ service, companyId })
    if (!permission.ok) {
      return privateNoStore(errorResponseFromCode(permission.code, log, {
        requestId,
        details: {
          access_status: permission.summary.status,
          max_sends: permission.summary.max_sends,
          sent_count: permission.summary.sent_count,
        },
      }))
    }

    const records = await loadPeppolRecords({ supabase, companyId, invoiceId, log, requestId })
    if (!records.ok) return records.response
    const { invoice, company } = records

    const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
    if (
      !isRealInvoice
      || invoice.credited_invoice_id
      || invoice.is_self_billed
      || !SENDABLE_STATUSES.has(invoice.status)
    ) {
      return privateNoStore(errorResponseFromCode('PEPPOL_SEND_INVALID_STATUS', log, {
        requestId,
        details: { status: invoice.status, document_type: invoice.document_type ?? 'invoice' },
      }))
    }

    const wasDraft = invoice.status === 'draft'
    // A draft is issued (numbered, marked sent, booked) after the network
    // accepts it. Refuse up front what issuance would refuse afterwards, so an
    // invoice never reaches the buyer and then fails to book.
    if (wasDraft) {
      const payeeSnapshot = await snapshotInvoicePayee(supabase, companyId, invoice)
      if (!payeeSnapshot.ok) {
        return privateNoStore(errorResponseFromCode(payeeSnapshot.code, log, {
          requestId,
          details: payeeSnapshot.details,
        }))
      }
      invoice.payment_details = payeeSnapshot.payee
    }
    if (wasDraft && !hasRequiredInvoicePaymentAccount(company, invoice)) {
      return privateNoStore(errorResponseFromCode('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', log, {
        requestId,
        details: { currency: invoice.currency },
      }))
    }

    if (wasDraft && !invoice.invoice_number) {
      try {
        invoice.invoice_number = await ensureInvoiceNumber(supabase, companyId, invoice)
      } catch (err) {
        log.error('failed to assign invoice number before Peppol send', err as Error)
        return privateNoStore(errorResponseFromCode('INVOICE_CREATE_NUMBER_ASSIGN_FAILED', log, { requestId }))
      }
    }

    const generated = generatePeppolDocumentOrResponse({ invoice, company, log, requestId })
    if (!generated.ok) return generated.response
    const document = generated.document

    const provider = transport.provider
    // Consolidated Qvalia setup: one provider account for every company. The
    // adapter resolves the account; the lifecycle only needs a stable label.
    const tenantId = process.env.QVALIA_ACCOUNT_REG_NO?.trim()
      || process.env.QVALIA_PARTNER_REG_NO?.trim()
      || provider

    try {
      let delivery: PeppolDeliverySummary = await stagePeppolDelivery({
        supabase,
        companyId,
        invoiceId,
        document,
      })

      if (delivery.provider_submission_id) {
        // Exact XML already handed to the network: idempotent replay, never a
        // second transmission.
        return privateNoStore(NextResponse.json({
          data: {
            delivery: summaryPayload(delivery),
            network_submitted: true,
            already_submitted: true,
            invoice_status: invoice.status,
          },
        }))
      }
      if (delivery.terminal_at && TERMINAL_FAILURE_STATUSES.has(delivery.status)) {
        return privateNoStore(errorResponseFromCode('PEPPOL_SUBMISSION_REJECTED', log, {
          requestId,
          details: { status: delivery.status, detail: delivery.status_detail },
        }))
      }

      const lookup = await transport.lookupRecipient(document.recipient)
      if (!lookup.reachable) {
        return privateNoStore(errorResponseFromCode('PEPPOL_RECIPIENT_NOT_REACHABLE', log, {
          requestId,
          details: {
            scheme: document.recipient.scheme,
            identifier: document.recipient.identifier,
            reason: lookup.reasonCode,
          },
        }))
      }
      const supportsInvoice = lookup.capabilities.length === 0
        || lookup.capabilities.some((c) => c.documentTypeId === PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID)
      if (!supportsInvoice) {
        return privateNoStore(errorResponseFromCode('PEPPOL_RECIPIENT_NOT_REACHABLE', log, {
          requestId,
          details: {
            scheme: document.recipient.scheme,
            identifier: document.recipient.identifier,
            reason: 'document_type_not_supported',
          },
        }))
      }

      delivery = await persistVerifiedPeppolEvent({
        supabase: service,
        companyId,
        event: routeEvent({
          provider,
          tenantId,
          idempotencyKey: delivery.idempotency_key,
          providerSubmissionId: null,
          code: 'recipient_lookup',
          status: 'recipient_verified',
          terminal: false,
          statusDetail: `${lookup.participant.scheme}:${lookup.participant.identifier}`,
          occurredAt: lookup.checkedAt,
          payload: { capabilities: lookup.capabilities.length },
        }),
      })

      const submittingAt = new Date().toISOString()
      delivery = await persistVerifiedPeppolEvent({
        supabase: service,
        companyId,
        event: routeEvent({
          provider,
          tenantId,
          idempotencyKey: delivery.idempotency_key,
          providerSubmissionId: null,
          code: 'submit_attempt',
          status: 'submitting',
          terminal: false,
          statusDetail: null,
          occurredAt: submittingAt,
        }),
      })

      let providerSubmissionId: string
      let acceptedAt: string
      try {
        const receipt = await transport.submit({
          idempotencyKey: delivery.idempotency_key,
          tenantReference: companyId,
          sender: document.sender,
          recipient: document.recipient,
          documentTypeId: PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
          processId: PEPPOL_BIS_BILLING_PROFILE_ID,
          filename: document.filename,
          contentType: 'application/xml',
          document: document.xml,
          documentSha256: delivery.xml_sha256,
        })
        providerSubmissionId = receipt.providerSubmissionId
        acceptedAt = receipt.acceptedAt
      } catch (err) {
        const retryable = isPeppolTransportError(err) ? err.retryable : true
        // The provider's own explanation (validation rule, duplicate notice) is
        // what the user can act on; the adapter's error message stays in the
        // event log and never reaches the response.
        const providerReason = isPeppolTransportError(err) ? err.detail : null
        const eventDetail = isPeppolTransportError(err)
          ? [err.message, providerReason].filter(Boolean).join(': ').slice(0, 500)
          : (err instanceof Error ? err.message : 'unknown transport error')
        log.error('Peppol submission failed', err as Error, {
          invoiceId,
          retryable,
        })
        await persistVerifiedPeppolEvent({
          supabase: service,
          companyId,
          event: routeEvent({
            provider,
            tenantId,
            idempotencyKey: delivery.idempotency_key,
            providerSubmissionId: null,
            code: retryable ? 'submit_failed' : 'submit_rejected',
            status: retryable ? 'retryable_failure' : 'failed',
            terminal: !retryable,
            statusDetail: eventDetail,
            occurredAt: new Date().toISOString(),
          }),
        })
        return privateNoStore(errorResponseFromCode(
          retryable ? 'PEPPOL_SUBMISSION_FAILED' : 'PEPPOL_SUBMISSION_REJECTED',
          log,
          { requestId, details: { reason: providerReason } },
        ))
      }

      delivery = await persistVerifiedPeppolEvent({
        supabase: service,
        companyId,
        event: routeEvent({
          provider,
          tenantId,
          idempotencyKey: delivery.idempotency_key,
          providerSubmissionId,
          code: 'submit_accepted',
          status: 'submission_accepted',
          terminal: false,
          statusDetail: null,
          occurredAt: acceptedAt,
          payload: { provider_submission_id: providerSubmissionId },
        }),
      })

      // The network has the document. A draft now becomes an issued invoice
      // with exactly the mark-sent semantics (number, status, verifikat under
      // faktureringsmetoden, PDF archived as underlag).
      let issuance: IssueAndBookResult | null = null
      let invoiceStatus: Invoice['status'] = invoice.status
      if (wasDraft) {
        issuance = await issueAndBookInvoice({
          supabase,
          companyId,
          userId: user.id,
          invoice,
          settings: company,
          log,
        })
        if (issuance.ok) {
          invoiceStatus = 'sent'
        } else {
          log.error('Peppol send accepted but issuance failed', {
            invoiceId,
            errorCode: issuance.errorCode,
          })
        }
      }

      return privateNoStore(NextResponse.json({
        data: {
          delivery: summaryPayload(delivery),
          network_submitted: true,
          already_submitted: false,
          recipient: {
            scheme: lookup.participant.scheme,
            identifier: lookup.participant.identifier,
          },
          invoice_status: invoiceStatus,
          journal_entry_id: issuance?.ok ? issuance.journalEntryId : null,
          issuance: issuance === null
            ? null
            : issuance.ok
              ? { ok: true, partial_failures: issuance.partialFailures }
              : { ok: false, error_code: issuance.errorCode },
        },
      }, { status: 201 }))
    } catch (err) {
      return privateNoStore(errorResponse(err, log, { requestId }))
    }
  },
  { requireWrite: true },
)
