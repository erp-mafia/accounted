/**
 * Sending a customer invoice over Peppol, and the reads around it: can this
 * invoice go (readiness), and what happened to the deliveries so far.
 *
 * One implementation behind the dashboard routes
 * (POST /api/invoices/[id]/peppol/send, GET /api/invoices/[id]/peppol/deliveries)
 * and the operations invoices.send-peppol, invoices.peppol-readiness and
 * invoices.peppol-deliveries (lib/operations/peppol.ts), so every door applies
 * the same gates in the same order:
 *
 *   1. an access point is configured (PEPPOL_TRANSPORT_PROVIDER + adapter);
 *   2. never the demo company (a transmission is billed per document);
 *   3. the operators granted the company Peppol access and the sending cap
 *      is not used up (peppol_access);
 *   4. the invoice is a plain invoice in draft, sent or overdue: no credit
 *      note, self-billed invoice, quote, proforma or delivery note;
 *   5. a draft can be issued afterwards: its chosen payee account is usable
 *      and a payment account for the currency exists;
 *   6. the BIS Billing 3 document builds (EN 16931 + Peppol + Sweden CIUS
 *      preflight in peppol-bis-billing.ts).
 *
 * The network is touched on commit only: the recipient lookup (SMP) and the
 * submission. A dry run (the MCP staging preview too) runs gates 1 to 6 as
 * reads and writes nothing: no payee snapshot, no invoice number, no staged
 * delivery row, no lifecycle event. A numberless draft is validated with a
 * placeholder number, since the real one is allocated on commit.
 *
 * A draft is numbered before the document is built (the number is in the
 * XML) and issued with the mark-sent semantics after the network accepted
 * it, exactly as the dashboard always did.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { issueAndBookInvoice, type IssueAndBookResult } from '@/lib/invoices/issue-and-book-invoice'
import { hasRequiredInvoicePaymentAccount } from '@/lib/invoices/payment-accounts'
import { snapshotInvoicePayee } from '@/lib/invoices/invoice-payee'
import {
  PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
  PEPPOL_BIS_BILLING_PROFILE_ID,
} from '@/lib/invoices/peppol-bis-billing'
import {
  checkPeppolSendPermission,
  getPeppolAccessSummary,
  type PeppolAccessSummary,
} from '@/lib/invoices/peppol-access'
import {
  isFiscalPeriodMissingError,
  listPeppolDeliveriesForInvoice,
  persistVerifiedPeppolEvent,
  sha256Hex,
  stagePeppolDelivery,
  stagePeppolDeliveryAsActor,
  type PeppolDeliverySummary,
} from '@/lib/invoices/peppol-delivery'
import {
  fetchPeppolRecordRows,
  generatePeppolDocument,
  peppolIssueDetails,
  PEPPOL_CUSTOMER_MISSING_MESSAGE_EN,
  PEPPOL_CUSTOMER_MISSING_MESSAGE_SV,
  type GeneratedPeppolInvoice,
  type PeppolInvoiceRecord,
} from '@/lib/invoices/peppol-document'
import {
  getPeppolTransport,
  getPeppolTransportAvailability,
  isPeppolTransportError,
  type PeppolDeliveryStatus,
  type PeppolParticipant,
  type PeppolRecipientLookup,
  type PeppolTransport,
  type PeppolTransportAvailability,
  type PeppolVerifiedEvent,
} from '@/lib/invoices/peppol-transport'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import type { CompanySettings, Invoice } from '@/types'

/** Invoice states that may still be handed to the network. */
const SENDABLE_STATUSES = new Set<Invoice['status']>(['draft', 'sent', 'overdue'])

const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'no_route', 'business_rejected'])

/**
 * Stands in for the number a numberless draft gets on commit, so the dry run
 * and the readiness check can run the full BIS preflight. Digits only: the
 * OCR reference is derived from it.
 */
const PLACEHOLDER_INVOICE_NUMBER = '1'

export const PEPPOL_SANDBOX_SEND_MESSAGE_SV =
  'Peppol-sändning är inte tillgänglig i demobolaget. Skapa ett riktigt konto för att skicka e-fakturor.'
export const PEPPOL_SANDBOX_SEND_MESSAGE_EN =
  'Peppol sending is not available in the demo company. Create a real account to send e-invoices.'

const PRECONDITION_PREFIX_SV = 'Fakturan kunde inte skickas via Peppol ännu: '
const PRECONDITION_PREFIX_EN = 'The invoice could not be sent via Peppol yet: '

