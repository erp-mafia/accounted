/**
 * BankID document signing through the machine doors: an agent or an API
 * client sends an archived PDF for signing, reads where it stands, chases a
 * signer, and fetches the signed copy. The rules live in lib/signing; the
 * dashboard's /api/signing-requests routes call the same functions.
 *
 * Agents prepare, request and chase; a person signs. There is no signing
 * door here: each signer signs in person with their own BankID, by the link
 * (/signera/<token>) or as the member the request names. The MCP request
 * stages (pending type request_signature): the links are mailed at approval,
 * and a link is answered only for a signer no mail reached, because the URL
 * is the credential. A personnummer never travels these doors (the inputs
 * are strict); the app's dialog is where a signer is locked to one.
 */
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import {
  cancelSigningRequest,
  createSigningRequest,
  getSigningRequest,
  listSigningRequests,
  previewSigningRequest,
  remindSigner,
} from '@/lib/signing/requests'
import { ensureSealed } from '@/lib/signing/seal'
import {
  SIGNING_DEFAULT_TTL_DAYS,
  SIGNING_MAX_SIGNERS,
  SIGNING_MAX_TTL_DAYS,
  SIGNING_MESSAGE_MAX,
  SIGNING_NAME_MAX,
  SIGNING_ROLE_MAX,
  SIGNING_TITLE_MAX,
} from '@/lib/signing/types'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const SIGNING_REQUEST_ID = z.string().uuid().describe('The signing request (signing_request_id).')
const SIGNER_ID = z.string().uuid().describe('The signer (signer_id from the request).')

const SignerOut = z.object({
  signer_id: z.string().uuid(),
  position: z.number().int(),
  name: z.string().describe('The name the sender gave.'),
  email: z.string().nullable(),
  role_label: z.string().nullable(),
  user_id: z.string().uuid().nullable().describe('Set when the signer is a member of the company (they can sign in the app).'),
  annual_report_signature_id: z.string().uuid().nullable().describe('On a board\'s årsredovisning request: the signer slot this signer fills.'),
  lock: z.enum(['none', 'member', 'personnummer']).describe('none: anyone with the link signs and their BankID name is recorded; member: only that member\'s BankID; personnummer: only that person.'),
  status: z.enum(['pending', 'signed', 'declined']),
  signed_at: z.string().nullable(),
  bankid_name: z.string().nullable().describe('The name in the BankID the signer signed with.'),
  declined_at: z.string().nullable(),
  decline_reason: z.string().nullable(),
  last_error_code: z.string().nullable().describe('Why the latest attempt was refused, e.g. SIGNING_SIGNER_MISMATCH.'),
  link_sent_at: z.string().nullable(),
  last_reminded_at: z.string().nullable(),
})

const SigningRequestOut = z.object({
  signing_request_id: z.string().uuid(),
  title: z.string(),
  message: z.string().nullable(),
  state: z.enum(['open', 'completed', 'declined', 'cancelled', 'expired']),
  document_id: z.string().uuid().describe('The PDF that is signed (an archive document).'),
  document_sha256: z.string().describe('Its SHA-256 when the request was made; every BankID signature carries it.'),
  annual_report_version_id: z.string().uuid().nullable(),
  created_by: z.string().uuid(),
  created_via: z.enum(['app', 'api', 'mcp']),
  created_at: z.string(),
  expires_at: z.string(),
  completed_at: z.string().nullable(),
  declined_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  signed_document_id: z.string().uuid().nullable().describe('Once completed: the signed PDF with its Signeringsbevis page (GET /documents/{id}/download).'),
  evidence_document_id: z.string().uuid().nullable().describe('Once completed: Bevispaket.zip, the original, each BankID signature and OCSP response, and a manifest.'),
  signers: z.array(SignerOut),
})

const EXAMPLE_REQUEST = {
  signing_request_id: '8e1d…',
  title: 'Hyresavtal kontor',
  message: null,
  state: 'open',
  document_id: '4f1c…',
  document_sha256: '9b2e…',
  annual_report_version_id: null,
  created_by: 'a3f0…',
  created_via: 'mcp',
  created_at: '2026-10-25T09:00:00.000Z',
  expires_at: '2026-11-08T09:00:00.000Z',
  completed_at: null,
  declined_at: null,
  cancelled_at: null,
  signed_document_id: null,
  evidence_document_id: null,
  signers: [
    {
      signer_id: '2c7b…',
      position: 1,
      name: 'Anna Svensson',
      email: 'anna@example.se',
      role_label: 'Hyresvärd',
      user_id: null,
      annual_report_signature_id: null,
      lock: 'none',
      status: 'pending',
      signed_at: null,
      bankid_name: null,
      declined_at: null,
      decline_reason: null,
      last_error_code: null,
      link_sent_at: '2026-10-25T09:00:01.000Z',
      last_reminded_at: null,
    },
  ],
}

