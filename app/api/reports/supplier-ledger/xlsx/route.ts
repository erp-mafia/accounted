import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

interface AgingRow {
  supplier_name: string
  current: number
  days_1_30: number
  days_31_60: number
  days_61_90: number
  days_90_plus: number
  total_outstanding: number
}

export const GET = withRouteContext('report.supplier_ledger.xlsx', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const asOfDate = searchParams.get('as_of_date') || undefined

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  try {
    const ledger = await generateSupplierLedger(supabase, companyId, asOfDate)

    const rows: AgingRow[] = ledger.entries.map((e) => ({
      supplier_name: e.supplier_name,
      current: e.current,
      days_1_30: e.days_1_30,
      days_31_60: e.days_31_60,
      days_61_90: e.days_61_90,
      days_90_plus: e.days_90_plus,
      total_outstanding: e.total_outstanding,
    }))

    const buffer = reportToWorkbook<AgingRow>([
      {
        name: 'Leverantörsreskontra',
        columns: [
          textColumn('Leverantör'),
          currencyColumn('Ej förfallet'),
          currencyColumn('1-30 dagar'),
          currencyColumn('31-60 dagar'),
          currencyColumn('61-90 dagar'),
          currencyColumn('90+ dagar'),
          currencyColumn('Totalt utestående'),
        ],
        rows,
        mapRow: (r) => [
          r.supplier_name,
          r.current,
          r.days_1_30,
          r.days_31_60,
          r.days_61_90,
          r.days_90_plus,
          r.total_outstanding,
        ],
      },
    ])

    const filename = xlsxFilename(
      'leverantorsreskontra',
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
      { error: err instanceof Error ? err.message : 'Kunde inte generera leverantörsreskontra' },
      { status: 500 }
    )
  }
})
