import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { z } from 'zod'
import {
  uploadDocument,
  createPendingDocumentUpload,
  completePendingDocumentUpload,
} from '@/lib/core/documents/document-service'
import { createServiceClient } from '@/lib/supabase/server'
import { validateBody } from '@/lib/api/validate'
import { hasErrorEntry } from '@/lib/errors/structured-errors'
import { dbError } from '@/lib/errors/db-error'
import { matchSupplierId } from '@/lib/suppliers/match-supplier'
import { extractInvoiceFields, ExtractionSchema, emptyResult, fetchOwnCompanyIdentity } from './lib/extract-invoice-fields'
import { mirrorExtractionToDocument } from './lib/mirror-extraction'
import {
  uploadAndExtract,
  processArchivedDocument,
  sanitiseFilename,
  sanitiseMime,
  isSandboxCompany,
  countPdfPages,
  slicePdfForExtraction,
  MAX_FILE_SIZE,
  maxPagesForAutoExtract,
  UPLOAD_ALLOWED_MIME_TYPES,
  EMAIL_ALLOWED_MIME_TYPES,
  ensureHtmlDocument,
  buildEmailBodyHtmlDocument,
} from './lib/upload-and-extract'
import {
  verifyInboundWebhook,
  fetchReceivingEmail,
  fetchInboundAttachment,
  extractSharedRecipientsForDomain,
  groupSharedRecipientsByInbox,
  resolveKindHintForTags,
  splitKnownInboxTags,
  type InboxKindHint,
  parseRecipients,
  isEmailReceivedEvent,
  ResendSignatureError,
} from './lib/resend-inbound'
import {
  rotateCompanyInbox,
  getActiveInbox,
  composeInboxAddress,
} from './lib/inbox-provisioning'
import {
  claimCustomDomain,
  checkCustomDomainVerification,
  removeCustomDomain,
  getCustomDomain,
  findCompanyForRecipientDomains,
  applyDomainStatusFromWebhook,
} from './lib/custom-domains'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { createSchedulesForSupplierInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { suggestBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  resolveSupplierInvoiceExchangeRate,
  supplierInvoiceSekAmounts,
} from '@/lib/currency/supplier-invoice-rate'
import { roundOre } from '@/lib/money'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
import { CreateSupplierInvoiceSchema, BookInboxItemDirectlySchema, BulkBookInboxSchema } from '@/lib/api/schemas'
import { bulkBookMatchedInboxItems } from '@/lib/transactions/categorize-core'
import {
  completeInboxItemsForBookedTransaction,
  resolveBookedJournalEntryIds,
  resolveUnderlagAnchoring,
  type UnderlagAnchoring,
} from '@/lib/transactions/inbox-underlag'

/**
 * Per-item underlag status on the wire (#1548): the anchoring verdict, or
 * 'unknown' when the document row could not be read. Absence is never
 * reported as anchored; the UI keeps 'unknown' out of the booked bucket.
 */
type UnderlagStatus = UnderlagAnchoring | 'unknown'
import { hasCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { evaluateMappingRules } from '@/lib/bookkeeping/mapping-engine'
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import { buildFallbackKonteringLines } from './lib/fallback-kontering'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import type { Transaction, EntityType } from '@/types'
import { createLogger } from '@/lib/logger'
import { fetchPurchasesWithoutUnderlag } from '@/lib/transactions/purchases-without-underlag'
import { lookupPortal } from '@/lib/receipt-hunt/portal-directory'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import { simpleParser } from 'mailparser'
import type { InboxChannelContext, InvoiceExtractionResult, InvoiceInboxItem, SupplierInvoice, SupplierInvoiceItem } from '@/types'

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
// clients fits; beyond that the rest is dropped with a log line.
const MAX_INBOUND_TARGETS_PER_EMAIL = 5

// Partial-update schema for the /items/:id/fields PATCH route. Only the
// scalar fields the UI exposes for inline editing: line items and
// vatBreakdown stay AI-managed for now and are preserved by the merge.
const NullableString = z.string().trim().max(500).nullable()
const NullableDate = z
  .string()
  .regex(
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
    'Invalid date: expected YYYY-MM-DD'
  )
  // Catch impossible calendar dates like 2026-02-30 that pass the regex.
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid calendar date')
  .nullable()
const NullableNumber = z.number().nullable()

const UpdateExtractedDataSchema = z.object({
  supplier: z
    .object({
      name: NullableString,
      orgNumber: NullableString,
      vatNumber: NullableString,
      address: NullableString,
      bankgiro: NullableString,
      plusgiro: NullableString,
    })
    .partial()
    .optional(),
  invoice: z
    .object({
      invoiceNumber: NullableString,
      invoiceDate: NullableDate,
      dueDate: NullableDate,
      paymentReference: NullableString,
      // ISO 4217: three uppercase letters. We accept the user's edit only
      // if it looks like a real currency code; loose strings would otherwise
      // flow into the supplier-invoice-creation step and produce a faktura
      // with an invalid currency (cf. ML 17 kap 24§ p.9).
      currency: z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO 4217 code'),
    })
    .partial()
    .optional(),
  totals: z
    .object({
      subtotal: NullableNumber,
      vatAmount: NullableNumber,
      total: NullableNumber,
    })
    .partial()
    .optional(),
})

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
  matched_transaction_id: z.string().uuid().nullable().optional(),
  skip_extraction: z.boolean().optional(),
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

// Custom inbound domains are fully built but deliberately not exposed,
// product decision 2026-07-02: the default is the Fortnox-style shared
// address (+ user-side forwarding); own-domain inbound waits for real demand.
// Flip INBOX_CUSTOM_DOMAINS_ENABLED=true to re-enable the /inbox/domain
// routes. The globe entry point in InvoiceInboxWorkspace was removed at the
// same time. Restore it when re-enabling.
const customDomainsEnabled = () => process.env.INBOX_CUSTOM_DOMAINS_ENABLED === 'true'

const customDomainsDisabledResponse = () =>
  NextResponse.json(
    { error: 'Egen domän är inte tillgänglig.', code: 'FEATURE_DISABLED' },
    { status: 403 }
  )

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

  apiRoutes: [
    // ── Manual upload ───────────────────────────────────────
    {
      method: 'POST',
      path: '/upload',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
        const matchedTransactionIdRaw = formData.get('matched_transaction_id')
        const matchedTransactionId =
          typeof matchedTransactionIdRaw === 'string' && matchedTransactionIdRaw.length > 0
            ? matchedTransactionIdRaw
            : null
        // Opt-out of the built-in Claude/Bedrock OCR. Agents with their own
        // extraction pipeline upload the document, get the inbox row, then
        // PUT /items/:id/extracted-data with their parsed fields.
        const skipExtraction =
          formData.get('skip_extraction') === 'true' ||
          formData.get('skip_extraction') === '1'

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

        // Validate matched_transaction_id belongs to this company before we
        // spend the AI extraction budget. RLS would also catch a mismatch on
        // the insert, but failing fast gives a clearer error and lets the
        // caller distinguish "your context_ref pointed at a tx you don't own"
        // from a generic upload failure.
        if (matchedTransactionId) {
          const { data: tx, error: txErr } = await ctx.supabase
            .from('transactions')
            .select('id')
            .eq('id', matchedTransactionId)
            .eq('company_id', ctx.companyId)
            .maybeSingle()
          if (txErr) {
            return NextResponse.json({ error: txErr.message }, { status: 500 })
          }
          if (!tx) {
            return errorResponseFromCode('INBOX_UPLOAD_TX_NOT_IN_COMPANY', ctx.log)
          }
        }

        try {
          const buffer = await file.arrayBuffer()
          // Staged upload: the row lands as 'processing' and the response
          // returns before Bedrock runs; the deferred worker (or the sweep
          // cron) flips it to 'received'. Only this web route defers: email
          // and WhatsApp ingestion already run in background contexts and
          // consume the returned item synchronously. When skipExtraction is
          // set the call stays synchronous (see uploadAndExtract).
          const result = await uploadAndExtract(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            { name: file.name, buffer, type: file.type },
            'upload',
            undefined,
            matchedTransactionId,
            { skipExtraction, deferExtraction: true },
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
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const parsed = await validateBody(request, CompleteSignedUploadSchema)
        if (!parsed.success) return parsed.response
        const { upload_id: uploadId, file_name: fileName, mime_type: mimeType } = parsed.data
        const matchedTransactionId = parsed.data.matched_transaction_id ?? null
        const skipExtraction = parsed.data.skip_extraction === true

        // The declared type drives the magic-byte check on completion, so
        // it is gated exactly like the multipart route's file.type.
        if (!UPLOAD_ALLOWED_MIME_TYPES.has(mimeType)) {
          return errorResponseFromCode('INBOX_UPLOAD_UNSUPPORTED_TYPE', ctx.log, {
            requestId: ctx.requestId,
            messageSv: `Filtypen stöds inte: ${mimeType}. Tillåtna format: PDF, JPEG, PNG, HEIC och WebP.`,
            messageEn: `Unsupported file type: ${mimeType}. Allowed: PDF, JPEG, PNG, HEIC, WebP.`,
          })
        }

        // Same ownership check as /upload: fail fast with a clear code
        // rather than letting RLS reject the insert after extraction.
        if (matchedTransactionId) {
          const { data: tx, error: txErr } = await ctx.supabase
            .from('transactions')
            .select('id')
            .eq('id', matchedTransactionId)
            .eq('company_id', ctx.companyId)
            .maybeSingle()
          if (txErr) {
            return errorResponse(txErr, ctx.log, { requestId: ctx.requestId })
          }
          if (!tx) {
            return errorResponseFromCode('INBOX_UPLOAD_TX_NOT_IN_COMPANY', ctx.log, {
              requestId: ctx.requestId,
            })
          }
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
            matchedTransactionId,
            { skipExtraction, deferExtraction: true },
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
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const status = url.searchParams.get('status')
        // Cap raised from 50 → 500: the inbox is a workqueue and booked items
        // now drop out of the default view client-side, so a low cap silently
        // hid active underlag behind older booked ones. 500 covers realistic
        // single-company volumes; pagination is the next step beyond that.
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 50), 500)

        let query = ctx.supabase
          .from('invoice_inbox_items')
          .select(`
            id, status, source, created_at, extracted_data,
            matched_supplier_id, document_id, email_from, email_subject,
            email_received_at, email_body_text, error_message,
            created_supplier_invoice_id,
            matched_transaction_id, created_journal_entry_id,
            resend_email_id, extraction_skipped, channel_context, kind_hint
          `)
          .eq('company_id', ctx.companyId)
          .order('created_at', { ascending: false })
          .limit(limit)

        if (status) query = query.eq('status', status)

        const { data, error } = await query
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        // Enrich matched-but-unstamped items with the verifikat that anchors
        // their transaction, when it is already booked. The stamp
        // (created_journal_entry_id) is UNIQUE per verifikat, so on a
        // samlingsverifikat only one of N items can carry it: deriving
        // "booked" from the transaction's own state is what lets the rest
        // leave the active inbox (2026-08-12 report: booked items stuck in
        // "Att göra" pointing at a transaction no longer in the work list).
        type ItemRow = {
          id: string
          document_id: string | null
          matched_transaction_id: string | null
          created_journal_entry_id: string | null
          created_supplier_invoice_id: string | null
        }
        const rows = (data ?? []) as ItemRow[]
        const unresolved = rows.filter(
          (r) =>
            r.matched_transaction_id &&
            !r.created_journal_entry_id &&
            !r.created_supplier_invoice_id,
        )
        const unresolvedTxIds = Array.from(
          new Set(unresolved.map((r) => r.matched_transaction_id as string)),
        )
        const bookedByTx = await resolveBookedJournalEntryIds(
          ctx.supabase,
          ctx.companyId,
          unresolvedTxIds,
        )
        // Per-item honesty (#1548): the transaction being booked says a
        // verifikat exists, not that THIS item's underlag reached it. A
        // document whose link failed, or that is anchored to another
        // verifikat, must keep the item in "Att göra" instead of reading as
        // booked on the transaction's word alone.
        const anchoring = await resolveUnderlagAnchoring(
          ctx.supabase,
          ctx.companyId,
          unresolved
            .filter((r) => bookedByTx.has(r.matched_transaction_id as string))
            .map((r) => ({
              id: r.id,
              document_id: r.document_id,
              journalEntryId: bookedByTx.get(r.matched_transaction_id as string) as string,
            })),
        )
        const items = rows.map((r) => {
          const derivedEntryId = r.matched_transaction_id
            ? bookedByTx.get(r.matched_transaction_id) ?? null
            : null
          // Absent from the anchoring map means the document row could not
          // be read: 'unknown', which the UI treats like a divergent item
          // (stays in Att göra, no booking bridge). Never booked on a guess.
          // Only unstamped items were sent to the anchoring read; a stamped
          // sibling is booked by its own column and gets no verdict here.
          const unstamped = !r.created_journal_entry_id && !r.created_supplier_invoice_id
          const underlagStatus: UnderlagStatus | null =
            derivedEntryId && unstamped ? anchoring.get(r.id)?.status ?? 'unknown' : null
          return {
            ...r,
            matched_transaction_journal_entry_id: derivedEntryId,
            underlag_status: underlagStatus,
          }
        })

        return NextResponse.json({ data: { items, count: items.length } })
      },
    },

    // ── Get processing_history timeline for an inbox item ───
    {
      method: 'GET',
      path: '/items/:id/history',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, correlation_id, company_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        if (!item.correlation_id) {
          return NextResponse.json({ data: { events: [] } })
        }

        const { data: events, error } = await ctx.supabase
          .from('processing_history')
          .select('event_id, event_type, occurred_at, payload, actor, causation_id')
          .eq('company_id', ctx.companyId)
          .eq('correlation_id', item.correlation_id)
          .order('occurred_at', { ascending: true })
          .limit(100)

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({ data: { events: events ?? [] } })
      },
    },

    // ── Get single inbox item ───────────────────────────────
    {
      method: 'GET',
      path: '/items/:id',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
        }
        let matchedTransactionJournalEntryId: string | null = null
        let underlagStatus: UnderlagStatus | null = null
        if (
          row.matched_transaction_id &&
          !row.created_journal_entry_id &&
          !row.created_supplier_invoice_id
        ) {
          const bookedByTx = await resolveBookedJournalEntryIds(ctx.supabase, ctx.companyId, [
            row.matched_transaction_id,
          ])
          matchedTransactionJournalEntryId = bookedByTx.get(row.matched_transaction_id) ?? null
          if (matchedTransactionJournalEntryId) {
            const anchoring = await resolveUnderlagAnchoring(ctx.supabase, ctx.companyId, [
              {
                id: row.id,
                document_id: row.document_id,
                journalEntryId: matchedTransactionJournalEntryId,
              },
            ])
            underlagStatus = anchoring.get(row.id)?.status ?? 'unknown'
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
    {
      method: 'PATCH',
      path: '/items/:id/fields',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        let body: z.infer<typeof UpdateExtractedDataSchema>
        try {
          const json = await request.json()
          body = UpdateExtractedDataSchema.parse(json)
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Invalid request body' },
            { status: 400 }
          )
        }

        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, extracted_data, created_supplier_invoice_id, updated_at')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        if (item.created_supplier_invoice_id) {
          return NextResponse.json(
            { error: 'Posten är redan kopplad till en leverantörsfaktura och kan inte ändras.' },
            { status: 409 }
          )
        }

        // Merge user edits into existing extracted_data so we don't lose
        // line items, vatBreakdown, or AI-confidence on partial updates.
        //
        // The spread of `current` is load-bearing and must come first. Naming
        // the surviving keys one by one, as this did, silently destroyed every
        // field the list happened not to mention: documentKind,
        // merchantCategory, legibility, purchaseTime, payment and
        // suggestedTemplateId were all wiped the first time somebody corrected
        // a single field by hand. The classification is not recoverable
        // afterwards without re-running extraction, and nothing surfaced the
        // loss. Spreading means anything added to InvoiceExtractionResult later
        // survives by default instead of waiting to be noticed missing.
        const current = (item.extracted_data ?? {}) as InvoiceExtractionResult
        const merged: InvoiceExtractionResult = {
          ...current,
          supplier: { ...current.supplier, ...body.supplier },
          invoice: { ...current.invoice, ...body.invoice },
          totals: { ...current.totals, ...body.totals },
          lineItems: current.lineItems ?? [],
          vatBreakdown: current.vatBreakdown ?? [],
          confidence: current.confidence ?? 0,
        }
        // A human touching TOTALT settles it: the value stops being a
        // promoted prominent amount (totalSource 'prominent', fallback-grade
        // in matching) and becomes a user-verified total at full weight.
        if (body.totals && 'total' in body.totals) {
          merged.totalSource = null
        }

        // Optimistic concurrency on the row's trigger-maintained updated_at:
        // this handler is read-merge-write over the whole jsonb blob, so a
        // write racing another autosave would silently restore the loser's
        // stale copy of every field it did not touch: including a
        // totalSource: 'prominent' stamp a concurrent TOTALT edit had just
        // cleared. Zero rows updated means the row moved under us; the client
        // gets a 409 and its next debounced save re-reads and re-applies.
        const { data: updated, error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({ extracted_data: merged as unknown as Record<string, unknown> })
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .eq('updated_at', (item as { updated_at: string }).updated_at)
          .select('id, extracted_data')
          .maybeSingle()

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }
        if (!updated) {
          return NextResponse.json(
            { error: 'Posten ändrades samtidigt av någon annan. Försök igen.' },
            { status: 409 }
          )
        }

        return NextResponse.json({ data: updated })
      },
    },

    // ── Replace extracted_data wholesale (BYO extraction) ────
    // Used by agents that ran their own OCR/extraction pipeline. Validates
    // the full InvoiceExtractionResult shape via the same Zod schema that
    // gates Bedrock output, so downstream consumers (UI, supplier-invoice
    // creation) cannot tell apart agent-supplied from AI-extracted data.
    {
      method: 'PUT',
      path: '/items/:id/extracted-data',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        // Rate-limit BYO extraction the same way fresh uploads are limited:
        // both paths inject extracted_data into invoice_inbox_items, so an
        // unbounded BYO loop is the same abuse surface as an upload flood
        // (ISO 27001 A.8.12, data-injection guard).
        const rl = await checkInboxUploadRateLimit(ctx.supabase, ctx.companyId)
        if (!rl.ok) {
          return NextResponse.json(
            { error: `För många förfrågningar, försök igen om en stund.` },
            {
              status: 429,
              headers: rl.retryAfterSec ? { 'Retry-After': String(rl.retryAfterSec) } : undefined,
            }
          )
        }

        let extracted: InvoiceExtractionResult
        try {
          const json = await request.json()
          // ExtractionSchema doesn't include `confidence` (the AI path tacks
          // it on after parsing). BYO data gets 0.95 so downstream UI can
          // distinguish it from a perfect AI parse: financial-data
          // provenance per ISO 27001 A.8.12.
          const parsed = ExtractionSchema.parse(json)
          extracted = { ...parsed, confidence: 0.95 }
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Invalid extracted_data shape' },
            { status: 400 }
          )
        }

        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, company_id, created_supplier_invoice_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        // Explicit tenant boundary assertion alongside the .eq filter
        // (V4.5.1 defense-in-depth). Surfaces any future change that
        // accidentally bypasses the where-clause.
        if (item.company_id !== ctx.companyId) {
          return NextResponse.json({ error: 'Not found' }, { status: 404 })
        }
        if (item.created_supplier_invoice_id) {
          return NextResponse.json(
            { error: 'Posten är redan kopplad till en leverantörsfaktura och kan inte ändras.' },
            { status: 409 }
          )
        }

        // Re-run supplier match so the agent's parsed fields trigger the
        // same auto-link the AI path uses. Skipped if no key is present.
        const matchedSupplierId = await matchSupplierId(
          ctx.supabase,
          ctx.companyId,
          extracted.supplier,
        )

        const { data: updated, error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({
            extracted_data: extracted as unknown as Record<string, unknown>,
            matched_supplier_id: matchedSupplierId,
          })
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .select('id, extracted_data, matched_supplier_id')
          .single()

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }

        // Audit the BYO override so financial-data provenance is traceable
        // (GDPR Art. 5(1)(f), SOC 2 CC9.2). Failure logged but never blocks
        // the response: the override has already happened.
        try {
          await appendProcessingHistory({
            companyId: ctx.companyId,
            correlationId: id,
            aggregateType: 'Document',
            aggregateId: id,
            eventType: 'DocumentExtractionOverridden',
            payload: {
              inbox_item_id: id,
              channel: 'rest_api',
              has_supplier_org_number: extracted.supplier.orgNumber != null,
              has_invoice_number: extracted.invoice.invoiceNumber != null,
              extracted_total: extracted.totals.total,
              matched_supplier_id: matchedSupplierId,
            },
            actor: { type: 'user', id: ctx.userId },
            occurredAt: new Date(),
          })
        } catch (auditErr) {
          console.error('[invoice-inbox] Failed to append DocumentExtractionOverridden:', auditErr)
        }

        return NextResponse.json({ data: updated })
      },
    },

    // ── Attach a source document to an existing inbox item ──
    {
      method: 'POST',
      path: '/items/:id/attach-document',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

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

        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, document_id, status, correlation_id, created_supplier_invoice_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!item) return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 })
        if (item.created_supplier_invoice_id) {
          return NextResponse.json({ error: 'Redan bokfört, kan inte ersätta bilden.' }, { status: 409 })
        }
        if (item.document_id) {
          return NextResponse.json({ error: 'Posten har redan en bilaga.' }, { status: 409 })
        }

        try {
          const buffer = await file.arrayBuffer()
          const doc = await uploadDocument(ctx.supabase, ctx.userId, ctx.companyId, {
            name: file.name,
            buffer,
            type: file.type,
          }, {
            upload_source: 'file_upload',
            // This route extracts below and mirrors the outcome onto the
            // document row; the document-extraction extension must not race it.
            extractionOwner: 'invoice-inbox',
          })

          // Same page handling as /upload (issue #553): long PDFs extract
          // from a slice (first pages + the last page); the skip only remains
          // for unsliceable (encrypted/malformed) PDFs. Sandbox companies
          // skip Bedrock unconditionally.
          const maxAutoExtractPages = maxPagesForAutoExtract()
          const pageCount =
            file.type === 'application/pdf' ? await countPdfPages(buffer) : null
          const gatedByPageCount =
            pageCount != null && pageCount > maxAutoExtractPages
          const sandbox = await isSandboxCompany(ctx.supabase, ctx.companyId)
          // Paid-tier gate: no `ai` capability → no Bedrock OCR (seed empty
          // skeleton; the attached document is still stored). Same paywall as
          // the shared upload path above.
          const hasAiEntitlement = await hasCapability(ctx.supabase, ctx.companyId, CAPABILITY.ai)
          const slicedBuffer =
            gatedByPageCount && hasAiEntitlement && !sandbox
              ? await slicePdfForExtraction(buffer, maxAutoExtractPages)
              : null
          const skipReason: 'no_ai_entitlement' | 'too_many_pages' | 'sandbox' | null =
            !hasAiEntitlement
              ? 'no_ai_entitlement'
              : sandbox
                ? 'sandbox'
                : gatedByPageCount && slicedBuffer == null
                  ? 'too_many_pages'
                  : null
          const skipExtraction = skipReason !== null

          const extraction = skipExtraction
            ? { data: emptyResult(), rawText: null, model: null, skipped: null }
            : await extractInvoiceFields({
                buffer: Buffer.from(slicedBuffer ?? buffer),
                mimeType: file.type,
                fileName: file.name,
                ownCompany: await fetchOwnCompanyIdentity(ctx.supabase, ctx.companyId),
              })
          const { data: extracted } = extraction
          if (!skipExtraction && slicedBuffer != null && pageCount != null) {
            extracted.pages = { total: pageCount, analyzed: maxAutoExtractPages }
          }
          await mirrorExtractionToDocument(doc.id, {
            data: extracted,
            rawText: extraction.rawText,
            model: extraction.model ?? null,
            skipped: skipReason ?? extraction.skipped ?? null,
          })

          const { error: linkError } = await ctx.supabase
            .from('invoice_inbox_items')
            .update({
              document_id: doc.id,
              extracted_data: extracted as unknown as Record<string, unknown>,
              extraction_skipped: skipExtraction,
            })
            .eq('id', id)
            .eq('company_id', ctx.companyId)
          if (linkError) {
            return NextResponse.json({ error: linkError.message }, { status: 500 })
          }

          if (item.correlation_id) {
            try {
              await appendProcessingHistory({
                companyId: ctx.companyId,
                correlationId: item.correlation_id,
                aggregateType: 'Document',
                aggregateId: doc.id,
                eventType: 'DocumentIngested',
                payload: {
                  channel: 'upload',
                  document_id: doc.id,
                  inbox_item_id: id,
                  mime_type: file.type,
                  size_bytes: file.size,
                  attached_to_existing: true,
                },
                actor: { type: 'user', id: ctx.userId },
                occurredAt: new Date(),
              })
            } catch (err) {
              console.error('[invoice-inbox/attach-document] appendProcessingHistory failed:', err)
            }
          }

          return NextResponse.json({
            data: {
              document_id: doc.id,
              inbox_item_id: id,
              extracted_data: extracted,
              extraction_skipped: skipExtraction,
              skip_reason: skipReason,
              page_count: pageCount,
            },
          })
        } catch (error) {
          console.error('[invoice-inbox/attach-document] Failed:', error)
          // Same pass-through rationale as the /upload catch above.
          const message = error instanceof Error && error.message.trim() ? error.message : null
          return NextResponse.json(
            {
              error: {
                code: 'INBOX_ATTACH_FAILED',
                message: message ?? 'Bilagan kunde inte kopplas. Försök igen.',
                message_en: message ?? 'Failed to attach the document.',
              },
            },
            { status: 500 }
          )
        }
      },
    },

    // ── Match a supplier to an inbox item ───────────────────
    {
      method: 'POST',
      path: '/items/:id/match-supplier',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        let body: { supplier_id?: string }
        try {
          body = await request.json()
        } catch {
          return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
        }
        if (!body.supplier_id || typeof body.supplier_id !== 'string') {
          return NextResponse.json({ error: 'supplier_id required' }, { status: 400 })
        }

        // Confirm supplier exists in this company before linking.
        const { data: supplier } = await ctx.supabase
          .from('suppliers')
          .select('id')
          .eq('id', body.supplier_id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()
        if (!supplier) {
          return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })
        }

        const { error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({ matched_supplier_id: body.supplier_id })
          .eq('id', id)
          .eq('company_id', ctx.companyId)

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }
        return NextResponse.json({ data: { id, matched_supplier_id: body.supplier_id } })
      },
    },

    // ── Match a bank transaction to an inbox item ──────────
    // Sets invoice_inbox_items.matched_transaction_id. Used by the
    // TransactionMatchPicker dialog after the user picks a candidate from
    // the confidence-scored list. The transaction.categorization agent
    // intent already reads this column in its capture() so the agent will
    // see the inbox metadata as underlag on its next invocation.
    {
      method: 'POST',
      path: '/items/:id/match-transaction',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

        // Confirm transaction belongs to this company before linking. RLS
        // would also catch it on the update, but failing fast keeps the
        // error specific. Also fetch the existing document_id so we can
        // decide whether to backfill it from the inbox doc below.
        const { data: tx } = await ctx.supabase
          .from('transactions')
          .select('id, document_id')
          .eq('id', body.transaction_id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()
        if (!tx) {
          return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
        }

        // Fetch the inbox item's document_id so we can mirror it to
        // transactions.document_id below: the TransactionInboxCard reads
        // that column to decide whether to show the paperclip/file-check
        // indicators on the /transactions list. Without this, a row that
        // has a matched inbox item still appears doc-less in the UI.
        const { data: inboxItem } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, document_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        const { data: updated, error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({ matched_transaction_id: body.transaction_id })
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .select('id, matched_transaction_id')
          .single()

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }

        // Mirror the inbox document onto the transaction so the list view
        // reflects "underlag bifogat" immediately. Only when the tx has
        // no other doc already (we never overwrite an existing link).
        if (inboxItem?.document_id && !tx.document_id) {
          const { error: txUpdateError } = await ctx.supabase
            .from('transactions')
            .update({ document_id: inboxItem.document_id })
            .eq('id', body.transaction_id)
            .eq('company_id', ctx.companyId)
            .is('document_id', null)
          if (txUpdateError) {
            // Non-fatal: the match itself succeeded; the UI indicator just
            // won't flip until next page refresh. Log but don't roll back.
            console.error('[invoice-inbox/match-transaction] tx.document_id backfill failed:', txUpdateError)
          }
        }

        // The matched transaction may already be booked (directly or via a
        // bulk-book samlingsverifikat): complete the item against the
        // anchoring verifikat (underlag link + consumed stamp) so matching
        // to a settled purchase resolves the item instead of stranding it
        // as "linked". Best-effort, logged inside.
        await completeInboxItemsForBookedTransaction(
          ctx.supabase,
          ctx.companyId,
          body.transaction_id,
        )

        return NextResponse.json({ data: updated })
      },
    },

    // ── Clear matched_transaction_id (user mistake / re-match) ────
    {
      method: 'POST',
      path: '/items/:id/unmatch-transaction',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        // Capture the current match before clearing so we can mirror the
        // unmatch onto transactions.document_id below.
        const { data: existing } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, document_id, matched_transaction_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        const { data: updated, error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({ matched_transaction_id: null })
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .select('id, matched_transaction_id')
          .single()

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }

        // Clear the mirrored tx.document_id only when it currently points
        // at the same doc this inbox item brought in. Guards against
        // clobbering a doc that came from another source (paperclip
        // upload, SIE import, etc.).
        if (existing?.matched_transaction_id && existing.document_id) {
          const { error: txUpdateError } = await ctx.supabase
            .from('transactions')
            .update({ document_id: null })
            .eq('id', existing.matched_transaction_id)
            .eq('company_id', ctx.companyId)
            .eq('document_id', existing.document_id)
          if (txUpdateError) {
            console.error('[invoice-inbox/unmatch-transaction] tx.document_id clear failed:', txUpdateError)
          }
        }

        return NextResponse.json({ data: updated })
      },
    },

    // ── Retry extraction on a stored document ──────────────
    {
      method: 'POST',
      path: '/items/:id/retry-extraction',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
          const extraction = await extractInvoiceFields({
            buffer,
            mimeType: doc.mime_type,
            fileName: doc.file_name,
            ownCompany: await fetchOwnCompanyIdentity(ctx.supabase, ctx.companyId),
          })
          const { data: extracted } = extraction
          await mirrorExtractionToDocument(item.document_id, {
            data: extracted,
            rawText: extraction.rawText,
            model: extraction.model ?? null,
            skipped: extraction.skipped ?? null,
          })

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
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

    // ── Custom inbound domain: read current state ────────────
    {
      method: 'GET',
      path: '/inbox/domain',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!customDomainsEnabled()) return customDomainsDisabledResponse()

        try {
          const row = await getCustomDomain(ctx.supabase, ctx.companyId)
          // null when the company has no custom domain: the UI renders the
          // claim form in that case.
          return NextResponse.json({ data: row })
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Failed to load domain' },
            { status: 500 }
          )
        }
      },
    },

    // ── Custom inbound domain: claim (admin/owner only) ──────
    {
      method: 'POST',
      path: '/inbox/domain',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!customDomainsEnabled()) return customDomainsDisabledResponse()

        const isAdmin = await isCompanyAdmin(ctx.supabase, ctx.userId, ctx.companyId)
        if (!isAdmin) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

        // Sandbox companies are anonymous 24h demo accounts: letting them
        // register domains in our Resend account is a pure abuse vector.
        if (await isSandboxCompany(ctx.supabase, ctx.companyId)) {
          return NextResponse.json(
            { error: 'Egen domän är inte tillgänglig i sandlådan.' },
            { status: 403 }
          )
        }

        // Claiming hits the Resend domains API: share the per-company inbox
        // quota so a claim/delete loop can't burn the provider budget.
        const limit = await checkInboxUploadRateLimit(ctx.supabase, ctx.companyId)
        if (!limit.ok) {
          return NextResponse.json(
            { error: 'För många förfrågningar, försök igen om en stund.', retry_after: limit.retryAfterSec },
            { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } },
          )
        }

        let body: z.infer<typeof ClaimDomainSchema>
        try {
          body = ClaimDomainSchema.parse(await request.json())
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Invalid request body' },
            { status: 400 }
          )
        }

        const result = await claimCustomDomain(ctx.supabase, ctx.companyId, body.domain)
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: result.status })
        }
        return NextResponse.json({ data: result.data })
      },
    },

    // ── Custom inbound domain: re-check verification ─────────
    {
      method: 'POST',
      path: '/inbox/domain/verify',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!customDomainsEnabled()) return customDomainsDisabledResponse()

        const isAdmin = await isCompanyAdmin(ctx.supabase, ctx.userId, ctx.companyId)
        if (!isAdmin) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

        // verify() triggers a DNS check at Resend: rate-limit the button.
        const limit = await checkInboxUploadRateLimit(ctx.supabase, ctx.companyId)
        if (!limit.ok) {
          return NextResponse.json(
            { error: 'För många kontroller, försök igen om en stund.', retry_after: limit.retryAfterSec },
            { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } },
          )
        }

        const result = await checkCustomDomainVerification(ctx.supabase, ctx.companyId)
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: result.status })
        }
        return NextResponse.json({ data: result.data })
      },
    },

    // ── Custom inbound domain: remove (admin/owner only) ─────
    {
      method: 'DELETE',
      path: '/inbox/domain',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!customDomainsEnabled()) return customDomainsDisabledResponse()

        const isAdmin = await isCompanyAdmin(ctx.supabase, ctx.userId, ctx.companyId)
        if (!isAdmin) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

        const result = await removeCustomDomain(ctx.supabase, ctx.companyId)
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: result.status })
        }
        return NextResponse.json({ data: result.data })
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

        // Resend pushes domain.* lifecycle events to the same webhook. Apply
        // domain.updated to custom-domain rows so verification flips without
        // the user pressing "Kontrollera igen" (requires the event type to be
        // subscribed on the Resend webhook; harmless when it isn't).
        if (event.type === 'domain.updated') {
          const domainServiceSupabase = createServiceRoleClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
          )
          const matched = await applyDomainStatusFromWebhook(domainServiceSupabase, {
            id: event.data.id,
            status: event.data.status,
            records: event.data.records,
          })
          return NextResponse.json({ data: { domain_updated: matched } })
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
        // no trace. Per-company verified custom domains come after, and only
        // when no shared address resolved. Custom domains are catch-all by
        // design: MX routing is per-domain, and a supplier typing fakturor@
        // instead of faktura@ must land in the inbox rather than silently
        // vanish (Resend has already accepted the message; there is no
        // bounce path).
        interface InboundTarget {
          companyId: string
          inboxId: string | null
          customDomain: boolean
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
        const domainLower = domain.toLowerCase()

        const sharedRecipients = extractSharedRecipientsForDomain(to, domain)
        const inboxGroups = groupSharedRecipientsByInbox(sharedRecipients)
        if (inboxGroups.length > MAX_INBOUND_TARGETS_PER_EMAIL) {
          console.warn('[invoice-inbox/inbound] Recipient fan-out capped', {
            addressed: inboxGroups.length,
            processed: MAX_INBOUND_TARGETS_PER_EMAIL,
          })
        }
        for (const group of inboxGroups.slice(0, MAX_INBOUND_TARGETS_PER_EMAIL)) {
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
          // retired shared address must not ride along onto a custom-domain
          // match further down. Custom domains are catch-all and stay
          // unhinted. Contradicting tags on one mail resolve to no hint.
          const { kindHint, conflict } = resolveKindHintForTags(group.tags)
          const { known, unknownCount } = splitKnownInboxTags(group.tags)
          targets.push({
            companyId: inbox.company_id,
            inboxId: inbox.id,
            customDomain: false,
            tags: known,
            unknownTagCount: unknownCount,
            kindHint,
            tagConflict: conflict,
          })
        }

        if (targets.length === 0) {
          const customDomains = parseRecipients(to)
            .map((r) => r.domain)
            .filter((d) => d !== domainLower)
          if (customDomains.length > 0) {
            const match = await findCompanyForRecipientDomains(serviceSupabase, customDomains)
            if (match) {
              targets.push({
                companyId: match.companyId,
                inboxId: null,
                customDomain: true,
                tags: [],
                unknownTagCount: 0,
                kindHint: null,
                tagConflict: false,
              })
            }
          }
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

        type AttachmentResult = { attachment_id: string; inbox_item_id?: string; error?: string; duplicate?: boolean }
        /**
         * What became of one attachment, for the mail's history event. Codes
         * only: the free-text error and the filename stay out of
         * processing_history (append-only, outside the erasure path).
         */
        type AttachmentOutcome = {
          id: string
          outcome: 'filed' | 'duplicate' | 'rejected' | 'failed'
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

          if (attachments.length === 0) {
            // Body-only mail: for many suppliers the HTML body IS the invoice
            // (SaaS receipts, e-mail invoices), and often the only underlag the
            // user has. Store the body as a text/html document and run the
            // normal extract pipeline instead of dead-ending in an error row.
            // Mails with an empty body keep the old error row.
            const bodyDoc = buildEmailBodyHtmlDocument(fullEmail.html ?? null, bodyText)
            if (bodyDoc && bodyDoc.byteLength <= MAX_FILE_SIZE) {
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
              if (existingBody) {
                return { processed: 0, reason: 'email_body_duplicate', inbox_item_id: existingBody.id, attachments: [] }
              }
              try {
                const result = await uploadAndExtract(
                  serviceSupabase,
                  userId,
                  companyId,
                  {
                    name: `mail-${sanitiseFilename(subject, 'meddelande')}.html`,
                    buffer: bodyDoc,
                    type: 'text/html',
                  },
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
                return { processed: 1, reason: 'email_body', inbox_item_id: result.inbox_item_id, attachments: [] }
              } catch (err) {
                // Fall through to the error row so the mail never vanishes.
                console.error('[invoice-inbox/inbound] Email-body document failed:', err)
              }
            }
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
              error_message: 'Email had no attachments',
              raw_email_payload: { messageId: message_id },
            })
            return { processed: 0, reason: 'no_attachments', attachments: [] }
          }

          const results: AttachmentResult[] = []

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

          for (const att of attachments) {
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
                const parsed = await simpleParser(Buffer.from(download.buffer))
                const innerAttachments = parsed.attachments || []
                const innerFrom = parsed.from?.text || from
                const innerSubject = parsed.subject || subject
                if (innerAttachments.length === 0) {
                  // Gmail "Forward as attachment" of a body-only HTML invoice:
                  // the forwarded mail's body is the underlag. Same treatment
                  // as a direct body-only mail; empty bodies keep the rejection.
                  const innerBodyDoc = buildEmailBodyHtmlDocument(
                    typeof parsed.html === 'string' ? parsed.html : null,
                    parsed.text ?? null
                  )
                  if (innerBodyDoc && innerBodyDoc.byteLength <= MAX_FILE_SIZE) {
                    const innerBodyResult = await uploadAndExtract(
                      serviceSupabase,
                      userId,
                      companyId,
                      {
                        name: `mail-${sanitiseFilename(innerSubject, 'meddelande')}.html`,
                        buffer: innerBodyDoc,
                        type: 'text/html',
                      },
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
                custom_domain: target.customDomain,
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

        if (outcomes.length === 1) {
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
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
    {
      method: 'DELETE',
      path: '/items/:id',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, created_supplier_invoice_id, created_journal_entry_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        if (item.created_supplier_invoice_id) {
          return NextResponse.json(
            { error: 'Posten är kopplad till en leverantörsfaktura och kan inte tas bort.' },
            { status: 409 }
          )
        }
        if (item.created_journal_entry_id) {
          return NextResponse.json(
            { error: 'Posten är bokförd och kan inte tas bort.' },
            { status: 409 }
          )
        }

        const { error } = await ctx.supabase
          .from('invoice_inbox_items')
          .delete()
          .eq('id', id)
          .eq('company_id', ctx.companyId)

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({ data: { id, deleted: true } })
      },
    },

    // ── Convert inbox item to supplier invoice ─────────────
    {
      method: 'POST',
      path: '/items/:id/convert',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const { data: item, error: fetchError } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('*')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .single()

        if (fetchError || !item) return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 })
        if (item.created_supplier_invoice_id) {
          return NextResponse.json({ error: 'Posten är redan kopplad till en leverantörsfaktura.' }, { status: 409 })
        }

        let body: ReturnType<typeof CreateSupplierInvoiceSchema.parse>
        try {
          const json = await request.json()
          body = CreateSupplierInvoiceSchema.parse(json)
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid request body'
          return NextResponse.json({ error: message }, { status: 400 })
        }

        const { data: supplier, error: supplierError } = await ctx.supabase
          .from('suppliers')
          .select('*')
          .eq('id', body.supplier_id)
          .eq('company_id', ctx.companyId)
          .single()

        if (supplierError || !supplier) {
          return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })
        }

        // Särskild löneskatt (SLP): same guards as /api/supplier-invoices.
        // The 7533/2514 pair is only lawful on 741x pension premiums and
        // cannot be combined with periodisering on the same row.
        if (
          body.items.some(
            (bodyItem) => bodyItem.apply_slp && !isSlpPensionAccount(bodyItem.account_number),
          )
        ) {
          return errorResponseFromCode('SI_CREATE_SLP_INVALID_ACCOUNT', ctx.log)
        }
        if (
          body.items.some(
            (bodyItem) =>
              bodyItem.apply_slp &&
              (bodyItem.accrual_period_start ||
                bodyItem.accrual_period_end ||
                bodyItem.accrual_balance_account),
          )
        ) {
          return errorResponseFromCode('SI_CREATE_SLP_ACCRUAL', ctx.log)
        }

        // Periodisering requires faktureringsmetoden: mirror the main
        // /api/supplier-invoices guard so kontantmetod companies never store
        // accrual fields the booking would silently ignore.
        const hasAccrualItems = body.items.some(
          (bodyItem) => bodyItem.accrual_period_start && bodyItem.accrual_period_end,
        )
        if (hasAccrualItems && body.reverse_charge) {
          // Omvänd skattskyldighet: the expense line carries the VAT base for
          // rutor 20-32: deferring the net to a 17xx interim account would
          // corrupt the momsdeklaration. Same guard as /api/supplier-invoices.
          return errorResponseFromCode('SI_CREATE_ACCRUAL_REVERSE_CHARGE', ctx.log)
        }
        if (hasAccrualItems) {
          const { data: methodSettings } = await ctx.supabase
            .from('company_settings')
            .select('accounting_method')
            .eq('company_id', ctx.companyId)
            .single()
          if ((methodSettings?.accounting_method || 'accrual') !== 'accrual') {
            return errorResponseFromCode('SI_CREATE_INVALID_INPUT', ctx.log, {
              details: { reason: 'periodisering requires faktureringsmetoden (accrual)' },
            })
          }
        }

        // Same currency policy as POST /api/supplier-invoices and the v1 REST
        // route (lib/currency/supplier-invoice-rate.ts): a non-SEK invoice with
        // no caller-supplied rate gets one fetched from Riksbanken for the
        // invoice date, and an unresolvable rate refuses the conversion instead
        // of writing exchange_rate = NULL. That matters most here: inbox items
        // are AI-extracted, the currency comes off the PDF and the rate never
        // does, so this path produced unconverted rows most readily. Resolved
        // before the arrival number so a refusal burns no ankomstnummer.
        const fx = await resolveSupplierInvoiceExchangeRate(ctx.supabase, {
          currency: body.currency,
          invoiceDate: body.invoice_date,
          suppliedRate: body.exchange_rate,
        })
        if (!fx.ok) {
          return errorResponseFromCode('SI_FX_RATE_MISSING', ctx.log, {
            details: { currency: fx.currency, invoice_date: fx.invoiceDate },
          })
        }

        const { data: arrivalNum, error: arrivalError } = await ctx.supabase
          .rpc('get_next_arrival_number', { p_company_id: ctx.companyId })

        if (arrivalError) {
          return NextResponse.json({ error: 'Failed to get arrival number' }, { status: 500 })
        }

        const items = body.items.map((bodyItem, index) => {
          const vatRate = bodyItem.vat_rate ?? 0.25
          const lineTotal = bodyItem.amount != null
            ? Math.round(bodyItem.amount * 100) / 100
            : Math.round((bodyItem.quantity ?? 1) * (bodyItem.unit_price ?? 0) * 100) / 100
          const vatAmount = Math.round(lineTotal * vatRate * 100) / 100
          return {
            sort_order: index,
            description: bodyItem.description,
            quantity: bodyItem.amount != null ? 1 : (bodyItem.quantity ?? 1),
            unit: bodyItem.amount != null ? 'st' : (bodyItem.unit || 'st'),
            unit_price: bodyItem.amount != null ? lineTotal : (bodyItem.unit_price ?? 0),
            line_total: lineTotal,
            account_number: bodyItem.account_number,
            vat_code: bodyItem.vat_code || null,
            vat_rate: vatRate,
            vat_amount: vatAmount,
            // Self-assessed RC rate (0.06/0.12/0.25) or null: engine defaults
            // to 25% huvudregeln when null for a reverse-charge invoice.
            reverse_charge_rate: body.reverse_charge ? (bodyItem.reverse_charge_rate ?? null) : null,
            // Periodisering: frozen onto the line; the balance account
            // defaults from the cost account's BAS convention.
            accrual_period_start:
              bodyItem.accrual_period_start && bodyItem.accrual_period_end
                ? bodyItem.accrual_period_start
                : null,
            accrual_period_end:
              bodyItem.accrual_period_start && bodyItem.accrual_period_end
                ? bodyItem.accrual_period_end
                : null,
            accrual_balance_account:
              bodyItem.accrual_period_start && bodyItem.accrual_period_end
                ? (bodyItem.accrual_balance_account ??
                  suggestBalanceAccount('expense', bodyItem.account_number))
                : null,
            // Särskild löneskatt (SLP): booking injects the self-balancing
            // 7533/2514 pair for this line. Guarded above (741x, no accrual).
            apply_slp: bodyItem.apply_slp === true,
          }
        })

        const subtotal = items.reduce((sum, i) => sum + i.line_total, 0)
        const totalVat = items.reduce((sum, i) => sum + i.vat_amount, 0)
        // roundOre, not the naive form: `total` and `total_sek` must round
        // identically or a SEK invoice ends up one öre apart.
        const total = roundOre(subtotal + totalVat)

        // SEK resolves to rate 1, so total_sek === total rather than NULL.
        const {
          subtotal_sek: subtotalSek,
          vat_amount_sek: vatAmountSek,
          total_sek: totalSek,
        } = supplierInvoiceSekAmounts(fx.rate, { subtotal, vatAmount: totalVat, total })

        const { data: invoice, error: invoiceError } = await ctx.supabase
          .from('supplier_invoices')
          .insert({
            user_id: ctx.userId,
            company_id: ctx.companyId,
            supplier_id: body.supplier_id,
            arrival_number: arrivalNum,
            supplier_invoice_number: body.supplier_invoice_number,
            invoice_date: body.invoice_date,
            due_date: body.due_date,
            delivery_date: body.delivery_date || null,
            status: 'registered',
            currency: fx.rate.currency,
            exchange_rate: fx.rate.exchangeRate,
            // Which day's kurs the SEK amounts were translated at: the audit
            // trail that makes them verifiable (BFL 5 kap).
            exchange_rate_date: fx.rate.exchangeRateDate,
            vat_treatment: body.vat_treatment || 'standard_25',
            reverse_charge: body.reverse_charge || false,
            payment_reference: body.payment_reference || null,
            subtotal: roundOre(subtotal),
            subtotal_sek: subtotalSek,
            vat_amount: roundOre(totalVat),
            vat_amount_sek: vatAmountSek,
            total,
            total_sek: totalSek,
            remaining_amount: total,
            document_id: item.document_id || null,
            // WhatsApp-sourced items: when the request carries NO notes field
            // at all, default to the rendered chat context (representation
            // deltagare + syfte, sender note) so the human answers from the
            // chat reach the leverantörsfaktura. Presence decides, not
            // truthiness: `notes: ""` is an explicit clear and stays empty
            // (same rule as book-direct, where the value lands on an
            // immutable verifikat). The caption is excluded: this form never
            // shows the chat context, so nobody reviewed it.
            notes:
              body.notes === undefined
                ? renderChannelContextNotes(
                    (item as { channel_context?: InboxChannelContext | null }).channel_context,
                  )
                : body.notes.trim() || null,
          })
          .select()
          .single()

        if (invoiceError || !invoice) {
          // A unique-index hit on (company_id, supplier_id,
          // supplier_invoice_number) is a recoverable conflict: the user
          // already registered this invoice (often manually, then tried to
          // convert the same inbox document). Mirror the main
          // /api/supplier-invoices route and return a friendly 409 with the
          // existing invoice, instead of letting the raw Postgres message
          // surface as a generic 500 ("Ett oväntat serverfel uppstod").
          const pgErr = invoiceError as { code?: string; message?: string } | null
          const isDuplicateNumber =
            pgErr?.code === '23505' &&
            (pgErr.message || '').includes('idx_supplier_invoices_company_supplier_number')

          if (isDuplicateNumber) {
            // Tenancy: ctx.supabase is the cookie-scoped RLS client and the
            // supplier_invoices SELECT policy is
            // `company_id IN (SELECT user_company_ids())`. Combined with the
            // explicit company_id filter below, this lookup can only ever
            // resolve an invoice the caller's own company owns: the returned
            // details are never cross-tenant (OWASP ASVS V8.2.1; ISO 27001
            // A.8.3; GDPR art.25(2)).
            const { data: existing } = await ctx.supabase
              .from('supplier_invoices')
              .select('id, supplier_invoice_number, status')
              .eq('company_id', ctx.companyId)
              .eq('supplier_id', body.supplier_id)
              .eq('supplier_invoice_number', body.supplier_invoice_number)
              .maybeSingle()

            let creditNoteId: string | null = null
            if (existing?.status === 'credited') {
              const { data: creditNote } = await ctx.supabase
                .from('supplier_invoices')
                .select('id')
                .eq('company_id', ctx.companyId)
                .eq('credited_invoice_id', existing.id)
                .eq('is_credit_note', true)
                .maybeSingle()
              creditNoteId = creditNote?.id ?? null
            }

            // Return ONLY server-authoritative fields the recovery dialog needs
            // (the existing row, read under RLS). The raw request body
            // (supplier_id / supplier_invoice_number) is deliberately not
            // echoed back: the client already holds it from its own form state,
            // and reflecting user-supplied values widens the response surface
            // for no benefit (GDPR art.5(1)(c) data minimisation; OWASP ASVS
            // V4.5). The Postgres constraint name is used only to classify the
            // error above and is never placed in the response.
            return errorResponseFromCode('SI_CREATE_DUPLICATE_INVOICE_NUMBER', ctx.log, {
              details: {
                existing: existing
                  ? {
                      id: existing.id,
                      supplier_invoice_number: existing.supplier_invoice_number,
                      status: existing.status,
                      credit_note_id: creditNoteId,
                    }
                  : null,
              },
            })
          }

          return NextResponse.json({ error: invoiceError?.message || 'Failed to create invoice' }, { status: 500 })
        }

        const itemInserts = items.map((lineItem) => ({
          supplier_invoice_id: invoice.id,
          ...lineItem,
        }))

        const { data: insertedItems, error: itemsError } = await ctx.supabase
          .from('supplier_invoice_items')
          .insert(itemInserts)
          .select('id, sort_order')

        if (itemsError) {
          await ctx.supabase.from('supplier_invoices').delete().eq('id', invoice.id)
          return NextResponse.json({ error: itemsError.message }, { status: 500 })
        }

        const { data: settings } = await ctx.supabase
          .from('company_settings')
          .select('accounting_method, defer_invoice_booking')
          .eq('company_id', ctx.companyId)
          .single()

        let registrationJournalEntryId: string | null = null

        // #967: deferred companies register WITHOUT booking (same gate as
        // POST /api/supplier-invoices); ekonomi books later via Bokför.
        if (booksInvoicesOnIssue(settings)) {
          try {
            const journalEntry = await createSupplierInvoiceRegistrationEntry(
              ctx.supabase,
              ctx.companyId,
              ctx.userId,
              invoice as SupplierInvoice,
              items as SupplierInvoiceItem[],
              supplier.supplier_type,
              supplier.name
            )
            if (journalEntry) {
              registrationJournalEntryId = journalEntry.id
              ;(invoice as SupplierInvoice).registration_journal_entry_id = journalEntry.id
              await ctx.supabase
                .from('supplier_invoices')
                .update({ registration_journal_entry_id: journalEntry.id })
                .eq('id', invoice.id)

              if (item.document_id) {
                await ctx.supabase
                  .from('document_attachments')
                  .update({ journal_entry_id: journalEntry.id })
                  .eq('id', item.document_id)
                  .eq('company_id', ctx.companyId)
              }

              if (hasAccrualItems) {
                // Schedules + catch-up dissolutions for deferred lines. Never
                // fatal: the registration entry is committed; failures are
                // retried/surfaced via the periodiseringar page.
                const idBySortOrder = new Map(
                  ((insertedItems ?? []) as Array<{ id: string; sort_order: number }>).map(
                    (row) => [row.sort_order, row.id],
                  ),
                )
                const itemsWithIds = items.map((lineItem) => ({
                  ...lineItem,
                  id: idBySortOrder.get(lineItem.sort_order) ?? null,
                }))
                const scheduleResult = await createSchedulesForSupplierInvoice(
                  ctx.supabase,
                  ctx.companyId,
                  ctx.userId,
                  invoice as SupplierInvoice,
                  itemsWithIds as unknown as SupplierInvoiceItem[],
                  journalEntry.id,
                )
                if (scheduleResult.failed > 0) {
                  ctx.log.error('accrual schedule creation failed on inbox convert', {
                    supplierInvoiceId: invoice.id,
                    failed: scheduleResult.failed,
                  })
                }
              }
            } else {
              // createSupplierInvoiceRegistrationEntry returns null ONLY when no
              // fiscal period covers invoice_date (every other failure throws).
              // Roll back so we never mark the inbox item converted against an
              // unbooked supplier invoice (orphan understating 2440/2641).
              await ctx.supabase
                .from('supplier_invoices')
                .delete()
                .eq('id', invoice.id)
                .eq('company_id', ctx.companyId)
              return errorResponseFromCode('SI_CREATE_NO_FISCAL_PERIOD', ctx.log, {
                details: { invoiceDate: (invoice as SupplierInvoice).invoice_date },
              })
            }
          } catch (err) {
            // Engine threw (period lock, unbalanced entry, etc.) instead of
            // cleanly returning null. Roll back the supplier invoice so the inbox
            // item is never marked converted against an unbooked invoice (an orphan
            // understating 2440/2641), then surface the error: mirroring the main
            // /api/supplier-invoices route's registration catch.
            await ctx.supabase
              .from('supplier_invoices')
              .delete()
              .eq('id', invoice.id)
              .eq('company_id', ctx.companyId)
            const typed = bookkeepingErrorResponse(err)
            if (typed) return typed
            return errorResponseFromCode('SI_CREATE_FAILED', ctx.log, {
              details: {
                reason: err instanceof Error ? err.message : 'unknown',
                step: 'registration_journal_entry',
              },
            })
          }
        }

        try {
          await ctx.emit({
            type: 'supplier_invoice.registered',
            payload: { supplierInvoice: invoice as SupplierInvoice, companyId: ctx.companyId, userId: ctx.userId },
          })
        } catch { /* non-blocking */ }

        await ctx.supabase
          .from('invoice_inbox_items')
          .update({ created_supplier_invoice_id: invoice.id })
          .eq('id', id)

        try {
          await ctx.emit({
            type: 'supplier_invoice.confirmed',
            payload: {
              inboxItem: { ...item, created_supplier_invoice_id: invoice.id } as InvoiceInboxItem,
              supplierInvoice: invoice as SupplierInvoice,
              userId: ctx.userId,
              companyId: ctx.companyId,
            },
          })
        } catch { /* non-blocking */ }

        return NextResponse.json({
          data: {
            ...invoice,
            items: itemInserts,
            registration_journal_entry_id: registrationJournalEntryId,
            inbox_item_id: id,
          },
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
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
          .select('id, document_id, status, created_supplier_invoice_id, created_journal_entry_id, matched_transaction_id, correlation_id, channel_context')
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
        let transaction: { id: string; journal_entry_id: string | null } | null = null
        if (body.transaction_id) {
          const { data: tx, error: txError } = await ctx.supabase
            .from('transactions')
            .select('id, journal_entry_id')
            .eq('id', body.transaction_id)
            .eq('company_id', ctx.companyId)
            .maybeSingle()
          if (txError || !tx) {
            return NextResponse.json({ error: 'Transaktion hittades inte' }, { status: 404 })
          }
          if (tx.journal_entry_id) {
            return NextResponse.json(
              { error: 'Transaktionen är redan bokförd' },
              { status: 409 }
            )
          }
          transaction = tx
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

        // Create the journal entry via the engine. Source-tracks back to
        // the inbox item so the audit trail is preserved even when no
        // transaction is involved.
        let journalEntry
        try {
          journalEntry = await createJournalEntry(ctx.supabase, ctx.companyId, ctx.userId, {
            fiscal_period_id: body.fiscal_period_id,
            entry_date: body.entry_date,
            description: body.description,
            source_type: transaction ? 'bank_transaction' : 'inbox_item',
            source_id: transaction ? transaction.id : item.id,
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

        // The transaction this verifikat settles: the one the caller named, or
        // the one the item was already matched to. Preserving the match without
        // booking it was half a fix, and the worse half: the item then looked
        // resolved while the bank line stayed open forever. The fallback needs
        // no ownership check because it was read off a company-scoped item.
        const bookedTransactionId = transaction?.id ?? item.matched_transaction_id ?? null

        if (bookedTransactionId) {
          const { error: txUpdateError } = await ctx.supabase
            .from('transactions')
            .update({
              journal_entry_id: journalEntry.id,
              is_business: true,
              category: 'uncategorized',
            })
            .eq('id', bookedTransactionId)
            .eq('company_id', ctx.companyId)
          if (txUpdateError) {
            console.error('[invoice-inbox/book-direct] Transaction link failed:', txUpdateError)
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
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
            .select('entity_type')
            .eq('company_id', ctx.companyId)
            .maybeSingle()
          // Same default as categorize-core. Leaving it undefined silently
          // proposed enskild-firma accounts to aktiebolag: 2013 instead of
          // 2893 for an owner expense, 6991 instead of 7610 for a course.
          const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'

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
          const mapping = await evaluateMappingRules(
            ctx.supabase,
            ctx.companyId,
            tx as Transaction,
            entityType,
            settlementAccount,
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

          const lines = buildTransactionEntryLines(tx as Transaction, mapping).map((l) => ({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            description: l.line_description ?? '',
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
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
