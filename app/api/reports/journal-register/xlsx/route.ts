import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateJournalRegister } from '@/lib/reports/journal-register'
import { requireCompanyId } from '@/lib/company/context'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  dateColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

interface FlatRow {
  voucher: string
  date: Date | null
  description: string
  source_type: string
  status: string
  account_number: string
  account_name: string
  debit: number
  credit: number
}

function toDate(s: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  try {
    const report = await generateJournalRegister(supabase, companyId, periodId)

    // Flatten: one row per (entry, line). Voucher metadata repeats so the
    // file is filterable in Excel without losing context.
    const rows: FlatRow[] = []
    for (const entry of report.entries) {
      const voucherLabel = `${entry.voucher_series}${entry.voucher_number}`
      for (const line of entry.lines) {
        rows.push({
          voucher: voucherLabel,
          date: toDate(entry.date),
          description: entry.description,
          source_type: entry.source_type,
          status: entry.status,
          account_number: line.account_number,
          account_name: line.account_name,
          debit: line.debit,
          credit: line.credit,
        })
      }
    }

    const buffer = reportToWorkbook<FlatRow>([
      {
        name: 'Grundbok',
        columns: [
          textColumn('Verifikat'),
          dateColumn('Datum'),
          textColumn('Beskrivning'),
          textColumn('Källa'),
          textColumn('Status'),
          textColumn('Konto'),
          textColumn('Kontonamn'),
          currencyColumn('Debet'),
          currencyColumn('Kredit'),
        ],
        rows,
        mapRow: (r) => [
          r.voucher,
          r.date,
          r.description,
          r.source_type,
          r.status,
          r.account_number,
          r.account_name,
          r.debit,
          r.credit,
        ],
      },
    ])

    const filename = xlsxFilename('grundbok', companyRow?.company_name ?? '', report.period.end)
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera grundbok' },
      { status: 500 }
    )
  }
}
