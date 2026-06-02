import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { extractInvoiceFields, ExtractionSchema, emptyResult } from './lib/extract-invoice-fields'
import {
  verifyInboundWebhook,
  fetchReceivingEmail,
  fetchInboundAttachment,
  extractLocalPartForDomain,
  isEmailReceivedEvent,
  ResendSignatureError,
} from './lib/resend-inbound'
import {
  rotateCompanyInbox,
  getActiveInbox,
  composeInboxAddress,
} from './lib/inbox-provisioning'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { CreateSupplierInvoiceSchema, BookInboxItemDirectlySchema } from '@/lib/api/schemas'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import { simpleParser } from 'mailparser'
import { PDFDocument } from 'pdf-lib'
import path from 'node:path'

/**
 * Defensive filename sanitisation for content arriving from .eml inner
 * attachments and rejected-attachment metadata. The document-service already
 * sanitises before storage paths are built (lib/core/documents/document-service.ts),
 * so this is defense-in-depth: strip directory traversal sequences and exotic
 * characters before they ever flow into DB columns or downstream consumers.
 */
function sanitiseFilename(raw: string | null | undefined, fallback: string): string {
  const base = path.basename(String(raw ?? '').trim())
  const cleaned = base.replace(/[^\w.-]/g, '_').slice(0, 200)
  return cleaned || fallback
}

function sanitiseMime(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim().slice(0, 120)
  return /^[\w./+-]+$/.test(value) ? value : 'application/octet-stream'
}
import type { InvoiceExtractionResult, InvoiceInboxItem, SupplierInvoice, SupplierInvoiceItem } from '@/types'

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_ATTACHMENTS_PER_EMAIL = 20

// AI extraction is tuned for single-page receipts/invoices. Documents above
// this page count tend to be sales reports, bank statements, or contracts —
// Bedrock churns for minutes and still extracts nothing useful (issue #553).
// Above the limit we skip extraction entirely; the document still lands in
// the inbox and can be attached to a transaction or converted manually.
const MAX_PAGES_FOR_AUTO_EXTRACT = 3

// Returns the page count for a PDF buffer, or null if the buffer isn't a
// parseable PDF. Errors fall through so callers can treat "unknown" the same
// as "small enough" — preserves today's behavior on malformed inputs.
async function countPdfPages(buffer: ArrayBuffer): Promise<number | null> {
  try {
    const pdf = await PDFDocument.load(buffer, { updateMetadata: false })
    return pdf.getPageCount()
  } catch {
    return null
  }
}

// Sandbox companies (24h anonymous demo accounts) skip the Bedrock extraction
// pipeline entirely. The document still uploads, the inbox row still lands,
// and the user can fill the fields in by hand — but no Claude tokens are
// spent on a throwaway account. See migration 20260311120000 for the column.
async function isSandboxCompany(
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

// Partial-update schema for the /items/:id/fields PATCH route. Only the
// scalar fields the UI exposes for inline editing — line items and
// vatBreakdown stay AI-managed for now and are preserved by the merge.
const NullableString = z.string().trim().max(500).nullable()
const NullableDate = z
  .string()
  .regex(
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
    'Invalid date — expected YYYY-MM-DD'
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
      // ISO 4217 — three uppercase letters. We accept the user's edit only
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

const UPLOAD_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
])

interface EmailMeta {
  from?: string | null
  subject?: string | null
  receivedAt?: string | null
  messageId?: string | null
  bodyText?: string | null
  resendEmailId?: string | null
  resendAttachmentId?: string | null
}

// ── Shared helper: upload + extract + create inbox item ──────

