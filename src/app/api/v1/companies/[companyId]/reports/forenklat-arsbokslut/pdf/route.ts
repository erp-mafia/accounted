/**
 * GET /api/v1/companies/{companyId}/reports/forenklat-arsbokslut/pdf: the
 * förenklat årsbokslut (BFNAR 2010:1) as the PDF the styrelse signs,
 * byte-identical to the dashboard download. The figures are those of
 * GET /reports/forenklat-arsbokslut for the same period.
 */
import { z } from 'zod'
import { v1ReportFileHandler } from '@/lib/api/v1/report-file-route'
import { getForenklatArsbokslutPdfFile } from '@/lib/bokslut/forenklat-arsbokslut/service'

export const GET = v1ReportFileHandler({
  operation: 'reports.forenklat-arsbokslut.pdf',
  path: '/api/v1/companies/:companyId/reports/forenklat-arsbokslut/pdf',
  summary: 'Förenklat årsbokslut (ideell förening, BFNAR 2010:1) as a PDF for the styrelse to sign.',
  description:
    'The ideell förening\'s förenklat årsbokslut in the BFNAR 2010:1 bilaga 2 layout: resultaträkning and balansräkning with comparatives, the tilläggsupplysningar, and a "Beslutat" date line with one signature and date line per styrelseledamot. Byte-identical to the dashboard download. Signing happens on the printed or exported document; nothing is filed anywhere: the document is kept with the books for seven years (BFL 7 kap. 2 §).',
  useWhen: 'The figures are reviewed (GET /reports/forenklat-arsbokslut has no blockers) and the document is to be signed.',
  doNotUseFor: 'Reading the figures (GET /reports/forenklat-arsbokslut), or an aktiebolag or ekonomisk förening (the årsredovisning).',
  pitfalls: [
    'Refused with 422 FORENKLAT_ARSBOKSLUT_BLOCKED while the report has blockers (details.reason names them): correct the books or confirm the eligibility in the app, do not retry.',
    'Only for an ideell förening: another legal form answers 400 FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM.',
    'Refused while an SIE import is unfinished: complete or undo it first.',
  ],
  contentType: 'application/pdf',
  errorCodes: [
    'FISCAL_PERIOD_NOT_FOUND',
    'FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM',
    'FORENKLAT_ARSBOKSLUT_BLOCKED',
    'REPORT_GENERATION_FAILED',
  ],
  query: z.object({ period_id: z.string().uuid().describe('The fiscal period (räkenskapsår) id.') }),
  build: (ctx, { period_id }) => getForenklatArsbokslutPdfFile(ctx, period_id),
})
