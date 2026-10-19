import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { formatQuoteNumber } from '@/lib/invoices/quote-status'
import { formatSeriesNumber, readInvoiceSeries } from '@/lib/company/invoice-number-series'

export const GET = withRouteContext(
  'invoice.peek_next_number',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const url = new URL(request.url)
    const documentType = url.searchParams.get('document_type') ?? 'invoice'
    if (!['invoice', 'proforma', 'delivery_note', 'quote'].includes(documentType)) {
      return NextResponse.json(
        { error: 'invalid document_type', requestId },
        { status: 400 },
      )
    }

    // delivery_note has its own sequence (generate_delivery_note_number); the
    // peek RPC only covers the invoice/proforma F-series counter, so for
    // delivery notes we return null and let the form skip the preview.
    if (documentType === 'delivery_note') {
      return NextResponse.json({ data: { preview: null } })
    }

    // Quotes are numbered at insert from company_settings.next_quote_number;
    // preview it directly (same format as generate_quote_number).
    if (documentType === 'quote') {
      const { data: settings, error: settingsError } = await supabase
        .from('company_settings')
        .select('next_quote_number')
        .eq('company_id', companyId)
        .maybeSingle()
      if (settingsError) {
        log.error('next_quote_number read failed', settingsError)
        return errorResponse(settingsError, log, { requestId })
      }
      const next = (settings as { next_quote_number?: number | null } | null)?.next_quote_number
      return NextResponse.json({ data: { preview: next ? formatQuoteNumber(next) : null } })
    }

    // The invoices decide where the series stands (20261012161600). When a
    // higher number already exists, nothing can be issued until the company
    // says where the series continues: the confirm offers continue_number,
    // the lowest number that continues it.
    let series: Awaited<ReturnType<typeof readInvoiceSeries>>
    try {
      series = await readInvoiceSeries(supabase, companyId!, {
        documentType: documentType as 'invoice' | 'proforma',
      })
    } catch (error) {
      log.error('invoice_number_series_status failed', error as Error)
      return errorResponse(error, log, { requestId })
    }

    if (series?.behind && series.highest_number !== null) {
      return NextResponse.json({
        data: {
          preview: null,
          behind: true,
          highest_number: formatSeriesNumber(series.prefix, series.highest_number),
          first_allowed: series.first_allowed,
          continue_number: formatSeriesNumber(series.prefix, series.first_allowed),
        },
      })
    }
    return NextResponse.json({ data: { preview: series?.next_number ?? null, behind: false } })
  },
)
