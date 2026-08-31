import { after } from 'next/server'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { extractInvoiceFields, emptyResult, fetchOwnCompanyIdentity } from './extract-invoice-fields'
import { mirrorExtractionToDocument } from './mirror-extraction'
import { getAiStatus } from '@/lib/ai'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { matchSupplierId } from '@/lib/suppliers/match-supplier'
import type { InvoiceExtractionResult } from '@/types'
import { PDFDocument } from 'pdf-lib'
import path from 'node:path'

// Verdicts decidable before touching the file. `ai_unconfigured` is the
// deployment-level "no AI backend" state (self-host without a key), distinct
// from the per-company paywall (`no_ai_entitlement`).
type SyncSkipReason =
  | 'no_ai_entitlement'
  | 'client_opt_out'
  | 'sandbox'
  | 'ai_unconfigured'
  | null

/**
 * Defensive filename sanitisation for content arriving from .eml inner
 * attachments and rejected-attachment metadata. The document-service already
 * sanitises before storage paths are built (lib/core/documents/document-service.ts),
 * so this is defense-in-depth: strip directory traversal sequences and exotic
 * characters before they ever flow into DB columns or downstream consumers.
 */
export function sanitiseFilename(raw: string | null | undefined, fallback: string): string {
  const base = path.basename(String(raw ?? '').trim())
  const cleaned = base.replace(/[^\w.-]/g, '_').slice(0, 200)
  return cleaned || fallback
}

export function sanitiseMime(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim().slice(0, 120)
  return /^[\w./+-]+$/.test(value) ? value : 'application/octet-stream'
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024

// Page budget for auto-extraction. Documents far above it tend to be sales
// reports, bank statements, or contracts (issue #553); those are sliced (see
// slicePdfForExtraction) rather than read whole. The budget depends on how
// the backend reads PDFs:
//   - native (Claude on hosted): the model reads PDF bytes directly and
//     handles long documents fine; 8 pages covers real multi-page invoices
//     whose totals sit on a later page without opening the door to 100-page
//     statements.
//   - rasterize (OpenAI-compatible self-host): every page becomes a PNG in
//     the prompt, so the old conservative budget of 3 stays.
export const MAX_PAGES_FOR_AUTO_EXTRACT = 3
export const MAX_PAGES_FOR_AUTO_EXTRACT_NATIVE = 8

export function maxPagesForAutoExtract(): number {
  return getAiStatus().capabilities.pdfNative
    ? MAX_PAGES_FOR_AUTO_EXTRACT_NATIVE
    : MAX_PAGES_FOR_AUTO_EXTRACT
}

// Returns the page count for a PDF buffer, or null if the buffer isn't a
// parseable PDF. Errors fall through so callers can treat "unknown" the same
// as "small enough": preserves today's behavior on malformed inputs.
export async function countPdfPages(buffer: ArrayBuffer): Promise<number | null> {
  try {
    const pdf = await PDFDocument.load(buffer, { updateMetadata: false })
    return pdf.getPageCount()
  } catch {
    return null
  }
}

// Long PDFs used to skip extraction entirely (issue #553). Instead we extract
// from a slim copy and record the truncation in extracted_data.pages. The
// slice is the first maxPages-1 pages PLUS the last page: on multi-page
// invoices the totals, OCR number and "Att betala" routinely sit on the final
// page, and a first-pages-only slice read everything except the amounts.
// Returns null when slicing fails (encrypted/malformed PDF) so the caller can
// fall back to the old skip.
export async function slicePdfForExtraction(
  buffer: ArrayBuffer,
  maxPages: number
): Promise<ArrayBuffer | null> {
  try {
    const src = await PDFDocument.load(buffer, { updateMetadata: false })
    const dst = await PDFDocument.create()
    const total = src.getPageCount()
    const indices =
      total > maxPages && maxPages >= 2
        ? [...Array.from({ length: maxPages - 1 }, (_, i) => i), total - 1]
        : Array.from({ length: Math.min(maxPages, total) }, (_, i) => i)
    const pages = await dst.copyPages(src, indices)
    for (const page of pages) dst.addPage(page)
    const bytes = await dst.save()
    // Copy into a fresh ArrayBuffer: Uint8Array.buffer is ArrayBufferLike
    // (possibly SharedArrayBuffer-backed) and may span more than the view.
    const out = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(out).set(bytes)
    return out
  } catch {
    return null
  }
}

// Sandbox companies (24h anonymous demo accounts) skip the Bedrock extraction
// pipeline entirely. The document still uploads, the inbox row still lands,
// and the user can fill the fields in by hand, but no Claude tokens are
// spent on a throwaway account. See migration 20260311120000 for the column.
export async function isSandboxCompany(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('is_sandbox')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !data) return false
  return data.is_sandbox === true
}

