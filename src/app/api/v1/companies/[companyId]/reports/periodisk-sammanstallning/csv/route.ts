/**
 * GET /api/v1/companies/{companyId}/reports/periodisk-sammanstallning/csv:
 * the SKV 574008 CSV for upload to Skatteverket, byte-identical to the
 * dashboard download. The JSON is GET /reports/periodisk-sammanstallning.
 */
import { v1ReportFileHandler } from '@/lib/api/v1/report-file-route'
import { PsPeriodInputSchema } from '@/lib/operations/filing-reports'
import { getPeriodiskSammanstallningCsv } from '@/lib/reports/filing-report-service'

export const GET = v1ReportFileHandler({
  operation: 'reports.periodisk-sammanstallning.csv',
  path: '/api/v1/companies/:companyId/reports/periodisk-sammanstallning/csv',
  summary: 'Periodisk sammanställning as the SKV 574008 CSV file, for upload at skatteverket.se.',
  description:
    'The EU sales list for a month or quarter in the file format Skatteverket\'s e-tjänst takes (SKV 574008): a header with the org number, period code and tax contact, then one row per customer VAT number with varor, trepartshandel and tjänster in whole kronor. Refused while the report has blocking warnings or the tax contact is incomplete. Nothing is sent to Skatteverket.',
  useWhen: 'The periodisk sammanställning is reviewed and is to be uploaded at skatteverket.se.',
  doNotUseFor: 'Reading the rows and warnings (GET /reports/periodisk-sammanstallning).',
  pitfalls: [
    'Blocking warnings answer 400 PS_REPORT_CSV_BLOCKED_BY_ERRORS: fix them (read the JSON) first.',
    'A missing tax contact (name, phone, email on the company settings) answers 400 PS_REPORT_MISSING_FILER_INFO.',
    'Refused while an SIE import is unfinished.',
  ],
  contentType: 'text/csv',
  errorCodes: ['PS_REPORT_MISSING_FILER_INFO', 'PS_REPORT_CSV_BLOCKED_BY_ERRORS', 'PS_REPORT_GENERATION_FAILED'],
  query: PsPeriodInputSchema,
  build: (ctx, input) => getPeriodiskSammanstallningCsv(ctx, input),
})
