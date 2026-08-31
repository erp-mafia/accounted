/**
 * Hand a routed inbound Peppol document to the supplier-invoice inbox.
 *
 * Follows the mail-hunt precedent (lib/receipt-hunt/ingest.ts): core archives
 * the underlag through uploadDocument() and inserts the inbox row directly,
 * with the extraction already filled in from the structured UBL, so no AI
 * pass runs and the reviewer sees exactly what the sender wrote.
 *
 * What is archived:
 * - the exact received XML, always, as a WORM document (upload_source
 *   'e_invoice', extractionOwner 'none'): that is the räkenskapsinformation;
 * - an embedded PDF rendering, when the sender attached one, as the document
 *   the inbox shows (people read PDFs, not UBL).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { roundOre } from '@/lib/money'
import { matchSupplierId } from '@/lib/suppliers/match-supplier'
import type { PeppolInboundDelivery } from '@/lib/invoices/peppol-inbound'
import type { PeppolInboundDocument, PeppolInboundLine } from '@/lib/invoices/peppol-inbound-ubl'
import type {
  ExtractedInvoiceLineItem,
  InboxChannelContext,
  InvoiceExtractionResult,
  VatBreakdownItem,
} from '@/types'

function formatGiro(digits: string | null): string | null {
  if (!digits) return null
  // Bankgiro 7-8 digits: XXX-XXXX / XXXX-XXXX; plusgiro: digits with a final
  // check digit after the hyphen. Both follow the inbox's "with hyphen" rule.
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4)}`
  return `${digits.slice(0, -1)}-${digits.slice(-1)}`
}

function lineToExtracted(line: PeppolInboundLine, sign: 1 | -1): ExtractedInvoiceLineItem {
  const quantity = line.quantity ?? 1
  const lineTotal = line.lineExtensionAmount ?? (line.priceAmount !== null ? roundOre(line.priceAmount * quantity) : 0)
  return {
    description: line.name ?? line.description ?? line.sellersItemId ?? '',
    quantity,
    unitPrice: line.priceAmount !== null ? roundOre(line.priceAmount * sign) : null,
    lineTotal: roundOre(lineTotal * sign),
    vatRate: line.vatPercent !== null ? Math.round(line.vatPercent) : null,
    accountSuggestion: null,
  }
}

/**
 * Map the UBL reading onto the inbox's extraction shape. Credit notes are
 * expressed as negative amounts, which is how the inbox/supplier-invoice flow
 * already represents a credit from the supplier.
 */
export function peppolDocumentToExtraction(document: PeppolInboundDocument): InvoiceExtractionResult {
  const sign: 1 | -1 = document.documentType === 'CreditNote' ? -1 : 1
  const bankgiro = document.paymentMeans.map((m) => m.bankgiro).find((v): v is string => !!v) ?? null
  const plusgiro = document.paymentMeans.map((m) => m.plusgiro).find((v): v is string => !!v) ?? null
  const paymentReference = document.paymentMeans.map((m) => m.paymentId).find((v): v is string => !!v) ?? null
  const supplier = document.supplier
  const addressParts = [
    supplier.street,
    supplier.additionalStreet,
    [supplier.postalZone, supplier.city].filter(Boolean).join(' ') || null,
    supplier.countryCode && supplier.countryCode.toUpperCase() !== 'SE' ? supplier.countryCode : null,
  ].filter((part): part is string => !!part)

  const vatBreakdown: VatBreakdownItem[] = document.taxSubtotals
    .filter((s) => s.percent !== null && s.taxableAmount !== null && s.taxAmount !== null)
    .map((s) => ({
      rate: Math.round(s.percent as number),
      base: roundOre((s.taxableAmount as number) * sign),
      amount: roundOre((s.taxAmount as number) * sign),
    }))

  const subtotal = document.totals.taxExclusive ?? document.totals.lineExtension
  const vatAmount = document.totals.taxAmount
  const total = document.totals.payable ?? document.totals.taxInclusive

  return {
    documentKind: 'supplier_invoice',
    legibility: 'good',
    supplier: {
      name: supplier.name,
      orgNumber: supplier.orgNumber,
      vatNumber: supplier.vatNumber,
      address: addressParts.length ? addressParts.join(', ') : null,
      bankgiro: formatGiro(bankgiro),
      plusgiro: formatGiro(plusgiro),
    },
    invoice: {
      invoiceNumber: document.documentId || null,
      invoiceDate: document.issueDate,
      dueDate: document.dueDate,
      paymentReference,
      currency: document.currency ?? 'SEK',
    },
    lineItems: document.lines.map((line) => lineToExtracted(line, sign)),
    totals: {
      subtotal: subtotal !== null ? roundOre(subtotal * sign) : null,
      vatAmount: vatAmount !== null ? roundOre(vatAmount * sign) : null,
      total: total !== null ? roundOre(total * sign) : null,
      roundingAmount: document.totals.payableRounding !== null && document.totals.payableRounding !== 0
        ? roundOre(document.totals.payableRounding * sign)
        : null,
    },
    vatBreakdown,
    // Structured e-invoice: the numbers are the sender's own, not a model's reading.
    confidence: 1,
  }
}

