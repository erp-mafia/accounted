import { NextResponse } from 'next/server'
import { generateBalansrapport } from '@/lib/reports/balansrapport'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import { formatLatestVouchers, LATEST_VOUCHERS_LABEL } from '@/lib/reports/latest-vouchers-format'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { BalansrapportSection } from '@/types'
import { fileResponse } from '@/lib/api/file-response'

interface FlatRow {
  group: string
  /** ÅRL heading the row sits under; its Summa row carries it too, so a filter keeps the pair. */
  section: string
  account_number: string
  account_name: string
  year_ib: number
  ib: number
  period_change: number
  ub: number
}

export const GET = withRouteContext('report.balansrapport.xlsx', async (request, { supabase, companyId, log, requestId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const [{ data: companyRow }, { data: period, error: periodError }] = await Promise.all([
    supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .maybeSingle(),
  ])

  if (periodError) throw periodError
  // A period_id that is not the active company's (a page still holding the
  // previous company's year right after a company switch) is a stale request,
  // not a failure: say so, and generate nothing from another company's period.
  if (!period) {
    return errorResponseFromCode('PERIOD_NOT_FOUND', log.child({ periodId }), { requestId })
  }

  const parsed = parseReportDateRange(searchParams, period)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  try {
    const report = await generateBalansrapport(supabase, companyId, periodId, parsed.range)

    const rows: FlatRow[] = []
    const pushSection = (group: string, section: BalansrapportSection) => {
      for (const child of section.sections) pushSection(group, child)
      for (const r of section.rows) {
        rows.push({
          group,
          section: section.label,
          account_number: r.account_number,
          account_name: r.account_name,
          year_ib: r.year_ib,
          ib: r.ib,
          period_change: r.period_change,
          ub: r.ub,
        })
      }
      rows.push({
        group,
        section: section.label,
        account_number: '',
        account_name: section.total_label,
        year_ib: section.subtotal_year_ib,
        ib: section.subtotal_ib,
        period_change: section.subtotal_change,
        ub: section.subtotal_ub,
      })
    }
    for (const g of report.groups) {
      for (const section of g.sections) pushSection(g.class_label, section)
      rows.push({
        group: g.class_label,
        section: '',
        account_number: '',
        account_name: `Summa ${g.class_label}`,
        year_ib: g.subtotal_year_ib,
        ib: g.subtotal_ib,
        period_change: g.subtotal_change,
        ub: g.subtotal_ub,
      })
    }
    rows.push({
      group: 'Beräknat resultat',
      section: '',
      account_number: '',
      account_name: 'Beräknat resultat',
      year_ib: 0,
      ib: 0,
      period_change: report.beraknat_resultat,
      ub: report.beraknat_resultat,
    })
    // The rows add up only with it: assets + eq_liab = beräknat resultat +
    // differens. Blank opening columns and change: the differens is no movement.
    if (report.differens !== 0) {
      rows.push({
        group: 'Differens',
        section: '',
        account_number: '',
        account_name: 'Differens (balanserar ej)',
        year_ib: null as unknown as number,
        ib: null as unknown as number,
        period_change: null as unknown as number,
        ub: report.differens,
      })
    }

    // Reconciliation aid (#1267). reportToWorkbook has no preamble concept, so
    // this rides as a first body row, the same way the dimension disclosure
    // does on the other report exports.
    const vouchersLabel = formatLatestVouchers(report.latest_vouchers)
    if (vouchersLabel) {
      rows.unshift({
        group: `${LATEST_VOUCHERS_LABEL}: ${vouchersLabel}`,
        section: '',
        account_number: '',
        account_name: '',
        year_ib: null as unknown as number,
        ib: null as unknown as number,
        period_change: null as unknown as number,
        ub: null as unknown as number,
      })
    }

    const buffer = await reportToWorkbook<FlatRow>([
      {
        name: 'Balansrapport',
        columns: [
          textColumn('Grupp'),
          textColumn('Avsnitt'),
          textColumn('Konto'),
          textColumn('Kontonamn'),
          currencyColumn('Ingående balans'),
          currencyColumn('Ingående saldo'),
          currencyColumn('Förändring'),
          currencyColumn('Utgående balans'),
        ],
        rows,
        mapRow: (r) => [
          r.group,
          r.section,
          r.account_number,
          r.account_name,
          r.year_ib,
          r.ib,
          r.period_change,
          r.ub,
        ],
      },
    ])

    const filename = xlsxFilename(
      'balansrapport',
      companyRow?.company_name ?? '',
      report.period.end,
    )
    return fileResponse(new Uint8Array(buffer), { filename: filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  } catch (err) {
    log.error('balansrapport xlsx generation failed', err as Error, { periodId })
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera balansrapport' },
      { status: 500 }
    )
  }
}, { requireCompleteLedger: true })
