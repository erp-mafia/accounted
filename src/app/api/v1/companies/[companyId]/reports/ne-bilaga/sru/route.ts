/**
 * GET /api/v1/companies/{companyId}/reports/ne-bilaga/sru: the NE-bilaga SRU
 * files (INFO.SRU + BLANKETTER.SRU, ISO 8859-1) zipped, byte-identical to
 * the dashboard's format=sru download. The file carries the owner's full
 * personnummer (the enskild firma's org number): it is the filing, so it is
 * exact. The JSON (GET /reports/ne-bilaga) masks it.
 */
import { z } from 'zod'
import { v1ReportFileHandler } from '@/lib/api/v1/report-file-route'
import { getNeSruFile } from '@/lib/reports/filing-report-service'

export const GET = v1ReportFileHandler({
  operation: 'reports.ne-bilaga.sru',
  path: '/api/v1/companies/:companyId/reports/ne-bilaga/sru',
  summary: 'NE-bilaga SRU files (INFO.SRU + BLANKETTER.SRU) as a zip, for upload at skatteverket.se.',
  description:
    'The enskild firma\'s NE-bilaga as the two SRU files Skatteverket\'s filöverföring takes, ISO 8859-1 encoded and zipped, byte-identical to the dashboard download. The figures are those of GET /reports/ne-bilaga for the same period. The file carries the owner\'s full personnummer (the identifier Skatteverket files it under). Nothing is sent to Skatteverket: the user uploads the files, reviews and signs there.',
  useWhen: 'The NE figures are reviewed and the files are to be uploaded at skatteverket.se.',
  doNotUseFor: 'Reading the figures (GET /reports/ne-bilaga), or an aktiebolag (GET /reports/ink2/sru).',
  pitfalls: [
    'The zip and its file name contain the owner\'s personnummer: store and forward it as personal data.',
    'Unzip and upload INFO.SRU and BLANKETTER.SRU under exactly those names; do not re-encode them to UTF-8.',
    'Only for enskild firma: another legal form answers 400 TAX_DECL_NE_WRONG_LEGAL_FORM.',
  ],
  contentType: 'application/zip',
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'TAX_DECL_NE_WRONG_LEGAL_FORM', 'TAX_DECL_GENERATION_FAILED'],
  query: z.object({ period_id: z.string().uuid().describe('The fiscal period (räkenskapsår) id.') }),
  build: (ctx, { period_id }) => getNeSruFile(ctx, period_id),
})
