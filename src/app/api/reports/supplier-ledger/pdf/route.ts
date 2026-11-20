import { NextResponse } from 'next/server'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseLedgerAsOfDate } from '@/lib/reports/ledger-as-of'
import { ledgerAsOfRefusal } from '@/lib/reports/ledger-as-of-refusal'
import { slugifyCompanyName } from '@/lib/reports/xlsx-export'
import type { CompanySettings } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { fileResponse } from '@/lib/api/file-response'

export const GET = withRouteContext('report.supplier_ledger.pdf', async (request, { supabase, companyId, log, requestId }) => {
  const { searchParams } = new URL(request.url)
  const asOf = parseLedgerAsOfDate(searchParams.get('as_of_date'))
  if (!asOf.ok) return ledgerAsOfRefusal(asOf, log, requestId)
  const asOfDate = asOf.asOfDate ?? todayIsoStockholm()

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (!companyRow) {
    return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 404 })
  }

  try {
    const ledger = await generateSupplierLedger(supabase, companyId, asOfDate)

    const [{ renderToBuffer }, { ReskontraPDF }] = await Promise.all([
      import('@react-pdf/renderer'),
      import('@/lib/reports/reskontra-pdf-template'),
    ])
    const pdfBuffer = await renderToBuffer(
      ReskontraPDF({
        title: 'Leverantörsreskontra',
        counterpartyLabel: 'Leverantör',
        asOfDate,
        aging: ledger.entries.map((e) => ({
          name: e.supplier_name,
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
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
      })
    )

    const companySlug = slugifyCompanyName(companyRow.company_name ?? '')
    const parts = ['leverantorsreskontra', companySlug, asOfDate.replace(/-/g, '')].filter(Boolean)
    const filename = `${parts.join('-')}.pdf`

    return fileResponse(new Uint8Array(pdfBuffer), { filename: filename, contentType: 'application/pdf' })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera leverantörsreskontra' },
      { status: 500 }
    )
  }
}, { requireCompleteLedger: true })