function safeFilename(base: string, extension: string): string {
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'peppol'
  return `${cleaned}.${extension}`
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Who the inbox row belongs to: the member who registered, else the company's first owner. */
export async function resolvePeppolInboxOwner(args: {
  service: SupabaseClient
  companyId: string
  provider: string
}): Promise<string | null> {
  const { data: registration } = await args.service
    .from('peppol_registrations')
    .select('user_id')
    .eq('company_id', args.companyId)
    .eq('provider', args.provider)
    .eq('status', 'registered')
    .limit(1)
    .maybeSingle()
  const registrant = (registration as { user_id: string | null } | null)?.user_id
  if (registrant) return registrant

  const { data: owner } = await args.service
    .from('company_members')
    .select('user_id')
    .eq('company_id', args.companyId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (owner as { user_id: string } | null)?.user_id ?? null
}

/**
 * The deliverer used by the inbound sync. Idempotent on the provider document
 * id via the inbox's per-channel unique index: a replay returns the existing
 * inbox item instead of a second one.
 */
export async function deliverPeppolDocumentToInbox(
  service: SupabaseClient,
  delivery: PeppolInboundDelivery,
): Promise<{ inboxItemId: string | null; xmlDocumentId: string | null }> {
  const { row, companyId, document, xml } = delivery

  const { data: existingItem } = await service
    .from('invoice_inbox_items')
    .select('id, document_id, channel_context')
    .eq('company_id', companyId)
    .eq('source', 'peppol')
    .eq('channel_context->>peppol_document_id', row.provider_document_id)
    .maybeSingle()
  if (existingItem) {
    const context = (existingItem as { channel_context?: InboxChannelContext | null }).channel_context
    return {
      inboxItemId: (existingItem as { id: string }).id,
      xmlDocumentId: context?.peppol_xml_document_id ?? row.xml_document_id ?? null,
    }
  }

  const userId = await resolvePeppolInboxOwner({ service, companyId, provider: row.provider })
  if (!userId) throw new Error('No owner member found for the receiving company')

  const baseName = `peppol-${document.documentType === 'CreditNote' ? 'kreditnota' : 'faktura'}-${document.documentId || row.provider_document_id}`

  // 1. The exact received XML, always archived.
  let xmlDocumentId: string | null = row.xml_document_id
  if (!xmlDocumentId && xml) {
    const archived = await uploadDocument(
      service,
      userId,
      companyId,
      { name: safeFilename(baseName, 'xml'), buffer: toArrayBuffer(Buffer.from(xml, 'utf8')), type: 'application/xml' },
      { upload_source: 'e_invoice', dedupeByContent: true, extractionOwner: 'none' },
    )
    xmlDocumentId = archived.id
  }

  // 2. An embedded PDF rendering, when the sender attached one.
  let pdfDocumentId: string | null = null
  const pdf = document.attachments.find((a) => a.base64 && (a.mimeType ?? '').toLowerCase() === 'application/pdf')
  if (pdf?.base64) {
    try {
      const bytes = Buffer.from(pdf.base64, 'base64')
      if (bytes.length > 0) {
        const rendered = await uploadDocument(
          service,
          userId,
          companyId,
          { name: pdf.filename || safeFilename(baseName, 'pdf'), buffer: toArrayBuffer(bytes), type: 'application/pdf' },
          { upload_source: 'e_invoice', dedupeByContent: true, extractionOwner: 'none' },
        )
        pdfDocumentId = rendered.id
      }
    } catch {
      // A broken attachment must not keep the invoice out of the inbox; the
      // XML archive and the structured data stand on their own.
      pdfDocumentId = null
    }
  }

  const extracted = peppolDocumentToExtraction(document)
  const matchedSupplierId = await matchSupplierId(service, companyId, {
    orgNumber: extracted.supplier.orgNumber,
    vatNumber: extracted.supplier.vatNumber,
    name: extracted.supplier.name,
  })

  const channelContext: InboxChannelContext = {
    channel: 'peppol',
    peppol_provider: row.provider,
    peppol_document_id: row.provider_document_id,
    peppol_document_type: document.documentType,
    peppol_sender_endpoint: document.supplier.endpoint
      ? `${document.supplier.endpoint.scheme}:${document.supplier.endpoint.identifier}`
      : null,
    peppol_xml_document_id: xmlDocumentId,
  }

  const { data: item, error } = await service
    .from('invoice_inbox_items')
    .insert({
      company_id: companyId,
      user_id: userId,
      document_id: pdfDocumentId ?? xmlDocumentId,
      source: 'peppol',
      status: 'received',
      extracted_data: extracted,
      extraction_skipped: false,
      matched_supplier_id: matchedSupplierId,
      email_from: document.supplier.name,
      email_received_at: row.received_at,
      channel_context: channelContext,
    })
    .select('id')
    .single()

  if (error) {
    // The per-channel unique index did its job under a concurrent run.
    if (error.code === '23505') {
      const { data: raced } = await service
        .from('invoice_inbox_items')
        .select('id')
        .eq('company_id', companyId)
        .eq('source', 'peppol')
        .eq('channel_context->>peppol_document_id', row.provider_document_id)
        .maybeSingle()
      if (raced) return { inboxItemId: (raced as { id: string }).id, xmlDocumentId }
    }
    throw new Error(`Failed to create inbox item for inbound Peppol document: ${error.message}`)
  }
  return { inboxItemId: (item as { id: string }).id, xmlDocumentId }
}
