import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { ReskontraPDF, type ReskontraInvoiceRow } from '@/lib/reports/reskontra-pdf-template'
import { withRouteContext } from '@/lib/api/with-route-context'
import { slugifyCompanyName } from '@/lib/reports/xlsx-export'
import type { CompanySettings } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext('report.ar_ledger.pdf', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const asOfParam = searchParams.get('as_of_date')

  if (asOfParam && !/^\d{4}-\d{2}-\d{2}$/.test(asOfParam)) {
    return NextResponse.json({ error: 'as_of_date måste vara på formatet ÅÅÅÅ-MM-DD' }, { status: 400 })
  }
  const asOfDate = asOfParam ?? new Date().toISOString().slice(0, 10)

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (!companyRow) {
    return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 404 })
  }

  try {
    const ledger = await generateARLedger(supabase, companyId, asOfDate)

    const invoices: ReskontraInvoiceRow[] = []
    for (const entry of ledger.entries) {
      for (const inv of entry.invoices) {
        if (inv.outstanding === 0) continue
        invoices.push({
          counterparty: entry.customer_name,
          invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date,
          due_date: inv.due_date,
          outstanding: inv.outstanding,
          // The SEK bridge: `outstanding` is in the invoice's own currency
          // while the aging table above it is in SEK, so the PDF needs the
          // converted amount to let a reader tie the two together. `null`
          // means the FX rate was missing, i.e. the row is absent from the
          // aging totals. Matches the XLSX export's "Utestående (SEK)".
          outstanding_sek: inv.outstanding_sek,
          currency: inv.currency,
          days_overdue: inv.days_overdue,
        })
      }
    }

    const pdfBuffer = await renderToBuffer(
      ReskontraPDF({
        title: 'Kundreskontra',
        counterpartyLabel: 'Kund',
        asOfDate,
        aging: ledger.entries.map((e) => ({
          name: e.customer_name,
          current: e.current,
          days_1_30: e.days_1_30,
          days_31_60: e.days_31_60,
          days_61_90: e.days_61_90,
          days_90_plus: e.days_90_plus,
          total_outstanding: e.total_outstanding,
        })),
        totals: {
          name: 'Summa',
          current: ledger.total_current,
          days_1_30: ledger.entries.reduce((s, e) => s + e.days_1_30, 0),
          days_31_60: ledger.entries.reduce((s, e) => s + e.days_31_60, 0),
          days_61_90: ledger.entries.reduce((s, e) => s + e.days_61_90, 0),
          days_90_plus: ledger.entries.reduce((s, e) => s + e.days_90_plus, 0),
          total_outstanding: ledger.total_outstanding,
        },
        unpaidCount: ledger.unpaid_count,
        unconvertedFxCount: ledger.unconverted_fx_count,
        invoices,
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
      })
    )

    const companySlug = slugifyCompanyName(companyRow.company_name ?? '')
    const parts = ['kundreskontra', companySlug, asOfDate.replace(/-/g, '')].filter(Boolean)
    const filename = `${parts.join('-')}.pdf`

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera kundreskontra' },
      { status: 500 }
    )
  }
}, { requireCompleteLedger: true })
