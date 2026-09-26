/**
 * GET /api/v1/companies/{companyId}/reports/ink2/sru: the INK2 SRU files
 * (INFO.SRU + BLANKETTER.SRU, ISO 8859-1) zipped, byte-identical to the
 * dashboard's format=sru download. The JSON is GET /reports/ink2.
 */
import { z } from 'zod'
import { v1ReportFileHandler } from '@/lib/api/v1/report-file-route'
import { getInk2SruFile } from '@/lib/reports/filing-report-service'

export const GET = v1ReportFileHandler({
  operation: 'reports.ink2.sru',
  path: '/api/v1/companies/:companyId/reports/ink2/sru',
  summary: 'INK2 SRU files (INFO.SRU + BLANKETTER.SRU) as a zip, for upload at skatteverket.se.',
  description:
    'The aktiebolag income tax return as the two SRU files Skatteverket\'s filöverföring takes, ISO 8859-1 encoded and zipped, byte-identical to the dashboard download. The figures are those of GET /reports/ink2 for the same period. Nothing is sent to Skatteverket: the user uploads the files, reviews and signs there.',
  useWhen: 'The INK2 figures are reviewed and the files are to be uploaded at skatteverket.se (Filöverföring).',
  doNotUseFor: 'Reading the figures (GET /reports/ink2), or an enskild firma (GET /reports/ne-bilaga/sru).',
  pitfalls: [
    'Unzip and upload INFO.SRU and BLANKETTER.SRU under exactly those names; do not re-encode them to UTF-8.',
    'Only for aktiebolag: another legal form answers 400 TAX_DECL_INK2_WRONG_LEGAL_FORM.',
    'Refused while an SIE import is unfinished: complete or undo it first.',
  ],
  contentType: 'application/zip',
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'TAX_DECL_INK2_WRONG_LEGAL_FORM', 'TAX_DECL_GENERATION_FAILED'],
  query: z.object({ period_id: z.string().uuid().describe('The fiscal period (räkenskapsår) id.') }),
  build: (ctx, { period_id }) => getInk2SruFile(ctx, period_id),
})
