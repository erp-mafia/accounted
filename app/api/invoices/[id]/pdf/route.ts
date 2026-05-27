import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender } from '@/lib/invoices/pdf-render-helpers'
import { requireCompanyId } from '@/lib/company/context'
import type { Invoice, InvoiceItem, Customer, CompanySettings } from '@/types'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  // Fetch invoice with customer and items
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select(`
      *,
      customer:customers(*),
      items:invoice_items(*)
    `)
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (invoiceError || !invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  // Fetch company settings
  const { data: company, error: companyError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (companyError || !company) {
    return NextResponse.json({ error: 'Company settings not found' }, { status: 404 })
  }

  // Sort items by sort_order
  const items = (invoice.items as InvoiceItem[]).sort((a, b) => a.sort_order - b.sort_order)

  // If this is a credit note, fetch the original invoice number
  let originalInvoiceNumber: string | undefined
  if (invoice.credited_invoice_id) {
    const { data: originalInvoice } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('id', invoice.credited_invoice_id)
      .single()

    if (originalInvoice) {
      originalInvoiceNumber = originalInvoice.invoice_number
    }
  }

  try {
    // Generate PDF
    const { branding } = prepareInvoicePdfRender(company as CompanySettings)
    const pdfBuffer = await renderToBuffer(
      InvoicePDF({
        invoice: invoice as Invoice,
        customer: invoice.customer as Customer,
        items,
        company: company as CompanySettings,
        originalInvoiceNumber,
        branding,
      })
    )

    // Convert Node.js Buffer to Uint8Array for Response
    const uint8Array = new Uint8Array(pdfBuffer)

    // Return PDF as response
    const isCreditNote = !!invoice.credited_invoice_id
    const filenameNumber = invoice.invoice_number ?? `utkast-${String(invoice.id).slice(0, 8)}`
    const filename = isCreditNote
      ? `kreditfaktura-${filenameNumber}.pdf`
      : `faktura-${filenameNumber}.pdf`

    return new NextResponse(uint8Array, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': pdfBuffer.length.toString(),
      },
    })
  } catch (error) {
    console.error('PDF generation error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'PDF generation failed' },
      { status: 500 }
    )
  }
}
