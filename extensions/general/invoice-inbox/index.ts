import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { extractInvoiceFields } from './lib/extract-invoice-fields'
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
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import type { InvoiceExtractionResult, InvoiceInboxItem, SupplierInvoice, SupplierInvoiceItem } from '@/types'

const MAX_FILE_SIZE = 10 * 1024 * 1024

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
  emailMeta?: EmailMeta
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

  const { data: extracted, rawText } = await extractInvoiceFields({
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

        try {
          const buffer = await file.arrayBuffer()
          const result = await uploadAndExtract(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            { name: file.name, buffer, type: file.type },
            'upload'
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
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 20), 50)

        let query = ctx.supabase
          .from('invoice_inbox_items')
          .select(`
            id, status, source, created_at, extracted_data,
            matched_supplier_id, document_id, email_from, email_subject,
            email_received_at, error_message, created_supplier_invoice_id,
            resend_email_id
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

          const { data: extracted } = await extractInvoiceFields({
            buffer: Buffer.from(buffer),
            mimeType: file.type,
            fileName: file.name,
          })

          const { error: linkError } = await ctx.supabase
            .from('invoice_inbox_items')
            .update({
              document_id: doc.id,
              extracted_data: extracted as unknown as Record<string, unknown>,
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
            data: { document_id: doc.id, inbox_item_id: id, extracted_data: extracted },
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
        const attachments = fullEmail.attachments ?? []

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
            if (!UPLOAD_ALLOWED_MIME_TYPES.has(download.contentType)) {
              results.push({ attachment_id: att.id, error: `Unsupported type ${download.contentType}` })
              continue
            }
            if (download.buffer.byteLength > MAX_FILE_SIZE) {
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
          .select('id, created_supplier_invoice_id')
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
            }
          } catch (err) {
            console.error('[invoice-inbox/convert] Failed to create registration journal entry:', err)
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
  ],
}

// Re-export the extraction shape for tests / consumers.
export type { InvoiceExtractionResult }
