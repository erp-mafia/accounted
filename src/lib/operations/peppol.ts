/**
 * Peppol e-invoicing operations: check whether a customer invoice can go
 * over Peppol, send it through the contracted access point, read its
 * deliveries, and the company side (receiving registration, access request).
 * Before these the whole Peppol flow was dashboard-only.
 *
 * Rules live in lib/invoices/peppol-send-service.ts and
 * lib/invoices/peppol-settings-service.ts, shared with the dashboard routes
 * POST /api/invoices/[id]/peppol/send, GET /api/invoices/[id]/peppol/deliveries,
 * GET/POST /api/settings/peppol and POST /api/settings/peppol/access.
 *
 * Every network call (the SMP recipient lookup, the submission, publishing a
 * participant id) happens on commit only: a dry run, and so the MCP staging
 * preview, validates with reads.
 */
import { z } from 'zod'
import type { PeppolDeliverySummary } from '@/lib/invoices/peppol-delivery'
import {
  getInvoicePeppolReadiness,
  listInvoicePeppolDeliveries,
  sendInvoiceViaPeppol,
} from '@/lib/invoices/peppol-send-service'
import {
  PeppolAccessRequestSchema,
  getPeppolRegistrationStatus,
  registerPeppolParticipant,
  requestPeppolAccessForCompany,
} from '@/lib/invoices/peppol-settings-service'
import {
  canRetryPeppolRegistration,
  isStalePeppolPending,
  type PeppolRegistrationRow,
} from '@/lib/invoices/peppol-registration'
import type { PeppolAccessSummary } from '@/lib/invoices/peppol-access'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const INVOICE_ID = z.string().uuid().describe('The customer invoice id, from GET /invoices.')

const Participant = z.object({
  scheme: z.string().describe('Peppol identifier scheme; 0007 is the Swedish organisation number.'),
  identifier: z.string().describe('The organisation number, digits only.'),
})

const Access = z.object({
  status: z.enum(['none', 'requested', 'enabled', 'disabled']),
  send_enabled: z.boolean(),
  receive_enabled: z.boolean().optional(),
  max_sends: z.number().nullable(),
  sent_count: z.number(),
  remaining_sends: z.number().nullable(),
})

function toAccess(summary: PeppolAccessSummary) {
  return {
    status: summary.status,
    send_enabled: summary.send_enabled,
    receive_enabled: summary.receive_enabled,
    max_sends: summary.max_sends,
    sent_count: summary.sent_count,
    remaining_sends: summary.remaining_sends,
  }
}

const Transport = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
  reason: z.string().nullable().describe('Why sending is off in this environment, when it is.'),
})

const Delivery = z.object({
  delivery_id: z.string().uuid(),
  idempotency_key: z.string(),
  recipient_scheme: z.string(),
  recipient_identifier: z.string(),
  xml_sha256: z.string().describe('SHA-256 of the exact UBL document staged for the network.'),
  provider: z.string().nullable(),
  provider_submission_id: z.string().nullable().describe('Set once the access point accepted the document.'),
  status: z.string().describe('staged, recipient_verified, submitting, retryable_failure, submission_accepted, transport_succeeded, recipient_acknowledged, business_accepted, business_rejected, no_route or failed.'),
  status_at: z.string(),
  status_detail: z.string().nullable(),
  submitted_at: z.string().nullable(),
  terminal_at: z.string().nullable(),
})

function toDelivery(d: PeppolDeliverySummary): z.infer<typeof Delivery> {
  return {
    delivery_id: d.id,
    idempotency_key: d.idempotency_key,
    recipient_scheme: d.recipient_scheme,
    recipient_identifier: d.recipient_identifier,
    xml_sha256: d.xml_sha256,
    provider: d.provider,
    provider_submission_id: d.provider_submission_id,
    status: d.status,
    status_at: d.status_at,
    status_detail: d.status_detail,
    submitted_at: d.submitted_at,
    terminal_at: d.terminal_at,
  }
}

const SCOPE_PITFALL =
  'Peppol here is BIS Billing 3: aktiebolag senders, standard invoices only (no credit notes, quotes, proformas or self-billing), Swedish org-number buyers whose org number is not a personnummer, SEK with taxable Swedish VAT at 6/12/25 %, no ROT/RUT deductions. Anything else is listed as a blocker.'

