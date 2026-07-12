import { NextResponse } from 'next/server'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  dateColumn,
  integerColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

interface AgingRow {
  customer_name: string
  current: number
  days_1_30: number
  days_31_60: number
  days_61_90: number
  days_90_plus: number
  total_outstanding: number
}

interface InvoiceRow {
  customer_name: string
  invoice_number: string
  invoice_date: Date | string
  due_date: Date | string
  total: number
  paid_amount: number
  outstanding: number
  outstanding_sek: number | null
  days_overdue: number
  currency: string
}

function toDate(s: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

export const GET = withRouteContext('report.ar_ledger.xlsx', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const asOfDate = searchParams.get('as_of_date') || undefined

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  try {
    const ledger = await generateARLedger(supabase, companyId, asOfDate)

    const agingRows: AgingRow[] = ledger.entries.map((e) => ({
      customer_name: e.customer_name,
      current: e.current,
      days_1_30: e.days_1_30,
      days_31_60: e.days_31_60,
      days_61_90: e.days_61_90,
      days_90_plus: e.days_90_plus,
      total_outstanding: e.total_outstanding,
    }))

    const invoiceRows: InvoiceRow[] = []
    for (const e of ledger.entries) {
      for (const inv of e.invoices) {
        invoiceRows.push({
          customer_name: e.customer_name,
          invoice_number: inv.invoice_number,
          invoice_date: toDate(inv.invoice_date) ?? inv.invoice_date,
          due_date: toDate(inv.due_date) ?? inv.due_date,
          total: inv.total,
          paid_amount: inv.paid_amount,
          outstanding: inv.outstanding,
          outstanding_sek: inv.outstanding_sek,
          days_overdue: inv.days_overdue,
          currency: inv.currency,
        })
      }
    }

    const buffer = reportToWorkbook([
      {
        name: 'Åldersfördelning',
        columns: [
          textColumn('Kund'),
          currencyColumn('Ej förfallet'),
          currencyColumn('1-30 dagar'),
          currencyColumn('31-60 dagar'),
          currencyColumn('61-90 dagar'),
          currencyColumn('90+ dagar'),
          currencyColumn('Totalt utestående'),
        ],
        rows: agingRows,
        mapRow: (r) => [
          r.customer_name,
          r.current,
          r.days_1_30,
          r.days_31_60,
          r.days_61_90,
          r.days_90_plus,
          r.total_outstanding,
        ],
      },
      {
        name: 'Fakturor',
        columns: [
          textColumn('Kund'),
          textColumn('Fakturanr'),
          dateColumn('Fakturadatum'),
          dateColumn('Förfallodatum'),
          currencyColumn('Totalt'),
          currencyColumn('Betalt'),
          currencyColumn('Utestående'),
          currencyColumn('Utestående (SEK)'),
          integerColumn('Dagar förfallet'),
          textColumn('Valuta'),
        ],
        rows: invoiceRows,
        mapRow: (r) => [
          r.customer_name,
          r.invoice_number,
          r.invoice_date instanceof Date ? r.invoice_date : null,
          r.due_date instanceof Date ? r.due_date : null,
          r.total,
          r.paid_amount,
          r.outstanding,
          r.outstanding_sek,
          r.days_overdue,
          r.currency,
        ],
      },
    ])

    const filename = xlsxFilename(
      'kundreskontra',
      companyRow?.company_name ?? '',
      asOfDate ?? new Date().toISOString().slice(0, 10),
    )
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera kundreskontra' },
      { status: 500 }
    )
  }
})
