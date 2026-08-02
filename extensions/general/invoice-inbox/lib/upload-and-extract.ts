import { uploadDocument } from '@/lib/core/documents/document-service'
import { extractInvoiceFields, emptyResult } from './extract-invoice-fields'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { PDFDocument } from 'pdf-lib'
import path from 'node:path'

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

// AI extraction is tuned for single-page receipts/invoices. Documents above
// this page count tend to be sales reports, bank statements, or contracts:
// Bedrock churns for minutes and still extracts nothing useful (issue #553).
// Above the limit we skip extraction entirely; the document still lands in
// the inbox and can be attached to a transaction or converted manually.
export const MAX_PAGES_FOR_AUTO_EXTRACT = 3

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

// Long PDFs used to skip extraction entirely (issue #553). Invoice data
// almost always sits on the first page(s), so instead we extract from a
// slim copy of the first MAX_PAGES_FOR_AUTO_EXTRACT pages and record the
// truncation in extracted_data.pages. Returns null when slicing fails
// (encrypted/malformed PDF) so the caller can fall back to the old skip.
export async function slicePdfForExtraction(
  buffer: ArrayBuffer,
  maxPages: number
): Promise<ArrayBuffer | null> {
  try {
    const src = await PDFDocument.load(buffer, { updateMetadata: false })
    const dst = await PDFDocument.create()
    const pages = await dst.copyPages(
      src,
      Array.from({ length: Math.min(maxPages, src.getPageCount()) }, (_, i) => i)
    )
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

export interface EmailMeta {
  from?: string | null
  subject?: string | null
  receivedAt?: string | null
  messageId?: string | null
  bodyText?: string | null
  resendEmailId?: string | null
  resendAttachmentId?: string | null
}

// ── Shared helper: upload + extract + create inbox item ──────

export async function uploadAndExtract(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  companyId: string,
  file: { name: string; buffer: ArrayBuffer; type: string },
  source: 'upload' | 'email',
  emailMeta?: EmailMeta,
  // Pre-match the new inbox item to a bank transaction. Set when the caller
  // already knows which transaction this receipt belongs to (e.g. the
  // VerifyAndBookOverlay opened from a transaction row's paperclip or from
  // a transaction-anchored chat). Skipped silently if missing.
  matchedTransactionId?: string | null,
  opts: { skipExtraction?: boolean } = {},
) {
  const correlationId = crypto.randomUUID()

  const doc = await uploadDocument(supabase, userId, companyId, {
    name: file.name,
    buffer: file.buffer,
    type: file.type,
  }, {
    upload_source: source === 'email' ? 'email' : 'file_upload',
  })

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
      actor: source === 'email' ? { type: 'system', id: 'resend-inbound' } : { type: 'user', id: userId },
      occurredAt: new Date(),
    })
  } catch (err) {
    console.error('[invoice-inbox] Failed to append DocumentIngested:', err)
  }

  // Page-count gate (issue #553): PDFs above MAX_PAGES_FOR_AUTO_EXTRACT
  // skip extraction. Bedrock would otherwise block the upload response for
  // minutes on a 6-page sales report and return nothing useful. Images and
  // non-PDFs are never gated (single-page by definition). countPdfPages
  // returns null on malformed PDFs: we treat null as "not gated" and fall
  // through to the existing extraction path so today's behavior is preserved.
  const pageCount =
    file.type === 'application/pdf' ? await countPdfPages(file.buffer) : null
  const gatedByPageCount =
    pageCount != null && pageCount > MAX_PAGES_FOR_AUTO_EXTRACT
  const sandbox = await isSandboxCompany(supabase, companyId)
  // Paid-tier gate: AI document OCR (Bedrock, via extractInvoiceFields) is the
  // `ai` capability. A company without it (free/manual tier) must never trigger
  // paid extraction: we seed an empty skeleton exactly like the sandbox / BYO-
  // extraction path, so the document is still stored and can be filled in
  // manually. Highest priority (a hard paywall rule, not a heuristic).
  const hasAiEntitlement = await hasCapability(supabase, companyId, CAPABILITY.ai)
  // Long PDFs are sliced to their first pages instead of skipped, but only
  // when extraction would actually run: slicing after an entitlement/sandbox/
  // opt-out verdict would be wasted CPU.
  const slicedBuffer =
    gatedByPageCount && hasAiEntitlement && !sandbox && !opts.skipExtraction
      ? await slicePdfForExtraction(file.buffer, MAX_PAGES_FOR_AUTO_EXTRACT)
      : null
  // Skip-reason priority: no-AI-entitlement > sandbox > client opt-out >
  // page-count. Opt-out now outranks the page gate (an opted-out caller never
  // extracts regardless of length), and too_many_pages only fires when the
  // slice fallback also failed (encrypted/malformed PDF).
  const skipReason: 'no_ai_entitlement' | 'too_many_pages' | 'client_opt_out' | 'sandbox' | null =
    !hasAiEntitlement
      ? 'no_ai_entitlement'
      : sandbox
        ? 'sandbox'
        : opts.skipExtraction
          ? 'client_opt_out'
          : gatedByPageCount && slicedBuffer == null
            ? 'too_many_pages'
            : null
  const skipExtraction = skipReason !== null

  // Bring-your-own-extraction: skip the Bedrock call entirely and seed an
  // empty extraction skeleton. The caller is expected to PUT the parsed
  // fields via /items/:id/extracted-data before converting to a supplier
  // invoice. extracted_data is never null in the DB; an empty skeleton
  // keeps downstream readers (UI, MCP) happy.
  const { data: extracted, rawText } = skipExtraction
    ? { data: emptyResult(), rawText: null }
    : await extractInvoiceFields({
        buffer: Buffer.from(slicedBuffer ?? file.buffer),
        mimeType: file.type,
        fileName: file.name,
      })
  if (!skipExtraction && slicedBuffer != null && pageCount != null) {
    extracted.pages = { total: pageCount, analyzed: MAX_PAGES_FOR_AUTO_EXTRACT }
  }

  // Supplier match by org-nr, then case-insensitive name (no AI fuzz).
  let matchedSupplierId: string | null = null
  if (extracted.supplier.orgNumber) {
    const { data: s } = await supabase
      .from('suppliers')
      .select('id')
      .eq('company_id', companyId)
      .eq('org_number', extracted.supplier.orgNumber)
      .limit(1)
      .maybeSingle()
    if (s) matchedSupplierId = s.id
  }
  if (!matchedSupplierId && extracted.supplier.name) {
    const { data: s } = await supabase
      .from('suppliers')
      .select('id')
      .eq('company_id', companyId)
      .ilike('name', extracted.supplier.name)
      .limit(1)
      .maybeSingle()
    if (s) matchedSupplierId = s.id
  }

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
    })
    .select('*')
    .single()

  if (inboxError) throw new Error(`Failed to create inbox item: ${inboxError.message}`)

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