export const UPLOAD_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
])

// The email pipeline additionally accepts HTML: many suppliers send the
// invoice as the mail body or an attached .html file, and for those the mail
// IS the underlag (BFL: the received form must be preserved). Deliberately
// NOT added to UPLOAD_ALLOWED_MIME_TYPES: HTML only enters through the
// inbound webhook, where the preview surfaces render it fully sandboxed.
export const EMAIL_ALLOWED_MIME_TYPES = new Set([...UPLOAD_ALLOWED_MIME_TYPES, 'text/html'])

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Wrap HTML in a minimal document shell unless it already is a full document.
 * Mail bodies are usually fragments (a bare <div>/<table>); the document
 * archive should hold self-contained files, and the document-service
 * magic-byte check requires HTML content to start with a doctype/root element.
 */
export function ensureHtmlDocument(html: string): ArrayBuffer {
  const head = html.replace(/^[﻿\s]+/, '').slice(0, 256).toLowerCase()
  const isFullDocument =
    head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')
  const full = isFullDocument
    ? html
    : `<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n${html}\n</body>\n</html>\n`
  const bytes = new TextEncoder().encode(full)
  // Copy into a fresh ArrayBuffer: Uint8Array.buffer is ArrayBufferLike
  // (possibly SharedArrayBuffer-backed) and may span more than the view.
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

/**
 * Build a text/html document from a mail's body parts, preferring the HTML
 * part. A plain-text-only mail is escaped into a <pre> so whitespace, amounts
 * and OCR numbers survive verbatim. Returns null when the mail has no body
 * worth storing.
 */
export function buildEmailBodyHtmlDocument(
  html: string | null,
  text: string | null
): ArrayBuffer | null {
  if (html?.trim()) return ensureHtmlDocument(html)
  if (text?.trim()) return ensureHtmlDocument(`<pre>${escapeHtml(text)}</pre>`)
  return null
}

export interface EmailMeta {
  from?: string | null
  subject?: string | null
  receivedAt?: string | null
  messageId?: string | null
  bodyText?: string | null
  resendEmailId?: string | null
  resendAttachmentId?: string | null
}

// Chat-channel provenance (whatsapp-inbox extension). When present, the inbox
// row links back to the delivering whatsapp_messages row and seeds
// channel_context (kept OUT of extracted_data: retry-extraction overwrites
// that container wholesale, and chat context must survive it).
export interface ChannelMeta {
  whatsappMessageId?: string
  caption?: string | null
}

// Captions are attacker-adjacent free text from a chat client: strip control
// characters and cap length before they land in a jsonb column read by the UI.
function sanitiseCaption(raw: string | null | undefined): string | null {
  if (!raw) return null
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500)
  return cleaned || null
}

// ── Shared helper: upload + extract + create inbox item ──────

export interface ArchivedDocumentProcessingOptions {
  skipExtraction?: boolean
  channelMeta?: ChannelMeta
  /** Overrides the system actor id on the DocumentIngested history event.
   *  Omitted = today's behavior (resend-inbound for email, user otherwise). */
  actorId?: string
  /**
   * Staged upload (web route only). When true AND extraction would actually
   * call Bedrock, the inbox row is inserted first (status 'processing',
   * extracted_data NULL), the function returns immediately, and extraction
   * runs after the response via a deferred worker that CAS-flips the row to
   * 'received'. Verdicts that never reach Bedrock (no AI entitlement,
   * sandbox, client opt-out) stay on the synchronous path: they are quick
   * and their response contract (empty skeleton + skip_reason) is
   * unchanged. skipExtraction in particular MUST stay synchronous: a
   * BYO-extraction agent PUTs its fields right after upload, and a deferred
   * flip would overwrite them. Default false = today's synchronous behavior
   * (email and WhatsApp callers are untouched).
   */
  deferExtraction?: boolean
}

