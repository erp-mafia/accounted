import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { routeClassifiedDocument } from './lib/route-from-arkiv'
import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import type { EventPayload } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
const extensionLog = createLogger('invoice-inbox')
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { NextResponse } from 'next/server'
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
import { emailBodyToText, isSignatureImage, isSubstantiveBody, renderEmailBodyUnderlag } from './lib/email-body-underlag'
import type { RenderedEmailBodyUnderlag } from './lib/email-body-underlag'
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
  ResendSignatureError,
} from './lib/resend-inbound'
import {
  rotateCompanyInbox,
  getActiveInbox,
  composeInboxAddress,
} from './lib/inbox-provisioning'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { assertTransactionBookable } from '@/lib/transactions/is-booked'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { roundOre } from '@/lib/money'
import { bookDirectDocumentCurrency, bookDirectFxRefusal } from '@/lib/bookkeeping/book-direct-prefill'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
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
import { fetchPurchasesWithoutUnderlag } from '@/lib/transactions/purchases-without-underlag'
import { sessionFailureResponse } from '@/lib/operations/session'
import { matchInboxItemTransaction } from '@/lib/documents/inbox-match'
import type { OperationContext } from '@/lib/operations/types'
import {
  deleteInboxItem,
  resolveInboxBookedState,
  unmatchInboxItemTransaction,
  updateInboxItemFields,
  UpdateInboxItemFieldsSchema,
  type UpdateInboxItemFieldsInput,
} from '@/lib/documents/inbox-item-actions'
import { convertInboxItemToSupplierInvoice } from '@/lib/documents/inbox-convert'
import { resolveInboxKind, type InboxKindSource } from '@/lib/documents/inbox-kind'
import { resolveInboxCreditTarget } from '@/lib/supplier-invoices/credit-target'
import { lookupPortal } from '@/lib/receipt-hunt/portal-directory'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import type { InboxChannelContext, InvoiceExtractionResult } from '@/types'
import { recordInboxDecision, snapshotInboxExtraction } from '@/lib/suggestion-log/inbox'
import { bookedTotals } from '@/lib/suggestion-log/inbox-classify'
import { finalFromLines, linesOf, recordDecisions, snapshotSuggestions } from '@/lib/suggestion-log/record'

const MAX_ATTACHMENTS_PER_EMAIL = 20
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