async function uploadAndExtract(
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
  // returns null on malformed PDFs — we treat null as "not gated" and fall
  // through to the existing extraction path so today's behavior is preserved.
  const pageCount =
    file.type === 'application/pdf' ? await countPdfPages(file.buffer) : null
  const gatedByPageCount =
    pageCount != null && pageCount > MAX_PAGES_FOR_AUTO_EXTRACT
  const sandbox = await isSandboxCompany(supabase, companyId)
  // Skip-reason priority: sandbox > page-count > client opt-out. Sandbox
  // wins because it's a hard cost-control rule, not a heuristic.
  const skipReason: 'too_many_pages' | 'client_opt_out' | 'sandbox' | null = sandbox
    ? 'sandbox'
    : gatedByPageCount
      ? 'too_many_pages'
      : opts.skipExtraction
        ? 'client_opt_out'
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
        buffer: Buffer.from(file.buffer),
        mimeType: file.type,
        fileName: file.name,
      })

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
              error:
                limit.scope === 'minute'
                  ? 'För många uppladdningar på kort tid. Försök igen om en stund.'
                  : 'Dagsgränsen för uppladdningar är nådd. Försök igen imorgon.',
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

        if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
        if (file.size > MAX_FILE_SIZE) {
          return NextResponse.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` }, { status: 400 })
        }
        if (!UPLOAD_ALLOWED_MIME_TYPES.has(file.type)) {
          return NextResponse.json(
            { error: `Unsupported file type: ${file.type}. Allowed: PDF, JPEG, PNG, HEIC, WebP` },
            { status: 400 }
          )
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
            return NextResponse.json(
              { error: 'matched_transaction_id refers to a transaction outside this company.' },
              { status: 400 },
            )
          }
        }

        try {
          const buffer = await file.arrayBuffer()
          const result = await uploadAndExtract(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            { name: file.name, buffer, type: file.type },
            'upload',
            undefined,
            matchedTransactionId,
            { skipExtraction },
          )
          return NextResponse.json({ data: result })
        } catch (error) {
          console.error('[invoice-inbox/upload] Failed:', error)
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Upload failed' },
            { status: 500 }
          )
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
            email_received_at, error_message, created_supplier_invoice_id,
            matched_transaction_id, created_journal_entry_id,
            resend_email_id, extraction_skipped
          `)
          .eq('company_id', ctx.companyId)
          .order('created_at', { ascending: false })
          .limit(limit)

        if (status) query = query.eq('status', status)

        const { data, error } = await query
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        return NextResponse.json({ data: { items: data, count: data?.length ?? 0 } })
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

        return NextResponse.json({ data })
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
          .select('id, extracted_data, created_supplier_invoice_id')
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
        const current = (item.extracted_data ?? {}) as InvoiceExtractionResult
        const merged: InvoiceExtractionResult = {
          supplier: { ...current.supplier, ...body.supplier },
          invoice: { ...current.invoice, ...body.invoice },
          totals: { ...current.totals, ...body.totals },
          lineItems: current.lineItems ?? [],
          vatBreakdown: current.vatBreakdown ?? [],
          confidence: current.confidence ?? 0,
        }

        const { data: updated, error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({ extracted_data: merged as unknown as Record<string, unknown> })
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .select('id, extracted_data')
          .single()

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
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

        // Rate-limit BYO extraction the same way fresh uploads are limited —
        // both paths inject extracted_data into invoice_inbox_items, so an
        // unbounded BYO loop is the same abuse surface as an upload flood
        // (ISO 27001 A.8.12, data-injection guard).
        const rl = await checkInboxUploadRateLimit(ctx.supabase, ctx.companyId)
        if (!rl.ok) {
          return NextResponse.json(
            { error: `För många förfrågningar — försök igen om en stund.` },
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
          // distinguish it from a perfect AI parse — financial-data
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
        // same auto-link the AI path uses. Skipped if neither key is present.
        let matchedSupplierId: string | null = null
        if (extracted.supplier.orgNumber) {
          const { data: s } = await ctx.supabase
            .from('suppliers')
            .select('id')
            .eq('company_id', ctx.companyId)
            .eq('org_number', extracted.supplier.orgNumber)
            .limit(1)
            .maybeSingle()
          if (s) matchedSupplierId = s.id
        }
        if (!matchedSupplierId && extracted.supplier.name) {
          const { data: s } = await ctx.supabase
            .from('suppliers')
            .select('id')
            .eq('company_id', ctx.companyId)
            .ilike('name', extracted.supplier.name)
            .limit(1)
            .maybeSingle()
          if (s) matchedSupplierId = s.id
        }

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
        // the response — the override has already happened.
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
        if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
        if (file.size > MAX_FILE_SIZE) {
          return NextResponse.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` }, { status: 400 })
        }
        if (!UPLOAD_ALLOWED_MIME_TYPES.has(file.type)) {
          return NextResponse.json(
            { error: `Unsupported file type: ${file.type}. Allowed: PDF, JPEG, PNG, HEIC, WebP` },
            { status: 400 }
          )
        }

        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, document_id, status, correlation_id, created_supplier_invoice_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!item) return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 })
        if (item.created_supplier_invoice_id) {
          return NextResponse.json({ error: 'Redan bokfört — kan inte ersätta bilden.' }, { status: 409 })
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
          })

          // Same page-count gate as /upload (issue #553) — attaching a 6-page
          // sales report to an existing inbox row should not block on Bedrock.
          // Sandbox companies skip Bedrock unconditionally.
          const pageCount =
            file.type === 'application/pdf' ? await countPdfPages(buffer) : null
          const gatedByPageCount =
            pageCount != null && pageCount > MAX_PAGES_FOR_AUTO_EXTRACT
          const sandbox = await isSandboxCompany(ctx.supabase, ctx.companyId)
          const skipReason: 'too_many_pages' | 'sandbox' | null = sandbox
            ? 'sandbox'
            : gatedByPageCount
              ? 'too_many_pages'
              : null
          const skipExtraction = skipReason !== null

          const { data: extracted } = skipExtraction
            ? { data: emptyResult() }
            : await extractInvoiceFields({
                buffer: Buffer.from(buffer),
                mimeType: file.type,
                fileName: file.name,
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
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Attach failed' },
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
        // transactions.document_id below — the TransactionInboxCard reads
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
            { error: 'Redan bokfört — kan inte köra om tolkningen.' },
            { status: 409 },
          )
        }
        if (!item.document_id) {
          return NextResponse.json(
            { error: 'Ingen bilaga att tolka om.' },
            { status: 400 },
          )
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

        const { data: blob, error: dlError } = await ctx.supabase.storage
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
          const { data: extracted } = await extractInvoiceFields({
            buffer,
            mimeType: doc.mime_type,
            fileName: doc.file_name,
          })

          const { error: updateError } = await ctx.supabase
            .from('invoice_inbox_items')
            .update({
              status: 'received',
              error_message: null,
              extracted_data: extracted as unknown as Record<string, unknown>,
              // Retry is user-initiated and bypasses the page-count gate by
              // design — the user explicitly opted into the slow path.
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

        const localPart = extractLocalPartForDomain(to, domain)
        if (!localPart) {
          console.warn('[invoice-inbox/inbound] No recipient matched domain', { to, domain })
          return NextResponse.json({ error: 'No matching recipient' }, { status: 404 })
        }

        const serviceSupabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        const { data: inbox } = await serviceSupabase
          .from('company_inboxes')
          .select('id, company_id, status')
          .eq('local_part', localPart)
          .maybeSingle()

        if (!inbox) {
          return NextResponse.json({ error: 'Address not found' }, { status: 404 })
        }
        if (inbox.status !== 'active') {
          return NextResponse.json({ error: 'Address no longer active' }, { status: 410 })
        }

        const { data: company } = await serviceSupabase
          .from('companies')
          .select('created_by')
          .eq('id', inbox.company_id)
          .single()

        if (!company?.created_by) {
          console.error('[invoice-inbox/inbound] Company has no created_by', inbox.company_id)
          return NextResponse.json({ error: 'Company owner missing' }, { status: 500 })
        }
        const userId = company.created_by

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

        // Per-company rate limit (30/min, 500/day). Same Postgres-backed
        // RPC as /upload. Acknowledge + drop on cap — returning 429 to
        // Resend would just consume more budget via their retry.
        const limit = await checkInboxUploadRateLimit(serviceSupabase, inbox.company_id)
        if (!limit.ok) {
          try {
            await appendProcessingHistory({
              companyId: inbox.company_id,
              correlationId: email_id,
              aggregateType: 'System',
              aggregateId: email_id,
              eventType: 'RateLimitedDropped',
              payload: {
                scope: limit.scope,
                retry_after_sec: limit.retryAfterSec,
                attachment_count: rawAttachments.length,
                from,
                subject,
              },
              actor: { type: 'system', id: 'resend-inbound' },
              occurredAt: new Date(),
            })
          } catch (err) {
            console.error('[invoice-inbox/inbound] RateLimitedDropped append failed:', err)
          }
          return NextResponse.json({ data: { processed: 0, reason: 'rate_limited' } })
        }

        // Per-email attachment cap. 20 covers any legitimate batched
        // supplier email; an attacker stuffing 500 PDFs into one message
        // gets truncated and a single history event records the drop.
        const totalAttachments = rawAttachments.length
        const attachments = rawAttachments.slice(0, MAX_ATTACHMENTS_PER_EMAIL)
        const truncatedCount = totalAttachments - attachments.length
        if (truncatedCount > 0) {
          try {
            await appendProcessingHistory({
              companyId: inbox.company_id,
              correlationId: email_id,
              aggregateType: 'System',
              aggregateId: email_id,
              eventType: 'AttachmentsTruncated',
              payload: {
                total: totalAttachments,
                processed: attachments.length,
                dropped: truncatedCount,
                from,
                subject,
              },
              actor: { type: 'system', id: 'resend-inbound' },
              occurredAt: new Date(),
            })
          } catch (err) {
            console.error('[invoice-inbox/inbound] AttachmentsTruncated append failed:', err)
          }
        }

        if (attachments.length === 0) {
          await serviceSupabase.from('invoice_inbox_items').insert({
            company_id: inbox.company_id,
            user_id: userId,
            status: 'error',
            source: 'email',
            email_from: from,
            email_subject: subject,
            email_received_at: created_at,
            email_body_text: bodyText,
            resend_email_id: email_id,
            error_message: 'Email had no attachments',
            raw_email_payload: { messageId: message_id },
          })
          return NextResponse.json({ data: { processed: 0, reason: 'no_attachments' } })
        }

        const results: Array<{ attachment_id: string; inbox_item_id?: string; error?: string; duplicate?: boolean }> = []

        // Persist a "rejected" inbox row so the user has visibility into the drop.
        // Without this, attachments that fail MIME validation vanish silently —
        // a common Gmail "forward as attachment" foot-gun until we added .eml
        // handling below.
        const logRejection = async (
          attachmentId: string,
          attachmentName: string | null,
          mime: string,
          reason: string,
        ) => {
          // attachment_name and mime are attacker-controlled (they come from the
          // forwarded email headers); sanitise before they land in the JSONB
          // raw_email_payload column so they can't surface as injection or
          // oversized values when read back into the UI / audit trails.
          try {
            await serviceSupabase.from('invoice_inbox_items').insert({
              company_id: inbox.company_id,
              user_id: userId,
              status: 'error',
              source: 'email',
              email_from: from,
              email_subject: subject,
              email_received_at: created_at,
              email_body_text: bodyText,
              resend_email_id: email_id,
              resend_attachment_id: attachmentId,
              error_message: reason.slice(0, 500),
              raw_email_payload: {
                messageId: message_id,
                attachment_name: sanitiseFilename(attachmentName, 'unknown'),
                mime: sanitiseMime(mime),
              },
            })
          } catch (insertErr) {
            console.error('[invoice-inbox/inbound] Failed to log rejected attachment:', insertErr)
          }
        }

        for (const att of attachments) {
          try {
            const { data: existing } = await serviceSupabase
              .from('invoice_inbox_items')
              .select('id')
              .eq('resend_email_id', email_id)
              .eq('resend_attachment_id', att.id)
              .maybeSingle()
            if (existing) {
              results.push({ attachment_id: att.id, inbox_item_id: existing.id, duplicate: true })
              continue
            }

            const download = await fetchInboundAttachment(email_id, att.id)

            // Gmail "Forward as attachment" wraps the original email as message/rfc822.
            // Unwrap it and process the inner attachments as if they had arrived
            // directly, carrying the inner email's subject/from into our metadata.
            if (download.contentType === 'message/rfc822') {
              const parsed = await simpleParser(Buffer.from(download.buffer))
              const innerAttachments = parsed.attachments || []
              if (innerAttachments.length === 0) {
                await logRejection(att.id, download.filename, download.contentType, 'Det vidarebefordrade meddelandet innehöll inga bilagor')
                results.push({ attachment_id: att.id, error: 'eml_no_inner_attachments' })
                continue
              }
              const innerFrom = parsed.from?.text || from
              const innerSubject = parsed.subject || subject
              for (let i = 0; i < innerAttachments.length; i++) {
                const inner = innerAttachments[i]
                const innerType = sanitiseMime(inner.contentType)
                const innerName = sanitiseFilename(inner.filename, `attachment-${i}`)
                const innerBuffer = inner.content
                if (!innerBuffer) continue
                const innerId = `${att.id}#${i}`
                if (!UPLOAD_ALLOWED_MIME_TYPES.has(innerType)) {
                  await logRejection(innerId, innerName, innerType, `Avvisad bilaga från vidarebefordrat mejl: filtypen ${innerType} stöds inte`)
                  results.push({ attachment_id: innerId, error: `Unsupported type ${innerType}` })
                  continue
                }
                if (innerBuffer.byteLength > MAX_FILE_SIZE) {
                  await logRejection(innerId, innerName, innerType, 'Bilagan i det vidarebefordrade mejlet är för stor')
                  results.push({ attachment_id: innerId, error: 'Inner attachment too large' })
                  continue
                }
                const innerArrayBuffer = new Uint8Array(innerBuffer).buffer
                const innerResult = await uploadAndExtract(
                  serviceSupabase,
                  userId,
                  inbox.company_id,
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
                  }
                )
                results.push({ attachment_id: innerId, inbox_item_id: innerResult.inbox_item_id })
              }
              continue
            }

            if (!UPLOAD_ALLOWED_MIME_TYPES.has(download.contentType)) {
              await logRejection(att.id, download.filename, download.contentType, `Avvisad: filtypen ${download.contentType} stöds inte`)
              results.push({ attachment_id: att.id, error: `Unsupported type ${download.contentType}` })
              continue
            }
            if (download.buffer.byteLength > MAX_FILE_SIZE) {
              await logRejection(att.id, download.filename, download.contentType, 'Bilagan är för stor')
              results.push({ attachment_id: att.id, error: 'Attachment too large' })
              continue
            }

            const result = await uploadAndExtract(
              serviceSupabase,
              userId,
              inbox.company_id,
              { name: download.filename, buffer: download.buffer, type: download.contentType },
              'email',
              {
                from,
                subject,
                receivedAt: created_at,
                messageId: message_id,
                bodyText,
                resendEmailId: email_id,
                resendAttachmentId: att.id,
              }
            )
            results.push({ attachment_id: att.id, inbox_item_id: result.inbox_item_id })
          } catch (err) {
            console.error('[invoice-inbox/inbound] Attachment processing failed:', err)
            results.push({
              attachment_id: att.id,
              error: err instanceof Error ? err.message : 'Unknown error',
            })
          }
        }

        return NextResponse.json({ data: { processed: results.length, results } })
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
            // Self-assessed RC rate (0.06/0.12/0.25) or null — engine defaults
            // to 25% huvudregeln when null for a reverse-charge invoice.
            reverse_charge_rate: body.reverse_charge ? (bodyItem.reverse_charge_rate ?? null) : null,
          }
        })

        const subtotal = items.reduce((sum, i) => sum + i.line_total, 0)
        const totalVat = items.reduce((sum, i) => sum + i.vat_amount, 0)
        const total = Math.round((subtotal + totalVat) * 100) / 100

        const exchangeRate = body.exchange_rate || null
        const subtotalSek = exchangeRate ? Math.round(subtotal * exchangeRate * 100) / 100 : null
        const vatAmountSek = exchangeRate ? Math.round(totalVat * exchangeRate * 100) / 100 : null
        const totalSek = exchangeRate ? Math.round(total * exchangeRate * 100) / 100 : null

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
            currency: body.currency || 'SEK',
            exchange_rate: exchangeRate,
            vat_treatment: body.vat_treatment || 'standard_25',
            reverse_charge: body.reverse_charge || false,
            payment_reference: body.payment_reference || null,
            subtotal: Math.round(subtotal * 100) / 100,
            subtotal_sek: subtotalSek,
            vat_amount: Math.round(totalVat * 100) / 100,
            vat_amount_sek: vatAmountSek,
            total: Math.round(total * 100) / 100,
            total_sek: totalSek,
            remaining_amount: Math.round(total * 100) / 100,
            document_id: item.document_id || null,
            notes: body.notes || null,
          })
          .select()
          .single()

        if (invoiceError || !invoice) {
          return NextResponse.json({ error: invoiceError?.message || 'Failed to create invoice' }, { status: 500 })
        }

        const itemInserts = items.map((lineItem) => ({
          supplier_invoice_id: invoice.id,
          ...lineItem,
        }))

        const { error: itemsError } = await ctx.supabase
          .from('supplier_invoice_items')
          .insert(itemInserts)

        if (itemsError) {
          await ctx.supabase.from('supplier_invoices').delete().eq('id', invoice.id)
          return NextResponse.json({ error: itemsError.message }, { status: 500 })
        }

        const { data: settings } = await ctx.supabase
          .from('company_settings')
          .select('accounting_method')
          .eq('company_id', ctx.companyId)
          .single()

        const accountingMethod = settings?.accounting_method || 'accrual'
        let registrationJournalEntryId: string | null = null

        if (accountingMethod === 'accrual') {
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
            // understating 2440/2641), then surface the error — mirroring the main
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
    // For kontantmetoden users (and ad-hoc receipts) — bypasses the
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
          .select('id, document_id, status, created_supplier_invoice_id, created_journal_entry_id, matched_transaction_id, correlation_id')
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
            notes: body.notes,
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

        // Link the source document to the new entry. Best-effort — the
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

        // If transaction-linked, mark the transaction as booked.
        if (transaction) {
          const { error: txUpdateError } = await ctx.supabase
            .from('transactions')
            .update({
              journal_entry_id: journalEntry.id,
              is_business: true,
              category: 'uncategorized',
            })
            .eq('id', transaction.id)
            .eq('company_id', ctx.companyId)
          if (txUpdateError) {
            console.error('[invoice-inbox/book-direct] Transaction link failed:', txUpdateError)
          }
        }

        // Mark the inbox item as resolved by writing the FK. The status
        // column is intentionally left at 'received' — terminal state is
        // encoded via created_journal_entry_id / matched_transaction_id
        // (see migration 20260504180000_invoice_inbox_remove_ai_columns).
        const { error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({
            created_journal_entry_id: journalEntry.id,
            matched_transaction_id: transaction?.id ?? null,
          })
          .eq('id', id)
          .eq('company_id', ctx.companyId)
        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }

        // The engine already emits journal_entry.committed — no need to
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
  ],
}

// Re-export the extraction shape for tests / consumers.
export type { InvoiceExtractionResult }