export async function uploadAndExtract(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  companyId: string,
  file: { name: string; buffer: ArrayBuffer; type: string },
  source: 'upload' | 'email' | 'whatsapp',
  emailMeta?: EmailMeta,
  // Pre-match the new inbox item to a bank transaction. Set when the caller
  // already knows which transaction this receipt belongs to (e.g. the
  // VerifyAndBookOverlay opened from a transaction row's paperclip or from
  // a transaction-anchored chat). Skipped silently if missing.
  matchedTransactionId?: string | null,
  opts: ArchivedDocumentProcessingOptions = {},
) {
  const doc = await uploadDocument(supabase, userId, companyId, {
    name: file.name,
    buffer: file.buffer,
    type: file.type,
  }, {
    upload_source: source === 'email' ? 'email' : source === 'whatsapp' ? 'whatsapp' : 'file_upload',
    // Every inbox channel dedupes on content: the same receipt forwarded to
    // two inboxes, re-hunted by a sweep, or uploaded twice must not become a
    // second archived document.
    dedupeByContent: true,
    // This function extracts (sync or deferred) and mirrors the outcome onto
    // the document row; the document-extraction extension must not race it.
    extractionOwner: 'invoice-inbox',
  })

  return processArchivedDocument(
    supabase,
    userId,
    companyId,
    doc,
    file,
    source,
    emailMeta,
    matchedTransactionId,
    opts,
  )
}

/**
 * Everything the inbox does with a document once it sits in the archive:
 * adopt an existing inbox item for deduplicated content, record the
 * DocumentIngested history, apply the page-count gate, decide the
 * entitlement/sandbox/opt-out verdict, extract (synchronously or deferred)
 * and insert the inbox row. Split out of uploadAndExtract so the
 * direct-to-storage route (signed upload URL, bytes never in a function
 * body) can archive through completePendingDocumentUpload and then join the
 * exact same pipeline as the multipart route.
 *
 * `doc` is the archived document (or the existing one it deduplicated to),
 * `file` carries the same bytes the archive holds: the pipeline reads them
 * for page counting and extraction.
 */