/**
 * The hosted text behind the precondition prefix when the registry knows the
 * code; nothing otherwise, so the registry's generic pointer to the settings
 * stands.
 */
export function peppolPreconditionMessages(code: string | null | undefined): { messageSv?: string; messageEn?: string } {
  const entry = code ? getErrorEntry(code) : undefined
  if (!entry) return {}
  return {
    messageSv: PRECONDITION_PREFIX_SV + entry.message_sv,
    messageEn: PRECONDITION_PREFIX_EN + entry.message_en,
  }
}

/**
 * The English sentence that goes with a send failure's Swedish override, for
 * the dashboard's bilingual envelope (the operation outcome carries Swedish
 * only; the v1 and MCP doors answer the registry's English).
 */
export function peppolSendFailureMessageEn(
  outcome: Extract<OperationOutcome<unknown>, { ok: false }>,
): string | undefined {
  if (outcome.code === 'PEPPOL_SANDBOX_NOT_ALLOWED') return PEPPOL_SANDBOX_SEND_MESSAGE_EN
  if (outcome.code === 'PEPPOL_SEND_PRECONDITION_FAILED') {
    return peppolPreconditionMessages(outcome.details?.code as string | undefined).messageEn
  }
  if (outcome.code === 'VALIDATION_ERROR') {
    if (outcome.details?.field === 'invoice.customer') return PEPPOL_CUSTOMER_MISSING_MESSAGE_EN
    const issues = outcome.details?.issues as Array<{ message_en?: string }> | undefined
    return issues?.[0]?.message_en
  }
  return undefined
}

/**
 * How a failed submission is classified. A verdict on the document arrives
 * only as the access point's own answer: the direct adapter throws a
 * non-retryable error without a code, and the connector wraps the access
 * point's refusal as a non-retryable CONNECTOR_UPSTREAM_ERROR. Every other
 * coded answer is about the sender, the key, the route or the service:
 * transient ones (unreachable, rate limited, ledger, upstream unconfigured,
 * HTTP 429/5xx) are a plain failure; permanent ones (sender not registered,
 * not allowed, quota, scope, key, HTTP 4xx, protocol) are a precondition.
 * Neither is terminal: the delivery stays resendable.
 */
type SubmitVerdict = 'rejected' | 'precondition' | 'failed'

function classifySubmitFailure(err: unknown): { verdict: SubmitVerdict; code: string | null } {
  if (!isPeppolTransportError(err)) return { verdict: 'failed', code: null }
  if (err.retryable) return { verdict: 'failed', code: err.code }
  const documentVerdict = err.code === null || err.code === 'CONNECTOR_UPSTREAM_ERROR'
  return { verdict: documentVerdict ? 'rejected' : 'precondition', code: err.code }
}

