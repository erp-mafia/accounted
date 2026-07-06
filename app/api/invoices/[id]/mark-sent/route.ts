import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { ensureInitialized } from '@/lib/init'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { createLogger } from '@/lib/logger'
import type { CompanySettings, Customer, EntityType, Invoice, InvoiceItem } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/mark-sent
 *
 * Manually marks a draft invoice as sent (for invoices delivered outside the system).
 * Under faktureringsmetoden (accrual): creates the journal entry (Debit 1510, Credit 30xx/26xx).
 * Under kontantmetoden (cash): no journal entry; booking happens at payment.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)
  const log = createLogger('invoice.mark-sent', { companyId, invoiceId: id })

  // Fetch invoice
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) {
    return NextResponse.json({ error: 'Fakturan hittades inte' }, { status: 404 })
  }

  if (invoice.status !== 'draft') {
    return NextResponse.json(
      { error: 'Endast utkast kan markeras som skickade' },
      { status: 400 }
    )
  }

  // Assign invoice number now if this draft doesn't have one yet
  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    log.error('failed to assign invoice number on mark-sent', err as Error)
    return NextResponse.json(
      { error: 'Kunde inte tilldela fakturanummer. Försök igen.' },
      { status: 500 }
    )
  }

  // Update status to sent
  const { error: updateError } = await supabase
    .from('invoices')
    .update({ status: 'sent' })
    .eq('id', id)
    .eq('company_id', companyId)

  if (updateError) {
    return NextResponse.json({ error: 'Kunde inte uppdatera status' }, { status: 500 })
  }

  // Fetch full company settings for PDF rendering and accounting method
  const { data: settings } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  const accountingMethod = settings?.accounting_method || 'accrual'

  // Only create journal entries for real invoices (not proformas or delivery notes)
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let journalEntryId: string | null = null
  if (isRealInvoice && accountingMethod === 'accrual') {
    try {
      const journalEntry = await createInvoiceJournalEntry(
        supabase,
        companyId,
        user.id,
        invoice as Invoice,
        (settings?.entity_type as EntityType) || 'enskild_firma',
        invoice.customer?.name
      )
      if (journalEntry) {
        journalEntryId = journalEntry.id

        // Periodiserade lines: create schedules + catch-up dissolutions now
        // that the revenue entry exists. Failures are logged, never fatal:
        // the verifikat is committed.
        const accrual = await createSchedulesForCustomerInvoice(
          supabase,
          companyId,
          user.id,
          invoice as Invoice,
          (invoice.items as InvoiceItem[] | null) ?? [],
          journalEntry.id,
          (settings?.entity_type as EntityType) || 'enskild_firma',
        )
        if (accrual.failed > 0) {
          log.error('accrual schedule creation failed on mark-sent', {
            failed: accrual.failed,
          })
        }

        const { error: linkError } = await supabase
          .from('invoices')
          .update({ journal_entry_id: journalEntry.id })
          .eq('id', id)
        if (linkError) {
          // Don't fail mark-sent: the verifikat committed; only the link
          // failed. But log it through the structured logger so it reaches log
          // aggregation/alerting: this write silently no-ops when the
          // journal_entry_id column is missing (it was absent in prod until the
          // 20260613100000 migration), which leaves mark-paid unable to detect
          // an already-booked sale.
          log.error('mark-sent: journal_entry_id link to invoice failed', linkError, {
            journalEntryId: journalEntry.id,
          })
        }
      }
    } catch (err) {
      log.error('failed to create invoice journal entry on mark-sent', err as Error)
    }
  }

  // Render and archive the PDF as underlag so it remains retrievable even if
  // the invoice row is later cancelled. Mirrors the send route.
  if (isRealInvoice && settings) {
    try {
      const items = (invoice.items as InvoiceItem[] | null ?? []).slice().sort(
        (a, b) => a.sort_order - b.sort_order
      )

      let originalInvoiceNumber: string | undefined
      if (invoice.credited_invoice_id) {
        const { data: originalInvoice } = await supabase
          .from('invoices')
          .select('invoice_number')
          .eq('id', invoice.credited_invoice_id)
          .eq('company_id', companyId)
          .single()
        originalInvoiceNumber = originalInvoice?.invoice_number ?? undefined
      }

      // The DB status flip already happened above, but the in-memory `invoice`
      // is stale and still reads 'draft': override here so the archived
      // underlag isn't stamped "UTKAST: inte en giltig faktura".
      const renderableInvoice = { ...(invoice as Invoice), status: 'sent' as const }
      const { branding, company: renderCompany } = await prepareInvoicePdfRender(
        settings as CompanySettings,
      )
      const swishQrDataUrl = await buildSwishQrDataUrl(settings as CompanySettings, renderableInvoice)
      const pdfBuffer = await renderToBuffer(
        InvoicePDF({
          invoice: renderableInvoice,
          customer: invoice.customer as Customer,
          items,
          company: renderCompany,
          originalInvoiceNumber,
          branding,
          swishQrDataUrl,
        })
      )

      const filename = invoice.credited_invoice_id
        ? `kreditfaktura-${invoice.invoice_number}.pdf`
        : `faktura-${invoice.invoice_number}.pdf`

      const pdfArrayBuffer = new Uint8Array(pdfBuffer).buffer as ArrayBuffer
      await uploadDocument(supabase, user.id, companyId, {
        name: filename,
        buffer: pdfArrayBuffer,
        type: 'application/pdf',
      }, {
        upload_source: 'system',
        journal_entry_id: journalEntryId ?? undefined,
      })
    } catch (err) {
      log.error('failed to archive invoice PDF on mark-sent', err as Error)
    }
  }

  return NextResponse.json({
    success: true,
    status: 'sent',
    journal_entry_id: journalEntryId,
  })
}
