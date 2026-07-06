import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { requireCompanyId } from '@/lib/company/context'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  dateColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

interface FlatRow {
  account_number: string
  account_name: string
  date: Date | string
  voucher: string
  description: string
  source_type: string
  debit: number
  credit: number
  balance: number
}

function toDate(s: string): Date | string {
  // Preserve original ISO string in the cell if parsing fails (avoids NaN
  // dates polluting the workbook).
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d
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
  const accountFrom = searchParams.get('account_from') || undefined
  const accountTo = searchParams.get('account_to') || undefined

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  try {
    const report = await generateGeneralLedger(supabase, companyId, periodId, accountFrom, accountTo, {
      dimensions: dimFilter.dimensions,
    })

    // Flatten accounts + their lines into a single sheet. Each account contributes
    // an opening-balance row, its lines (with running balance), and a closing
    // row: matching how huvudbok is read in Fortnox/Visma.
    const rows: FlatRow[] = []
    for (const acc of report.accounts) {
      rows.push({
        account_number: acc.account_number,
        account_name: acc.account_name,
        date: '',
        voucher: '',
        description: 'Ingående balans',
        source_type: '',
        debit: 0,
        credit: 0,
        balance: acc.opening_balance,
      })
      for (const line of acc.lines) {
        rows.push({
          account_number: acc.account_number,
          account_name: acc.account_name,
          date: toDate(line.date),
          voucher: `${line.voucher_series}${line.voucher_number}`,
          description: line.description,
          source_type: line.source_type,
          debit: line.debit,
          credit: line.credit,
          balance: line.balance,
        })
      }
      rows.push({
        account_number: acc.account_number,
        account_name: acc.account_name,
        date: '',
        voucher: '',
        description: 'Utgående balans',
        source_type: '',
        debit: acc.total_debit,
        credit: acc.total_credit,
        balance: acc.closing_balance,
      })
    }

    // Partial-view disclosure: a filtered huvudbok starts balance accounts
    // at zero IB (opening balances cannot be dimension-scoped): the export
    // must say so or a project-filtered ledger reads as a full one.
    const disclosure = dimensionFilterDisclosure(dimFilter.dimensions)
    if (disclosure) {
      rows.unshift({
        account_number: disclosure,
        account_name: '',
        date: null as unknown as Date,
        voucher: '',
        description: 'Ingående balanser ingår inte i filtrerad vy',
        source_type: '',
        debit: null as unknown as number,
        credit: null as unknown as number,
        balance: null as unknown as number,
      })
    }

    const buffer = reportToWorkbook<FlatRow>([
      {
        name: 'Huvudbok',
        columns: [
          textColumn('Konto'),
          textColumn('Kontonamn'),
          dateColumn('Datum'),
          textColumn('Verifikat'),
          textColumn('Beskrivning'),
          textColumn('Källa'),
          currencyColumn('Debet'),
          currencyColumn('Kredit'),
          currencyColumn('Saldo'),
        ],
        rows,
        mapRow: (r) => [
          r.account_number,
          r.account_name,
          r.date instanceof Date ? r.date : null,
          r.voucher,
          r.description,
          r.source_type,
          r.debit,
          r.credit,
          r.balance,
        ],
      },
    ])

    const filename = xlsxFilename(`huvudbok${dimensionFilterFileSuffix(dimFilter.dimensions)}`, companyRow?.company_name ?? '', report.period.end)
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera huvudbok' },
      { status: 500 }
    )
  }
}