// ---------------------------------------------------------------------------
// invoices.peppol-readiness
// ---------------------------------------------------------------------------

const Blocker = z.object({
  code: z.string().describe('Registry code of the gate, or the BIS preflight rule (e.g. BUYER_REFERENCE_REQUIRED).'),
  field: z.string().nullable(),
  message_sv: z.string(),
  message_en: z.string(),
})

export const invoicesPeppolReadiness = defineOperation({
  id: 'invoices.peppol-readiness',
  kind: 'read',
  scope: 'invoices:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Check whether a customer invoice can be sent over Peppol, to which participant, and what is missing.',
    description:
      'Runs every gate the Peppol send applies, as reads, and lists each failing one: the access point is configured, the company is not the demo company, the operators granted Peppol access and sends remain, the invoice is a plain invoice in draft/sent/overdue, a draft can be issued (payee account), and the BIS Billing 3 document builds (EN 16931 + Sweden CIUS preflight). Answers the sender and recipient participant ids (0007 + org number). The recipient\'s registration in the Peppol network is not looked up here: the send does that on commit.',
    useWhen:
      'Before POST /invoices/{id}/send-peppol, to fix what is missing (a buyer reference, a Bankgiro, the org number) instead of learning it from a refused send.',
    doNotUseFor:
      'Downloading the UBL XML (the dashboard export) or reading past transmissions (GET /invoices/{id}/peppol/deliveries).',
    pitfalls: [
      'ready=true means nothing on Accounted\'s side stops the send; the buyer can still be unregistered in Peppol, which the send answers as 422 PEPPOL_RECIPIENT_NOT_REACHABLE.',
      'A draft without a number is validated with a placeholder number: the real F-series number is allocated only when the send commits.',
      'PEPPOL_ACCESS_REQUIRED means the company has not been granted Peppol: request it with POST /peppol/access-request.',
      SCOPE_PITFALL,
    ],
    example: {
      response: {
        data: {
          invoice_id: '7d1e…',
          invoice_number: 'F-1042',
          invoice_status: 'sent',
          ready: false,
          will_issue_invoice: false,
          sender: { scheme: '0007', identifier: '5560160680' },
          recipient: { scheme: '0007', identifier: '5566778899' },
          transport: { available: true, provider: 'qvalia', reason: null },
          access: { status: 'enabled', send_enabled: true, max_sends: 50, sent_count: 3, remaining_sends: 47 },
          blockers: [
            {
              code: 'BUYER_REFERENCE_REQUIRED',
              field: 'invoice.your_reference',
              message_sv: 'Märkning eller Er referens krävs för Peppol när inköpsordernummer saknas.',
              message_en: 'A marking or buyer reference is required for Peppol when no purchase order reference is available.',
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({ invoice_id: INVOICE_ID }),
  output: z.object({
    invoice_id: z.string().uuid(),
    invoice_number: z.string().nullable(),
    invoice_status: z.string(),
    ready: z.boolean(),
    will_issue_invoice: z.boolean().describe('True for a draft: a successful send numbers, issues and books it.'),
    sender: Participant.nullable(),
    recipient: Participant.nullable().describe('The participant the invoice would be addressed to; null when the document does not build.'),
    transport: Transport,
    access: Access,
    blockers: z.array(Blocker),
  }),
  errorCodes: ['INVOICE_NOT_FOUND', 'INVOICE_SEND_COMPANY_SETTINGS_MISSING'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/invoices/:id/peppol',
    pathParams: { id: 'invoice_id' },
  },
  mcp: {
    name: 'gnubok_get_invoice_peppol_readiness',
    title: 'Get Invoice Peppol Readiness',
    description:
      'Check whether a customer invoice can be sent as a Peppol e-invoice: lists every blocker (access grant, invoice state, BIS Billing 3 rules such as buyer reference or Bankgiro) and the recipient participant id. Call before gnubok_send_invoice_peppol.',
    keywords: ['peppol', 'e-faktura', 'efaktura', 'kan fakturan skickas', 'bis billing', 'mottagare peppol'],
  },
  run: async (ctx, { invoice_id }) => getInvoicePeppolReadiness(ctx, invoice_id),
})

// ---------------------------------------------------------------------------
// invoices.send-peppol
// ---------------------------------------------------------------------------

const Issuance = z
  .union([
    z.object({ ok: z.literal(true), partial_failures: z.array(z.unknown()) }),
    z.object({ ok: z.literal(false), error_code: z.string() }),
  ])
  .nullable()
  .describe('Null unless a draft was issued after the network accepted it.')

export const invoicesSendPeppol = defineOperation({
  id: 'invoices.send-peppol',
  kind: 'write',
  scope: 'invoices:write',
  // Transmits a legal invoice to an external network (billed per document)
  // and, for a draft, numbers, issues and books it.
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Send a customer invoice as a Peppol e-invoice (BIS Billing 3) through the access point.',
    description:
      'Builds the BIS Billing 3 UBL document, stages it as a delivery (retained with the invoice\'s fiscal year), looks the buyer up in the Peppol network and submits it. A draft is numbered first (the number is in the document) and, once the network accepted it, issued with the :mark-sent semantics: status sent, verifikat under faktureringsmetoden, PDF archived as underlag. Resending the exact same document replays the first submission instead of transmitting twice. The dry run validates everything as reads and contacts no network.',
    useWhen:
      'The buyer receives e-invoices over Peppol (typically public sector, where Lag 2018:1277 requires it, or a company that asks for it) and GET /invoices/{id}/peppol shows no blockers.',
    doNotUseFor:
      'Emailing the invoice (POST /invoices/{id}/send), recording one delivered another way (:mark-sent), credit notes, quotes or proformas.',
    pitfalls: [
      'Needs the company\'s Peppol access grant: 403 PEPPOL_ACCESS_REQUIRED until the operators enable it (POST /peppol/access-request), 409 PEPPOL_SEND_LIMIT_REACHED once the sending cap is used.',
      'A buyer not registered in Peppol answers 422 PEPPOL_RECIPIENT_NOT_REACHABLE and nothing is transmitted; a failed lookup answers 502 PEPPOL_LOOKUP_FAILED and is safe to retry.',
      '422 PEPPOL_SUBMISSION_REJECTED is the access point\'s verdict on the document: fix the invoice (a correction is a credit note plus a new invoice once issued), do not resend unchanged.',
      '502 PEPPOL_SUBMISSION_FAILED and 409 PEPPOL_SEND_PRECONDITION_FAILED leave the delivery resendable: retry later or fix the Peppol settings.',
      'If a draft was transmitted but could not be marked as sent, the response carries issuance.ok=false and a PEPPOL_SENT_NOT_ISSUED warning: complete it with POST /invoices/{id}/mark-sent, which reuses the number.',
      'An invoice date outside every fiscal year answers 422 PEPPOL_FISCAL_PERIOD_MISSING (the delivery needs its retention basis).',
      SCOPE_PITFALL,
    ],
    example: {
      response: {
        data: {
          invoice_id: '7d1e…',
          invoice_number: 'F-1042',
          invoice_status: 'sent',
          network_submitted: true,
          already_submitted: false,
          delivery: {
            delivery_id: '2b9c…',
            idempotency_key: '5e3f…',
            recipient_scheme: '0007',
            recipient_identifier: '5566778899',
            xml_sha256: 'a3f1…',
            provider: 'qvalia',
            provider_submission_id: 'int-1',
            status: 'submission_accepted',
            status_at: '2026-09-26T10:00:02Z',
            status_detail: null,
            submitted_at: '2026-09-26T10:00:02Z',
            terminal_at: null,
          },
          recipient: { scheme: '0007', identifier: '5566778899' },
          journal_entry_id: '9a0b…',
          issuance: { ok: true, partial_failures: [] },
        },
        meta: META,
      },
    },
  },
  input: z.object({ invoice_id: INVOICE_ID }),
  output: z.object({
    invoice_id: z.string().uuid(),
    invoice_number: z.string().nullable(),
    invoice_status: z.string(),
    network_submitted: z.literal(true),
    already_submitted: z.boolean().describe('True when this exact document was already handed to the network: nothing was transmitted again.'),
    delivery: Delivery,
    recipient: Participant.nullable(),
    journal_entry_id: z.string().uuid().nullable(),
    issuance: Issuance,
  }),
  errorCodes: [
    'PEPPOL_TRANSPORT_UNAVAILABLE',
    'PEPPOL_SANDBOX_NOT_ALLOWED',
    'PEPPOL_ACCESS_REQUIRED',
    'PEPPOL_SEND_LIMIT_REACHED',
    'INVOICE_NOT_FOUND',
    'INVOICE_SEND_COMPANY_SETTINGS_MISSING',
    'PEPPOL_SEND_INVALID_STATUS',
    'INVOICE_SEND_PAYMENT_ACCOUNT_INVALID',
    'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING',
    'INVOICE_CREATE_NUMBER_ASSIGN_FAILED',
    'VALIDATION_ERROR',
    'PEPPOL_FISCAL_PERIOD_MISSING',
    'PEPPOL_LOOKUP_FAILED',
    'PEPPOL_RECIPIENT_NOT_REACHABLE',
    'PEPPOL_SUBMISSION_REJECTED',
    'PEPPOL_SUBMISSION_FAILED',
    'PEPPOL_SEND_PRECONDITION_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/invoices/:id/send-peppol',
    pathParams: { id: 'invoice_id' },
  },
  mcp: {
    name: 'gnubok_send_invoice_peppol',
    title: 'Send Invoice via Peppol',
    description:
      'Stage sending a customer invoice as a Peppol e-invoice through the access point; a draft is numbered, issued and booked once the network accepts it. The preview validates the BIS document without contacting the network. Check gnubok_get_invoice_peppol_readiness first.',
    keywords: ['peppol', 'skicka e-faktura', 'e-faktura', 'efaktura', 'skicka via peppol', 'offentlig sektor', 'bis billing'],
    stage: {
      pendingType: 'send_invoice_peppol',
      title: () => 'Skicka kundfaktura via Peppol',
    },
  },
  run: async (ctx, { invoice_id }, { dryRun }) => {
    const outcome = await sendInvoiceViaPeppol(ctx, invoice_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const r = outcome.data
    return {
      ...outcome,
      data: {
        invoice_id: r.invoice_id,
        invoice_number: r.invoice_number,
        invoice_status: r.invoice_status,
        network_submitted: true as const,
        already_submitted: r.already_submitted,
        delivery: toDelivery(r.delivery),
        recipient: r.recipient,
        journal_entry_id: r.journal_entry_id,
        issuance: r.issuance,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// invoices.peppol-deliveries
// ---------------------------------------------------------------------------

export const invoicesPeppolDeliveries = defineOperation({
  id: 'invoices.peppol-deliveries',
  kind: 'read',
  scope: 'invoices:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List an invoice\'s Peppol deliveries and their network status.',
    description:
      'Every document staged for the Peppol network for this invoice, newest first, with its lifecycle status (staged through submission_accepted, transport_succeeded and the buyer\'s business response), the access point\'s submission id and the SHA-256 of the exact XML. Also answers whether sending is available in this environment and the company\'s access grant. Status updates arrive asynchronously from the access point.',
    useWhen: 'After a send, to follow the delivery, or before resending, to see whether the invoice already went out.',
    doNotUseFor: 'Checking whether an invoice can be sent (GET /invoices/{id}/peppol) or email deliveries.',
    pitfalls: [
      'submission_accepted means the access point took the document, not that the buyer received it; transport_succeeded and business_accepted come later.',
      'A delivery in retryable_failure can be resent with POST /invoices/{id}/send-peppol; a terminal failed or business_rejected one cannot be resent unchanged.',
    ],
    example: {
      response: {
        data: {
          invoice_id: '7d1e…',
          deliveries: [
            {
              delivery_id: '2b9c…',
              idempotency_key: '5e3f…',
              recipient_scheme: '0007',
              recipient_identifier: '5566778899',
              xml_sha256: 'a3f1…',
              provider: 'qvalia',
              provider_submission_id: 'int-1',
              status: 'transport_succeeded',
              status_at: '2026-09-26T10:01:00Z',
              status_detail: null,
              submitted_at: '2026-09-26T10:00:02Z',
              terminal_at: null,
            },
          ],
          transport: { available: true, provider: 'qvalia', reason: null },
          access: { status: 'enabled', send_enabled: true, receive_enabled: false, max_sends: 50, sent_count: 3, remaining_sends: 47 },
        },
        meta: META,
      },
    },
  },
  input: z.object({ invoice_id: INVOICE_ID }),
  output: z.object({
    invoice_id: z.string().uuid(),
    deliveries: z.array(Delivery),
    transport: Transport,
    access: Access,
  }),
  errorCodes: ['INVOICE_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/invoices/:id/peppol/deliveries',
    pathParams: { id: 'invoice_id' },
  },
  mcp: {
    name: 'gnubok_list_invoice_peppol_deliveries',
    title: 'List Invoice Peppol Deliveries',
    description:
      'List the Peppol deliveries of a customer invoice with their network status (accepted by the access point, delivered, accepted or rejected by the buyer). Use after gnubok_send_invoice_peppol or before resending.',
    keywords: ['peppol status', 'e-faktura status', 'leverans peppol', 'skickad via peppol'],
  },
  run: async (ctx, { invoice_id }) => {
    const outcome = await listInvoicePeppolDeliveries(ctx, invoice_id)
    if (!outcome.ok || outcome.dryRun) return outcome
    const { deliveries, transport, access } = outcome.data
    return {
      ok: true,
      data: {
        invoice_id,
        deliveries: deliveries.map(toDelivery),
        transport: {
          available: transport.available,
          provider: transport.available ? transport.provider : null,
          reason: transport.available ? null : transport.reason,
        },
        access: toAccess(access),
      },
    }
  },
})

// ---------------------------------------------------------------------------
// peppol.get-registration / peppol.register
// ---------------------------------------------------------------------------

const Registration = z.object({
  registration_id: z.string().uuid(),
  provider: z.string(),
  participant_scheme: z.string(),
  participant_identifier: z.string(),
  status: z.enum(['pending', 'registered', 'failed', 'deregistered']),
  registered_at: z.string().nullable(),
  deregistered_at: z.string().nullable(),
  last_error_code: z.string().nullable().describe('Registry code of the last failure; translate it, never retry a permanent one.'),
  stale_pending: z.boolean().describe('A pending attempt that never finished; registering again retires it.'),
  can_retry: z.boolean().describe('Whether registering again can change the outcome.'),
  updated_at: z.string(),
})

function toRegistration(row: PeppolRegistrationRow | null): z.infer<typeof Registration> | null {
  if (!row) return null
  return {
    registration_id: row.id,
    provider: row.provider,
    participant_scheme: row.participant_scheme,
    participant_identifier: row.participant_identifier,
    status: row.status,
    registered_at: row.registered_at,
    deregistered_at: row.deregistered_at,
    last_error_code: row.last_error_code,
    stale_pending: isStalePeppolPending(row),
    can_retry: canRetryPeppolRegistration(row),
    updated_at: row.updated_at,
  }
}

const REGISTRATION_PATH = '/api/v1/companies/:companyId/peppol/registration'

const EXAMPLE_REGISTRATION = {
  registration_id: '4c2d…',
  provider: 'qvalia',
  participant_scheme: '0007',
  participant_identifier: '5595386219',
  status: 'registered',
  registered_at: '2026-09-26T10:00:00Z',
  deregistered_at: null,
  last_error_code: null,
  stale_pending: false,
  can_retry: false,
  updated_at: '2026-09-26T10:00:00Z',
}

export const peppolGetRegistration = defineOperation({
  id: 'peppol.get-registration',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the company\'s Peppol receiving status: access grant, eligibility and registration.',
    description:
      'Whether this environment has an access point and whether it supports receiving, the company\'s Peppol access grant (sending cap, receiving slot), whether the company can be registered at all (a 10-digit organisation number that is not a personnummer, a company name), and the registration of its participant id (0007 + org number) with its status and last error.',
    useWhen: 'Before POST /peppol/registration, or to explain why the company does not receive e-invoices.',
    doNotUseFor: 'Sending (GET /invoices/{id}/peppol checks an invoice) or reading received e-invoices (they arrive in the invoice inbox).',
    pitfalls: [
      'participant.ok=false with PEPPOL_REGISTRATION_PERSONAL_NUMBER means a sole trader identified by personnummer: it cannot be published in the Peppol directory.',
      'registration.can_retry says whether registering again can help; a permanent verdict (e.g. CONNECTOR_PEPPOL_PARTICIPANT_TAKEN) needs support.',
    ],
    example: {
      response: {
        data: {
          transport: { available: true, provider: 'qvalia', reason: null },
          receiving_supported: true,
          access: { status: 'enabled', send_enabled: true, receive_enabled: true, max_sends: 50, sent_count: 3, remaining_sends: 47 },
          participant: { ok: true, code: null },
          registration: EXAMPLE_REGISTRATION,
        },
        meta: META,
      },
    },
  },
  input: z.object({}),
  output: z.object({
    transport: Transport,
    receiving_supported: z.boolean(),
    access: Access,
    participant: z.object({ ok: z.boolean(), code: z.string().nullable() }),
    registration: Registration.nullable(),
  }),
  http: { method: 'GET', path: REGISTRATION_PATH },
  mcp: {
    name: 'gnubok_get_peppol_registration',
    title: 'Get Peppol Registration',
    description:
      'Read whether the company can receive Peppol e-invoices: the access grant and receiving slot, whether its org number can be registered, and the registration of its participant id with status and last error.',
    keywords: ['peppol', 'ta emot e-faktura', 'peppol-id', 'peppol registrering', 'mottagning'],
  },
  run: async (ctx) => {
    const outcome = await getPeppolRegistrationStatus(ctx)
    if (!outcome.ok || outcome.dryRun) return outcome
    const { transport, receiving_supported, access, participant, registration } = outcome.data
    return {
      ok: true,
      data: {
        transport: {
          available: transport.available,
          provider: transport.available ? transport.provider : null,
          reason: transport.available ? null : transport.reason,
        },
        receiving_supported,
        access: toAccess(access),
        participant: { ok: participant.ok, code: participant.code },
        registration: toRegistration(registration),
      },
    }
  },
})

export const peppolRegister = defineOperation({
  id: 'peppol.register',
  kind: 'write',
  scope: 'companies:write',
  // Publishes the company in the public Peppol directory through the hosted
  // access point and consumes a contracted receiving slot. Withdrawing it is
  // dashboard-only for now, so no single API call undoes it.
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Register the company as a Peppol participant so it can receive e-invoices.',
    description:
      'Publishes the company\'s participant id (scheme 0007 + organisation number) with a business card (name, country, city, VAT number) at the access point, for BIS Billing 3 invoices and credit notes. Received e-invoices then arrive in the invoice inbox. Needs the operators\' receiving grant. A pending attempt older than five minutes is retired and retried. Owner/admin only. The dry run checks everything as reads and contacts no network.',
    useWhen: 'The company wants suppliers to send it e-invoices over Peppol and GET /peppol/registration shows receive_enabled.',
    doNotUseFor: 'Sending e-invoices (that needs no registration of the buyer side here) or asking for access (POST /peppol/access-request).',
    pitfalls: [
      'Without the grant: 403 PEPPOL_ACCESS_REQUIRED; with sending but no receiving slot: 403 PEPPOL_RECEIVING_NOT_ENABLED.',
      'A personnummer-based sole trader answers 422 PEPPOL_REGISTRATION_PERSONAL_NUMBER: it would publish personal data in the directory.',
      '502 PEPPOL_REGISTRATION_FAILED is operational and retryable; 422 PEPPOL_REGISTRATION_REJECTED is a verdict on the identifier (details.code says which), do not retry it.',
      '409 PEPPOL_REGISTRATION_CAP_REACHED: every contracted receiving slot is taken; sending still works.',
      'Owner or admin only: a member key gets 403 FORBIDDEN.',
    ],
    example: { response: { data: { registration: EXAMPLE_REGISTRATION }, meta: META } },
  },
  input: z.object({}),
  output: z.object({ registration: Registration }),
  errorCodes: [
    'FORBIDDEN',
    'PEPPOL_TRANSPORT_UNAVAILABLE',
    'PEPPOL_SANDBOX_NOT_ALLOWED',
    'PEPPOL_ACCESS_REQUIRED',
    'PEPPOL_RECEIVING_NOT_ENABLED',
    'INVOICE_SEND_COMPANY_SETTINGS_MISSING',
    'PEPPOL_RECEIVING_UNSUPPORTED',
    'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED',
    'PEPPOL_REGISTRATION_PERSONAL_NUMBER',
    'PEPPOL_REGISTRATION_COMPANY_NAME_REQUIRED',
    'PEPPOL_REGISTRATION_CAP_REACHED',
    'PEPPOL_REGISTRATION_FAILED',
    'PEPPOL_REGISTRATION_REJECTED',
  ],
  http: { method: 'POST', path: REGISTRATION_PATH },
  mcp: {
    name: 'gnubok_register_peppol_participant',
    title: 'Register Peppol Participant',
    description:
      'Stage publishing the company\'s Peppol participant id (0007 + org number) at the access point so it can receive e-invoices. Needs the operators\' receiving grant; owner/admin only. The preview checks everything without contacting the network.',
    keywords: ['peppol', 'ta emot e-faktura', 'registrera peppol', 'peppol-id', 'mottagning e-faktura'],
    stage: {
      pendingType: 'register_peppol_participant',
      title: () => 'Registrera bolaget för Peppol-mottagning',
    },
  },
  run: async (ctx, _input, { dryRun }) => {
    const outcome = await registerPeppolParticipant(ctx, { dryRun, requireAdmin: true })
    if (!outcome.ok || outcome.dryRun) return outcome
    const registration = toRegistration(outcome.data.registration)
    if (!registration) return { ok: false, code: 'INTERNAL_ERROR' }
    return { ...outcome, data: { registration } }
  },
})

// ---------------------------------------------------------------------------
// peppol.request-access
// ---------------------------------------------------------------------------

export const peppolRequestAccess = defineOperation({
  id: 'peppol.request-access',
  kind: 'write',
  scope: 'companies:write',
  // Records the request and e-mails the operators; grants nothing by itself.
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Ask the operators to switch on Peppol for the company (sending, optionally receiving).',
    description:
      'Peppol is locked per company until the operators grant it (every transmission is billed per document and every receiving id uses a contracted slot). This records the request and notifies the operators by e-mail; they enable it with a sending cap and, when wants_receiving is true, a receiving slot. Idempotent: a second request keeps the first. Dry-runnable.',
    useWhen: 'GET /invoices/{id}/peppol or GET /peppol/registration reports PEPPOL_ACCESS_REQUIRED and the user wants Peppol.',
    doNotUseFor: 'Registering the participant id once access is granted (POST /peppol/registration).',
    pitfalls: [
      'A company that already has access answers 409 PEPPOL_ACCESS_ALREADY_ENABLED; ask support for a higher cap or a receiving slot instead.',
      'Nothing is enabled immediately: poll GET /peppol/registration for access.status=enabled.',
    ],
    example: {
      request: { wants_receiving: true, note: 'Vi fakturerar kommuner.' },
      response: {
        data: {
          access: { status: 'requested', send_enabled: false, receive_enabled: false, max_sends: null, sent_count: 0, remaining_sends: null },
          created: true,
        },
        meta: META,
      },
    },
  },
  input: PeppolAccessRequestSchema,
  output: z.object({
    access: Access,
    created: z.boolean().describe('False when an open request already existed.'),
  }),
  errorCodes: ['PEPPOL_SANDBOX_NOT_ALLOWED', 'PEPPOL_ACCESS_ALREADY_ENABLED'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/peppol/access-request' },
  mcp: {
    name: 'gnubok_request_peppol_access',
    title: 'Request Peppol Access',
    description:
      'Stage asking the operators to switch on Peppol e-invoicing for the company (sending, and receiving when wants_receiving is true). Records the request and e-mails the operators on approval; nothing is enabled immediately.',
    keywords: ['peppol', 'aktivera peppol', 'e-faktura', 'begär åtkomst', 'slå på peppol'],
    stage: {
      pendingType: 'request_peppol_access',
      title: () => 'Begär Peppol-åtkomst',
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await requestPeppolAccessForCompany(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ...outcome, data: { access: toAccess(outcome.data.access), created: outcome.data.created } }
  },
})