export async function processArchivedDocument(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  companyId: string,
  doc: { id: string; deduplicated?: boolean },
  file: { name: string; buffer: ArrayBuffer; type: string },
  source: 'upload' | 'email' | 'whatsapp',
  emailMeta?: EmailMeta,
  matchedTransactionId?: string | null,
  opts: ArchivedDocumentProcessingOptions = {},
) {
  const correlationId = crypto.randomUUID()

  if (doc.deduplicated) {
    // The company already archived this exact content. If an inbox item
    // exists for it, adopt that item so the caller always gets a real
    // inbox_item_id; only when the document entered outside the inbox do we
    // fall through and file an item for the EXISTING document (no copy).
    const { data: existingItem, error: itemLookupError } = await supabase
      .from('invoice_inbox_items')
      .select('id, status, extracted_data, matched_supplier_id, matched_transaction_id')
      .eq('company_id', companyId)
      .eq('document_id', doc.id)
      .order('created_at', { ascending: true })
      .limit(1)
    if (itemLookupError) {
      // Fail closed: falling through would file a second item for a document
      // that may already carry one. The delivering channel retries.
      throw new Error(`Duplicate-item lookup failed: ${itemLookupError.message}`)
    }
    const adopted = (existingItem as Array<{
      id: string
      status: string
      extracted_data: unknown
      matched_supplier_id: string | null
      matched_transaction_id: string | null
    }> | null)?.[0]
    if (adopted) {
      try {
        await appendProcessingHistory({
          companyId,
          correlationId,
          aggregateType: 'Document',
          aggregateId: doc.id,
          eventType: 'DocumentDuplicateSkipped',
          payload: {
            channel: source,
            document_id: doc.id,
            inbox_item_id: adopted.id,
            reason: 'duplicate_content',
          },
          actor: opts.actorId
            ? { type: 'system', id: opts.actorId }
            : source === 'email'
              ? { type: 'system', id: 'resend-inbound' }
              : { type: 'user', id: userId },
          occurredAt: new Date(),
        })
      } catch (err) {
        console.error('[invoice-inbox] Failed to append DocumentDuplicateSkipped:', err)
      }
      return {
        document_id: doc.id,
        inbox_item_id: adopted.id,
        status: adopted.status,
        extracted_data: adopted.extracted_data,
        matched_supplier_id: adopted.matched_supplier_id,
        matched_transaction_id: adopted.matched_transaction_id,
        extraction_skipped: true,
        skip_reason: 'duplicate_content' as const,
        page_count: null,
        duplicate: true as const,
      }
    }
  }

  try {
    await appendProcessingHistory({
      companyId,
      correlationId,
      aggregateType: 'Document',
      aggregateId: doc.id,
      eventType: 'DocumentIngested',
      payload: {
        channel: source,
        document_id: doc.id,
        mime_type: file.type,
        size_bytes: file.buffer.byteLength,
      },
      actor: opts.actorId
        ? { type: 'system', id: opts.actorId }
        : source === 'email'
          ? { type: 'system', id: 'resend-inbound' }
          : { type: 'user', id: userId },
      occurredAt: new Date(),
    })
  } catch (err) {
    console.error('[invoice-inbox] Failed to append DocumentIngested:', err)
  }

  // Page-count gate (issue #553): PDFs above the auto-extract page budget
  // are sliced before extraction. Bedrock would otherwise block the upload
  // response for minutes on a long sales report and return nothing useful.
  // Images and non-PDFs are never gated (single-page by definition).
  // countPdfPages returns null on malformed PDFs: we treat null as "not
  // gated" and fall through to the existing extraction path so today's
  // behavior is preserved.
  const maxAutoExtractPages = maxPagesForAutoExtract()
  const pageCount =
    file.type === 'application/pdf' ? await countPdfPages(file.buffer) : null
  const gatedByPageCount =
    pageCount != null && pageCount > maxAutoExtractPages
  const sandbox = await isSandboxCompany(supabase, companyId)
  // Paid-tier gate: AI document OCR (Bedrock, via extractInvoiceFields) is the
  // `ai` capability. A company without it (free/manual tier) must never trigger
  // paid extraction: we seed an empty skeleton exactly like the sandbox / BYO-
  // extraction path, so the document is still stored and can be filled in
  // manually. Highest priority (a hard paywall rule, not a heuristic).
  const hasAiEntitlement = await hasCapability(supabase, companyId, CAPABILITY.ai)
  // The verdicts that avoid Bedrock entirely, in the established priority
  // order: no-AI-entitlement > sandbox > client opt-out. All three are
  // decidable without touching the PDF; too_many_pages is not (it only fires
  // when the slice fallback fails) and is resolved below, on whichever path
  // (sync or deferred) actually attempts the slice.
  // `ai_unconfigured` (no AI credentials/model on this deployment, the
  // self-host "key not set yet" state) is decided up front as well: a call
  // that can never succeed must not take the deferred path and leave the row
  // in 'processing' until the sweep.
  const syncSkipReason: SyncSkipReason =
    !hasAiEntitlement
      ? 'no_ai_entitlement'
      : sandbox
        ? 'sandbox'
        : opts.skipExtraction
          ? 'client_opt_out'
          : !getAiStatus().configured
            ? 'ai_unconfigured'
            : null

  if (opts.deferExtraction && syncSkipReason === null) {
    // Staged path: extraction WILL call Bedrock, so create the row now and
    // let the response go. The deferred worker (or, after a crash, the sweep
    // cron at /api/extensions/invoice-inbox/sweep/cron) flips the row to
    // 'received'. extracted_data stays NULL until then: that is what keeps
    // the MCP create-from-inbox guard ("re-run extraction first") holding
    // for free on in-flight rows.
    const { data: inbox, error: inboxError } = await supabase
      .from('invoice_inbox_items')
      .insert({
        company_id: companyId,
        user_id: userId,
        status: 'processing',
        source,
        document_id: doc.id,
        extracted_data: null,
        extraction_skipped: false,
        matched_supplier_id: null,
        email_from: emailMeta?.from || null,
        email_subject: emailMeta?.subject || null,
        email_received_at: emailMeta?.receivedAt || null,
        email_body_text: emailMeta?.bodyText || null,
        resend_email_id: emailMeta?.resendEmailId || null,
        resend_attachment_id: emailMeta?.resendAttachmentId || null,
        raw_email_payload: emailMeta?.messageId
          ? { messageId: emailMeta.messageId, filename: file.name }
          : null,
        correlation_id: correlationId,
        matched_transaction_id: matchedTransactionId ?? null,
        whatsapp_message_id: opts.channelMeta?.whatsappMessageId ?? null,
        channel_context: opts.channelMeta
          ? { channel: 'whatsapp', caption: sanitiseCaption(opts.channelMeta.caption) }
          : null,
      })
      .select('*')
      .single()

    if (inboxError) throw new Error(`Failed to create inbox item: ${inboxError.message}`)

    scheduleDeferredExtraction({
      itemId: inbox.id,
      documentId: doc.id,
      companyId,
      correlationId,
      file,
      pageCount,
      gatedByPageCount,
      maxAutoExtractPages,
    })

    return {
      document_id: doc.id,
      inbox_item_id: inbox.id,
      status: inbox.status,
      extracted_data: null,
      matched_supplier_id: inbox.matched_supplier_id,
      matched_transaction_id: inbox.matched_transaction_id,
      extraction_skipped: false,
      skip_reason: null,
      page_count: pageCount,
    }
  }

  // Long PDFs are sliced (first pages + the last page) instead of skipped,
  // but only when extraction would actually run: slicing after an
  // entitlement/sandbox/opt-out verdict would be wasted CPU.
  const slicedBuffer =
    gatedByPageCount && syncSkipReason === null
      ? await slicePdfForExtraction(file.buffer, maxAutoExtractPages)
      : null
  // Skip-reason priority: no-AI-entitlement > sandbox > client opt-out >
  // page-count. Opt-out outranks the page gate (an opted-out caller never
  // extracts regardless of length), and too_many_pages only fires when the
  // slice fallback also failed (encrypted/malformed PDF).
  const skipReason: SyncSkipReason | 'too_many_pages' =
    syncSkipReason ??
    (gatedByPageCount && slicedBuffer == null ? 'too_many_pages' : null)
  const skipExtraction = skipReason !== null

  // Bring-your-own-extraction: skip the Bedrock call entirely and seed an
  // empty extraction skeleton. The caller is expected to PUT the parsed
  // fields via /items/:id/extracted-data before converting to a supplier
  // invoice. extracted_data is never null in the DB; an empty skeleton
  // keeps downstream readers (UI, MCP) happy.
  const extraction = skipExtraction
    ? { data: emptyResult(), rawText: null, model: null, skipped: null }
    : await extractInvoiceFields({
        buffer: Buffer.from(slicedBuffer ?? file.buffer),
        mimeType: file.type,
        fileName: file.name,
        ownCompany: await fetchOwnCompanyIdentity(supabase, companyId),
      })
  const { data: extracted, rawText } = extraction
  if (!skipExtraction && slicedBuffer != null && pageCount != null) {
    extracted.pages = { total: pageCount, analyzed: maxAutoExtractPages }
  }

  // Supplier match by org-nr, then VAT number, then case-insensitive name
  // (no AI fuzz).
  const matchedSupplierId = await matchSupplierId(supabase, companyId, extracted.supplier)

  const { data: inbox, error: inboxError } = await supabase
    .from('invoice_inbox_items')
    .insert({
      company_id: companyId,
      user_id: userId,
      status: 'received',
      source,
      document_id: doc.id,
      extracted_data: extracted as unknown as Record<string, unknown>,
      extraction_skipped: skipExtraction,
      matched_supplier_id: matchedSupplierId,
      email_from: emailMeta?.from || null,
      email_subject: emailMeta?.subject || null,
      email_received_at: emailMeta?.receivedAt || null,
      email_body_text: emailMeta?.bodyText || null,
      resend_email_id: emailMeta?.resendEmailId || null,
      resend_attachment_id: emailMeta?.resendAttachmentId || null,
      raw_email_payload: emailMeta?.messageId
        ? { messageId: emailMeta.messageId, filename: file.name }
        : null,
      correlation_id: correlationId,
      matched_transaction_id: matchedTransactionId ?? null,
      // Chat-channel provenance. Explicit nulls (not a conditional spread)
      // keep the payload statically checkable; a null insert is identical to
      // omitting the column, so the email/upload behavior is unchanged.
      whatsapp_message_id: opts.channelMeta?.whatsappMessageId ?? null,
      channel_context: opts.channelMeta
        ? { channel: 'whatsapp', caption: sanitiseCaption(opts.channelMeta.caption) }
        : null,
    })
    .select('*')
    .single()

  if (inboxError) throw new Error(`Failed to create inbox item: ${inboxError.message}`)

  // The extension yielded to us (extractionOwner); put the outcome where it
  // would have written it, so the document row tells the same story.
  await mirrorExtractionToDocument(doc.id, {
    data: extracted,
    rawText,
    model: extraction.model ?? null,
    skipped: skipReason ?? extraction.skipped ?? null,
  })

  try {
    await appendProcessingHistory({
      companyId,
      correlationId,
      aggregateType: 'Document',
      aggregateId: doc.id,
      eventType: 'DocumentExtractionAttempted',
      payload: {
        document_id: doc.id,
        inbox_item_id: inbox.id,
        succeeded: rawText != null && rawText.length > 0,
        extracted_total: extracted.totals.total,
        has_org_number: extracted.supplier.orgNumber != null,
        has_ocr: extracted.invoice.paymentReference != null,
        skipped: skipExtraction,
        skip_reason: skipReason,
        page_count: pageCount,
      },
      actor: { type: 'system', id: 'invoice-inbox-extract' },
      occurredAt: new Date(),
    })
  } catch (err) {
    console.error('[invoice-inbox] Failed to append DocumentExtractionAttempted:', err)
  }

  return {
    document_id: doc.id,
    inbox_item_id: inbox.id,
    status: inbox.status,
    extracted_data: extracted,
    matched_supplier_id: inbox.matched_supplier_id,
    matched_transaction_id: inbox.matched_transaction_id,
    extraction_skipped: skipExtraction,
    skip_reason: skipReason,
    page_count: pageCount,
  }
}

