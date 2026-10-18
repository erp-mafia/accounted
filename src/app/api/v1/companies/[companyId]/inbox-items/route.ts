/**
 * GET /api/v1/companies/{companyId}/inbox-items: the invoice inbox
 * (operation inbox-items.list). Contract, docs and rules live in
 * src/lib/operations/inbox-items.ts.
 *
 * POST /api/v1/companies/{companyId}/inbox-items: the partner door into the
 * Inkorg (operation inbox-items.deliver). A partner (first: a digital
 * mailbox) delivers a supplier invoice or a receipt the way a person uploads
 * one. It runs the invoice-inbox pipeline (content dedupe, extraction,
 * Arkiv) through the extension's registry service, files an item with
 * source 'upload' and the partner's provenance in channel_context, records
 * a 'partner_api' arrival, and books nothing: it waits among the Inkorg's
 * open items for a person or a granted agent to book.
 *
 * multipart/form-data parts:
 *   file              (required, binary): PDF or image, at most 10 MB
 *   kind_hint         (optional): supplier_invoice | receipt
 *   external_ref      (optional): the partner's id for this delivery, 1-200 chars
 *   sender_name, sender_org_number, subject, message (optional): what the delivery says
 *   received_at       (optional ISO timestamp): when the partner received it
 *
 * Retries: Idempotency-Key is mandatory (the wrapper replays a resend), and
 * external_ref is a business key on top: a repeated external_ref answers the
 * first delivery's item, whatever key it carries. Not dry-runnable: the
 * archive write is the side effect (test keys are refused by the wrapper).
 *
 * Core cannot import @/extensions: the pipeline is reached through
 * extensionRegistry.get('invoice-inbox').services (contract:
 * src/lib/intake/partner-delivery.ts), and a deployment without the
 * extension answers EXTENSION_DISABLED.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { created, ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ZodIssues } from '@/lib/api/v1/errors'
import { MAX_DOCUMENT_SIZE } from '@/lib/core/documents/document-service'
import { INBOX_UPLOAD_TYPES } from '@/lib/documents/upload-types'
import { extensionRegistry } from '@/lib/extensions/registry'
import { apiKeyArrivalActor, recordDocumentArrival } from '@/lib/intake/arrivals'
import {
  INBOX_DELIVERY_KINDS,
  INVOICE_INBOX_EXTENSION_ID,
  PARTNER_DELIVERY_SOURCE,
  findPartnerDelivery,
  partnerChannelContext,
  type InboxDeliveryResult,
  type InvoiceInboxServices,
} from '@/lib/intake/partner-delivery'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { v1OperationHandler } from '@/lib/operations/v1'
import { inboxItemsList } from '@/lib/operations/inbox-items'

export const GET = v1OperationHandler(inboxItemsList)

const MAX_MB = MAX_DOCUMENT_SIZE / 1024 / 1024

/** The text parts, as one schema: what the route validates and the spec publishes. */
const DeliveryFields = z.object({
  kind_hint: z
    .enum(INBOX_DELIVERY_KINDS)
    .optional()
    .describe('What the sender says it is. Shown in the Inkorg ahead of what extraction reads.'),
  external_ref: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Your own id for this delivery (1-200 chars). A repeat answers the first delivery\'s item.'),
  sender_name: z.string().trim().min(1).max(200).optional().describe('Who sent the document to you, shown as its sender.'),
  sender_org_number: z.string().trim().min(1).max(32).optional().describe('The sender\'s organisationsnummer, as you have it.'),
  subject: z.string().trim().min(1).max(300).optional().describe('A subject line, shown when no supplier name was read.'),
  message: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe('A short text that came with the document. Kept with the arrival, not on the item.'),
  received_at: z.string().datetime({ offset: true }).optional().describe('ISO timestamp you received it. Defaults to now.'),
})
const FIELD_NAMES = Object.keys(DeliveryFields.shape) as Array<keyof typeof DeliveryFields.shape>

// For the registry: the text parts plus the binary file part (a `z.unknown()`
// part renders as `{ type: 'string', format: 'binary' }`).
const MultipartBodySchema = DeliveryFields.extend({ file: z.unknown() })