const SignerIn = z
  .object({
    name: z.string().trim().min(1).max(SIGNING_NAME_MAX).describe('The signer\'s name, as the document names them.'),
    email: z.string().trim().email().max(254).nullish().describe('Where the link is mailed. Without one, the answer carries the link for you to hand over.'),
    role_label: z.string().trim().max(SIGNING_ROLE_MAX).nullish().describe('What they sign as, e.g. Styrelseledamot, Hyresgäst.'),
    user_id: z.string().uuid().nullish().describe('A member of the company: they can sign in the app, locked to their own BankID when they log in with one.'),
  })
  .strict()

export const signingRequestsCreate = defineOperation({
  id: 'signing-requests.create',
  kind: 'write',
  scope: 'documents:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Send an archived PDF for BankID signing: one link per signer, mailed when they have an address.',
    description:
      'Freezes the document by its SHA-256 and creates one link per signer to a page at /signera/<token> where they read the PDF and sign it with BankID (an advanced electronic signature under eIDAS). ' +
      `Links are valid expires_in_days (default ${SIGNING_DEFAULT_TTL_DAYS}, at most ${SIGNING_MAX_TTL_DAYS}). Signers with an email get a mail; the answer carries the url only for a signer no mail reached. ` +
      'A member of the company (user_id) can also sign in the app. When everyone has signed, the archive gets the signed PDF (with a Signeringsbevis page) and Bevispaket.zip; read them from GET /signing-requests/{id} or the signing.completed webhook. ' +
      'Dry-runnable: ?dry_run=true answers what would be sent and mints nothing.',
    useWhen: 'An agreement, minutes, a policy or any other PDF in the archive needs signatures from people inside or outside the company.',
    doNotUseFor: 'Signing bank payments (POST /payments/signing-links), the fastställelseintyg (signed at Bolagsverket), or documents that are not PDFs.',
    pitfalls: [
      'The url is the credential: hand it to that signer only, once, and do not store it.',
      'SIGNING_DOCUMENT_UNSUPPORTED: only the current version of a PDF of at most 10 MB without a password can be signed.',
      'SIGNING_SIGNERS_INVALID: a name is required, an email or member appears once, and user_id must be a member of the company (details.reason says which).',
      'A personnummer cannot be sent here; locking a signer to one person is done in the app.',
      'SIGNING_UNAVAILABLE: BankID signing is not switched on for this deployment.',
    ],
    example: {
      request: {
        document_id: '4f1c…',
        title: 'Hyresavtal kontor',
        signers: [{ name: 'Anna Svensson', email: 'anna@example.se', role_label: 'Hyresvärd' }],
      },
      response: {
        data: {
          signing_request_id: '8e1d…',
          status: 'open',
          title: 'Hyresavtal kontor',
          document_id: '4f1c…',
          document_sha256: '9b2e…',
          expires_at: '2026-11-08T09:00:00.000Z',
          signers: [{ signer_id: '2c7b…', position: 1, name: 'Anna Svensson', email: 'anna@example.se', annual_report_signature_id: null, lock: 'none', email_sent: true, url: null }],
        },
        meta: META,
      },
    },
  },
  input: z
    .object({
      document_id: z.string().uuid().describe('The PDF in the archive (document_id).'),
      title: z.string().trim().min(1).max(SIGNING_TITLE_MAX).describe('What the signers sign, shown in the mail, on the page and in the BankID app.'),
      message: z.string().max(SIGNING_MESSAGE_MAX).nullish().describe('A message to the signers, shown in the mail and on the page.'),
      expires_in_days: z.number().int().min(1).max(SIGNING_MAX_TTL_DAYS).nullish().describe(`How long the links work. Default ${SIGNING_DEFAULT_TTL_DAYS}.`),
      send_email: z.boolean().optional().describe('Mail each signer with an email (default true).'),
      signers: z.array(SignerIn).min(1).max(SIGNING_MAX_SIGNERS).describe(`1-${SIGNING_MAX_SIGNERS} signers; everyone signs, in any order.`),
    })
    .strict(),
  output: z.object({
    signing_request_id: z.string().uuid(),
    status: z.literal('open'),
    title: z.string(),
    document_id: z.string().uuid(),
    document_sha256: z.string(),
    expires_at: z.string(),
    signers: z.array(
      z.object({
        signer_id: z.string().uuid(),
        position: z.number().int(),
        name: z.string(),
        email: z.string().nullable(),
        annual_report_signature_id: z.string().uuid().nullable(),
        lock: z.enum(['none', 'member', 'personnummer']),
        email_sent: z.boolean(),
        url: z.string().nullable().describe('The signer\'s link, only when no mail reached them. The credential itself.'),
      }),
    ),
  }),
  errorCodes: ['SIGNING_UNAVAILABLE', 'SIGNING_DOCUMENT_NOT_FOUND', 'SIGNING_DOCUMENT_UNSUPPORTED', 'SIGNING_DOCUMENT_CHANGED', 'SIGNING_SIGNERS_INVALID'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/signing-requests' },
  mcp: {
    name: 'gnubok_request_signature',
    title: 'Request Signature',
    description:
      'Stage sending an archived PDF for BankID signing: one link per signer, mailed at approval when they have an email. Agents request; each signer signs in person. Read progress with gnubok_get_signing_request.',
    visibility: 'search',
    keywords: ['signera dokument', 'skicka för signering', 'e-signering', 'bankid signering', 'signera avtal', 'underskrift', 'avtal signering', 'styrelseprotokoll signera'],
    stage: {
      pendingType: 'request_signature',
      title: (input) => {
        const count = Array.isArray(input.signers) ? input.signers.length : 0
        const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'dokument'
        return `Skicka för signering: ${title} (${count} undertecknare)`
      },
      extras: () => ({
        next: {
          description:
            'After approval the signers with an email get their link by mail; data.signers[].url is set only for a signer no mail reached: hand it to that signer only. ' +
            'When a person approves in Accounted instead, read result_data from gnubok_list_pending_operations.',
          tool: 'gnubok_approve_pending_operation',
        },
      }),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const request = {
      documentId: input.document_id,
      title: input.title,
      message: input.message ?? null,
      expiresInDays: input.expires_in_days ?? null,
      sendEmail: input.send_email,
      createdVia: ctx.pendingOperationId ? ('mcp' as const) : ('api' as const),
      signers: input.signers.map((s) => ({ name: s.name, email: s.email ?? null, roleLabel: s.role_label ?? null, userId: s.user_id ?? null })),
    }
    if (dryRun) return previewSigningRequest(ctx, request)
    return createSigningRequest(ctx, request)
  },
})

export const signingRequestsList = defineOperation({
  id: 'signing-requests.list',
  kind: 'read',
  scope: 'documents:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the company\'s BankID signing requests, newest first, with every signer\'s status.',
    description:
      'Filter by status (open, completed, declined, cancelled) or document_id (the signed PDF, its signed copy or its evidence package). An open request past its expiry reads as state expired.',
    useWhen: 'You need to know which documents wait for signatures, or find the request behind a document.',
    doNotUseFor: 'One request in detail (GET /signing-requests/{id}).',
    pitfalls: ['status filters the stored status; an expired request still has status open and reads state expired.'],
    example: { response: { data: { signing_requests: [EXAMPLE_REQUEST] }, meta: META } },
  },
  input: z.object({
    status: z.enum(['open', 'completed', 'declined', 'cancelled']).optional().describe('Only requests with this status.'),
    document_id: z.string().uuid().optional().describe('Only requests covering this document.'),
    limit: z.coerce.number().int().min(1).max(200).optional().describe('At most this many (default 50).'),
  }),
  output: z.object({ signing_requests: z.array(SigningRequestOut) }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/signing-requests' },
  mcp: {
    name: 'gnubok_list_signing_requests',
    title: 'List Signing Requests',
    description: 'List BankID signing requests (filter by status or document_id) with every signer\'s status.',
    visibility: 'search',
    keywords: ['signeringar', 'väntar på signatur', 'signeringsstatus', 'vem har signerat'],
  },
  run: async (ctx, input) => {
    const requests = await listSigningRequests(ctx, { status: input.status, documentId: input.document_id, limit: input.limit })
    return { ok: true, data: { signing_requests: requests } }
  },
})

export const signingRequestsGet = defineOperation({
  id: 'signing-requests.get',
  kind: 'read',
  scope: 'documents:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one BankID signing request: every signer\'s status and, once completed, the signed PDF and the evidence package.',
    description:
      'signed_document_id is the signed PDF (the original plus a Signeringsbevis page with each signer\'s BankID name, time and masked personnummer) and evidence_document_id is Bevispaket.zip (the original, every BankID signature with its OCSP response, and a manifest). Download either through GET /documents/{id}/download.',
    useWhen: 'You sent a document for signing and need to know who has signed, or want the signed copy.',
    doNotUseFor: 'Listing requests (GET /signing-requests).',
    pitfalls: ['A completed request may show null copies for a moment while they are sealed; read it again.'],
    example: { response: { data: EXAMPLE_REQUEST, meta: META } },
  },
  input: z.object({ signing_request_id: SIGNING_REQUEST_ID }),
  output: SigningRequestOut,
  errorCodes: ['SIGNING_REQUEST_NOT_FOUND'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/signing-requests/:id', pathParams: { id: 'signing_request_id' } },
  mcp: {
    name: 'gnubok_get_signing_request',
    title: 'Get Signing Request',
    description: 'Read one BankID signing request: who has signed and, once completed, the signed PDF and evidence package document ids.',
    visibility: 'search',
    keywords: ['signeringsstatus', 'signerat dokument', 'bevispaket', 'har alla signerat'],
  },
  run: async (ctx, input) => {
    const outcome = await getSigningRequest(ctx, input.signing_request_id)
    if (!outcome.ok || outcome.dryRun) return outcome
    const view = outcome.data
    if (view.state !== 'completed' || (view.signed_document_id && view.evidence_document_id)) return outcome
    await ensureSealed(
      createServiceClient(),
      { id: view.signing_request_id, status: 'completed', completed_at: view.completed_at, signed_document_id: view.signed_document_id, evidence_document_id: view.evidence_document_id },
      ctx.log,
    )
    return getSigningRequest(ctx, input.signing_request_id)
  },
})

export const signingRequestsRemind = defineOperation({
  id: 'signing-requests.remind',
  kind: 'write',
  scope: 'documents:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Mail a pending signer again, once a day at most; the mail carries a new link and the old one stops working.',
    description:
      'For an open request and a signer who has not signed and has an email. Refused while the signer is in a BankID signing right now. The answer carries the new link only when no mail went out. Dry-runnable.',
    useWhen: 'A signer has not signed after a while.',
    doNotUseFor: 'A signer without an email (hand them the link you got at creation) or a closed request.',
    pitfalls: [
      'SIGNING_REMIND_TOO_SOON: one mail per signer per 24 hours, the first mail included.',
      'SIGNING_SESSION_ACTIVE: the signer started BankID in the last few minutes; try later.',
      'The old link stops working: only the newest link signs.',
    ],
    example: { response: { data: { signing_request_id: '8e1d…', signer_id: '2c7b…', email_sent: true, url: null }, meta: META } },
  },
  input: z.object({ signing_request_id: SIGNING_REQUEST_ID, signer_id: SIGNER_ID }),
  output: z.object({ signing_request_id: z.string().uuid(), signer_id: z.string().uuid(), email_sent: z.boolean(), url: z.string().nullable() }),
  errorCodes: ['SIGNING_REQUEST_NOT_FOUND', 'SIGNING_REQUEST_CLOSED', 'SIGNING_SIGNER_NOT_FOUND', 'SIGNING_SIGNER_NOT_PENDING', 'SIGNING_REMIND_NO_EMAIL', 'SIGNING_REMIND_TOO_SOON', 'SIGNING_SESSION_ACTIVE', 'FORBIDDEN'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/signing-requests/:id/signers/:signerId/remind',
    pathParams: { id: 'signing_request_id', signerId: 'signer_id' },
  },
  mcp: {
    name: 'gnubok_remind_signer',
    title: 'Remind Signer',
    description: 'Stage mailing a pending signer of a signing request again (once a day at most; the new mail carries a new link).',
    visibility: 'search',
    keywords: ['påminn undertecknare', 'påminnelse signering', 'skicka signeringslänk igen'],
    stage: { pendingType: 'remind_signature', title: () => 'Påminn om signering' },
  },
  run: (ctx, input, { dryRun }) => remindSigner(ctx, { signingRequestId: input.signing_request_id, signerId: input.signer_id, dryRun }),
})