// Claim body for POST /inbox/domain. Length-capped only: real validation
// (punycode, hostname shape, blocklist) lives in normalizeInboundDomain /
// validateClaimableDomain so the same rules apply to every caller.
const ClaimDomainSchema = z.object({
  domain: z.string().trim().min(1).max(255),
})

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

  eventHandlers: [
    {
      // Arkiv said what a document is: queue a receipt or invoice that came in another way, release what is not booked
      // from here, and carry a person's type onto the item already queued.
      eventType: 'document.classified',
      handler: async (payload: EventPayload<'document.classified'>) => {
        try {
          const outcome = await routeClassifiedDocument(createServiceClientNoCookies(), {
            documentId: payload.document.id,
            companyId: payload.companyId,
            userId: payload.userId,
            docType: payload.docType,
            admission: payload.admission,
            decidedBy: payload.decidedBy,
          })
          if (outcome === 'queued' || outcome === 'requeued' || outcome === 'retyped' || outcome === 'routed_to_arkiv') {
            extensionLog.info('routed classified document', { doc: payload.document.id, docType: payload.docType, outcome })
          }
        } catch (err) {
          extensionLog.warn('routing classified document failed', { doc: payload.document.id, reason: err instanceof Error ? err.message : String(err) })
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
              routed_to_arkiv_at, routed_doc_type
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
        type ItemRow = {
          id: string
          document_id: string | null
          matched_transaction_id: string | null
          created_journal_entry_id: string | null
          created_supplier_invoice_id: string | null
          extracted_data: Record<string, unknown> | null
          extraction_skipped: boolean | null
        }
        const rows = (data ?? []) as ItemRow[]
        const bookedState = await resolveInboxBookedState(ctx.supabase, ctx.companyId, rows)
        const items = rows.map((r) => ({
          ...r,
          matched_transaction_journal_entry_id: bookedState.get(r.id)?.journalEntryId ?? null,
          underlag_status: bookedState.get(r.id)?.underlag ?? null,
        }))

        // A receipt dropped into Dokument is routed here the moment the
        // classifier types it, before its reading has landed: the item was
        // created with none and stayed "Inte AI-tolkad" although the document
        // row got the reading seconds later (prod 2026-09-24). The document's
        // own reading stands in for the item's.
        const unread = items.filter((i) => i.extracted_data == null && i.document_id).map((i) => i.document_id as string)
        if (unread.length > 0) {
          // In slices: the list is no longer capped, so the id list is not either.
          const docs: Array<{ id: string; extracted_data: Record<string, unknown> | null }> = []
          for (const ids of chunk(unread, 200)) {
            const { data: part, error: docsError } = await ctx.supabase.from('document_attachments').select('id, extracted_data').in('id', ids)
            if (docsError) return NextResponse.json({ error: docsError.message }, { status: 500 })
            docs.push(...((part ?? []) as typeof docs))
          }
          const readingOf = new Map(
            docs.filter((d) => d.extracted_data).map((d) => [d.id, d.extracted_data]),
          )
          for (const item of items) {
            if (item.extracted_data == null && item.document_id && readingOf.has(item.document_id)) {
              item.extracted_data = readingOf.get(item.document_id) ?? null
              item.extraction_skipped = false
            }
          }
        }

        // arkiv_section: whether the Dokument section is open for this company, so the
        // "routed to the archive" line links there only when the link leads somewhere.
        return NextResponse.json({ data: { items, count: items.length, arkiv_section: isArkivSectionEnabled(ctx.companyId) } })
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

        const { data, error } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('*')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .single()

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

        // Same enrichment as the list: the detail rail must not offer to
        // book a matched transaction that is already booked.
        const row = data as {
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

        // Same stand-in as the list: the document's reading when the item has none.
        if (row.extracted_data == null && row.document_id) {
          const { data: doc } = await ctx.supabase.from('document_attachments').select('id, extracted_data').eq('id', row.document_id).maybeSingle()
          const reading = (doc as { extracted_data?: Record<string, unknown> | null } | null)?.extracted_data ?? null
          if (reading) {
            row.extracted_data = reading
            row.extraction_skipped = false
          }
        }

        return NextResponse.json({
          data: {
            ...row,
            matched_transaction_journal_entry_id: matchedTransactionJournalEntryId,
            underlag_status: underlagStatus,
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

        let body: { transaction_id?: string }
        try {
          body = await request.json()
        } catch {
          return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
        }
        if (!body.transaction_id || typeof body.transaction_id !== 'string') {
          return NextResponse.json({ error: 'transaction_id required' }, { status: 400 })
        }

        const outcome = await matchInboxItemTransaction(operationContext(ctx), id, body.transaction_id)
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
          .select('id, document_id, correlation_id, created_supplier_invoice_id')
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
          })
          const { data: extracted } = extraction

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
          return NextResponse.json({
            data: {
              address: composeInboxAddress(inbox.local_part, domain),
              local_part: inbox.local_part,
              status: inbox.status,
              created_at: inbox.created_at,
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
    {
      method: 'POST',
      path: '/inbox/rotate',
      handler: async (_request: Request, ctx: ExtensionContext) => {
        const domain = process.env.RESEND_INBOUND_DOMAIN
        if (!domain) {
          return NextResponse.json({ error: 'RESEND_INBOUND_DOMAIN not configured' }, { status: 503 })
        }

        const isAdmin = await isCompanyAdmin(ctx.supabase, ctx.userId, ctx.companyId)
        if (!isAdmin) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

        try {
          const newInbox = await rotateCompanyInbox(ctx.supabase, ctx.companyId)
          return NextResponse.json({
            data: {
              address: composeInboxAddress(newInbox.local_part, domain),
              local_part: newInbox.local_part,
              status: newInbox.status,
            },
          })
        } catch (err) {
          console.error('[invoice-inbox/inbox/rotate] Failed:', err)
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Rotation failed' },
            { status: 500 }
          )
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
          if (inbox.status !== 'active') {
            sharedInboxStatus ??= inbox.status
            continue
          }
          // Two active addresses of one company file once.
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
        const signatureImages = attachments.filter((att) => isSignatureImage(att))
        const documentAttachments = attachments.filter((att) => !isSignatureImage(att))

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
         * 'ignored' is a signature image: never downloaded, never a row.
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

        const processForTarget = async (target: InboundTarget): Promise<TargetOutcome> => {
          const { companyId, kindHint } = target
          const userId = owners.get(companyId)!
          const attachmentOutcomes: AttachmentOutcome[] = []

          // Per-company rate limit (30/min, 500/day). Same Postgres-backed
          // RPC as /upload. Acknowledge + drop on cap: returning 429 to
          // Resend would just consume more budget via their retry.
          const limit = await checkInboxUploadRateLimit(serviceSupabase, companyId)
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
            const { data: existingBody } = await serviceSupabase
              .from('invoice_inbox_items')
              .select('id')
              .eq('company_id', companyId)
              .eq('resend_email_id', email_id)
              .is('resend_attachment_id', null)
              .maybeSingle()
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

          for (const att of documentAttachments) {
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
                // Ids keep their position in the full list so a redelivery
                // dedupes against the same keys.
                const innerIsSignature = innerAttachments.map((inner) =>
                  isSignatureImage({
                    content_type: inner.contentType,
                    content_disposition: inner.contentDisposition,
                    content_id: inner.contentId,
                    size: inner.size,
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
                    results.push({ attachment_id: att.id, inbox_item_id: innerBodyResult.inbox_item_id })
                    attachmentOutcomes.push({ id: att.id, outcome: 'filed', inbox_item_id: innerBodyResult.inbox_item_id })
                    continue
                  }
                  const rejectedId = await logRejection(att.id, download.filename, download.contentType, 'Det vidarebefordrade meddelandet innehöll inga bilagor')
                  results.push({ attachment_id: att.id, error: 'eml_no_inner_attachments' })
                  attachmentOutcomes.push({ id: att.id, outcome: 'rejected', reason: 'eml_no_inner_attachments', inbox_item_id: rejectedId })
                  continue
                }
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
                  results.push({ attachment_id: innerId, inbox_item_id: innerResult.inbox_item_id })
                  attachmentOutcomes.push({ id: innerId, outcome: 'filed', inbox_item_id: innerResult.inbox_item_id })
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
              results.push({ attachment_id: att.id, inbox_item_id: result.inbox_item_id })
              attachmentOutcomes.push({
                id: att.id,
                outcome: 'filed',
                inbox_item_id: result.inbox_item_id,
                ...(replacedItemId ? { replaced_item_id: replacedItemId } : {}),
              })
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
    // Rules in lib/documents/inbox-convert.ts, shared with the v1 operation
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

        const { data: item, error: fetchError } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, document_id, status, created_supplier_invoice_id, created_journal_entry_id, matched_transaction_id, correlation_id, channel_context, extracted_data')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (fetchError) {
          // Surface the real DB error instead of masking as 404. Common cause:
          // the migration adding `created_journal_entry_id` hasn't been
          // applied to this database (e.g. local dev DB lagging staging).
          console.error('[invoice-inbox/book-direct] Item lookup failed:', fetchError)
          return NextResponse.json(
            { error: `Kunde inte slå upp posten: ${fetchError.message}` },
            { status: 500 }
          )
        }
        if (!item) {
          return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 })
        }
        if (item.created_supplier_invoice_id) {
          return NextResponse.json(
            { error: 'Posten är redan kopplad till en leverantörsfaktura.' },
            { status: 409 }
          )
        }
        if (item.created_journal_entry_id) {
          return NextResponse.json(
            { error: 'Posten är redan bokförd.' },
            { status: 409 }
          )
        }

        // If a transaction is provided, validate it before booking.
        let transaction: Pick<Transaction, 'id' | 'journal_entry_id' | 'cash_account_id' | 'date' | 'amount' | 'currency' | 'amount_sek' | 'exchange_rate'> | null = null
        const sourceTransactionId = body.transaction_id ?? item.matched_transaction_id
        if (sourceTransactionId) {
          const { data: tx, error: txError } = await ctx.supabase
            .from('transactions')
            .select('id, journal_entry_id, cash_account_id, date, amount, currency, amount_sek, exchange_rate, transaction_voucher_links(journal_entry_id, role)')
            .eq('id', sourceTransactionId)
            .eq('company_id', ctx.companyId)
            .maybeSingle()
          if (txError || !tx) {
            return NextResponse.json({ error: 'Transaktion hittades inte' }, { status: 404 })
          }
          // The booking doors' shared answer: the pointer OR a bank_line voucher
          // link naming a posted verifikat (a bulk-booked or split row has a
          // NULL pointer). A stale pointer at a reversed verifikat does not
          // block; the locked link below replaces exactly that observed value.
          const bookable = await assertTransactionBookable(ctx.supabase, ctx.companyId, tx)
          if (!bookable.ok) {
            return errorResponseFromCode(bookable.code, ctx.log, {
              requestId: ctx.requestId,
              details: { journal_entry_id: bookable.journalEntryId, via: bookable.via },
            })
          }
          transaction = tx
        }

        // A foreign-currency underlag has no kronor amount of its own, and the
        // lines arrive as bare numbers the engine stores as SEK: a receipt for
        // 100 EUR used to post as 100 kr (crm#1146). Kronor typed by hand are a
        // real booking (a receipt somebody paid privately has no bank row), so
        // only that signature is refused: a line carrying the document's
        // foreign total as its kronor amount. Same rule the dialog reads, from
        // the same module; nothing is converted here.
        const documentCurrency = bookDirectDocumentCurrency(item.extracted_data)
        const fxRefusal = bookDirectFxRefusal(item.extracted_data, transaction, body.lines)
        if (fxRefusal === 'bank_row_without_sek') {
          return errorResponseFromCode('TX_MISSING_SEK_VALUE', ctx.log, {
            requestId: ctx.requestId,
            details: { currency: documentCurrency, transaction_id: transaction?.id ?? null },
          })
        }
        if (fxRefusal === 'face_amount') {
          return errorResponseFromCode('INBOX_BOOK_DIRECT_FX_FACE_AMOUNT', ctx.log, {
            requestId: ctx.requestId,
            details: { currency: documentCurrency },
            messageSv: `Beloppen är underlagets belopp i ${documentCurrency}, inte kronor. Ange beloppen i kronor, eller välj banktransaktionen som betalade underlaget. Är valutan fel rättar du den på underlaget.`,
            messageEn: `The amounts are the document's amounts in ${documentCurrency}, not SEK. Enter the amounts in SEK, or pick the bank transaction that paid the document. If the currency is wrong, correct it on the document.`,
          })
        }

        // WhatsApp-sourced items: when the request carries NO notes field at
        // all, default to the rendered chat context (representation deltagare
        // + syfte, sender note) so the audit text reaches the verifikat even
        // through clients that never saw the chat (MCP, older UI).
        //
        // Presence decides, not truthiness: `notes: ""` is the UI saying the
        // user emptied the field, and resurrecting the prefill there would
        // write text onto an immutable verifikat against an explicit user
        // action (removable only via rättelse). So an empty string clears,
        // and only an absent field defaults. The caption is excluded: this
        // path can run without a human ever seeing the string.
        const effectiveNotes =
          body.notes === undefined
            ? renderChannelContextNotes(
                (item as { channel_context?: InboxChannelContext | null }).channel_context,
              ) ?? undefined
            : body.notes.trim() || undefined

        // What was on offer, taken before booking: the model's reading of
        // the underlag, and the bank line's suggestions when one is booked.
        const extractionSnapshot = await snapshotInboxExtraction(ctx.supabase, ctx.companyId, item)
        const settledTransactionId = transaction?.id ?? item.matched_transaction_id ?? null
        const bankSnapshot = settledTransactionId
          ? await snapshotSuggestions(ctx.supabase, ctx.companyId, [settledTransactionId])
          : null

        // Create the journal entry via the engine. Source-tracks back to
        // the inbox item so the audit trail is preserved even when no
        // transaction is involved.
        let journalEntry
        try {
          journalEntry = await createJournalEntry(ctx.supabase, ctx.companyId, ctx.userId, {
            fiscal_period_id: body.fiscal_period_id,
            entry_date: body.entry_date,
            description: body.description,
            source_type: body.transaction_id ? 'bank_transaction' : 'inbox_item',
            source_id: body.transaction_id ? transaction!.id : item.id,
            ...(transaction ? { bank_booking_context: [bankBookingContext(transaction,
              await resolveSettlementAccount(ctx.supabase, ctx.companyId, transaction.cash_account_id,
                createLogger('invoice-inbox.book-direct'), transaction.currency),
            )] } : {}),
            notes: effectiveNotes,
            lines: body.lines,
          })
        } catch (err) {
          const typed = bookkeepingErrorResponse(err)
          if (typed) return typed
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Kunde inte skapa verifikation' },
            { status: 400 }
          )
        }

        // The transaction this verifikat settles: the one the caller named, or
        // the one the item was already matched to. Preserving the match without
        // booking it was half a fix, and the worse half: the item then looked
        // resolved while the bank line stayed open forever. Both are read and
        // checked above, so `transaction` is set whenever there is one.
        const bookedTransactionId = transaction?.id ?? null

        if (transaction) {
          // CAS on the pointer value read above (NULL, or a stale pointer at a
          // reversed verifikat), like the manual book route: a concurrent
          // booking that changed it wins. The losing verifikat is posted and
          // immutable, so it is reversed through the storno service.
          const linkQuery = ctx.supabase
            .from('transactions')
            .update({
              journal_entry_id: journalEntry.id,
              is_business: true,
              category: 'uncategorized',
            })
            .eq('id', transaction.id)
            .eq('company_id', ctx.companyId)
          const { data: linkedRows, error: txUpdateError } = await (transaction.journal_entry_id
            ? linkQuery.eq('journal_entry_id', transaction.journal_entry_id)
            : linkQuery.is('journal_entry_id', null)
          ).select('id')

          if (txUpdateError || !linkedRows || linkedRows.length === 0) {
            await reverseOrphanedJournalEntry(
              ctx.supabase,
              ctx.companyId,
              ctx.userId,
              journalEntry.id,
              'Bokföringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
            )
            if (txUpdateError) return errorResponse(txUpdateError, ctx.log, { requestId: ctx.requestId })
            return errorResponseFromCode('TX_CATEGORIZE_RACE', ctx.log, { requestId: ctx.requestId })
          }
        }

        // Link the source document to the new entry. Best-effort: the
        // entry itself is already posted; surfacing the failure shouldn't
        // roll it back, but log so support can re-link manually.
        if (item.document_id) {
          try {
            await linkToJournalEntry(
              ctx.supabase,
              ctx.companyId,
              item.document_id,
              journalEntry.id
            )
          } catch (err) {
            console.error('[invoice-inbox/book-direct] Document link failed:', err)
          }
        }

        // Mark the inbox item as resolved by writing the FK. The status
        // column is intentionally left at 'received': terminal state is
        // encoded via created_journal_entry_id / matched_transaction_id
        // (see migration 20260504180000_invoice_inbox_remove_ai_columns).
        const { error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({
            created_journal_entry_id: journalEntry.id,
            // Keep the existing match when the caller sent no transaction_id.
            // Overwriting with null let a caller that merely forgot the field
            // silently unpick a match somebody had already made, and left the
            // bank line unbooked with nothing on screen saying so.
            matched_transaction_id: bookedTransactionId,
          })
          .eq('id', id)
          .eq('company_id', ctx.companyId)
        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }

        const postedLines = linesOf(journalEntry)
        await recordInboxDecision(ctx.supabase, extractionSnapshot, {
          journal_entry_id: journalEntry.id,
          fields: bookedTotals(postedLines),
          lines: postedLines,
        }, ctx.userId)
        if (bankSnapshot && bookedTransactionId) {
          await recordDecisions(ctx.supabase, bankSnapshot, [{
            transactionId: bookedTransactionId,
            final: finalFromLines(journalEntry.id, postedLines),
          }], ctx.userId)
        }

        // The engine already emits journal_entry.committed: no need to
        // re-emit. Transaction categorization is implicit: the entry is
        // already source-linked to the transaction via source_type.

        return NextResponse.json({
          data: {
            journal_entry: journalEntry,
            inbox_item_id: id,
            transaction_id: transaction?.id ?? null,
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
    // actual posting still goes through book-direct → createJournalEntry.
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
          const purchases = await fetchPurchasesWithoutUnderlag(ctx.supabase, ctx.companyId)

          return NextResponse.json({
            data: {
              count: purchases.length,
              purchases: purchases.map((p) => {
                // Where the invoice lives, when the supplier does not send one.
                // lookupPortal answers null for salary and tax, which have no
                // invoice to fetch: a link there would be worse than silence.
                const portal = lookupPortal(p.merchant_name || p.description)
                return {
                  id: p.id,
                  date: p.date,
                  description: p.description,
                  merchant_name: p.merchant_name,
                  amount: p.amount,
                  currency: p.currency,
                  amount_sek: p.amount_sek,
                  portal: portal ? { vendor: portal.vendor, url: portal.url, note: portal.note ?? null } : null,
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
