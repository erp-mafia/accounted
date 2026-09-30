/**
 * GET /api/v1/companies/{companyId}/reports/vat-declaration/eskd: the
 * momsdeklaration as an eSKDUpload (v6.0) XML file for "Deklarera via fil"
 * at skatteverket.se, byte-identical to the dashboard download. The rutor
 * are GET /reports/vat-declaration.
 */
import { v1ReportFileHandler } from '@/lib/api/v1/report-file-route'
import { VatPeriodInputSchema } from '@/lib/operations/vat-settlement'
import { getVatEskdFile } from '@/lib/reports/filing-report-service'

export const GET = v1ReportFileHandler({
  operation: 'reports.vat-declaration.eskd',
  path: '/api/v1/companies/:companyId/reports/vat-declaration/eskd',
  summary: 'Momsdeklaration as an eSKD XML file, for "Deklarera via fil" at skatteverket.se.',
  description:
    'The momsdeklaration for a period as the eSKDUpload v6.0 XML (ISO 8859-1) that Skatteverket\'s e-tjänst accepts as a file upload, computed purely from the bookkeeping: the same rutor as GET /reports/vat-declaration. No Skatteverket connection is needed and nothing is sent: the user uploads the file, reviews, signs and submits there.',
  useWhen: 'The momsdeklaration is reviewed and the user files it by uploading a file rather than through the Skatteverket connection.',
  doNotUseFor: 'Reading the rutor (GET /reports/vat-declaration) or submitting through the Skatteverket API connection.',
  pitfalls: [
    'A missing or invalid org number on the company settings answers 400 VAT_ESKD_ORG_NUMBER_INVALID: the file would be rejected at upload.',
    'fiscal_period_id is for yearly (helårsmoms) with a broken räkenskapsår; it is ignored for monthly and quarterly.',
    'Refused while an SIE import is unfinished.',
  ],
  contentType: 'application/xml',
  errorCodes: ['VAT_ESKD_SETTINGS_MISSING', 'VAT_ESKD_ORG_NUMBER_INVALID', 'FISCAL_PERIOD_NOT_FOUND', 'VAT_REPORT_GENERATION_FAILED'],
  query: VatPeriodInputSchema,
  build: (ctx, input) => getVatEskdFile(ctx, input),
})
