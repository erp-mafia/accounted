import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { routeClassifiedDocument } from './lib/route-from-arkiv'
import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import type { EventPayload } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
const extensionLog = createLogger('invoice-inbox')
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { NextResponse, after } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { z } from 'zod'
import {
  createPendingDocumentUpload,
  completePendingDocumentUpload,
} from '@/lib/core/documents/document-service'
import { createServiceClient } from '@/lib/supabase/server'
import { validateBody } from '@/lib/api/validate'
import { hasErrorEntry } from '@/lib/errors/structured-errors'
import { dbError } from '@/lib/errors/db-error'
import { matchSupplierId } from '@/lib/suppliers/match-supplier'
import { fetchOwnCompanyIdentity } from '@/lib/documents/inbox-extraction/extract-invoice-fields'
import { extractAndMirror } from '@/lib/documents/inbox-extraction/extract-and-mirror'
import { loadDocumentReading } from '@/lib/documents/reading/load'
import { peppolReader } from '@/lib/invoices/peppol-reading'
import { checkNeverCheckedInboxItems, neverChecked, neverCheckedToCheck, proposeBankMatchForInboxItem } from '@/lib/operations/inbox-bank-match'
import type { InboxPairing } from '@/lib/inkorg/pairs'
import { nothingRead } from '@/lib/inkorg/decision'
import { INBOX_ITEM_DOCUMENT_HOLD, withDocumentHold, type DocumentHoldRow } from '@/lib/documents/inbox-item-state'
import type { InkorgItem, ReadingRetry } from '@/lib/inkorg/items'
import { readingRetryOf } from './lib/provider-retry'
import { readInboxPairings, type ListedItem } from '@/lib/operations/inbox-pairings'
import { sameInvoiceItems, type SameInvoiceItem } from '@/lib/inkorg/same-invoice'
import { readInboxBankMatch, readInboxBankMatches, type BankMatch, type BankMatchItemRow } from '@/lib/documents/inbox-bank-match'
import { readCardKnown, readCardOf, readKnownCards } from '@/lib/documents/bank-match/known-cards'
import type { ReadingItemRow } from '@/lib/documents/reading/resolve'
import type { DocumentReading } from '@/lib/documents/reading/types'
import {
  uploadAndExtract,
  processArchivedDocument,
  sanitiseFilename,
  sanitiseMime,
  isSandboxCompany,
  MAX_FILE_SIZE,
  UPLOAD_ALLOWED_MIME_TYPES,
  EMAIL_ALLOWED_MIME_TYPES,
  ensureHtmlDocument,
} from './lib/upload-and-extract'
import {
  contentIdsReferencedByHtml,
  emailBodyToText,
  isSignatureImage,
  isSubstantiveBody,
  normaliseContentId,
  renderEmailBodyUnderlag,
} from './lib/email-body-underlag'
import { fileInboxDelivery } from './lib/inbox-delivery'
import type { RenderedEmailBodyUnderlag } from './lib/email-body-underlag'
import { recordInboundMailArrivals } from './lib/inbound-arrival'
import { recordDocumentArrival } from '@/lib/intake/arrivals'
import {
  verifyInboundWebhook,
  fetchReceivingEmail,
  fetchInboundAttachment,
  extractSharedRecipientsForDomain,
  groupSharedRecipientsByInbox,
  resolveKindHintForTags,
  splitKnownInboxTags,
  type InboxKindHint,
  isEmailReceivedEvent,
  baseContentType,
  isMailMachineryPart,
  isPlainTextPart,
  mayRedeliverOverMinuteCap,
  ResendSignatureError,
} from './lib/resend-inbound'
import {
  rotateCompanyInbox,
  renameCompanyInbox,
  InboxRenameRefused,
  getActiveInbox,
  listPreviousInboxes,
  stopPreviousInbox,
  inboxReceivesMail,
  composeInboxAddress,
} from './lib/inbox-provisioning'
import { inboxAddressCarriesName } from '@/lib/documents/inbox-address'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { roundOre } from '@/lib/money'
import { CreateSupplierInvoiceSchema, BookInboxItemDirectlySchema, BulkBookInboxSchema } from '@/lib/api/schemas'
import { bulkBookMatchedInboxItems } from '@/lib/transactions/categorize-core'
import { hasCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { evaluateMappingRules } from '@/lib/bookkeeping/mapping-engine'
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { buildFallbackKonteringLines } from './lib/fallback-kontering'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import type { Transaction, EntityType } from '@/types'
import { createLogger } from '@/lib/logger'
import { fetchPurchasesWithoutUnderlag } from '@/lib/receipt-hunt/purchases-without-underlag'
import { vendorLogoUrls } from '@/lib/vendor-logos/read'
import { sessionFailureResponse } from '@/lib/operations/session'
import { matchInboxItemTransaction } from '@/lib/documents/inbox-match'
import { documentFitGate } from '@/lib/documents/bank-match/fit'
import { bookInboxItemDirectly } from '@/lib/operations/inbox-book-direct'
import type { OperationContext } from '@/lib/operations/types'
import {
  deleteInboxItem,
  resolveInboxBookedState,
  unmatchInboxItemTransaction,
  updateInboxItemFields,
  UpdateInboxItemFieldsSchema,
  type UpdateInboxItemFieldsInput,
} from '@/lib/documents/inbox-item-actions'
import { convertInboxItemToSupplierInvoice } from '@/lib/operations/inbox-convert'
import { setInboxItemPurchaseCategory, SetInboxPurchaseCategorySchema } from '@/lib/documents/inbox-purchase-category'
import { resolveInboxPurchaseCategoryChoices } from '@/lib/categories/inbox-purchase-category'
import { carriedPersonFields, keepPersonChoices } from '@/lib/documents/person-corrections'
import { mirrorCorrectedReadingToDocument } from '@/lib/documents/reading-correction'
import { resolveInboxKind, type InboxKindSource } from '@/lib/documents/inbox-kind'
import { resolveInboxCreditTarget } from '@/lib/supplier-invoices/credit-target'
import { resolvePortal } from '@/lib/receipt-hunt/company-portals'
import { readCompanyPortals } from '@/lib/receipt-hunt/company-portals-read'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { checkInboxUploadRateLimit, type InboxLimitResult } from '@/lib/rate-limits/inbox'
import type { InvoiceExtractionResult } from '@/types'

const MAX_ATTACHMENTS_PER_EMAIL = 20

/** POST /inbox/rotate: an empty body rotates; keep_previous renames. */
const RotateInboxSchema = z.object({ keep_previous: z.boolean().optional() }).strict()
/** POST /inbox/previous/stop: one earlier address, as GET /inbox/address lists it. */
const StopPreviousInboxSchema = z.object({ address: z.string().trim().min(1).max(320) }).strict()
// Received-mail panel window (#2181): 30 days covers "the mail I sent last
// week"; the hard cap keeps the query bounded.
const INBOUND_HISTORY_DEFAULT_DAYS = 30
const INBOUND_HISTORY_MAX_DAYS = 365
const INBOUND_HISTORY_LIMIT = 200
// One mail can name several inboxes (#2181), but the recipient list is
// sender-controlled and every target costs a full download-and-extract
// pass: cap the fan-out so a mail addressed to fifty known inboxes cannot
// multiply the work fifty times. A consultant forwarding to a handful of
// clients fits. Every addressed inbox is still resolved (one cheap lookup
// each) and the ones past the cap get a history record saying the mail
// arrived and was not processed, so no company is left without a trace.
const MAX_INBOUND_TARGETS_PER_EMAIL = 5

// The partial-update schema for PATCH /items/:id/fields lives with its rules
// in lib/documents/inbox-item-actions.ts (UpdateInboxItemFieldsSchema).

/** The operation context the shared inbox services take, from the extension's. */
function operationContext(ctx: ExtensionContext): OperationContext {
  return { supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.userId, log: extensionLog }
}

// Direct-to-storage upload (signed URL, see the /upload/create route).
// size_bytes is the browser's own report: the server re-measures the object
// on completion, so this only refuses the obviously oversized before a URL
// is handed out. file_name must be sent identically to both steps: it is
// part of the reserved storage key.
const CreateSignedUploadSchema = z.object({
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(120),
  size_bytes: z.number().int().min(1),
})

const CompleteSignedUploadSchema = z.object({
  upload_id: z.string().uuid(),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(120),
})

/**
 * The inbox item already filed for an archived document, in the /upload
 * response shape. Lets /upload/complete be retried after a lost response:
 * completePendingDocumentUpload converges on the same document row, and
 * this keeps the pipeline from filing a second item for it.
 */
async function findInboxItemForDocument(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  companyId: string,
  documentId: string,
) {
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, status, extracted_data, matched_supplier_id, matched_transaction_id, extraction_skipped')
    .eq('company_id', companyId)
    .eq('document_id', documentId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw dbError(error, 'Completed-upload lookup failed')
  if (!data) return null
  return {
    document_id: documentId,
    inbox_item_id: data.id as string,
    status: data.status as string,
    extracted_data: data.extracted_data,
    matched_supplier_id: data.matched_supplier_id as string | null,
    matched_transaction_id: data.matched_transaction_id as string | null,
    extraction_skipped: data.extraction_skipped === true,
    skip_reason: null,
    page_count: null,
    already_completed: true as const,
  }
}

/**
 * Map a failure in the signed-upload steps to the error envelope. Coded
 * failures get their own status and copy: a viewer-role member's 42501 on
 * the document insert (the storage policy admits the bytes on membership
 * alone), an expired or never-written reservation, and the document
 * service's content verdicts (empty object, over the cap, bytes that are
 * not the declared type; that last one carries its authored Swedish
 * sentence as `messageSv`). Everything else lands on INBOX_UPLOAD_FAILED
 * with the registry copy: the raw message goes to the log only.
 */
function signedUploadFailureResponse(
  error: unknown,
  ctx: ExtensionContext,
  step: 'upload/create' | 'upload/complete',
): NextResponse {
  const reason = error instanceof Error ? error.message : String(error)
  ctx.log.error(`[invoice-inbox/${step}] Failed`, error)
  const coded = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown
    messageSv?: unknown
  }
  const code = typeof coded.code === 'string' ? coded.code : null
  if (code === '42501') {
    return errorResponseFromCode('INBOX_UPLOAD_NOT_PERMITTED', ctx.log, {
      requestId: ctx.requestId,
      reason,
    })
  }
  if (code && hasErrorEntry(code)) {
    return errorResponseFromCode(code, ctx.log, {
      requestId: ctx.requestId,
      reason,
      ...(typeof coded.messageSv === 'string' && coded.messageSv.trim()
        ? { messageSv: coded.messageSv }
        : {}),
    })
  }
  return errorResponseFromCode('INBOX_UPLOAD_FAILED', ctx.log, { requestId: ctx.requestId, reason })
}

// ── Admin/owner check helper ──────────────────────────────────

async function isCompanyAdmin(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  companyId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  return !!data && ['owner', 'admin'].includes(data.role)
}

// ── Extension definition ─────────────────────────────────────

export const invoiceInboxExtension: Extension = {
  id: 'invoice-inbox',
  name: 'Dokumentinkorg',
  version: '3.0.0',

  // Registry-resolved services for core callers (core cannot import
  // @/extensions). Contract: lib/intake/partner-delivery.ts.
  services: {
    // The v1 partner door, POST /api/v1/companies/{id}/inbox-items.
    fileInboxDelivery,
  },

  eventHandlers: [
    {
      // Arkiv said what a document is: queue a receipt or invoice that came in another way, release what is not booked
      // from here, and carry a person's type onto the item already queued.
      eventType: 'document.classified',
      // A failure throws to the event bus, which logs it as an error with the
      // event type and this consumer's name and keeps it from the classifier (lib/events/bus.ts).
      handler: async (payload: EventPayload<'document.classified'>) => {
        const outcome = await routeClassifiedDocument(createServiceClientNoCookies(), {
          documentId: payload.document.id,
          companyId: payload.companyId,
          userId: payload.userId,
          docType: payload.docType,
          admission: payload.admission,
          decidedBy: payload.decidedBy,
        })
        if (outcome === 'queued' || outcome === 'requeued' || outcome === 'retyped' || outcome === 'routed_to_arkiv' || outcome === 'duplicate_of_queued_or_booked') {
          extensionLog.info('routed classified document', { doc: payload.document.id, docType: payload.docType, outcome })
        }
      },
    },
  ],
  apiRoutes: [
    // ── Manual upload ───────────────────────────────────────
    {
      method: 'POST',
      path: '/upload',
      handler: async (request: Request, ctx: ExtensionContext) => {
        // Per-company rate limit (30/min, 500/day). Defense against script
        // floods and compromised sessions; never hit by real users in normal
        // monthly receipt-clearing.
        const limit = await checkInboxUploadRateLimit(ctx.supabase, ctx.companyId)
        if (!limit.ok) {
          return NextResponse.json(
            {
              error: {
                code: 'RATE_LIMITED',
                message:
                  limit.scope === 'minute'
                    ? 'För många uppladdningar på kort tid. Försök igen om en stund.'
                    : 'Dagsgränsen för uppladdningar är nådd. Försök igen imorgon.',
                message_en:
                  limit.scope === 'minute'
                    ? 'Too many uploads in a short time. Try again in a moment.'
                    : 'The daily upload limit has been reached. Try again tomorrow.',
              },
              retry_after: limit.retryAfterSec,
            },
            { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } },
          )
        }

        const formData = await request.formData()
        const file = formData.get('file') as File | null

        if (!file) return errorResponseFromCode('INBOX_UPLOAD_NO_FILE', ctx.log)
        if (file.size > MAX_FILE_SIZE) {
          return errorResponseFromCode('INBOX_UPLOAD_TOO_LARGE', ctx.log, {
            messageSv: `Filen är för stor. Maxstorlek är ${MAX_FILE_SIZE / 1024 / 1024} MB.`,
            messageEn: `File exceeds the ${MAX_FILE_SIZE / 1024 / 1024} MB size limit.`,
          })
        }
        if (!UPLOAD_ALLOWED_MIME_TYPES.has(file.type)) {
          return errorResponseFromCode('INBOX_UPLOAD_UNSUPPORTED_TYPE', ctx.log, {
            messageSv: `Filtypen stöds inte: ${file.type || 'okänd'}. Tillåtna format: PDF, JPEG, PNG, HEIC och WebP.`,
            messageEn: `Unsupported file type: ${file.type || 'unknown'}. Allowed: PDF, JPEG, PNG, HEIC, WebP.`,
          })
        }

        try {
          const buffer = await file.arrayBuffer()
          // Staged upload: the row lands as 'processing' and the response
          // returns before Bedrock runs; the deferred worker (or the sweep
          // cron) flips it to 'received'. Only this web route defers: email
          // and WhatsApp ingestion already run in background contexts and
          // consume the returned item synchronously.
          const result = await uploadAndExtract(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            { name: file.name, buffer, type: file.type },
            'upload',
            undefined,
            null,
            { deferExtraction: true },
          )
          // How it came in (best effort, never fails the upload).
          await recordDocumentArrival(ctx.supabase, {
            companyId: ctx.companyId,
            source: 'upload',
            documentId: result.document_id,
            inboxItemId: result.inbox_item_id,
            fetchedBy: { type: 'user', user_id: ctx.userId },
          })
          return NextResponse.json({ data: result })
        } catch (error) {
          console.error('[invoice-inbox/upload] Failed:', error)
          // Pass the thrown message through: the document service raises its
          // user-facing failures (magic-byte mismatch, corrupt content) in
          // Swedish, and getErrorMessage substitutes the registry copy for
          // this code when the message is internal English.
          const message = error instanceof Error && error.message.trim() ? error.message : null
          return NextResponse.json(
            {
              error: {
                code: 'INBOX_UPLOAD_FAILED',
                message: message ?? 'Uppladdningen misslyckades. Försök igen.',
                message_en: message ?? 'Upload failed.',
              },
            },
            { status: 500 }
          )
        }
      },
    },

    // ── Direct-to-storage upload (signed URL, two steps) ────
    // A hosted function body is capped at 4.5 MB by the platform, before the
    // route runs, so a scanned PDF above that can never reach /upload
    // (issue #1551). The browser instead asks for a short-lived signed URL
    // here, PUTs the bytes straight to Storage, and hands the reservation to
    // /upload/complete, which reads the object back out of Storage, hashes
    // and archives it: the integrity chain stays server-computed. Two path
    // segments so the dispatcher's segment-count match never confuses these
    // with /upload. Rate-limited on create only: complete cannot mint
    // anything the create step did not already pay for.
    {
      method: 'POST',
      path: '/upload/create',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const limit = await checkInboxUploadRateLimit(ctx.supabase, ctx.companyId)
        if (!limit.ok) {
          return NextResponse.json(
            {
              error: {
                code: 'RATE_LIMITED',
                message:
                  limit.scope === 'minute'
                    ? 'För många uppladdningar på kort tid. Försök igen om en stund.'
                    : 'Dagsgränsen för uppladdningar är nådd. Försök igen imorgon.',
                message_en:
                  limit.scope === 'minute'
                    ? 'Too many uploads in a short time. Try again in a moment.'
                    : 'The daily upload limit has been reached. Try again tomorrow.',
              },
              retry_after: limit.retryAfterSec,
            },
            { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } },
          )
        }

        const parsed = await validateBody(request, CreateSignedUploadSchema)
        if (!parsed.success) return parsed.response
        const { file_name: fileName, mime_type: mimeType, size_bytes: sizeBytes } = parsed.data

        if (!UPLOAD_ALLOWED_MIME_TYPES.has(mimeType)) {
          return errorResponseFromCode('INBOX_UPLOAD_UNSUPPORTED_TYPE', ctx.log, {
            requestId: ctx.requestId,
            messageSv: `Filtypen stöds inte: ${mimeType}. Tillåtna format: PDF, JPEG, PNG, HEIC och WebP.`,
            messageEn: `Unsupported file type: ${mimeType}. Allowed: PDF, JPEG, PNG, HEIC, WebP.`,
          })
        }
        if (sizeBytes > MAX_FILE_SIZE) {
          return errorResponseFromCode('INBOX_UPLOAD_TOO_LARGE', ctx.log, {
            requestId: ctx.requestId,
            messageSv: `Filen är för stor. Maxstorlek är ${MAX_FILE_SIZE / 1024 / 1024} MB.`,
            messageEn: `File exceeds the ${MAX_FILE_SIZE / 1024 / 1024} MB size limit.`,
          })
        }

        try {
          const uploadId = crypto.randomUUID()
          const reservation = await createPendingDocumentUpload(
            ctx.supabase,
            ctx.companyId,
            ctx.userId,
            uploadId,
            fileName,
          )
          // The RAW Storage URL, deliberately not the same-origin proxy the
          // MCP tools hand out (toSameOriginStorageUrl): that proxy buffers
          // the PUT body inside a function and so sits under the very
          // ceiling this route exists to get around. CSP connect-src
          // already allows the Storage host.
          return NextResponse.json({
            data: {
              upload_id: reservation.uploadId,
              upload_url: reservation.signedUrl,
              expires_at: reservation.expiresAt,
            },
          })
        } catch (error) {
          return signedUploadFailureResponse(error, ctx, 'upload/create')
        }
      },
    },

    {
      method: 'POST',
      path: '/upload/complete',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const parsed = await validateBody(request, CompleteSignedUploadSchema)
        if (!parsed.success) return parsed.response
        const { upload_id: uploadId, file_name: fileName, mime_type: mimeType } = parsed.data

        // The declared type drives the magic-byte check on completion, so
        // it is gated exactly like the multipart route's file.type.
        if (!UPLOAD_ALLOWED_MIME_TYPES.has(mimeType)) {
          return errorResponseFromCode('INBOX_UPLOAD_UNSUPPORTED_TYPE', ctx.log, {
            requestId: ctx.requestId,
            messageSv: `Filtypen stöds inte: ${mimeType}. Tillåtna format: PDF, JPEG, PNG, HEIC och WebP.`,
            messageEn: `Unsupported file type: ${mimeType}. Allowed: PDF, JPEG, PNG, HEIC, WebP.`,
          })
        }

        try {
          // Idempotent: a retry after a lost response (tab reloaded, network
          // dropped) must return the item that already exists, not file a
          // second one. The document id IS the upload id.
          const existing = await findInboxItemForDocument(ctx.supabase, ctx.companyId, uploadId)
          if (existing) return NextResponse.json({ data: existing })

          const completed = await completePendingDocumentUpload(
            ctx.supabase,
            ctx.companyId,
            ctx.userId,
            uploadId,
            fileName,
            mimeType,
            undefined,
            {
              extractionOwner: 'invoice-inbox',
              uploadSource: 'file_upload',
              // Same content dedupe the multipart route gets from
              // uploadDocument: the same receipt uploaded twice must not
              // become a second archived document.
              dedupeByContent: true,
            },
          )
          // From here on this is the multipart route, byte for byte: same
          // staged extraction, same inbox row, same response shape.
          const result = await processArchivedDocument(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            completed.document,
            { name: fileName, buffer: completed.buffer, type: mimeType },
            'upload',
            undefined,
            null,
            { deferExtraction: true },
          )
          await recordDocumentArrival(ctx.supabase, {
            companyId: ctx.companyId,
            source: 'upload',
            documentId: result.document_id,
            inboxItemId: result.inbox_item_id,
            fetchedBy: { type: 'user', user_id: ctx.userId },
          })
          return NextResponse.json({ data: result })
        } catch (error) {
          return signedUploadFailureResponse(error, ctx, 'upload/complete')
        }
      },
    },

    // ── List inbox items ────────────────────────────────────
    {
      method: 'GET',
      path: '/items',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const status = url.searchParams.get('status')
        // The inbox is a workqueue and booked items drop out of the view
        // client-side, so any cap on the read hides open underlag behind
        // older booked ones (it was 50, then 500). Without ?limit every item
        // is read, paged; ?limit asks for the newest N only (at most 1,000).
        const limitParam = Number(url.searchParams.get('limit'))
        const limit = Number.isInteger(limitParam) && limitParam >= 1 ? Math.min(limitParam, 1000) : null

        const itemsQuery = () => {
          let query = ctx.supabase
            .from('invoice_inbox_items')
            .select(`
              id, status, source, created_at, extracted_data,
              matched_supplier_id, document_id, email_from, email_subject,
              email_received_at, email_body_text, error_message,
              created_supplier_invoice_id,
              matched_transaction_id, created_journal_entry_id,
              resend_email_id, extraction_skipped, channel_context, kind_hint,
              routed_to_arkiv_at, routed_doc_type,
              bank_match_transaction_id, bank_match_basis, bank_match_evidence_level, bank_match_source_key,
              bank_match_checked_at, ${INBOX_ITEM_DOCUMENT_HOLD}
            `)
            .eq('company_id', ctx.companyId)
            .order('created_at', { ascending: false })
            .order('id', { ascending: true })
          if (status) query = query.eq('status', status)
          return query
        }

        let data: unknown[]
        try {
          if (limit === null) {
            data = await fetchAllRows<unknown>(({ from, to }) => itemsQuery().range(from, to))
          } else {
            const { data: page, error } = await itemsQuery().range(0, limit - 1)
            if (error) throw error
            data = page ?? []
          }
        } catch (error) {
          return NextResponse.json({ error: (error as { message?: string }).message ?? String(error) }, { status: 500 })
        }

        // Matched-but-unstamped items carry the verifikat that books their
        // transaction, and whether this item's underlag reached it: the same
        // enrichment as v1 (resolveInboxBookedState in inbox-item-actions).
        type ItemRow = DocumentHoldRow & {
          id: string
          document_id: string | null
          matched_transaction_id: string | null
          created_journal_entry_id: string | null
          created_supplier_invoice_id: string | null
          extracted_data: Record<string, unknown> | null
          extraction_skipped: boolean | null
          created_at: string
        }
        const rows = ((data ?? []) as ItemRow[]).map(withDocumentHold)
        const bookedState = await resolveInboxBookedState(ctx.supabase, ctx.companyId, rows)

        // Match on arrival, for the whole list in a few reads (never one per
        // item): the bank row each open item looks already paid by, checked
        // again now, as the detail read below does. Read from the rows as
        // stored, before the document's reading stands in.
        let bankMatches = new Map<string, BankMatch>()
        try {
          bankMatches = await readInboxBankMatches(ctx.supabase, ctx.companyId, rows as unknown as BankMatchItemRow[])
        } catch (err) {
          extensionLog.warn('inbox list bank match read failed', { err: err instanceof Error ? err.message : String(err) })
        }

        // Items filed before match on arrival existed (or whose bank rows
        // came before it) were never checked: the newest few are checked
        // after this answer, at most one batch per company per cooldown, so
        // old items heal as the list is read, without a backfill. Their
        // writes reach the page as realtime changes and the next read shows
        // the proposals. Never part of this answer, never its failure.
        const neverCheckedIds = neverCheckedToCheck(rows as unknown as Parameters<typeof neverCheckedToCheck>[0], new Date())
        if (neverCheckedIds.length > 0) {
          try {
            after(() => checkNeverCheckedInboxItems(ctx.supabase, ctx.companyId, neverCheckedIds, extensionLog).then(() => undefined))
          } catch (err) {
            extensionLog.warn('inbox list never-checked items not scheduled', { err: err instanceof Error ? err.message : String(err) })
          }
        }

        const items = rows.map((r) => ({
          ...r,
          matched_transaction_journal_entry_id: bookedState.get(r.id)?.journalEntryId ?? null,
          underlag_status: bookedState.get(r.id)?.underlag ?? null,
          bank_match: bankMatches.get(r.id) ?? null,
          reading_retry: null as ReadingRetry | null,
        }))

        // A receipt dropped into Dokument is routed here the moment the
        // classifier types it, before its reading has landed: the item was
        // created with none and stayed "Inte AI-tolkad" although the document
        // row got the reading seconds later (prod 2026-09-24). The document's
        // own reading stands in for the item's.
        //
        // The same read gives an open item whose reading came back empty its
        // document's stamp: when the AI provider could not take the call
        // (failed:provider_unavailable), reading_retry says whether the sweep
        // reads it again, so the Inkorg shows an outage as one instead of as
        // a document nobody read (2026-10-26).
        const unread = items
          .filter(
            (i) =>
              i.document_id &&
              (i.extracted_data == null ||
                (i.extraction_skipped !== true &&
                  !i.created_supplier_invoice_id &&
                  !i.created_journal_entry_id &&
                  nothingRead(i.extracted_data as unknown as InkorgItem['extracted_data']))),
          )
          .map((i) => i.document_id as string)
        if (unread.length > 0) {
          // In slices: the list is no longer capped, so the id list is not either.
          const docs: Array<{ id: string; extracted_data: Record<string, unknown> | null; extraction_model: string | null }> = []
          for (const ids of chunk(unread, 200)) {
            const { data: part, error: docsError } = await ctx.supabase.from('document_attachments').select('id, extracted_data, extraction_model').in('id', ids)
            if (docsError) return NextResponse.json({ error: docsError.message }, { status: 500 })
            docs.push(...((part ?? []) as typeof docs))
          }
          const readingOf = new Map(
            docs.filter((d) => d.extracted_data).map((d) => [d.id, d.extracted_data]),
          )
          const stampOf = new Map(docs.map((d) => [d.id, d.extraction_model]))
          const now = Date.now()
          for (const item of items) {
            if (!item.document_id) continue
            if (item.extracted_data == null && readingOf.has(item.document_id)) {
              item.extracted_data = readingOf.get(item.document_id) ?? null
              item.extraction_skipped = false
            }
            item.reading_retry = readingRetryOf(stampOf.get(item.document_id), item.created_at, now)
          }
        }

        // The vendor's own icon, when the logo cron stored one (lib/vendor-logos): resolved from
        // the supplier as read and the sender, served from our bucket. No icon is no logo_url.
        const logos = await vendorLogoUrls(
          items.map((i) => {
            const supplier = (i.extracted_data as { supplier?: { name?: unknown } } | null)?.supplier?.name
            const row = i as { email_from?: string | null; email_subject?: string | null }
            return {
              key: i.id,
              name: (typeof supplier === 'string' && supplier.trim()) || row.email_subject || null,
              emails: [row.email_from],
            }
          }),
        )

        // An invoice and its receipt from the same arrival are one purchase
        // (lib/inkorg/pairs.ts): each row says which one it came with, read
        // after the documents' readings stand in. An invoice registered and
        // still unpaid keeps its receipt with it, and an open half whose
        // other half is booked already is that booking's companion, with its
        // verifikat (lib/operations/inbox-pairings.ts). A pairing that cannot
        // be read is none: the rows stand alone.
        let pairings = new Map<string, InboxPairing>()
        try {
          pairings = await readInboxPairings(ctx.supabase, ctx.companyId, items as unknown as ListedItem[])
        } catch (err) {
          extensionLog.warn('inbox list pairing read failed', { err: err instanceof Error ? err.message : String(err) })
        }

        // A card number read off a receipt is a reading, not a fact (crm#1534):
        // each row says whether it is one of the company's own cards, after
        // the documents' readings stand in. A check that cannot be read is
        // none known: the number shows as read.
        let knownCards = new Set<string>()
        try {
          knownCards = await readKnownCards(ctx.supabase, ctx.companyId, items.map((i) => readCardOf(i.extracted_data)))
        } catch (err) {
          extensionLog.warn('inbox list known cards read failed', { err: err instanceof Error ? err.message : String(err) })
        }

        // A multi-page paper invoice photographed a page at a time is one
        // item per page: each open row names the others read as the same
        // supplier invoice, so it is registered once (lib/inkorg/same-invoice.ts).
        const sameInvoice = sameInvoiceItems(items as unknown as SameInvoiceItem[])

        const withLogos = items.map((i) => ({
          ...i,
          logo_url: logos.get(i.id) ?? null,
          pairing: pairings.get(i.id) ?? null,
          same_invoice: sameInvoice.get(i.id) ?? null,
          payment_card_known: readCardKnown(i.extracted_data, knownCards),
        }))

        // arkiv_section: whether the Dokument section is open for this company, so the
        // "routed to the archive" line links there only when the link leads somewhere.
        return NextResponse.json({ data: { items: withLogos, count: withLogos.length, arkiv_section: isArkivSectionEnabled(ctx.companyId) } })
      },
    },

    // ── Which invoice a credit note in the inbox credits ────
    // Issue #2980: a supplier's credit note is handled by crediting the
    // invoice it references (POST /api/supplier-invoices/:id/credit with the
    // inbox item), never registered as a payable. The rail asks here which
    // invoice that is; resolution rules in lib/supplier-invoices/credit-target.ts.
    {
      method: 'GET',
      path: '/items/:id/credit-target',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const { data: item, error } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, kind_hint, matched_supplier_id, extracted_data, document_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()
        if (error) return sessionFailureResponse({ ok: false, code: 'UNKNOWN_ERROR', error }, extensionLog, ctx.requestId ?? '')
        if (!item) return sessionFailureResponse({ ok: false, code: 'INBOX_ITEM_NOT_FOUND' }, extensionLog, ctx.requestId ?? '')

        const row = item as {
          kind_hint: string | null
          matched_supplier_id: string | null
          extracted_data: Record<string, unknown> | null
          document_id: string | null
        }
        // Same stand-in as the item routes: the document's reading when the item has none.
        if (row.extracted_data == null && row.document_id) {
          const { data: doc } = await ctx.supabase.from('document_attachments').select('extracted_data').eq('id', row.document_id).eq('company_id', ctx.companyId).maybeSingle()
          row.extracted_data = (doc as { extracted_data?: Record<string, unknown> | null } | null)?.extracted_data ?? null
        }
        if (resolveInboxKind(row as InboxKindSource) !== 'credit_note') {
          return NextResponse.json({ data: { is_credit_note: false, credit_target: null } })
        }
        const creditTarget = await resolveInboxCreditTarget(ctx.supabase, ctx.companyId, row)
        return NextResponse.json({ data: { is_credit_note: true, credit_target: creditTarget } })
      },
    },

    // ── Get single inbox item ───────────────────────────────
    {
      method: 'GET',
      path: '/items/:id',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const { data: stored, error } = await ctx.supabase
          .from('invoice_inbox_items')
          .select(`*, ${INBOX_ITEM_DOCUMENT_HOLD}`)
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .single()

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        if (!stored) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        const data = withDocumentHold(stored as unknown as DocumentHoldRow) as Record<string, unknown>

        // Same enrichment as the list: the detail rail must not offer to
        // book a matched transaction that is already booked.
        const row = data as unknown as {
          id: string
          document_id: string | null
          matched_transaction_id: string | null
          created_journal_entry_id: string | null
          created_supplier_invoice_id: string | null
          extracted_data: Record<string, unknown> | null
          extraction_skipped: boolean | null
        }
        const bookedState = (await resolveInboxBookedState(ctx.supabase, ctx.companyId, [row])).get(row.id)
        const matchedTransactionJournalEntryId = bookedState?.journalEntryId ?? null
        const underlagStatus = bookedState?.underlag ?? null

        // ?include=reading: the one reading (lib/documents/reading), each
        // field with its source and evidence level. Read from the row as
        // stored, before the document's reading stands in below.
        let documentReading: DocumentReading | null = null
        if (url.searchParams.get('include') === 'reading') {
          try {
            documentReading = await loadDocumentReading(ctx.supabase, ctx.companyId, { item: { ...(data as unknown as ReadingItemRow) } }, peppolReader)
          } catch (err) {
            extensionLog.warn('inbox item reading failed', { inboxItemId: id, err: err instanceof Error ? err.message : String(err) })
            return NextResponse.json({ error: 'Kunde inte läsa underlagets fält' }, { status: 500 })
          }
        }

        // Match on arrival: the bank row it looks already paid by, checked
        // again now (lib/documents/inbox-bank-match.ts). A proposal, never a
        // booking; read from the row as stored, before the stand-in below.
        // An item the bank was never checked for is checked now, before the
        // read below, so the focus view opens with what the bank says. Once:
        // the check stamps bank_match_checked_at whatever it finds.
        if (neverChecked(data as unknown as Parameters<typeof neverChecked>[0])) {
          const checked = await checkNeverCheckedInboxItems(ctx.supabase, ctx.companyId, [id], extensionLog)
          if (checked.includes(id)) {
            const { data: fresh } = await ctx.supabase
              .from('invoice_inbox_items')
              .select('bank_match_transaction_id, bank_match_basis, bank_match_evidence_level, bank_match_checked_at, bank_match_source_key')
              .eq('id', id)
              .eq('company_id', ctx.companyId)
              .maybeSingle()
            if (fresh) Object.assign(data as Record<string, unknown>, fresh)
          }
        }

        let bankMatch: BankMatch | null = null
        try {
          bankMatch = await readInboxBankMatch(ctx.supabase, ctx.companyId, { ...(data as unknown as BankMatchItemRow) })
        } catch (err) {
          extensionLog.warn('inbox item bank match read failed', { inboxItemId: id, err: err instanceof Error ? err.message : String(err) })
        }

        // Same stand-in as the list: the document's reading when the item has none.
        if (row.extracted_data == null && row.document_id) {
          const { data: doc } = await ctx.supabase.from('document_attachments').select('id, extracted_data').eq('id', row.document_id).maybeSingle()
          const reading = (doc as { extracted_data?: Record<string, unknown> | null } | null)?.extracted_data ?? null
          if (reading) {
            row.extracted_data = reading
            row.extraction_skipped = false
          }
        }

        // What the underlag bought, computed at read time (null when ambiguous),
        // and what else the evidence points to for the picker.
        const purchaseCategory = await resolveInboxPurchaseCategoryChoices(ctx.supabase, ctx.companyId, row)

        // As the list: whether the card number read off it is one of the company's own cards (crm#1534).
        let paymentCardKnown: boolean | null = null
        if (readCardOf(row.extracted_data)) {
          try {
            paymentCardKnown = readCardKnown(row.extracted_data, await readKnownCards(ctx.supabase, ctx.companyId, [readCardOf(row.extracted_data)]))
          } catch (err) {
            paymentCardKnown = false
            extensionLog.warn('inbox item known cards read failed', { inboxItemId: id, err: err instanceof Error ? err.message : String(err) })
          }
        }

        return NextResponse.json({
          data: {
            ...row,
            payment_card_known: paymentCardKnown,
            matched_transaction_journal_entry_id: matchedTransactionJournalEntryId,
            underlag_status: underlagStatus,
            purchase_category: purchaseCategory.proposal,
            purchase_category_alternatives: purchaseCategory.alternatives,
            bank_match: bankMatch,
            ...(documentReading ? { reading: documentReading } : {}),
          },
        })
      },
    },

    // ── Update extracted_data fields (manual user edits) ────
    // Rules (merge, supplier-invoice lock, optimistic concurrency) live in
    // lib/documents/inbox-item-actions.ts, shared with the v1 operation
    // inbox-items.update-extracted-data.
    {
      method: 'PATCH',
      path: '/items/:id/fields',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        let body: UpdateInboxItemFieldsInput
        try {
          const json = await request.json()
          body = UpdateInboxItemFieldsSchema.parse(json)
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Invalid request body' },
            { status: 400 }
          )
        }

        const outcome = await updateInboxItemFields(operationContext(ctx), id, body)
        if (!outcome.ok) return sessionFailureResponse(outcome, extensionLog, ctx.requestId ?? '')
        if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
        // A corrected amount, OCR or giro can pair another bank row, or none.
        await proposeBankMatchForInboxItem(ctx.supabase, ctx.companyId, id, extensionLog)
        return NextResponse.json({ data: outcome.data })
      },
    },

    // ── Set or clear the purchase category (a person's choice) ────
    // Rules in lib/documents/inbox-purchase-category.ts, shared with the v1
    // operation inbox-items.set-purchase-category. every_time makes it the
    // matched supplier's instruction ("varje gång"). Books nothing.
    {
      method: 'PUT',
      path: '/items/:id/purchase-category',
      // A viewer is refused by the dispatcher with a clear 403, not by RLS
      // matching zero rows.
      requireWrite: true,
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, reason: 'missing id' })

        const parsed = SetInboxPurchaseCategorySchema.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) {
          return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, reason: 'invalid purchase category' })
        }

        const outcome = await setInboxItemPurchaseCategory(operationContext(ctx), id, parsed.data.code, {
          via: 'dashboard',
          everyTime: parsed.data.every_time,
        })
        if (!outcome.ok) return sessionFailureResponse(outcome, extensionLog, ctx.requestId ?? '')
        if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
        return NextResponse.json({ data: outcome.data })
      },
    },

    // ── Match a bank transaction to an inbox item ──────────
    // Sets invoice_inbox_items.matched_transaction_id. Used by the
    // TransactionMatchPicker dialog after the user picks a candidate from
    // the confidence-scored list. Rules in lib/documents/inbox-match.ts
    // (v1: inbox-items.match-transaction).
    {
      method: 'POST',
      path: '/items/:id/match-transaction',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        let body: { transaction_id?: string; check_fit?: boolean; mismatch_reason?: string }
        try {
          body = await request.json()
        } catch {
          return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
        }
        if (!body.transaction_id || typeof body.transaction_id !== 'string') {
          return NextResponse.json({ error: 'transaction_id required' }, { status: 400 })
        }

        // check_fit: the Inkorg's drop on a purchase, where the person never
        // sees the document's amount and seller next to the row (crm#1479);
        // mismatch_reason is their confirmation after DOC_ROW_MISMATCH. The
        // pickers that show both sides call without it.
        const outcome = await matchInboxItemTransaction(operationContext(ctx), id, body.transaction_id, {
          fitCheck: body.check_fit === true ? documentFitGate(ctx.supabase, ctx.companyId, body.mismatch_reason) : undefined,
        })
        if (!outcome.ok) return sessionFailureResponse(outcome, extensionLog, ctx.requestId ?? '')
        if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
        return NextResponse.json({ data: outcome.data })
      },
    },

    // ── Clear matched_transaction_id (user mistake / re-match) ────
    // Rules in lib/documents/inbox-item-actions.ts (v1:
    // inbox-items.unmatch-transaction).
    {
      method: 'POST',
      path: '/items/:id/unmatch-transaction',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const outcome = await unmatchInboxItemTransaction(operationContext(ctx), id)
        if (!outcome.ok) return sessionFailureResponse(outcome, extensionLog, ctx.requestId ?? '')
        if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
        // Open again: look in the bank for its payment.
        await proposeBankMatchForInboxItem(ctx.supabase, ctx.companyId, id, extensionLog)
        return NextResponse.json({ data: { id: outcome.data.id, matched_transaction_id: null } })
      },
    },

    // ── Retry extraction on a stored document ──────────────
    {
      method: 'POST',
      path: '/items/:id/retry-extraction',
      handler: async (request: Request, ctx: ExtensionContext) => {
        // Retry runs pdfjs extraction synchronously and is CPU-heavy; counts
        // against the same per-company quota as a fresh upload so an
        // attacker can't burn server CPU by repeatedly re-extracting one doc.
        const limit = await checkInboxUploadRateLimit(ctx.supabase, ctx.companyId)
        if (!limit.ok) {
          return NextResponse.json(
            {
              error:
                limit.scope === 'minute'
                  ? 'För många tolkningsförsök på kort tid. Försök igen om en stund.'
                  : 'Dagsgränsen för tolkningar är nådd. Försök igen imorgon.',
              retry_after: limit.retryAfterSec,
            },
            { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } },
          )
        }

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, document_id, correlation_id, created_supplier_invoice_id, extracted_data, email_subject, email_received_at')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!item) return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 })
        if (item.created_supplier_invoice_id) {
          return NextResponse.json(
            { error: 'Redan bokfört, kan inte köra om tolkningen.' },
            { status: 409 },
          )
        }
        if (!item.document_id) {
          return NextResponse.json(
            { error: 'Ingen bilaga att tolka om.' },
            { status: 400 },
          )
        }

        // Paid-tier gate: retry is an explicit "run AI OCR now" action, so a
        // company without the `ai` capability is hard-blocked (403) rather than
        // silently emptied: there is nothing to retry without the entitlement.
        if (!(await hasCapability(ctx.supabase, ctx.companyId, CAPABILITY.ai))) {
          return capabilityBlockedResponse(CAPABILITY.ai)
        }

        if (await isSandboxCompany(ctx.supabase, ctx.companyId)) {
          return NextResponse.json(
            { error: 'AI-tolkning är inte tillgänglig i sandlådan.' },
            { status: 409 },
          )
        }

        const { data: doc } = await ctx.supabase
          .from('document_attachments')
          .select('storage_path, mime_type, file_name')
          .eq('id', item.document_id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!doc) {
          return NextResponse.json({ error: 'Bilagan kunde inte hittas.' }, { status: 404 })
        }

        // Download via the service-role client: the storage SELECT policy
        // only covers the uploader's own folder, and inbox documents are
        // attributed to the company creator, so ctx.supabase (user-bound)
        // cannot read them for other members. The company-scoped row fetch
        // above is the authorization.
        const { data: blob, error: dlError } = await createServiceClient().storage
          .from('documents')
          .download(doc.storage_path)

        if (dlError || !blob) {
          console.error('[invoice-inbox/retry-extraction] download failed:', dlError)
          return NextResponse.json(
            { error: 'Kunde inte ladda ner bilagan.' },
            { status: 500 },
          )
        }

        try {
          const buffer = Buffer.from(await blob.arrayBuffer())
          const extraction = await extractAndMirror(item.document_id, {
            buffer,
            mimeType: doc.mime_type,
            fileName: doc.file_name,
            ownCompany: await fetchOwnCompanyIdentity(ctx.supabase, ctx.companyId),
            // Read again with the mail it came with, as on arrival (crm#1749).
            emailContext: { subject: item.email_subject ?? null, receivedAt: item.email_received_at ?? null },
          })
          // What a person decided is final: the new reading carries their
          // corrected fields and their purchase category.
          const extracted = keepPersonChoices(item.extracted_data, extraction.data)

          // Re-running the extraction has to re-run the match too, or the one
          // affordance the user reaches for when an item failed to auto-link
          // ("Tolka om") can never produce a link: this path rewrote
          // extracted_data and left matched_supplier_id untouched. Only a
          // positive match is written, so a supplier the user picked by hand
          // survives a retry that finds nothing.
          const matchedSupplierId = await matchSupplierId(
            ctx.supabase,
            ctx.companyId,
            extracted.supplier,
          )

          // Two literal payloads instead of one with a conditional spread:
          // the phantom-column guard can only check columns written as inline
          // object literals, and matched_supplier_id should be checkable.
          const { error: updateError } = matchedSupplierId
            ? await ctx.supabase
                .from('invoice_inbox_items')
                .update({
                  status: 'received',
                  error_message: null,
                  extracted_data: extracted as unknown as Record<string, unknown>,
                  // Retry is user-initiated and bypasses the page-count gate by
                  // design: the user explicitly opted into the slow path.
                  extraction_skipped: false,
                  matched_supplier_id: matchedSupplierId,
                })
                .eq('id', id)
                .eq('company_id', ctx.companyId)
            : await ctx.supabase
                .from('invoice_inbox_items')
                .update({
                  status: 'received',
                  error_message: null,
                  extracted_data: extracted as unknown as Record<string, unknown>,
                  extraction_skipped: false,
                })
                .eq('id', id)
                .eq('company_id', ctx.companyId)

          if (updateError) {
            return NextResponse.json({ error: updateError.message }, { status: 500 })
          }

          // extractAndMirror wrote the model's fresh reading onto the document;
          // a person's carried corrections follow it there, as after an edit.
          if (carriedPersonFields(item.extracted_data)) {
            await mirrorCorrectedReadingToDocument({
              documentId: item.document_id,
              companyId: ctx.companyId,
              reading: extracted as unknown as Record<string, unknown>,
            })
          }

          if (item.correlation_id) {
            try {
              await appendProcessingHistory({
                companyId: ctx.companyId,
                correlationId: item.correlation_id,
                aggregateType: 'Document',
                aggregateId: item.document_id,
                eventType: 'DocumentExtractionRetried',
                payload: {
                  inbox_item_id: id,
                  document_id: item.document_id,
                },
                actor: { type: 'user', id: ctx.userId },
                occurredAt: new Date(),
              })
            } catch (logErr) {
              console.error('[invoice-inbox/retry-extraction] history append failed:', logErr)
            }
          }

          // The new reading may be paid by another bank row, or by none.
          await proposeBankMatchForInboxItem(ctx.supabase, ctx.companyId, id, extensionLog)

          return NextResponse.json({ data: { extracted_data: extracted } })
        } catch (error) {
          console.error('[invoice-inbox/retry-extraction] extraction failed:', error)
          const message = error instanceof Error ? error.message : 'Tolkning misslyckades'
          await ctx.supabase
            .from('invoice_inbox_items')
            .update({ status: 'error', error_message: message })
            .eq('id', id)
            .eq('company_id', ctx.companyId)
          return NextResponse.json({ error: message }, { status: 500 })
        }
      },
    },

    // ── Get this company's inbox address ────────────────────
    {
      method: 'GET',
      path: '/inbox/address',
      handler: async (_request: Request, ctx: ExtensionContext) => {
        const domain = process.env.RESEND_INBOUND_DOMAIN
        if (!domain) {
          return NextResponse.json({ error: 'RESEND_INBOUND_DOMAIN not configured' }, { status: 503 })
        }

        try {
          const inbox = await getActiveInbox(ctx.supabase, ctx.companyId)
          if (!inbox) {
            return NextResponse.json({ error: 'No active inbox' }, { status: 404 })
          }
          // Read alongside, never a reason to fail the address: null when unread.
          const [previous, company] = await Promise.all([
            listPreviousInboxes(ctx.supabase, ctx.companyId).catch(() => null),
            ctx.supabase.from('companies').select('name').eq('id', ctx.companyId).maybeSingle(),
          ])
          const companyName = (company.data as { name?: string } | null)?.name
          return NextResponse.json({
            data: {
              address: composeInboxAddress(inbox.local_part, domain),
              local_part: inbox.local_part,
              status: inbox.status,
              created_at: inbox.created_at,
              // A rename leaves the address alone (suppliers send to it): false
              // once it no longer carries the company's name (crm#1334).
              carries_company_name: companyName ? inboxAddressCarriesName(inbox.local_part, companyName) : null,
              // Earlier addresses a rename kept: they still receive.
              previous: previous?.map((localPart) => composeInboxAddress(localPart, domain)) ?? null,
            },
          })
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Failed to load inbox' },
            { status: 500 }
          )
        }
      },
    },

    // ── Rotate inbox address (admin/owner only) ─────────────
    // No body: a new address, every old one stops (410). keep_previous: a new
    // address with the company's current name while the old one keeps
    // receiving (rename_company_inbox, crm#1334); refused with 409 when the
    // address already carries the name.
    {
      method: 'POST',
      path: '/inbox/rotate',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const domain = process.env.RESEND_INBOUND_DOMAIN
        if (!domain) {
          return NextResponse.json({ error: 'RESEND_INBOUND_DOMAIN not configured' }, { status: 503 })
        }

        const raw = await request.text().catch(() => '')
        let body: unknown = {}
        if (raw.trim()) {
          try {
            body = JSON.parse(raw)
          } catch {
            return NextResponse.json({ error: 'Ogiltig begäran.' }, { status: 400 })
          }
        }
        const parsed = RotateInboxSchema.safeParse(body)
        if (!parsed.success) return NextResponse.json({ error: 'Ogiltig begäran.' }, { status: 400 })
        const keepPrevious = parsed.data.keep_previous === true

        const isAdmin = await isCompanyAdmin(ctx.supabase, ctx.userId, ctx.companyId)
        if (!isAdmin) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

        try {
          const newInbox = keepPrevious
            ? await renameCompanyInbox(ctx.supabase, ctx.companyId)
            : await rotateCompanyInbox(ctx.supabase, ctx.companyId)
          return NextResponse.json({
            data: {
              address: composeInboxAddress(newInbox.local_part, domain),
              local_part: newInbox.local_part,
              status: newInbox.status,
            },
          })
        } catch (err) {
          if (err instanceof InboxRenameRefused) {
            return err.reason === 'unchanged'
              ? NextResponse.json({ error: 'Inkorgsadressen har redan bolagets namn.' }, { status: 409 })
              : NextResponse.json({ error: 'Bolaget har ingen inkorgsadress att byta.' }, { status: 404 })
          }
          console.error('[invoice-inbox/inbox/rotate] Failed:', err)
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Rotation failed' },
            { status: 500 }
          )
        }
      },
    },

    // ── Stop an earlier address (admin/owner only, crm#1209) ─
    // One address a rename kept stops receiving (410 from then on) and leaves
    // the list; what came in through it stays. The active address is never
    // stopped here: rotation is the tool for that.
    {
      method: 'POST',
      path: '/inbox/previous/stop',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const parsed = await validateBody(request, StopPreviousInboxSchema)
        if (!parsed.success) return parsed.response

        const isAdmin = await isCompanyAdmin(ctx.supabase, ctx.userId, ctx.companyId)
        if (!isAdmin) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

        // The list shows full addresses; the row holds the part before the @.
        const address = parsed.data.address.toLowerCase()
        const at = address.lastIndexOf('@')
        const localPart = at === -1 ? address : address.slice(0, at)

        try {
          const stopped = await stopPreviousInbox(ctx.supabase, ctx.companyId, localPart)
          if (!stopped) {
            return NextResponse.json({ error: 'Adressen finns inte bland bolagets tidigare adresser.' }, { status: 404 })
          }
          return NextResponse.json({ data: { stopped: true } })
        } catch (err) {
          console.error('[invoice-inbox/inbox/previous/stop] Failed:', err)
          return NextResponse.json({ error: 'Adressen kunde inte stängas.' }, { status: 500 })
        }
      },
    },

    // ── Resend Inbound webhook (Svix-signed, no user auth) ──
    {
      method: 'POST',
      path: '/inbound',
      skipAuth: true,
      handler: async (request: Request) => {
        const domain = process.env.RESEND_INBOUND_DOMAIN
        if (!domain) {
          console.error('[invoice-inbox/inbound] RESEND_INBOUND_DOMAIN not configured')
          return NextResponse.json({ error: 'Inbound not configured' }, { status: 503 })
        }

        const rawBody = await request.text()

        let event
        try {
          event = verifyInboundWebhook(rawBody, request.headers)
        } catch (err) {
          if (err instanceof ResendSignatureError) {
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
          }
          console.error('[invoice-inbox/inbound] Verification error:', err)
          return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
        }

        if (!isEmailReceivedEvent(event)) {
          return NextResponse.json({ data: { ignored: event.type } }, { status: 200 })
        }

        const { email_id, to, from, subject, message_id, created_at } = event.data

        const serviceSupabase = createServiceRoleClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        // Recipient → company resolution. Every shared-domain recipient is
        // read (#2181): one mail can name the same inbox under two tags, or
        // two inboxes at once, and reading only the first lost the rest with
        // no trace.
        interface InboundTarget {
          companyId: string
          inboxId: string | null
          /** The documented tags (+lev / +ver) that reached this inbox. */
          tags: string[]
          /** Tags outside the documented set: counted, never stored. */
          unknownTagCount: number
          kindHint: InboxKindHint | null
          tagConflict: boolean
        }
        const targets: InboundTarget[] = []
        let sharedInboxStatus: string | null = null
        let localPart: string | null = null

        const sharedRecipients = extractSharedRecipientsForDomain(to, domain)
        for (const group of groupSharedRecipientsByInbox(sharedRecipients)) {
          localPart ??= group.localPart
          const { data: inbox } = await serviceSupabase
            .from('company_inboxes')
            .select('id, company_id, status')
            .eq('local_part', group.localPart)
            .maybeSingle()
          if (!inbox) continue
          // The active address, or an earlier one a rename kept (crm#1334).
          if (!inboxReceivesMail(inbox.status)) {
            sharedInboxStatus ??= inbox.status
            continue
          }
          // Two receiving addresses of one company (old and new, or one under
          // two tags) file once.
          if (targets.some((t) => t.companyId === inbox.company_id)) continue
          // Sender-declared kind from the +lev / +ver tag. Set only from the
          // addresses that resolved this company: a tag on an unknown or
          // retired shared address must not ride along. Contradicting tags on
          // one mail resolve to no hint.
          const { kindHint, conflict } = resolveKindHintForTags(group.tags)
          const { known, unknownCount } = splitKnownInboxTags(group.tags)
          targets.push({
            companyId: inbox.company_id,
            inboxId: inbox.id,
            tags: known,
            unknownTagCount: unknownCount,
            kindHint,
            tagConflict: conflict,
          })
        }

        // Fan-out cap: the first targets in recipient order are processed,
        // the rest only recorded (below), never downloaded or extracted.
        const deferredTargets = targets.splice(MAX_INBOUND_TARGETS_PER_EMAIL)
        if (deferredTargets.length > 0) {
          console.warn('[invoice-inbox/inbound] Recipient fan-out capped', {
            addressed: targets.length + deferredTargets.length,
            processed: targets.length,
          })
        }

        if (targets.length === 0) {
          // Preserve the pre-custom-domain status semantics: 410 for a
          // deprecated/blocked shared address, 404 otherwise.
          if (sharedInboxStatus && sharedInboxStatus !== 'active') {
            return NextResponse.json({ error: 'Address no longer active' }, { status: 410 })
          }
          console.warn('[invoice-inbox/inbound] No recipient matched', { to, domain })
          return NextResponse.json(
            { error: localPart ? 'Address not found' : 'No matching recipient' },
            { status: 404 }
          )
        }

        const owners = new Map<string, string>()
        for (const target of targets) {
          const { data: company } = await serviceSupabase
            .from('companies')
            .select('created_by')
            .eq('id', target.companyId)
            .single()

          if (!company?.created_by) {
            console.error('[invoice-inbox/inbound] Company has no created_by', target.companyId)
            return NextResponse.json({ error: 'Company owner missing' }, { status: 500 })
          }
          owners.set(target.companyId, company.created_by)
        }

        let fullEmail
        try {
          fullEmail = await fetchReceivingEmail(email_id)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[invoice-inbox/inbound] Failed to fetch received email:', err)
          return NextResponse.json({ error: `Fetch failed: ${message}` }, { status: 500 })
        }

        const bodyText = fullEmail.text ?? null
        const rawAttachments = fullEmail.attachments ?? []

        // Per-email attachment cap. 20 covers any legitimate batched
        // supplier email; an attacker stuffing 500 PDFs into one message
        // gets truncated and a single history event records the drop.
        const totalAttachments = rawAttachments.length
        const attachments = rawAttachments.slice(0, MAX_ATTACHMENTS_PER_EMAIL)
        const truncatedCount = totalAttachments - attachments.length

        // Signature-sized inline images (logos, tracking pixels, mail-client
        // decorations) are never underlag on their own (#2751). Resend lists
        // them as attachments, so a forwarded receipt whose text was the
        // receipt took the attachment path on their account: the logo got
        // filed and extracted, the body was never looked at. They are ignored
        // next to real documents, and the mail is filed by its body when they
        // are all it carries.
        //
        // Inline means the body shows the image, not what its disposition
        // says: Booking.com marks its logos `attachment` and embeds them by
        // content id, which filed each logo and lost the receipt text. The
        // HTML above has those references rewritten to data: URIs (the form
        // the body document embeds), so the references are read from the cid
        // form, fetched only when a small image with a content id is not
        // already inline.
        let embeddedIds = new Set<string>()
        if (attachments.some((att) => !!att.content_id && !isSignatureImage(att) && isSignatureImage({ ...att, embedded: true }))) {
          try {
            embeddedIds = contentIdsReferencedByHtml((await fetchReceivingEmail(email_id, { htmlFormat: 'cid' })).html)
          } catch (err) {
            // The images are then classified by disposition alone: filed as
            // documents the user can discard, never lost.
            console.warn('[invoice-inbox/inbound] cid-form fetch failed:', err)
          }
        }
        const isSignature = (att: (typeof attachments)[number]) =>
          isSignatureImage({ ...att, embedded: embeddedIds.has(normaliseContentId(att.content_id)) })
        const signatureImages = attachments.filter(isSignature)
        const documentAttachments = attachments.filter((att) => !isSignature(att))

        // The body rendering does not depend on the receiving inbox: one mail
        // addressed to several inboxes renders once.
        let bodyUnderlag: Promise<RenderedEmailBodyUnderlag | null> | undefined
        const renderBodyUnderlag = () =>
          (bodyUnderlag ??= renderEmailBodyUnderlag(
            {
              from,
              to,
              subject,
              receivedAt: created_at,
              messageId: message_id,
              html: fullEmail.html,
              text: fullEmail.text,
            },
            // A note next to signature images ("Skickat från min iPhone") is
            // not a receipt; a body with nothing else is archived as before.
            { requireSubstantive: signatureImages.length > 0 },
          ))

        type AttachmentResult = { attachment_id: string; inbox_item_id?: string; error?: string; duplicate?: boolean }
        /**
         * What became of one attachment, for the mail's history event. Codes
         * only: the free-text error and the filename stay out of
         * processing_history (append-only, outside the erasure path).
         * 'ignored' is a signature image, or a text/plain part or a part the
         * mail carries for its own sake (an invite, a mail signature) next to
         * other parts (reason says which): never downloaded, never a row.
         */
        type AttachmentOutcome = {
          id: string
          outcome: 'filed' | 'duplicate' | 'rejected' | 'failed' | 'ignored'
          inbox_item_id?: string
          reason?: string
          mime?: string
          /** The transient error row a redelivery replaced (BFL 5 kap 5 §: the replacement leaves a trace). */
          replaced_item_id?: string
        }
        type TargetOutcome = {
          processed: number
          reason?: string
          inbox_item_id?: string
          results?: AttachmentResult[]
          attachments: AttachmentOutcome[]
        }

        // Per-company rate limit (30/min, 500/day), every inbox before any is
        // processed. Same Postgres-backed RPC as /upload; a refused call takes
        // its increment back, so a redelivery spends no budget.
        const limits = new Map<string, InboxLimitResult>()
        for (const target of targets) {
          limits.set(target.companyId, await checkInboxUploadRateLimit(serviceSupabase, target.companyId))
        }
        // Over the minute cap, a young mail goes back to Resend (429), whose
        // next attempt lands after the window has turned. Dropping it lost 12
        // of 42 receipts an agent forwarded in 20 seconds, with nothing in the
        // Inkorg to show for them (crm#1783). The whole mail goes back, for
        // every inbox, so the redelivery files it once each with one record;
        // nothing is recorded for this attempt. Past the redelivery window,
        // and on the day cap, the mail is dropped and recorded as before.
        const redeliverAfter = [...limits.values()].find(
          (limit) => !limit.ok && limit.scope === 'minute' && mayRedeliverOverMinuteCap(created_at),
        )
        if (redeliverAfter) {
          const retryAfterSec = redeliverAfter.retryAfterSec ?? 60
          console.warn('[invoice-inbox/inbound] Minute cap reached, asking Resend to redeliver', {
            targets: targets.length,
            retryAfterSec,
          })
          return NextResponse.json(
            { error: 'Rate limited', data: { reason: 'rate_limited_redelivery', retry_after: retryAfterSec } },
            { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
          )
        }

        const processForTarget = async (target: InboundTarget): Promise<TargetOutcome> => {
          const { companyId, kindHint } = target
          const userId = owners.get(companyId)!
          const attachmentOutcomes: AttachmentOutcome[] = []

          const limit = limits.get(companyId) ?? { ok: true }
          if (!limit.ok) {
            try {
              await appendProcessingHistory({
                companyId,
                correlationId: email_id,
                aggregateType: 'System',
                aggregateId: email_id,
                eventType: 'RateLimitedDropped',
                // No `from` / `subject`: processing_history is append-only
                // (UPDATE is trigger-blocked) and outside the archive's erasure
                // path, so the sender address and the free-text subject may not
                // land here. correlationId is the Resend email_id, which reaches
                // both through invoice_inbox_items.
                payload: {
                  scope: limit.scope,
                  retry_after_sec: limit.retryAfterSec,
                  attachment_count: rawAttachments.length,
                },
                actor: { type: 'system', id: 'resend-inbound' },
                occurredAt: new Date(),
              })
            } catch (err) {
              console.error('[invoice-inbox/inbound] RateLimitedDropped append failed:', err)
            }
            return { processed: 0, reason: 'rate_limited', attachments: [] }
          }

          if (truncatedCount > 0) {
            try {
              await appendProcessingHistory({
                companyId,
                correlationId: email_id,
                aggregateType: 'System',
                aggregateId: email_id,
                eventType: 'AttachmentsTruncated',
                // Counts only, for the same reason as RateLimitedDropped above.
                payload: {
                  total: totalAttachments,
                  processed: attachments.length,
                  dropped: truncatedCount,
                },
                actor: { type: 'system', id: 'resend-inbound' },
                occurredAt: new Date(),
              })
            } catch (err) {
              console.error('[invoice-inbox/inbound] AttachmentsTruncated append failed:', err)
            }
          }

          const ignoredOutcomes: AttachmentOutcome[] = signatureImages.map((att) => ({
            id: att.id,
            outcome: 'ignored' as const,
            reason: 'signature_image',
            mime: sanitiseMime(att.content_type),
          }))

          // The mail body as its own underlag: rendered to a PDF with the
          // received parts embedded and run through the normal extract
          // pipeline. Null when there is nothing to file (an empty body, a
          // mail-client note next to signature images, a render or upload
          // failure): the caller decides what stays behind then.
          const fileEmailBody = async (): Promise<{ inbox_item_id: string; duplicate: boolean } | null> => {
            let bodyDoc: RenderedEmailBodyUnderlag | null = null
            try {
              bodyDoc = await renderBodyUnderlag()
            } catch (err) {
              console.error('[invoice-inbox/inbound] Email-body rendering failed:', err)
            }
            if (!bodyDoc || bodyDoc.buffer.byteLength > MAX_FILE_SIZE) return null
            // Resend retries the webhook on failure: a retry after success
            // must not duplicate the body document. Body items carry the
            // email_id with a NULL attachment id. Scoped to the company:
            // one mail to two inboxes files once per inbox (#2181).
            // limit(1), not maybeSingle: a NULL attachment id is outside the
            // unique index, so two overlapping deliveries can each file a
            // body, and maybeSingle then errored on every later delivery,
            // read as "none" and filed one more copy each time. A lookup
            // that fails, fails closed: the 500 makes Resend redeliver.
            const { data: existingBodies, error: existingBodyError } = await serviceSupabase
              .from('invoice_inbox_items')
              .select('id')
              .eq('company_id', companyId)
              .eq('resend_email_id', email_id)
              .is('resend_attachment_id', null)
              .limit(1)
            if (existingBodyError) throw new Error(`Body dedupe lookup failed: ${existingBodyError.message}`)
            const existingBody = (existingBodies as Array<{ id: string }> | null)?.[0]
            if (existingBody) return { inbox_item_id: existingBody.id, duplicate: true }
            try {
              const result = await uploadAndExtract(
                serviceSupabase,
                userId,
                companyId,
                bodyDoc,
                'email',
                {
                  from,
                  subject,
                  receivedAt: created_at,
                  messageId: message_id,
                  bodyText,
                  resendEmailId: email_id,
                  kindHint,
                }
              )
              return { inbox_item_id: result.inbox_item_id, duplicate: false }
            } catch (err) {
              console.error('[invoice-inbox/inbound] Email-body document failed:', err)
              return null
            }
          }

          if (documentAttachments.length === 0) {
            // Body-only mail: for app-store, SaaS and travel receipts the body
            // IS the receipt, and often the only underlag the user has. Filed
            // instead of dead-ending in an error row. An empty body, or a
            // mail-client note next to signature images, keeps the error row:
            // there is nothing to archive.
            const body = await fileEmailBody()
            if (body?.duplicate) {
              return { processed: 0, reason: 'email_body_duplicate', inbox_item_id: body.inbox_item_id, attachments: [] }
            }
            if (body) {
              return { processed: 1, reason: 'email_body', inbox_item_id: body.inbox_item_id, attachments: ignoredOutcomes }
            }
            // Fall through to the error row so the mail never vanishes.
            await serviceSupabase.from('invoice_inbox_items').insert({
              company_id: companyId,
              user_id: userId,
              status: 'error',
              source: 'email',
              email_from: from,
              email_subject: subject,
              email_received_at: created_at,
              email_body_text: bodyText,
              resend_email_id: email_id,
              kind_hint: kindHint,
              error_message:
                signatureImages.length > 0
                  ? 'Mejlet innehöll bara signaturbilder och ingen mejltext att spara som underlag'
                  : 'Email had no attachments',
              raw_email_payload: { messageId: message_id },
            })
            return { processed: 0, reason: 'no_attachments', attachments: ignoredOutcomes }
          }

          const results: AttachmentResult[] = []
          attachmentOutcomes.push(...ignoredOutcomes)

          // What one upload became. 'duplicate_delivery' is an overlapping
          // delivery of this mail that filed the attachment first (Resend
          // redelivers while a slow run is still extracting): already
          // received, not a failure, and the rest of the mail goes on.
          // 'duplicate_content' is a file the company already had: it joined
          // that earlier item (often booked long ago) and nothing new was
          // filed, so the mail's history must not say it was (PH 225).
          const recordUpload = (
            attachmentId: string,
            result: { inbox_item_id: string; skip_reason?: string | null },
            replacedItemId?: string,
          ) => {
            const duplicate = result.skip_reason === 'duplicate_delivery' || result.skip_reason === 'duplicate_content'
            results.push({
              attachment_id: attachmentId,
              inbox_item_id: result.inbox_item_id,
              ...(duplicate ? { duplicate: true } : {}),
            })
            attachmentOutcomes.push({
              id: attachmentId,
              outcome: duplicate ? 'duplicate' : 'filed',
              inbox_item_id: result.inbox_item_id,
              ...(result.skip_reason === 'duplicate_content' ? { reason: 'duplicate_content' } : {}),
              ...(replacedItemId ? { replaced_item_id: replacedItemId } : {}),
            })
          }

          // Persist a "rejected" inbox row so the user has visibility into the drop.
          // Without this, attachments that fail MIME validation vanish silently,
          // a common Gmail "forward as attachment" foot-gun until we added .eml
          // handling below.
          const logRejection = async (
            attachmentId: string,
            attachmentName: string | null,
            mime: string,
            reason: string,
            // A catch-path row: the attachment itself was fine, our side
            // failed. A Resend retry may replace it (see the loop below).
            transient = false,
          ): Promise<string | undefined> => {
            // attachment_name and mime are attacker-controlled (they come from the
            // forwarded email headers); sanitise before they land in the JSONB
            // raw_email_payload column so they can't surface as injection or
            // oversized values when read back into the UI / audit trails.
            try {
              const { data: row } = await serviceSupabase
                .from('invoice_inbox_items')
                .insert({
                  company_id: companyId,
                  user_id: userId,
                  status: 'error',
                  source: 'email',
                  email_from: from,
                  email_subject: subject,
                  email_received_at: created_at,
                  email_body_text: bodyText,
                  resend_email_id: email_id,
                  resend_attachment_id: attachmentId,
                  kind_hint: kindHint,
                  error_message: reason.slice(0, 500),
                  raw_email_payload: {
                    messageId: message_id,
                    attachment_name: sanitiseFilename(attachmentName, 'unknown'),
                    mime: sanitiseMime(mime),
                    ...(transient ? { transient: true } : {}),
                  },
                })
                .select('id')
                .maybeSingle()
              return row?.id ?? undefined
            } catch (insertErr) {
              console.error('[invoice-inbox/inbound] Failed to log rejected attachment:', insertErr)
              return undefined
            }
          }

          // A text/plain part next to any other part of the mail is the mail's
          // plain-text alternative (or an ATT00001.txt). The inbox never takes
          // it, and the rejection row it got was one line of noise per
          // forwarded mail (crm#1783). Every other part leaves a row of its
          // own (filed, duplicate, rejected or failed), so the mail stays
          // visible; a text/plain part alone keeps its rejection row.
          const hasNonTextPart = documentAttachments.some((att) => !isPlainTextPart(att.content_type))
          // The same for the parts a mail carries for its own sake (a calendar
          // invite, an S/MIME signature, a contact card): never a document,
          // and next to a part that can be one, their rejection row was a
          // "could not be read" line beside the invoice that was read
          // (crm#1809). That other part leaves a row whatever becomes of it,
          // so the mail stays visible; alone, they keep their rejection row.
          const hasDocumentPart = documentAttachments.some(
            (att) => !isPlainTextPart(att.content_type) && !isMailMachineryPart(att.content_type),
          )

          for (const att of documentAttachments) {
            if (hasNonTextPart && isPlainTextPart(att.content_type)) {
              attachmentOutcomes.push({ id: att.id, outcome: 'ignored', reason: 'text_part', mime: 'text/plain' })
              continue
            }
            if (hasDocumentPart && isMailMachineryPart(att.content_type)) {
              attachmentOutcomes.push({ id: att.id, outcome: 'ignored', reason: 'mail_part', mime: sanitiseMime(baseContentType(att.content_type)) })
              continue
            }
            let replacedItemId: string | undefined
            try {
              // Scoped to the company so one mail to two inboxes files once
              // per inbox rather than treating the second as a retry (#2181).
              const { data: existing } = await serviceSupabase
                .from('invoice_inbox_items')
                .select('id, status, raw_email_payload')
                .eq('company_id', companyId)
                .eq('resend_email_id', email_id)
                .eq('resend_attachment_id', att.id)
                .maybeSingle()
              if (existing) {
                // A row the catch below wrote for a failure on our side
                // (download, storage) is not a filing: a redelivery gets to
                // try again, as it did before the row existed. The row is
                // replaced so the unique key stays free; if the retry fails
                // too, the catch writes a fresh one. Rejections (bad type,
                // too large) and filed rows stay duplicates.
                const transient =
                  existing.status === 'error' &&
                  (existing.raw_email_payload as { transient?: unknown } | null)?.transient === true
                if (!transient) {
                  results.push({ attachment_id: att.id, inbox_item_id: existing.id, duplicate: true })
                  attachmentOutcomes.push({ id: att.id, outcome: 'duplicate', inbox_item_id: existing.id })
                  continue
                }
                await serviceSupabase.from('invoice_inbox_items').delete().eq('id', existing.id)
                replacedItemId = existing.id
              }

              const download = await fetchInboundAttachment(email_id, att.id)

              // Gmail "Forward as attachment" wraps the original email as message/rfc822.
              // Unwrap it and process the inner attachments as if they had arrived
              // directly, carrying the inner email's subject/from into our metadata.
              if (download.contentType === 'message/rfc822') {
                // mailparser loads here, on a forwarded mail, not with every
                // route that loads the extension registry.
                const { simpleParser } = await import('mailparser')
                const parsed = await simpleParser(Buffer.from(download.buffer))
                const innerAttachments = parsed.attachments || []
                const innerFrom = parsed.from?.text || from
                const innerSubject = parsed.subject || subject
                // Same signature-image rule as the outer mail: mailparser
                // lists the forwarded mail's inline logos as attachments too.
                // `related` is mailparser's "embedded in the body" (a part
                // with a content id inside multipart/related), the signal
                // the outer mail reads from the cid references.
                // Ids keep their position in the full list so a redelivery
                // dedupes against the same keys.
                const innerIsSignature = innerAttachments.map((inner) =>
                  isSignatureImage({
                    content_type: inner.contentType,
                    content_disposition: inner.contentDisposition,
                    content_id: inner.contentId,
                    size: inner.size,
                    embedded: inner.related,
                  }),
                )
                const innerSignatureCount = innerIsSignature.filter(Boolean).length
                if (innerSignatureCount === innerAttachments.length) {
                  // Gmail "Forward as attachment" of a body-only receipt: the
                  // forwarded mail's body is the underlag. Same treatment as a
                  // direct body-only mail; empty bodies keep the rejection.
                  for (let i = 0; i < innerAttachments.length; i++) {
                    attachmentOutcomes.push({
                      id: `${att.id}#${i}`,
                      outcome: 'ignored',
                      reason: 'signature_image',
                      mime: sanitiseMime(innerAttachments[i].contentType),
                    })
                  }
                  const innerTo = Array.isArray(parsed.to)
                    ? parsed.to.map((a) => a.text).join(', ')
                    : (parsed.to?.text ?? null)
                  const innerBodyDoc = await renderEmailBodyUnderlag(
                    {
                      from: innerFrom,
                      to: innerTo,
                      subject: innerSubject,
                      receivedAt: parsed.date?.toISOString() ?? created_at,
                      messageId: parsed.messageId ?? message_id,
                      html: typeof parsed.html === 'string' ? parsed.html : null,
                      text: parsed.text ?? null,
                    },
                    { requireSubstantive: innerSignatureCount > 0 },
                  )
                  if (innerBodyDoc && innerBodyDoc.buffer.byteLength <= MAX_FILE_SIZE) {
                    const innerBodyResult = await uploadAndExtract(
                      serviceSupabase,
                      userId,
                      companyId,
                      innerBodyDoc,
                      'email',
                      {
                        from: innerFrom,
                        subject: innerSubject,
                        receivedAt: created_at,
                        messageId: message_id,
                        bodyText,
                        resendEmailId: email_id,
                        resendAttachmentId: att.id,
                        kindHint,
                      }
                    )
                    recordUpload(att.id, innerBodyResult)
                    continue
                  }
                  const rejectedId = await logRejection(att.id, download.filename, download.contentType, 'Det vidarebefordrade meddelandet innehöll inga bilagor')
                  results.push({ attachment_id: att.id, error: 'eml_no_inner_attachments' })
                  attachmentOutcomes.push({ id: att.id, outcome: 'rejected', reason: 'eml_no_inner_attachments', inbox_item_id: rejectedId })
                  continue
                }
                // The parts are filed under their own ids (att#i), never under
                // the .eml's, so the redelivery check above cannot see them.
                // Without this a redelivery extracted every part again, the
                // first one already filed hit the unique index, and the rest
                // of the .eml was skipped behind a false error row. A failed
                // lookup only costs that check: the index still holds.
                const innerPartIds = innerAttachments.flatMap((_, i) => (innerIsSignature[i] ? [] : [`${att.id}#${i}`]))
                const filedParts = new Map<string, string>()
                if (innerPartIds.length > 0) {
                  const { data: partRows } = await serviceSupabase
                    .from('invoice_inbox_items')
                    .select('id, resend_attachment_id')
                    .eq('company_id', companyId)
                    .eq('resend_email_id', email_id)
                    .in('resend_attachment_id', innerPartIds)
                  for (const row of (partRows as Array<{ id: string; resend_attachment_id: string }> | null) ?? []) {
                    filedParts.set(row.resend_attachment_id, row.id)
                  }
                }
                // Same text/plain rule as the outer mail, among the forwarded
                // mail's own parts.
                const innerHasNonTextPart = innerAttachments.some(
                  (inner, i) => !innerIsSignature[i] && !isPlainTextPart(inner.contentType),
                )
                const innerHasDocumentPart = innerAttachments.some(
                  (inner, i) =>
                    !innerIsSignature[i] && !isPlainTextPart(inner.contentType) && !isMailMachineryPart(inner.contentType),
                )
                for (let i = 0; i < innerAttachments.length; i++) {
                  const inner = innerAttachments[i]
                  const innerType = sanitiseMime(inner.contentType)
                  const innerName = sanitiseFilename(inner.filename, `attachment-${i}`)
                  const innerBuffer = inner.content
                  if (!innerBuffer) continue
                  const innerId = `${att.id}#${i}`
                  if (innerIsSignature[i]) {
                    attachmentOutcomes.push({ id: innerId, outcome: 'ignored', reason: 'signature_image', mime: innerType })
                    continue
                  }
                  if (innerHasNonTextPart && isPlainTextPart(inner.contentType)) {
                    attachmentOutcomes.push({ id: innerId, outcome: 'ignored', reason: 'text_part', mime: 'text/plain' })
                    continue
                  }
                  if (innerHasDocumentPart && isMailMachineryPart(inner.contentType)) {
                    attachmentOutcomes.push({ id: innerId, outcome: 'ignored', reason: 'mail_part', mime: sanitiseMime(baseContentType(inner.contentType)) })
                    continue
                  }
                  const filedPartId = filedParts.get(innerId)
                  if (filedPartId) {
                    results.push({ attachment_id: innerId, inbox_item_id: filedPartId, duplicate: true })
                    attachmentOutcomes.push({ id: innerId, outcome: 'duplicate', inbox_item_id: filedPartId })
                    continue
                  }
                  if (!EMAIL_ALLOWED_MIME_TYPES.has(innerType)) {
                    const rejectedId = await logRejection(innerId, innerName, innerType, `Avvisad bilaga från vidarebefordrat mejl: filtypen ${innerType} stöds inte`)
                    results.push({ attachment_id: innerId, error: `Unsupported type ${innerType}` })
                    attachmentOutcomes.push({ id: innerId, outcome: 'rejected', reason: 'unsupported_type', mime: innerType, inbox_item_id: rejectedId })
                    continue
                  }
                  if (innerBuffer.byteLength > MAX_FILE_SIZE) {
                    const rejectedId = await logRejection(innerId, innerName, innerType, 'Bilagan i det vidarebefordrade mejlet är för stor')
                    results.push({ attachment_id: innerId, error: 'Inner attachment too large' })
                    attachmentOutcomes.push({ id: innerId, outcome: 'rejected', reason: 'too_large', inbox_item_id: rejectedId })
                    continue
                  }
                  const innerArrayBuffer =
                    innerType === 'text/html'
                      ? ensureHtmlDocument(innerBuffer.toString('utf8'))
                      : new Uint8Array(innerBuffer).buffer
                  const innerResult = await uploadAndExtract(
                    serviceSupabase,
                    userId,
                    companyId,
                    { name: innerName, buffer: innerArrayBuffer, type: innerType },
                    'email',
                    {
                      from: innerFrom,
                      subject: innerSubject,
                      receivedAt: created_at,
                      messageId: message_id,
                      bodyText,
                      resendEmailId: email_id,
                      resendAttachmentId: innerId,
                      kindHint,
                    }
                  )
                  recordUpload(innerId, innerResult)
                }
                continue
              }

              if (!EMAIL_ALLOWED_MIME_TYPES.has(download.contentType)) {
                const rejectedId = await logRejection(att.id, download.filename, download.contentType, `Avvisad: filtypen ${download.contentType} stöds inte`)
                results.push({ attachment_id: att.id, error: `Unsupported type ${download.contentType}` })
                attachmentOutcomes.push({ id: att.id, outcome: 'rejected', reason: 'unsupported_type', mime: sanitiseMime(download.contentType), inbox_item_id: rejectedId })
                continue
              }
              if (download.buffer.byteLength > MAX_FILE_SIZE) {
                const rejectedId = await logRejection(att.id, download.filename, download.contentType, 'Bilagan är för stor')
                results.push({ attachment_id: att.id, error: 'Attachment too large' })
                attachmentOutcomes.push({ id: att.id, outcome: 'rejected', reason: 'too_large', inbox_item_id: rejectedId })
                continue
              }

              // Attached .html invoices are often fragments; wrap them into a
              // self-contained document so the archive holds a renderable file.
              const attachmentBuffer =
                download.contentType === 'text/html'
                  ? ensureHtmlDocument(Buffer.from(download.buffer).toString('utf8'))
                  : download.buffer

              const result = await uploadAndExtract(
                serviceSupabase,
                userId,
                companyId,
                { name: download.filename, buffer: attachmentBuffer, type: download.contentType },
                'email',
                {
                  from,
                  subject,
                  receivedAt: created_at,
                  messageId: message_id,
                  bodyText,
                  resendEmailId: email_id,
                  resendAttachmentId: att.id,
                  kindHint,
                }
              )
              recordUpload(att.id, result, replacedItemId)
            } catch (err) {
              console.error('[invoice-inbox/inbound] Attachment processing failed:', err)
              const message = err instanceof Error ? err.message : 'Unknown error'
              results.push({ attachment_id: att.id, error: message })
              // The failure used to leave nothing behind: the webhook answered
              // 200, Resend never retried, and the attachment was gone (#2181,
              // the reporter's second PDF). An error row keeps it in the inbox
              // where the user can see it and send it again. Skipped when the
              // upload got as far as its own row before throwing.
              let failedItemId: string | undefined
              try {
                const { data: partial } = await serviceSupabase
                  .from('invoice_inbox_items')
                  .select('id')
                  .eq('company_id', companyId)
                  .eq('resend_email_id', email_id)
                  .eq('resend_attachment_id', att.id)
                  .maybeSingle()
                failedItemId = partial?.id ?? undefined
              } catch {
                failedItemId = undefined
              }
              if (!failedItemId) {
                failedItemId = await logRejection(
                  att.id,
                  att.filename ?? null,
                  att.content_type ?? 'application/octet-stream',
                  `Bilagan kunde inte tas emot: ${message.slice(0, 200)}. Skicka den igen.`,
                  true,
                )
              }
              attachmentOutcomes.push({
                id: att.id,
                outcome: 'failed',
                inbox_item_id: failedItemId,
                ...(replacedItemId ? { replaced_item_id: replacedItemId } : {}),
              })
            }
          }

          // Every attachment was refused (a calendar invite, a type outside
          // the allowlist, too large) and none was filed: the body is then
          // filed the way a body-only mail is. A booking confirmation whose
          // only attachment was an .ics left an error row and no document
          // at all, though its body was the receipt (agent feedback seq
          // 957595). Only for a substantive body, so a "see attached" note
          // next to a refused file does not become a document, and not when
          // an attachment failed on our side: that one is the likelier
          // receipt and its error row asks for it again. Filing the body next
          // to attachments that WERE filed is a separate design call.
          const onlyRefused = attachmentOutcomes.every((o) => o.outcome === 'rejected' || o.outcome === 'ignored')
          if (onlyRefused && isSubstantiveBody(emailBodyToText(fullEmail.html, fullEmail.text))) {
            const body = await fileEmailBody()
            if (body) {
              return {
                processed: results.length + (body.duplicate ? 0 : 1),
                reason: body.duplicate ? 'email_body_duplicate' : 'email_body',
                inbox_item_id: body.inbox_item_id,
                results,
                attachments: attachmentOutcomes,
              }
            }
          }

          return { processed: results.length, results, attachments: attachmentOutcomes }
        }

        const outcomes: Array<{ target: InboundTarget; outcome: TargetOutcome }> = []
        for (const target of targets) {
          const outcome = await processForTarget(target)
          outcomes.push({ target, outcome })
          // One durable record per mail and inbox, whatever became of it
          // (#2181): the inbox list only shows rows that were filed, so a
          // mail whose every attachment failed had no trace a user could
          // find. Ids and a closed vocabulary only: no sender, no subject,
          // no address (the local part of an enskild firma's inbox is the
          // owner's name) and no sender-typed tag. processing_history is
          // append-only and outside the erasure path, and the PII validator
          // in appendProcessingHistory would refuse a numeric tag outright,
          // losing the one record this exists to keep. The panel derives
          // the address from inbox_id at read time.
          try {
            await appendProcessingHistory({
              companyId: target.companyId,
              correlationId: email_id,
              aggregateType: 'System',
              aggregateId: email_id,
              eventType: 'InboundMailReceived',
              payload: {
                inbox_id: target.inboxId,
                tags: target.tags,
                unknown_tag_count: target.unknownTagCount,
                kind_hint: target.kindHint,
                tag_conflict: target.tagConflict,
                outcome: outcome.reason ?? 'attachments',
                attachment_count: totalAttachments,
                inbox_item_id: outcome.inbox_item_id ?? null,
                attachments: outcome.attachments,
              },
              actor: { type: 'system', id: 'resend-inbound' },
              occurredAt: new Date(),
            })
          } catch (err) {
            console.error('[invoice-inbox/inbound] InboundMailReceived append failed:', err)
          }
        }

        for (const target of deferredTargets) {
          try {
            await appendProcessingHistory({
              companyId: target.companyId,
              correlationId: email_id,
              aggregateType: 'System',
              aggregateId: email_id,
              eventType: 'InboundMailReceived',
              payload: {
                inbox_id: target.inboxId,
                tags: target.tags,
                unknown_tag_count: target.unknownTagCount,
                kind_hint: target.kindHint,
                tag_conflict: target.tagConflict,
                outcome: 'fan_out_capped',
                attachment_count: totalAttachments,
                inbox_item_id: null,
                attachments: [],
              },
              actor: { type: 'system', id: 'resend-inbound' },
              occurredAt: new Date(),
            })
          } catch (err) {
            console.error('[invoice-inbox/inbound] InboundMailReceived (capped) append failed:', err)
          }
        }

        // The mail itself, per company that took it in: sender, text,
        // headers and the whole .eml. After the filing so what it produced is
        // known; best effort, it never changes the answer below.
        await recordInboundMailArrivals(serviceSupabase, {
          email: fullEmail,
          event: { email_id, from, to, subject, message_id, created_at },
          targets: outcomes.map(({ target, outcome }) => ({
            companyId: target.companyId,
            inboxId: target.inboxId,
            tags: target.tags,
            reason: outcome.reason,
            inbox_item_id: outcome.inbox_item_id,
            attachments: outcome.attachments,
          })),
        })

        if (outcomes.length === 1 && deferredTargets.length === 0) {
          const { processed, reason, inbox_item_id, results } = outcomes[0].outcome
          return NextResponse.json({
            data: {
              processed,
              ...(reason ? { reason } : {}),
              ...(inbox_item_id ? { inbox_item_id } : {}),
              ...(results ? { results } : {}),
            },
          })
        }
        return NextResponse.json({
          data: {
            processed: outcomes.reduce((sum, o) => sum + o.outcome.processed, 0),
            targets: outcomes.map(({ target, outcome }) => ({
              company_id: target.companyId,
              processed: outcome.processed,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
              ...(outcome.inbox_item_id ? { inbox_item_id: outcome.inbox_item_id } : {}),
              ...(outcome.results ? { results: outcome.results } : {}),
            })),
            ...(deferredTargets.length > 0
              ? { deferred: deferredTargets.map((t) => ({ company_id: t.companyId, reason: 'fan_out_capped' })) }
              : {}),
          },
        })
      },
    },

    // ── Received-mail history (#2181) ─────────────────────────
    // One row per mail and inbox from the InboundMailReceived events the
    // webhook appends, so a user can tell "never arrived" from "arrived
    // and was rejected" or "arrived and is hidden by a filter". Sender and
    // subject are not in the payload (see the webhook); the filed item ids
    // are, which is what the panel links to.
    {
      method: 'GET',
      path: '/inbound-history',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const rawDays = url.searchParams.get('days')
        const days = rawDays === null ? INBOUND_HISTORY_DEFAULT_DAYS : Number(rawDays)
        if (!Number.isInteger(days) || days < 1 || days > INBOUND_HISTORY_MAX_DAYS) {
          return NextResponse.json(
            { error: `days must be an integer between 1 and ${INBOUND_HISTORY_MAX_DAYS}` },
            { status: 400 }
          )
        }
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

        const { data, error } = await ctx.supabase
          .from('processing_history')
          .select('event_id, correlation_id, occurred_at, payload')
          .eq('company_id', ctx.companyId)
          .eq('event_type', 'InboundMailReceived')
          .gte('occurred_at', since)
          .order('occurred_at', { ascending: false })
          // One past the cap: the extra row only says whether older mail in
          // the window was cut off, so the panel can say so.
          .limit(INBOUND_HISTORY_LIMIT + 1)

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        const hasMore = (data ?? []).length > INBOUND_HISTORY_LIMIT
        const page = (data ?? []).slice(0, INBOUND_HISTORY_LIMIT)

        // The event stores inbox_id only (no address, see the webhook); the
        // company's own addresses are resolved here, for its own members.
        const inboxes = new Map<string, { local_part: string; status: string }>()
        if (page.length > 0) {
          const { data: rows } = await ctx.supabase
            .from('company_inboxes')
            .select('id, local_part, status')
            .eq('company_id', ctx.companyId)
          for (const row of rows ?? []) inboxes.set(row.id, { local_part: row.local_part, status: row.status })
        }

        return NextResponse.json({
          data: {
            days,
            has_more: hasMore,
            mails: page.map((row) => {
              const payload = row.payload as Record<string, unknown>
              const inbox = typeof payload.inbox_id === 'string' ? inboxes.get(payload.inbox_id) : undefined
              return {
                event_id: row.event_id,
                email_id: row.correlation_id,
                occurred_at: row.occurred_at,
                ...payload,
                inbox_local_part: inbox?.local_part ?? null,
                inbox_status: inbox?.status ?? null,
              }
            }),
          },
        })
      },
    },

    // ── Delete inbox item ──────────────────────────────────
    // Rules in lib/documents/inbox-item-actions.ts (v1: inbox-items.delete).
    {
      method: 'DELETE',
      path: '/items/:id',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const outcome = await deleteInboxItem(operationContext(ctx), id)
        if (!outcome.ok) return sessionFailureResponse(outcome, extensionLog, ctx.requestId ?? '')
        if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
        return NextResponse.json({ data: { id, deleted: true } })
      },
    },

    // ── Convert inbox item to supplier invoice ─────────────
    // Rules in lib/operations/inbox-convert.ts, shared with the v1 operation
    // inbox-items.convert-to-supplier-invoice.
    {
      method: 'POST',
      path: '/items/:id/convert',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        let body: ReturnType<typeof CreateSupplierInvoiceSchema.parse>
        try {
          const json = await request.json()
          body = CreateSupplierInvoiceSchema.parse(json)
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid request body'
          return NextResponse.json({ error: message }, { status: 400 })
        }

        const outcome = await convertInboxItemToSupplierInvoice(operationContext(ctx), id, body, {
          emit: (event) => ctx.emit(event),
        })
        if (!outcome.ok) return sessionFailureResponse(outcome, extensionLog, ctx.requestId ?? '')
        if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
        return NextResponse.json({
          data: {
            ...outcome.data.invoice,
            items: outcome.data.items,
            registration_journal_entry_id: outcome.data.registration_journal_entry_id,
            inbox_item_id: outcome.data.inbox_item_id,
          },
          // A non-blocking note, e.g. bank details the supplier card lacks (lib/payments/payee-alerts.ts).
          ...(outcome.warnings?.length ? { warnings: outcome.warnings.map((w) => ({ code: w.code, message: w.message_sv })) } : {}),
        })
      },
    },

    // ── Book inbox item directly as a manual journal entry ─
    // For kontantmetoden users (and ad-hoc receipts): bypasses the
    // supplier-invoice flow entirely. Optionally links to a bank
    // transaction; otherwise produces a standalone verifikation
    // (e.g. private outlay, cash receipt). The source document is
    // attached to the new entry per BFL 5 kap. 6§.
    {
      method: 'POST',
      path: '/items/:id/book-direct',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        let body: z.infer<typeof BookInboxItemDirectlySchema>
        try {
          const json = await request.json()
          body = BookInboxItemDirectlySchema.parse(json)
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Invalid request body' },
            { status: 400 }
          )
        }

        // Rules in lib/operations/inbox-book-direct.ts, shared with the
        // Inkorg's one click (POST /api/inkorg/items/:id/book).
        const outcome = await bookInboxItemDirectly(
          { ...operationContext(ctx), requestId: ctx.requestId },
          id,
          body,
        )
        if (!outcome.ok) return outcome.response

        return NextResponse.json({
          data: {
            journal_entry: outcome.journalEntry,
            inbox_item_id: id,
            transaction_id: outcome.transactionId,
          },
        })
      },
    },

    // ── Bulk-book selected inbox items (Modell B) ─────────────
    // "Bokför valda" in the Underlag selection bar. Each selected item is
    // booked against its matched bank transaction (which already carries the
    // SEK amount) using one shared category + VAT treatment: individual
    // verifikat, not a samlingsverifikation. Unmatched / already-booked /
    // supplier-invoice-linked items are skipped, not errored, so the batch is
    // resilient. Reuses the same categorize core as the single-item agent flow,
    // so reverse-charge moms on foreign services is handled correctly.
    {
      method: 'POST',
      path: '/items/bulk-book',
      handler: async (request: Request, ctx: ExtensionContext) => {
        let body: z.infer<typeof BulkBookInboxSchema>
        try {
          const json = await request.json()
          body = BulkBookInboxSchema.parse(json)
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Invalid request body' },
            { status: 400 }
          )
        }

        const { booked, skipped } = await bulkBookMatchedInboxItems(
          ctx.supabase,
          ctx.userId,
          ctx.companyId,
          body,
        )

        return NextResponse.json({
          data: {
            booked_count: booked.length,
            skipped_count: skipped.length,
            booked,
            skipped,
          },
        })
      },
    },

    // ── What this underlag would be booked as ─────────────────────
    //
    // Read-only. Nothing here writes, and nothing here is authoritative: the
    // answer is a suggestion the user approves, edits or ignores, and the
    // actual posting still goes through book-direct → the posting port.
    //
    // Derived on demand rather than stored on the row, so it cannot go stale
    // against a corrected amount, a re-matched transaction or a template the
    // company taught itself yesterday. The receipt hunt deliberately does not
    // compute it: the nightly run is already at its time ceiling, and a
    // proposal nobody opens is wasted work.
    //
    // The lines come from buildTransactionEntryLines, the same function the
    // commit path and the pending-operations preview use, so what is shown
    // here cannot drift from what gets posted.
    {
      method: 'POST',
      path: '/items/:id/suggest-booking',
      // Computes a proposal from reads only; nothing is written.
      viewerMay: true,
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        // A dropped `error` here would report a missing column or a lagging
        // migration as "Posten hittades inte", pointing the user at their
        // document instead of at the database.
        const { data: item, error: itemError } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, matched_transaction_id, created_journal_entry_id, created_supplier_invoice_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (itemError) {
          ctx.log.error('suggest-booking: inbox lookup failed', { itemId: id, error: itemError.message })
          return NextResponse.json({ error: 'Kunde inte läsa posten' }, { status: 500 })
        }
        if (!item) return NextResponse.json({ error: 'Posten hittades inte' }, { status: 404 })

        // Already resolved: there is nothing left to propose, and showing a
        // suggestion beside a posted verifikat invites double-booking.
        if (item.created_journal_entry_id || item.created_supplier_invoice_id) {
          return NextResponse.json({
            data: { source: 'already_booked' as const, lines: [], confidence: null },
          })
        }

        if (!item.matched_transaction_id) {
          // Without a transaction there is no amount we trust, no settlement
          // account and no learned counterparty. The honest answer is that we
          // cannot propose one yet; the UI asks the user to match first.
          return NextResponse.json({
            data: { source: 'no_transaction' as const, lines: [], confidence: null },
          })
        }

        // The transaction is queried explicitly by company even though RLS
        // would narrow it: service-role paths have none, and the filter is the
        // defense-in-depth this repo mandates.
        const { data: tx, error: txError } = await ctx.supabase
          .from('transactions')
          .select('*')
          .eq('id', item.matched_transaction_id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (txError) {
          ctx.log.error('suggest-booking: transaction lookup failed', {
            itemId: id,
            error: txError.message,
          })
          return NextResponse.json({ error: 'Kunde inte läsa transaktionen' }, { status: 500 })
        }
        if (!tx) {
          return NextResponse.json({ error: 'Transaktionen hittades inte' }, { status: 404 })
        }

        // The inbox row is not the only way a purchase gets booked. Booking the
        // bank line from Transaktioner, from bulk-book or over MCP stamps the
        // transaction and leaves invoice_inbox_items.created_journal_entry_id
        // null, so trusting the inbox row alone proposes a second verifikat for
        // money that already has one.
        if ((tx as Transaction).journal_entry_id) {
          return NextResponse.json({
            data: { source: 'already_booked' as const, lines: [], confidence: null },
          })
        }

        // Everything an empty proposal can still say about the matched bank
        // row: the amount in kronor and the day the money moved. Without it
        // the manual-booking dialog opened with nothing at all (the regression
        // behind "beloppet följer inte med längre"), which on a foreign
        // invoice left the user with no kronor figure anywhere.
        const txSekSigned = resolveSekAmountOrNull(
          (tx as Transaction).amount,
          (tx as Transaction).amount_sek,
          (tx as Transaction).currency,
          (tx as Transaction).exchange_rate,
        )
        const txSummary =
          txSekSigned != null
            ? {
                amount_sek: roundOre(txSekSigned),
                date: (tx as Transaction).date,
              }
            : null
        const emptyProposalExtras = (settlementAccount: string) => ({
          entry_date: (tx as Transaction).date,
          transaction: txSummary,
          fallback_lines: buildFallbackKonteringLines(tx as Transaction, settlementAccount),
        })

        try {
          const { data: settings } = await ctx.supabase
            .from('company_settings')
            .select('entity_type, vat_registered')
            .eq('company_id', ctx.companyId)
            .maybeSingle()
          // Resolved, never defaulted: a guessed form proposes the wrong
          // owner account (2013 vs 2893 vs 2890) and the wrong course
          // account (6991 vs 7610).
          const entityType: EntityType = await resolveCompanyEntityType(
            ctx.supabase,
            ctx.companyId,
            settings?.entity_type,
          )

          const settlementAccount = await resolveSettlementAccount(
            ctx.supabase,
            ctx.companyId,
            (tx as Transaction).cash_account_id,
            createLogger('invoice-inbox.suggest-booking'),
            (tx as Transaction).currency,
          )
          // evaluateMappingRules applies the settlement account itself on every
          // return path. Applying it again rewrote a legitimate 1930 leg, which
          // on an own-account transfer collapsed both sides onto one account.
          // A non-registered company is proposed no moms line either
          // (lib/bookkeeping/vat-registration.ts); the flag is passed as loaded.
          const mapping = await evaluateMappingRules(
            ctx.supabase,
            ctx.companyId,
            tx as Transaction,
            entityType,
            settlementAccount,
            settings?.vat_registered ?? null,
          )

          // getDefaultResult is the engine's way of saying it has nothing: a
          // 6991 placeholder at confidence 0.1. Rendering that as a proposal
          // dresses "no idea" up as an answer, so it is reported as no_mapping,
          // which is what the empty branch was always meant to cover.
          const isPlaceholder =
            !mapping.rule && !mapping.template_id && mapping.confidence <= 0.1
          if (isPlaceholder || !mapping.debit_account || !mapping.credit_account) {
            return NextResponse.json({
              data: {
                source: 'no_mapping' as const,
                lines: [],
                confidence: mapping.confidence ?? null,
                ...emptyProposalExtras(settlementAccount),
              },
            })
          }

          // mapping-engine's rule branch computes VAT from the transaction's own
          // currency while every other line is built in SEK (see the NOTE at
          // buildResult). On a non-SEK row that understates ingående moms by the
          // exchange rate: 100 EUR at 11.5 shows 20 kr of moms instead of 230.
          // The entry still balances, so nothing downstream catches it. Until
          // that is fixed in the engine, this surface does not render it: a
          // wrong number one click from the ledger is worse than no number.
          const sekAmount = (tx as Transaction).amount_sek
          const isForeign =
            (tx as Transaction).currency !== 'SEK' &&
            sekAmount != null &&
            Math.abs(sekAmount) !== Math.abs((tx as Transaction).amount)
          if (mapping.rule && isForeign) {
            ctx.log.info('suggest-booking: withheld a rule-branch proposal on a foreign-currency row', {
              itemId: id,
              currency: (tx as Transaction).currency,
            })
            return NextResponse.json({
              data: {
                source: 'currency_unsupported' as const,
                lines: [],
                confidence: null,
                ...emptyProposalExtras(settlementAccount),
              },
            })
          }

          // A line's bag is part of what would be posted: a multi-line
          // template tags its business lines one by one, which the
          // top-level `dimensions` below cannot express.
          const lines = buildTransactionEntryLines(tx as Transaction, mapping).map((l) => ({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            description: l.line_description ?? '',
            ...(l.dimensions ? { dimensions: l.dimensions } : {}),
          }))

          return NextResponse.json({
            data: {
              // template_id marks a static library template; a learned
              // counterparty template sets neither field. Reading it the other
              // way round labelled the konteringskarta's most trusted match
              // 'default', the same word the 6991 placeholder gets.
              source: mapping.rule
                ? ('mapping_rule' as const)
                : mapping.template_id
                  ? ('booking_template' as const)
                  : ('counterparty_template' as const),
              lines,
              // Everything below is what the "Varför så här?" fold reads. It
              // already existed on MappingResult and nothing rendered it.
              confidence: mapping.confidence,
              requires_review: mapping.requires_review,
              direction_mismatch: mapping.direction_mismatch ?? false,
              risk_level: mapping.risk_level,
              description: mapping.description,
              rule_name: mapping.rule?.rule_name ?? null,
              template_id: mapping.template_id ?? null,
              dimensions: mapping.dimensions ?? null,
              // The day the money moved, not the day printed on the document:
              // it is what decides the period the entry lands in.
              entry_date: (tx as Transaction).date,
            },
          })
        } catch (err) {
          ctx.log.warn('suggest-booking failed', {
            itemId: id,
            error: err instanceof Error ? err.message : String(err),
          })
          // A suggestion that cannot be produced is not an error the user did
          // anything about: fall back to the empty proposal and let them book
          // by hand. The settlement account may be what threw, so the skeleton
          // uses the 1930 default rather than the resolved account here.
          return NextResponse.json({
            data: {
              source: 'no_mapping' as const,
              lines: [],
              confidence: null,
              ...emptyProposalExtras('1930'),
            },
          })
        }
      },
    },

    // ── Purchases still missing their underlag ────────────────────
    //
    // The page has always listed documents, so a purchase with no document at
    // all could not appear on it. That is exactly the gap the receipt hunt
    // exists to close, and the half a user can act on: fetch the invoice from
    // the supplier's portal, or ask whoever made the purchase.
    //
    // Read-only. The predicate is shared with the hunt so the page and the
    // nightly run cannot disagree about what "missing its receipt" means.
    {
      method: 'GET',
      path: '/purchases',
      handler: async (_request: Request, ctx: ExtensionContext) => {
        try {
          const [purchases, companyPortals] = await Promise.all([
            fetchPurchasesWithoutUnderlag(ctx.supabase, ctx.companyId),
            readCompanyPortals(ctx.supabase, ctx.companyId),
          ])
          const logos = await vendorLogoUrls(
            purchases.map((p) => ({ key: p.id, name: p.merchant_name || p.description, texts: [p.description] })),
          )

          return NextResponse.json({
            data: {
              count: purchases.length,
              purchases: purchases.map((p) => {
                // Where the invoice lives, when the supplier does not send one:
                // the company's own portal for the supplier first, then the
                // directory. Null for salary and tax, which have no invoice to
                // fetch: a link there would be worse than silence.
                const portal = resolvePortal(companyPortals, p.merchant_name || p.description)
                return {
                  id: p.id,
                  date: p.date,
                  description: p.description,
                  merchant_name: p.merchant_name,
                  amount: p.amount,
                  currency: p.currency,
                  amount_sek: p.amount_sek,
                  portal,
                  logo_url: logos.get(p.id) ?? null,
                }
              }),
            },
          })
        } catch (err) {
          ctx.log.error('purchases lookup failed', {
            error: err instanceof Error ? err.message : String(err),
          })
          return NextResponse.json({ error: 'Kunde inte hämta köpen' }, { status: 500 })
        }
      },
    },
  ],
}

// Re-export the extraction shape for tests / consumers.
export type { InvoiceExtractionResult }
