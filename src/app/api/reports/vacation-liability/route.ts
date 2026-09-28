import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { VacationLiabilityQuerySchema } from '@/lib/api/schemas'
import { contentDisposition } from '@/lib/api/content-disposition'
import { privateNoStore } from '@/lib/api/private-no-store'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { generateVacationLiability, vacationLiabilityCheck } from '@/lib/reports/vacation-liability'
import { bookedVacationBalances } from '@/lib/salary/semesterberedning'
import { SemesterskuldPDF } from '@/lib/reports/semesterskuld-pdf-template'
import {
  currencyColumn,
  decimalColumn,
  reportToWorkbook,
  slugifyCompanyName,
  textColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

/**
 * GET /api/reports/vacation-liability
 *
 * Semesterlöneskuld per employee (BFNAR 2016:10 kap 16), accounts 2920 +
 * 2940, as of a fiscal period's end (`period_id`) or December 31 of `year`
 * (default: the current year). JSON carries `check`: the booked 2920/2940
 * balances and the difference against the report, null when no fiscal
 * period covers the date. format=pdf|xlsx downloads the same report.
 */
export const GET = withRouteContext('report.vacation_liability', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const query = validateQuery(request, VacationLiabilityQuerySchema, {
    log,
    operation: 'report.vacation_liability',
  })
  if (!query.success) return query.response
  const { period_id: periodId, year, format } = query.data

  let asOfDate = `${year ?? new Date().getFullYear()}-12-31`
  if (periodId) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!period) {
      return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
    }
    asOfDate = (period as { period_end: string }).period_end
  }

  try {
    const [report, booked] = await Promise.all([
      generateVacationLiability(supabase, companyId, asOfDate),
      // The check is a convenience beside the report: a failed ledger read
      // drops it rather than failing the report.
      bookedVacationBalances(supabase, companyId, asOfDate).catch((err: unknown) => {
        log.warn('vacation liability check failed', { asOfDate, error: String(err) })
        return null
      }),
    ])
    const check = booked?.ok ? vacationLiabilityCheck(report, booked.data) : null

    if (format === 'json') {
      return privateNoStore(NextResponse.json({ data: { ...report, check } }))
    }

    const { data: company } = await supabase
      .from('companies')
      .select('name, org_number')
      .eq('id', companyId)
      .maybeSingle()
    const companyInfo = {
      name: (company as { name?: string } | null)?.name ?? '',
      org_number: (company as { org_number?: string | null } | null)?.org_number ?? null,
    }

    if (format === 'pdf') {
      const pdf = await renderToBuffer(SemesterskuldPDF({ report, check, company: companyInfo }))
      const filename = `semesterskuld-${slugifyCompanyName(companyInfo.name)}-${asOfDate.replace(/-/g, '')}.pdf`
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': contentDisposition('attachment', filename),
          'Cache-Control': 'private, no-store',
        },
      })
    }

    const buffer = reportToWorkbook([
      {
        name: 'Semesterskuld',
        columns: [
          textColumn('Anställd'),
          textColumn('Personnr (4)'),
          textColumn('Semesterregel'),
          decimalColumn('Dagar'),
          decimalColumn('Uttagna dagar'),
          decimalColumn('Kvarvarande dagar'),
          decimalColumn('Sparade dagar'),
          currencyColumn('Semesterlön (2920)'),
          currencyColumn('Sociala avgifter (2940)'),
          currencyColumn('Summa skuld'),
          currencyColumn('Förskottsskuld'),
        ],
        rows: report.rows,
        mapRow: (r) => [
          r.employeeName,
          r.personnummerLast4,
          r.vacationRule,
          r.vacationDaysEntitled,
          r.vacationDaysTaken,
          r.vacationDaysRemaining,
          r.vacationDaysSaved,
          r.accruedAmount,
          r.accruedAvgifter,
          r.totalLiability,
          r.advanceVacationDebt,
        ],
      },
    ])
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': contentDisposition('attachment', xlsxFilename('semesterskuld', companyInfo.name, asOfDate)),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    // Raw message stays server-side: it can carry table names / SQL.
    log.error('vacation liability generation failed', err as Error, { asOfDate })
    return errorResponseFromCode('REPORT_GENERATION_FAILED', log, { requestId })
  }
}, { requireCompleteLedger: (request) => ['pdf', 'xlsx'].includes(new URL(request.url).searchParams.get('format') ?? '') })
