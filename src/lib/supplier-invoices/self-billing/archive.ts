import type { SupabaseClient } from '@supabase/supabase-js'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { linkBasisColumns } from '@/lib/links/stamp'
import type { Logger } from '@/lib/logger'
import type { SelfBillingPdfInvoice, SelfBillingPdfItem } from './pdf-template'
import { renderSelfBillingPdfBuffer, selfBillingPdfFilename } from './render'
import type { SelfBillingSnapshot } from './snapshot'
import { loadSelfBillingBranding } from './branding'

/** The warning a registration carries when its document could not be archived. */
export const SELF_BILL_DOCUMENT_ARCHIVE_FAILED_WARNING = {
  code: 'SELF_BILL_DOCUMENT_ARCHIVE_FAILED',
  message_sv:
    'Självfakturan registrerades, men dokumentet kunde inte arkiveras. Ladda ner det från fakturan och kontakta supporten om felet kvarstår.',
  message_en:
    'The self-billing invoice was registered, but its document could not be archived. Download it from the invoice and contact support if this persists.',
} as const

export interface ArchiveSelfBillingInput {
  supplierInvoiceId: string
  invoice: SelfBillingPdfInvoice
  items: SelfBillingPdfItem[]
  snapshot: SelfBillingSnapshot
  /** The verifikat the document is the underlag of; null when none is posted yet. */
  journalEntryId: string | null
}

/**
 * Make the self-billing invoice's document and archive it as its underlag
 * (BFL 5 kap 6-7 §, 7 kap): stored in the WORM archive, pointed at by
 * supplier_invoices.document_id and linked to the verifikat when one is
 * posted. Without a verifikat yet (kontantmetoden, deferred booking) the
 * payment paths anchor it later (anchorSupplierInvoiceDocument).
 *
 * Runs after the registration is committed, so it never throws: the document
 * id, or null when the archive failed and the caller warns.
 */
export async function archiveSelfBillingDocument(
  ctx: { supabase: SupabaseClient; companyId: string; userId: string; log: Logger },
  input: ArchiveSelfBillingInput,
): Promise<string | null> {
  const { supabase, companyId, userId, log } = ctx
  try {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('invoice_primary_color, invoice_accent_color, logo_url, invoice_show_logo')
      .eq('company_id', companyId)
      .maybeSingle()
    const branding = await loadSelfBillingBranding(settings)

    const buffer = await renderSelfBillingPdfBuffer({
      invoice: input.invoice,
      items: input.items,
      snapshot: input.snapshot,
      branding,
    })
    const document = await uploadDocument(
      supabase,
      userId,
      companyId,
      {
        name: selfBillingPdfFilename({
          number: input.invoice.supplier_invoice_number,
          isCreditNote: input.invoice.is_credit_note,
          sellerName: input.snapshot.seller.name,
        }),
        buffer: new Uint8Array(buffer).buffer as ArrayBuffer,
        type: 'application/pdf',
      },
      {
        upload_source: 'system',
        // The document the verifikat was booked from: the app made both.
        ...(input.journalEntryId
          ? { journal_entry_id: input.journalEntryId, linkBasis: linkBasisColumns('system_derived') }
          : {}),
        extractionOwner: 'none',
      },
    )

    const { error: linkError } = await supabase
      .from('supplier_invoices')
      .update({ document_id: document.id })
      .eq('id', input.supplierInvoiceId)
      .eq('company_id', companyId)
      .is('document_id', null)
    if (linkError) {
      log.error('self-billing document archived but not linked to the invoice', linkError as unknown as Error, {
        supplierInvoiceId: input.supplierInvoiceId,
        documentId: document.id,
      })
      return null
    }
    if (!input.journalEntryId) await anchorSupplierInvoiceDocument(supabase, companyId, input.supplierInvoiceId)
    return document.id
  } catch (err) {
    log.error('self-billing document could not be archived', err as Error, { supplierInvoiceId: input.supplierInvoiceId })
    return null
  }
}