/** Provider-source lifecycle events written by the send (service role). */
function sendEvent(args: {
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

function resolveTransport(): { availability: PeppolTransportAvailability; transport: PeppolTransport | null } {
  const availability = getPeppolTransportAvailability()
  const transport = availability.available ? getPeppolTransport(availability.provider) : null
  return { availability, transport }
}

function isRealInvoice(invoice: Pick<Invoice, 'document_type'>): boolean {
  return !invoice.document_type || invoice.document_type === 'invoice'
}

function isSendableInvoice(invoice: PeppolInvoiceRecord): boolean {
  return isRealInvoice(invoice)
    && !invoice.credited_invoice_id
    && !invoice.is_self_billed
    && SENDABLE_STATUSES.has(invoice.status)
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/**
 * Options for the door. The dashboard's ctx.supabase runs as the user (RLS,
 * auth.uid()), so it passes a service-role client for the rows the user's
 * JWT cannot reach (peppol_deliveries, the lifecycle event RPC). The v1 and
 * MCP doors already run on service role and pass nothing; their delivery is
 * then staged through stage_peppol_delivery_as_actor for ctx.userId, since
 * stage_peppol_delivery reads auth.uid().
 */
export interface PeppolDoorOptions {
  service?: SupabaseClient
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface PeppolSendResult {
  invoice_id: string
  invoice_number: string | null
  invoice_status: Invoice['status']
  delivery: PeppolDeliverySummary
  already_submitted: boolean
  /** The participant the SMP lookup confirmed; null on an idempotent replay. */
  recipient: PeppolParticipant | null
  journal_entry_id: string | null
  /** Null unless a draft was issued after the network accepted it. */
  issuance: { ok: true; partial_failures: unknown[] } | { ok: false; error_code: string } | null
}

export async function sendInvoiceViaPeppol(
  ctx: OperationContext,
  invoiceId: string,
  options: PeppolDoorOptions & { dryRun?: boolean } = {},
): Promise<OperationOutcome<PeppolSendResult>> {
  const { supabase, companyId, log } = ctx
  const dryRun = options.dryRun === true
  const service = options.service ?? supabase

  // Every refusal before a delivery row exists leaves one structured line
  // with the registry code: no amounts, no names. Prod had zero deliveries
  // and no way to tell which gate stopped them (#2484).
  const logRefusal = (code: string, extra: Record<string, unknown> = {}) =>
    log.info('peppol send refused', { invoiceId, code, ...extra })
  const refuse = (code: string, rest: Omit<Failure, 'ok' | 'code'> = {}): Failure => {
    logRefusal(code)
    return { ok: false, code, ...rest }
  }

  const { availability, transport } = resolveTransport()
  if (!availability.available || !transport) {
    return refuse('PEPPOL_TRANSPORT_UNAVAILABLE', {
      details: { reason: availability.available ? 'provider_adapter_unavailable' : availability.reason },
    })
  }

  if (await isSandboxCompany(supabase, companyId)) {
    return refuse('PEPPOL_SANDBOX_NOT_ALLOWED', { messageSv: PEPPOL_SANDBOX_SEND_MESSAGE_SV })
  }

  // Access is granted per company by the operators and capped in sends:
  // refused before any invoice data is touched.
  const permission = await checkPeppolSendPermission({ service, companyId })
  if (!permission.ok) {
    return refuse(permission.code, {
      details: {
        access_status: permission.summary.status,
        max_sends: permission.summary.max_sends,
        sent_count: permission.summary.sent_count,
      },
    })
  }

  const records = await fetchPeppolRecordRows(supabase, companyId, invoiceId)
  if (!records.ok) return refuse(records.code)
  const { invoice, company } = records

  if (!isSendableInvoice(invoice)) {
    return refuse('PEPPOL_SEND_INVALID_STATUS', {
      details: { status: invoice.status, document_type: invoice.document_type ?? 'invoice' },
    })
  }

  const wasDraft = invoice.status === 'draft'
  // A draft is issued (numbered, marked sent, booked) after the network
  // accepts it. Refuse up front what issuance would refuse afterwards, so an
  // invoice never reaches the buyer and then fails to book.
  if (wasDraft) {
    const payeeSnapshot = await snapshotInvoicePayee(supabase, companyId, invoice, { persist: !dryRun })
    if (!payeeSnapshot.ok) return refuse(payeeSnapshot.code, { details: payeeSnapshot.details })
    invoice.payment_details = payeeSnapshot.payee
    if (!hasRequiredInvoicePaymentAccount(company, invoice)) {
      return refuse('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', { details: { currency: invoice.currency } })
    }
  }

  const numberPending = wasDraft && !invoice.invoice_number
  if (numberPending && !dryRun) {
    try {
      invoice.invoice_number = await ensureInvoiceNumber(supabase, companyId, invoice)
    } catch (err) {
      log.error('failed to assign invoice number before Peppol send', err as Error)
      return refuse('INVOICE_CREATE_NUMBER_ASSIGN_FAILED')
    }
  }

  const generated = generatePeppolDocument(
    numberPending && dryRun ? { ...invoice, invoice_number: PLACEHOLDER_INVOICE_NUMBER } : invoice,
    company,
  )
  if (!generated.ok) {
    if (generated.reason === 'customer_missing') {
      return refuse('VALIDATION_ERROR', {
        messageSv: PEPPOL_CUSTOMER_MISSING_MESSAGE_SV,
        details: { field: 'invoice.customer' },
      })
    }
    // The BIS issue codes say which preflight rule stopped the send.
    logRefusal('VALIDATION_ERROR', { issues: generated.issues.slice(0, 10).map((i) => i.code) })
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      messageSv: generated.issues[0]?.messageSv,
      details: { issues: peppolIssueDetails(generated.issues) },
    }
  }
  const document = generated

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        invoice: {
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number ?? '(allocated atomically on commit)',
          status: invoice.status,
          invoice_date: invoice.invoice_date,
          due_date: invoice.due_date ?? null,
          currency: invoice.currency,
          total: invoice.total,
          customer_name: invoice.customer?.name ?? null,
        },
        sender: document.sender,
        recipient: document.recipient,
        transport_provider: transport.provider,
        remaining_sends: permission.remaining,
        will_issue_invoice: wasDraft,
        network_submitted: false,
        // The SMP lookup and the submission are network calls: commit only.
        recipient_lookup: 'on_commit',
      },
    }
  }

  return submitStagedDocument({ ctx, service, stageAsActor: !options.service, transport, invoice, company, document, wasDraft, refuse })
}