const Delivered = z.object({
  inbox_item_id: z.string().uuid().describe('The item in the Inkorg. Read it with GET /inbox-items/{id}.'),
  document_id: z.string().uuid().describe('The archived document (BFL 7 kap retention).'),
  deduplicated: z
    .boolean()
    .describe('True when nothing new was filed: the same external_ref, or the same file, was already in the Inkorg and that item is returned.'),
  arrival_id: z
    .string()
    .uuid()
    .nullable()
    .describe('The recorded delivery (how it came in, by whom). Null when it could not be recorded; the item is filed regardless.'),
})

registerEndpoint({
  operation: 'inbox-items.deliver',
  method: 'POST',
  path: '/api/v1/companies/:companyId/inbox-items',
  summary: 'Deliver a supplier invoice or receipt into the Inkorg for a person to book.',
  description:
    `Multipart delivery of one document (PDF, JPEG, PNG, HEIC or WebP, at most ${MAX_MB} MB) into the company's Inkorg. ` +
    'It takes the same path as a person\'s upload: the file is archived under BFL 7 kap (deduplicated on content), read by extraction, ' +
    'and waits among the Inkorg\'s open items as an inbox item with source "upload", until a person, or an agent the owner has granted it to, books it. ' +
    'Nothing is booked here: no supplier invoice, no verifikat. Answers 201 with the new inbox_item_id and document_id, or 200 with ' +
    'deduplicated=true when the same external_ref or the same file was already delivered. ' +
    'For a mailbox partner (Billo and the like): deliver each document here instead of POST /supplier-invoices. That endpoint registers and ' +
    'books the invoice on arrival, past the Inkorg and its duplicate check; this one hands it to the company to review. Send your own id as ' +
    'external_ref, the sender as sender_name and sender_org_number, and kind_hint when you know what the document is. Booking without a ' +
    'person will come back later as a grant the owner switches on, not as a partner call.',
  useWhen:
    'You deliver documents to a company on its behalf (a digital mailbox, a scanning service, a portal) and the company should review and book them in Accounted.',
  doNotUseFor:
    'Booking (convert the item with POST /inbox-items/{id}/convert, or book it from the Inkorg). Archiving a document that already belongs to a verifikat (POST /documents with journal_entry_id). Several files at once: one file per call.',
  pitfalls: [
    'This files into the Inkorg for a person or a granted agent to book; it does not book. No supplier invoice and no verifikat exist until someone books the item.',
    'Idempotency-Key is mandatory; a resend with the same key and the same parts replays the first answer. external_ref is the business key on top: a repeat with the same external_ref returns the first delivery\'s item (200, deduplicated=true) even under a new key.',
    'The same external_ref with a different file answers 409 INBOX_DELIVERY_REF_CONFLICT: give each document its own external_ref.',
    'external_ref is unique per company across every partner delivering to it: prefix it with something of your own (billo-123, not 123).',
    'Do not send the same delivery twice concurrently: wait for the answer (or a timeout) before resending, or both requests may file.',
    `Only PDF, JPEG, PNG, HEIC and WebP up to ${MAX_MB} MB: INBOX_UPLOAD_UNSUPPORTED_TYPE, INBOX_UPLOAD_TOO_LARGE, or DOC_UPLOAD_INVALID_CONTENT for bytes that do not match the declared type.`,
    'The Inkorg takes at most 30 deliveries a minute and 500 a day per company, a person\'s uploads included: 429 RATE_LIMITED with Retry-After. Resend after it with the same Idempotency-Key.',
    'Extraction runs after the answer: GET /inbox-items/{id} shows status "processing" until the reading is in.',
    'Not dry-runnable: test keys are refused with TEST_KEY_WRITE_BLOCKED.',
  ],
  example: {
    request: {
      file: '<binary>',
      kind_hint: 'supplier_invoice',
      external_ref: 'billo-8f2c1a',
      sender_name: 'Leverantören AB',
      sender_org_number: '556677-8899',
      subject: 'Faktura 1001',
      received_at: '2026-10-15T08:00:00Z',
    },
    response: {
      data: {
        inbox_item_id: '1b2c…',
        document_id: '4f1c…',
        deduplicated: false,
        arrival_id: '9a0d…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'documents:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: MultipartBodySchema, contentType: 'multipart/form-data' },
  response: {
    success: dataEnvelope(Delivered),
    errorCodes: [
      'VALIDATION_ERROR',
      'INBOX_UPLOAD_NO_FILE',
      'DOC_UPLOAD_EMPTY',
      'INBOX_UPLOAD_TOO_LARGE',
      'INBOX_UPLOAD_UNSUPPORTED_TYPE',
      'DOC_UPLOAD_INVALID_CONTENT',
      'INBOX_DELIVERY_REF_CONFLICT',
      'IDEMPOTENCY_KEY_REUSE',
      'RATE_LIMITED',
      'EXTENSION_DISABLED',
      'INBOX_UPLOAD_FAILED',
    ],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'inbox-items.deliver',
  async (request, ctx) => {
    const companyId = ctx.companyId!

    // The archive write is the side effect; there is nothing to simulate.
    // Test keys never get here (the wrapper refuses them on an endpoint that
    // cannot dry-run); a live key asking for one is told so instead of
    // having its file filed for real.
    if (ctx.dryRun) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'dry_run', message: 'dry_run is not supported: the archive write is the side effect.' },
      })
    }

    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body must be multipart/form-data with a `file` part.' },
      })
    }

    const files = formData.getAll('file')
    const file = files[0]
    if (!file || !(file instanceof File)) {
      return v1ErrorResponseFromCode('INBOX_UPLOAD_NO_FILE', ctx.log, { requestId: ctx.requestId })
    }
    if (files.length > 1) {
      // A second part would be silently dropped, and with it an underlag.
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'file', message: 'One file per delivery: send each document in its own call.' },
      })
    }
    if (file.size === 0) {
      return v1ErrorResponseFromCode('DOC_UPLOAD_EMPTY', ctx.log, { requestId: ctx.requestId })
    }
    if (file.size > MAX_DOCUMENT_SIZE) {
      return v1ErrorResponseFromCode('INBOX_UPLOAD_TOO_LARGE', ctx.log, {
        requestId: ctx.requestId,
        details: { file_size_bytes: file.size, max_size_bytes: MAX_DOCUMENT_SIZE },
      })
    }
    if (!INBOX_UPLOAD_TYPES.includes(file.type)) {
      return v1ErrorResponseFromCode('INBOX_UPLOAD_UNSUPPORTED_TYPE', ctx.log, {
        requestId: ctx.requestId,
        details: { mime_type: file.type || null, allowed_types: INBOX_UPLOAD_TYPES },
      })
    }

    const raw: Record<string, string> = {}
    for (const name of FIELD_NAMES) {
      const values = formData.getAll(name)
      if (values.length === 0) continue
      if (values.length > 1 || typeof values[0] !== 'string') {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { issues: [{ field: name, message: 'Send this part once, as text.' }] },
        })
      }
      raw[name] = values[0]
    }
    const parsed = DeliveryFields.safeParse(raw)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: v1ZodIssues(parsed.error) },
      })
    }
    const fields = parsed.data

    // The invoice-inbox extension is opt-in (extensions.config.json); without
    // it this deployment has no Inkorg to deliver into.
    const services = (await extensionRegistry.get(INVOICE_INBOX_EXTENSION_ID))?.services as
      | Partial<InvoiceInboxServices>
      | undefined
    if (!services?.fileInboxDelivery) {
      return v1ErrorResponseFromCode('EXTENSION_DISABLED', ctx.log, {
        requestId: ctx.requestId,
        details: { extension: INVOICE_INBOX_EXTENSION_ID },
      })
    }

    const buffer = await file.arrayBuffer()

    // Business key: the first delivery under this external_ref answers. The
    // same reference with other bytes is refused rather than replayed (the
    // new file would be lost) or filed (it would hide under the old one).
    if (fields.external_ref) {
      const hit = await findPartnerDelivery(ctx.supabase, companyId, fields.external_ref)
      if (hit) {
        const sha256 = createHash('sha256').update(new Uint8Array(buffer)).digest('hex')
        if (hit.original_sha256 && hit.original_sha256 !== sha256) {
          return v1ErrorResponseFromCode('INBOX_DELIVERY_REF_CONFLICT', ctx.log, {
            requestId: ctx.requestId,
            details: { external_ref: fields.external_ref, inbox_item_id: hit.inbox_item_id, document_id: hit.document_id },
          })
        }
        if (hit.inbox_item_id && hit.document_id) {
          return ok(
            { inbox_item_id: hit.inbox_item_id, document_id: hit.document_id, deduplicated: true, arrival_id: hit.arrival_id },
            { requestId: ctx.requestId },
          )
        }
        // The first delivery's links are incomplete: file again below.
        // Content dedupe converges on the same document, and the arrival
        // gains the links it lacked.
      }
    }

    // The same per-company quota as the person's upload (30/min, 500/day):
    // every delivery may cost an extraction. A 429 is never cached by the
    // idempotency layer, so the documented resend after Retry-After runs.
    const limit = await checkInboxUploadRateLimit(ctx.supabase, companyId)
    if (!limit.ok) {
      return v1ErrorResponseFromCode('RATE_LIMITED', ctx.log, {
        requestId: ctx.requestId,
        details: { quota: 'inbox_deliveries', window: limit.scope ?? null },
        retryAfterSeconds: limit.retryAfterSec ?? 60,
      })
    }

    const opLog = ctx.log.child({ filename: file.name, sizeBytes: file.size })
    let result: InboxDeliveryResult
    try {
      result = await services.fileInboxDelivery(ctx.supabase, {
        userId: ctx.userId,
        companyId,
        file: { name: file.name, buffer, type: file.type },
        kindHint: fields.kind_hint ?? null,
        senderName: fields.sender_name ?? null,
        subject: fields.subject ?? null,
        receivedAt: fields.received_at ? new Date(fields.received_at).toISOString() : null,
        channelContext: partnerChannelContext({ keyLabel: ctx.apiKeyName, externalRef: fields.external_ref }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      // Magic-byte refusals (validateDocumentMagicBytes) are the sender's
      // file, not a storage failure.
      if (/kunde inte verifieras|matchar inte den angivna filtypen/i.test(message)) {
        opLog.warn('inbox delivery rejected by content validation', { reason: message })
        return v1ErrorResponseFromCode('DOC_UPLOAD_INVALID_CONTENT', opLog, {
          requestId: ctx.requestId,
          details: { reason: getErrorMessage(err) },
        })
      }
      // The raw message can carry storage internals: logged, not returned.
      opLog.error('inbox delivery failed', err as Error)
      return v1ErrorResponseFromCode('INBOX_UPLOAD_FAILED', opLog, { requestId: ctx.requestId })
    }

    // How it came in (best effort, never fails the delivery): the archived
    // document is its own original. The reference is external_ref when sent,
    // so a repeat resolves to this arrival; otherwise the document id.
    const sender: Record<string, string> = {}
    if (fields.sender_name) sender.name = fields.sender_name
    if (fields.sender_org_number) sender.org_number = fields.sender_org_number
    const recorded = await recordDocumentArrival(ctx.supabase, {
      companyId,
      source: PARTNER_DELIVERY_SOURCE,
      documentId: result.document_id,
      inboxItemId: result.inbox_item_id,
      sourceRef: fields.external_ref ?? null,
      fetchedBy: apiKeyArrivalActor(ctx),
      sender,
      subject: fields.subject ?? null,
      messageText: fields.message ?? null,
      receivedAt: fields.received_at ?? new Date(),
      sourceMeta: {
        operation: 'inbox-items.deliver',
        ...(fields.external_ref ? { external_ref: fields.external_ref } : {}),
        ...(fields.kind_hint ? { kind_hint: fields.kind_hint } : {}),
        ...(ctx.idempotencyKey ? { idempotency_key: ctx.idempotencyKey.slice(0, 255) } : {}),
      },
    })

    const body = {
      inbox_item_id: result.inbox_item_id,
      document_id: result.document_id,
      deduplicated: result.deduplicated,
      arrival_id: recorded?.arrival.id ?? null,
    }
    return result.deduplicated ? ok(body, { requestId: ctx.requestId }) : created(body, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