export const signingRequestsCancel = defineOperation({
  id: 'signing-requests.cancel',
  kind: 'write',
  scope: 'documents:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Cancel an open signing request: its links stop working; signatures already made stay.',
    description: 'The sender, an owner or an admin. Cancelling twice answers the same. A completed or declined request cannot be cancelled. Dry-runnable.',
    useWhen: 'The document changed or was sent to the wrong people.',
    doNotUseFor: 'Removing a signature (a signature is evidence and is kept).',
    pitfalls: ['SIGNING_REQUEST_CLOSED: the request completed or was declined.'],
    example: { response: { data: { signing_request_id: '8e1d…', cancelled: true }, meta: META } },
  },
  input: z.object({ signing_request_id: SIGNING_REQUEST_ID }),
  output: z.object({ signing_request_id: z.string().uuid(), cancelled: z.literal(true) }),
  errorCodes: ['SIGNING_REQUEST_NOT_FOUND', 'SIGNING_REQUEST_CLOSED', 'FORBIDDEN'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/signing-requests/:id/cancel', pathParams: { id: 'signing_request_id' } },
  run: (ctx, input, { dryRun }) => cancelSigningRequest(ctx, { signingRequestId: input.signing_request_id, dryRun }),
})

export const SIGNING_REQUEST_OPERATIONS = [
  signingRequestsCreate,
  signingRequestsList,
  signingRequestsGet,
  signingRequestsRemind,
  signingRequestsCancel,
] as const
