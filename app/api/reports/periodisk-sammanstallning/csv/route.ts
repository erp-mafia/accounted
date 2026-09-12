import {
  generatePeriodiskSammanstallning,
  type PsPeriodType,
} from '@/lib/reports/periodisk-sammanstallning'
import {
  buildPeriodiskSammanstallningCsv,
  PsCsvBuildError,
} from '@/lib/reports/periodisk-sammanstallning-csv'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/reports/periodisk-sammanstallning/csv
 *
 * Returns the SKV574008-formatted CSV file for upload to Skatteverket.
 * Refuses (400) if the report has any blocking warnings.
 */
export const GET = withRouteContext(
  'report.periodisk_sammanstallning.csv',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as PsPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')

    if (!periodType || !yearStr || !periodStr) {
      return errorResponseFromCode('PS_REPORT_MISSING_PARAMS', log, { requestId })
    }
    if (periodType !== 'monthly' && periodType !== 'quarterly') {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD_TYPE', log, {
        requestId, details: { received: periodType },
      })
    }
    const year = parseInt(yearStr, 10)
    const period = parseInt(periodStr, 10)
    if (isNaN(year) || year < 2000 || year > 2100) {
      return errorResponseFromCode('PS_REPORT_INVALID_YEAR', log, { requestId })
    }
    if (isNaN(period)) {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD', log, { requestId })
    }
    if (periodType === 'monthly' && (period < 1 || period > 12)) {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD', log, { requestId })
    }
    if (periodType === 'quarterly' && (period < 1 || period > 4)) {
      return errorResponseFromCode('PS_REPORT_INVALID_PERIOD', log, { requestId })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('org_number, tax_contact_name, tax_contact_phone, tax_contact_email')
      .eq('company_id', companyId)
      .single()

    if (!settings?.org_number
      || !settings?.tax_contact_name
      || !settings?.tax_contact_phone
      || !settings?.tax_contact_email) {
      return errorResponseFromCode('PS_REPORT_MISSING_FILER_INFO', log, { requestId })
    }

    try {
      const report = await generatePeriodiskSammanstallning(
        supabase, companyId, periodType, year, period,
      )

      const csv = buildPeriodiskSammanstallningCsv(report, {
        organizationNumber: settings.org_number,
        contactName: settings.tax_contact_name,
        contactPhone: settings.tax_contact_phone,
        contactEmail: settings.tax_contact_email,
      })

      return new Response(csv.content as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': csv.mimeType,
          'Content-Disposition': `attachment; filename="${csv.filename}"`,
          'X-Request-Id': requestId,
        },
      })
    } catch (err) {
      if (err instanceof PsCsvBuildError) {
        if (err.reason === 'BLOCKING_WARNINGS') {
          return errorResponseFromCode('PS_REPORT_CSV_BLOCKED_BY_ERRORS', log, {
            requestId, details: { message: getUserErrorMessage(err) },
          })
        }
        if (err.reason === 'MISSING_FILER_INFO') {
          return errorResponseFromCode('PS_REPORT_MISSING_FILER_INFO', log, {
            requestId, details: { message: getUserErrorMessage(err) },
          })
        }
      }
      log.error('periodisk sammanställning CSV failed', err as Error, {
        periodType, year, period,
      })
      return errorResponseFromCode('PS_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  }, { requireCompleteLedger: true })