// ── Deferred extraction (staged web upload) ──────────────────

interface DeferredExtractionJob {
  itemId: string
  documentId: string
  companyId: string
  correlationId: string
  file: { name: string; buffer: ArrayBuffer; type: string }
  pageCount: number | null
  gatedByPageCount: boolean
  /** Snapshot of maxPagesForAutoExtract() from the request, so the gate
   *  verdict and the slice/stamp below cannot disagree. */
  maxAutoExtractPages: number
}

/**
 * Run extraction after the upload response is sent, then CAS-flip the
 * 'processing' row to 'received'. Exact dispatch-kick idiom (whatsapp-inbox
 * kickInboundProcessing): never awaited, never throws out, falls back to a
 * microtask outside a request scope (tests). The request-scoped supabase
 * client may be gone once the response is flushed, so the worker builds its
 * own cookieless service client.
 */
function scheduleDeferredExtraction(job: DeferredExtractionJob): void {
  const run = async (): Promise<void> => {
    try {
      const supabase = createServiceClientNoCookies()

      // Mirrors the synchronous path: extraction failures are swallowed into
      // the empty skeleton (extractInvoiceFields does most of that itself);
      // an unsliceable long PDF becomes the too_many_pages skip.
      let extracted: InvoiceExtractionResult = emptyResult()
      let rawText: string | null = null
      let model: string | null = null
      let extractionSkipped = false
      let skipReason: string | null = null
      try {
        const slicedBuffer = job.gatedByPageCount
          ? await slicePdfForExtraction(job.file.buffer, job.maxAutoExtractPages)
          : null
        if (job.gatedByPageCount && slicedBuffer == null) {
          extractionSkipped = true
          skipReason = 'too_many_pages'
        } else {
          const result = await extractInvoiceFields({
            buffer: Buffer.from(slicedBuffer ?? job.file.buffer),
            mimeType: job.file.type,
            fileName: job.file.name,
            ownCompany: await fetchOwnCompanyIdentity(supabase, job.companyId),
          })
          extracted = result.data
          rawText = result.rawText
          model = result.model ?? null
          if (result.skipped) {
            // No model call could be made (AI unconfigured, no vision on this
            // backend, rasterizer missing). Same UI affordance as the other
            // skips: the row lands with the empty skeleton and the hint.
            extractionSkipped = true
            skipReason = result.skipped
          }
          if (slicedBuffer != null && job.pageCount != null) {
            extracted.pages = { total: job.pageCount, analyzed: job.maxAutoExtractPages }
          }
        }
      } catch (err) {
        // Persist the empty skeleton below, exactly like the sync path does
        // on a swallowed failure: the row becomes a normal received item with
        // empty fields, and the manual-edit / retry affordances take over.
        console.error('[invoice-inbox] Deferred extraction failed:', err)
      }

      // Supplier match by org-nr, then VAT number, then case-insensitive name
      // (no AI fuzz).
      const matchedSupplierId = await matchSupplierId(
        supabase,
        job.companyId,
        extracted.supplier,
      )

      // CAS: only the row still waiting on THIS worker flips. A user retry
      // or the sweep cron may have claimed it first; their result wins.
      const { data: claimed, error: updateError } = await supabase
        .from('invoice_inbox_items')
        .update({
          status: 'received',
          extracted_data: extracted as unknown as Record<string, unknown>,
          extraction_skipped: extractionSkipped,
          matched_supplier_id: matchedSupplierId,
        })
        .eq('id', job.itemId)
        .eq('status', 'processing')
        .select('id')
      if (updateError) {
        // The sweep cron flips the row to 'received' once it goes stale.
        console.error('[invoice-inbox] Deferred extraction flip failed:', updateError)
        return
      }
      if (!Array.isArray(claimed) || claimed.length === 0) return

      await mirrorExtractionToDocument(job.documentId, {
        data: extracted,
        rawText,
        model,
        skipped: skipReason,
      })

      try {
        await appendProcessingHistory({
          companyId: job.companyId,
          correlationId: job.correlationId,
          aggregateType: 'Document',
          aggregateId: job.documentId,
          eventType: 'DocumentExtractionAttempted',
          payload: {
            document_id: job.documentId,
            inbox_item_id: job.itemId,
            succeeded: rawText != null && rawText.length > 0,
            extracted_total: extracted.totals.total,
            has_org_number: extracted.supplier.orgNumber != null,
            has_ocr: extracted.invoice.paymentReference != null,
            skipped: extractionSkipped,
            skip_reason: skipReason,
            page_count: job.pageCount,
          },
          actor: { type: 'system', id: 'invoice-inbox-extract' },
          occurredAt: new Date(),
        })
      } catch (err) {
        console.error('[invoice-inbox] Failed to append DocumentExtractionAttempted:', err)
      }
    } catch (err) {
      console.error('[invoice-inbox] Deferred extraction worker crashed:', err)
      // Best-effort flip so the row does not sit in 'processing' until the
      // sweep: same CAS, same empty skeleton the sync swallow persists.
      try {
        await createServiceClientNoCookies()
          .from('invoice_inbox_items')
          .update({
            status: 'received',
            extracted_data: emptyResult() as unknown as Record<string, unknown>,
            extraction_skipped: false,
          })
          .eq('id', job.itemId)
          .eq('status', 'processing')
        await mirrorExtractionToDocument(job.documentId, { data: null, rawText: null })
      } catch {
        // The sweep cron is the recovery of last resort.
      }
    }
  }

  try {
    after(() => run())
  } catch {
    queueMicrotask(() => void run())
  }
}