async function submitStagedDocument(args: {
  ctx: OperationContext
  service: SupabaseClient
  stageAsActor: boolean
  transport: PeppolTransport
  invoice: PeppolInvoiceRecord
  company: CompanySettings
  document: GeneratedPeppolInvoice
  wasDraft: boolean
  refuse: (code: string, rest?: Omit<Failure, 'ok' | 'code'>) => Failure
}): Promise<OperationOutcome<PeppolSendResult>> {
  const { ctx, service, transport, invoice, company, document, wasDraft, refuse } = args
  const { supabase, companyId, userId, log } = ctx
  const invoiceId = invoice.id
  const provider = transport.provider
  // Consolidated Qvalia setup: one provider account for every company. The
  // adapter resolves the account; the lifecycle only needs a stable label.
  const tenantId = process.env.QVALIA_ACCOUNT_REG_NO?.trim()
    || process.env.QVALIA_PARTNER_REG_NO?.trim()
    || provider
  const result = (
    delivery: PeppolDeliverySummary,
    rest: Partial<PeppolSendResult> = {},
  ): PeppolSendResult => ({
    invoice_id: invoiceId,
    invoice_number: invoice.invoice_number ?? null,
    invoice_status: invoice.status,
    delivery,
    already_submitted: false,
    recipient: null,
    journal_entry_id: null,
    issuance: null,
    ...rest,
  })

  try {
    let delivery: PeppolDeliverySummary
    try {
      delivery = args.stageAsActor
        ? await stagePeppolDeliveryAsActor({ supabase, companyId, invoiceId, actorId: userId, document })
        : await stagePeppolDelivery({ supabase, companyId, invoiceId, document })
    } catch (err) {
      if (isFiscalPeriodMissingError(err)) {
        return refuse('PEPPOL_FISCAL_PERIOD_MISSING', { details: { invoice_date: invoice.invoice_date } })
      }
      throw err
    }

    if (delivery.provider_submission_id) {
      // Exact XML already handed to the network: idempotent replay, never a
      // second transmission.
      return { ok: true, data: result(delivery, { already_submitted: true }) }
    }
    if (delivery.terminal_at && TERMINAL_FAILURE_STATUSES.has(delivery.status)) {
      return {
        ok: false,
        code: 'PEPPOL_SUBMISSION_REJECTED',
        details: { status: delivery.status, detail: delivery.status_detail },
      }
    }

    // A lookup that cannot be performed is not a lookup that answered "not
    // registered" and never a verdict on the document: the delivery stays
    // staged, nothing terminal is recorded, and the answer is always 502
    // retryable. Anything but a transport error keeps the generic handling.
    let lookup: PeppolRecipientLookup
    try {
      lookup = await transport.lookupRecipient(document.recipient)
    } catch (err) {
      if (!isPeppolTransportError(err)) throw err
      log.error('Peppol recipient lookup failed', err, {
        invoiceId,
        retryable: err.retryable,
        transportCode: err.code,
      })
      return { ok: false, code: 'PEPPOL_LOOKUP_FAILED', details: { reason: err.detail, code: err.code } }
    }
    if (!lookup.reachable) {
      return {
        ok: false,
        code: 'PEPPOL_RECIPIENT_NOT_REACHABLE',
        details: {
          scheme: document.recipient.scheme,
          identifier: document.recipient.identifier,
          reason: lookup.reasonCode,
        },
      }
    }
    const supportsInvoice = lookup.capabilities.length === 0
      || lookup.capabilities.some((c) => c.documentTypeId === PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID)
    if (!supportsInvoice) {
      return {
        ok: false,
        code: 'PEPPOL_RECIPIENT_NOT_REACHABLE',
        details: {
          scheme: document.recipient.scheme,
          identifier: document.recipient.identifier,
          reason: 'document_type_not_supported',
        },
      }
    }

    delivery = await persistVerifiedPeppolEvent({
      supabase: service,
      companyId,
      event: sendEvent({
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

    delivery = await persistVerifiedPeppolEvent({
      supabase: service,
      companyId,
      event: sendEvent({
        provider,
        tenantId,
        idempotencyKey: delivery.idempotency_key,
        providerSubmissionId: null,
        code: 'submit_attempt',
        status: 'submitting',
        terminal: false,
        statusDetail: null,
        occurredAt: new Date().toISOString(),
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
      const { verdict, code: transportCode } = classifySubmitFailure(err)
      // Only the access point's own verdict (provider `rejected`/`duplicate`)
      // is terminal; a precondition or a transient failure leaves the
      // delivery resendable.
      const retryable = verdict !== 'rejected'
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
        verdict,
        transportCode,
      })
      await persistVerifiedPeppolEvent({
        supabase: service,
        companyId,
        event: sendEvent({
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
      if (verdict === 'precondition' && transportCode !== null) {
        return {
          ok: false,
          code: 'PEPPOL_SEND_PRECONDITION_FAILED',
          ...(peppolPreconditionMessages(transportCode).messageSv
            ? { messageSv: peppolPreconditionMessages(transportCode).messageSv }
            : {}),
          details: { reason: providerReason, code: transportCode },
        }
      }
      return {
        ok: false,
        code: verdict === 'failed' ? 'PEPPOL_SUBMISSION_FAILED' : 'PEPPOL_SUBMISSION_REJECTED',
        details: { reason: providerReason, code: transportCode },
      }
    }

    delivery = await persistVerifiedPeppolEvent({
      supabase: service,
      companyId,
      event: sendEvent({
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
    const warnings: OperationWarning[] = []
    if (wasDraft) {
      issuance = await issueAndBookInvoice({ supabase, companyId, userId, invoice, settings: company, log })
      if (issuance.ok) {
        invoiceStatus = 'sent'
      } else {
        log.error('Peppol send accepted but issuance failed', { invoiceId, errorCode: issuance.errorCode })
        warnings.push({
          code: 'PEPPOL_SENT_NOT_ISSUED',
          message_sv:
            'Fakturan skickades via Peppol men kunde inte markeras som skickad. Slutför utfärdandet med mark-sent; numret återanvänds.',
          message_en:
            'The invoice was sent via Peppol but could not be marked as sent. Complete the issuance with mark-sent; the number is reused.',
        })
      }
    }

    return {
      ok: true,
      created: true,
      data: result(delivery, {
        invoice_status: invoiceStatus,
        recipient: { scheme: lookup.participant.scheme, identifier: lookup.participant.identifier },
        journal_entry_id: issuance?.ok ? issuance.journalEntryId : null,
        issuance: issuance === null
          ? null
          : issuance.ok
            ? { ok: true, partial_failures: issuance.partialFailures }
            : { ok: false, error_code: issuance.errorCode },
      }),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (err) {
    return { ok: false, code: 'INTERNAL_ERROR', error: err }
  }
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface PeppolReadinessBlocker {
  code: string
  field: string | null
  message_sv: string
  message_en: string
}

export interface PeppolReadiness {
  invoice_id: string
  invoice_number: string | null
  invoice_status: Invoice['status']
  ready: boolean
  will_issue_invoice: boolean
  sender: PeppolParticipant | null
  recipient: PeppolParticipant | null
  transport: { available: boolean; provider: string | null; reason: string | null }
  access: Pick<PeppolAccessSummary, 'status' | 'send_enabled' | 'max_sends' | 'sent_count' | 'remaining_sends'>
  blockers: PeppolReadinessBlocker[]
}

function blocker(
  code: string,
  overrides: { field?: string | null; messageSv?: string; messageEn?: string } = {},
): PeppolReadinessBlocker {
  const entry = getErrorEntry(code)
  return {
    code,
    field: overrides.field ?? null,
    message_sv: overrides.messageSv ?? entry?.message_sv ?? code,
    message_en: overrides.messageEn ?? entry?.message_en ?? code,
  }
}

/**
 * Can this invoice go over Peppol, to which participant, and what is in the
 * way. Every gate the send applies is evaluated and every failing one listed
 * (the send stops at the first). Reads only; the recipient's registration in
 * the Peppol network is NOT looked up here (that is a network call the send
 * makes on commit), so `ready` means "nothing on our side stops it".
 */
export async function getInvoicePeppolReadiness(
  ctx: OperationContext,
  invoiceId: string,
  options: PeppolDoorOptions = {},
): Promise<OperationOutcome<PeppolReadiness>> {
  const { supabase, companyId } = ctx
  const service = options.service ?? supabase

  const records = await fetchPeppolRecordRows(supabase, companyId, invoiceId)
  if (!records.ok) return { ok: false, code: records.code }
  const { invoice, company } = records
  const blockers: PeppolReadinessBlocker[] = []

  const { availability } = resolveTransport()
  if (!availability.available) {
    blockers.push(blocker('PEPPOL_TRANSPORT_UNAVAILABLE', { field: availability.reason }))
  }
  if (await isSandboxCompany(supabase, companyId)) {
    blockers.push(blocker('PEPPOL_SANDBOX_NOT_ALLOWED', {
      messageSv: PEPPOL_SANDBOX_SEND_MESSAGE_SV,
      messageEn: PEPPOL_SANDBOX_SEND_MESSAGE_EN,
    }))
  }
  const access = await getPeppolAccessSummary({ supabase: service, service, companyId })
  if (!access.send_enabled) blockers.push(blocker('PEPPOL_ACCESS_REQUIRED'))
  else if (access.remaining_sends === 0) blockers.push(blocker('PEPPOL_SEND_LIMIT_REACHED'))

  const sendable = isSendableInvoice(invoice)
  if (!sendable) blockers.push(blocker('PEPPOL_SEND_INVALID_STATUS', { field: 'invoice.status' }))

  const wasDraft = invoice.status === 'draft'
  if (sendable && wasDraft) {
    const payeeSnapshot = await snapshotInvoicePayee(supabase, companyId, invoice, { persist: false })
    if (!payeeSnapshot.ok) {
      blockers.push(blocker(payeeSnapshot.code, { field: 'invoice.payment_cash_account_id' }))
    } else {
      invoice.payment_details = payeeSnapshot.payee
      if (!hasRequiredInvoicePaymentAccount(company, invoice)) {
        blockers.push(blocker('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', { field: 'company.payment_accounts' }))
      }
    }
  }

  let sender: PeppolParticipant | null = null
  let recipient: PeppolParticipant | null = null
  const generated = generatePeppolDocument(
    wasDraft && !invoice.invoice_number ? { ...invoice, invoice_number: PLACEHOLDER_INVOICE_NUMBER } : invoice,
    company,
  )
  if (generated.ok) {
    sender = generated.sender
    recipient = generated.recipient
  } else if (generated.reason === 'customer_missing') {
    blockers.push(blocker('VALIDATION_ERROR', {
      field: 'invoice.customer',
      messageSv: PEPPOL_CUSTOMER_MISSING_MESSAGE_SV,
      messageEn: PEPPOL_CUSTOMER_MISSING_MESSAGE_EN,
    }))
  } else {
    for (const issue of generated.issues) {
      blockers.push({ code: issue.code, field: issue.field, message_sv: issue.messageSv, message_en: issue.messageEn })
    }
  }

  return {
    ok: true,
    data: {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number ?? null,
      invoice_status: invoice.status,
      ready: blockers.length === 0,
      will_issue_invoice: wasDraft,
      sender,
      recipient,
      transport: {
        available: availability.available,
        provider: availability.available ? availability.provider : null,
        reason: availability.available ? null : availability.reason,
      },
      access: {
        status: access.status,
        send_enabled: access.send_enabled,
        max_sends: access.max_sends,
        sent_count: access.sent_count,
        remaining_sends: access.remaining_sends,
      },
      blockers,
    },
  }
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export interface PeppolDeliveriesResult {
  deliveries: PeppolDeliverySummary[]
  transport: PeppolTransportAvailability
  access: PeppolAccessSummary
}

/** An invoice's Peppol deliveries (newest first) with the transport and access state. */
export async function listInvoicePeppolDeliveries(
  ctx: OperationContext,
  invoiceId: string,
  options: PeppolDoorOptions = {},
): Promise<OperationOutcome<PeppolDeliveriesResult>> {
  const { supabase, companyId } = ctx
  const service = options.service ?? supabase

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('id')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .single()
  if (invoiceError || !invoice) return { ok: false, code: 'INVOICE_NOT_FOUND' }

  try {
    const deliveries = await listPeppolDeliveriesForInvoice({ service, companyId, invoiceId })
    const access = await getPeppolAccessSummary({ supabase, service, companyId })
    return { ok: true, data: { deliveries, transport: getPeppolTransportAvailability(), access } }
  } catch (err) {
    return { ok: false, code: 'INTERNAL_ERROR', error: err }
  }
}
