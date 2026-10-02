/**
 * GET /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/pdf:
 * the årsredovisning as PDF, byte-identical to the dashboard download. The
 * live draft holds the SIE import read lease; a frozen version (version_id)
 * is served as versioned, with its recorded signatures.
 */
import { z } from 'zod'
import { v1ReportFileHandler } from '@/lib/api/v1/report-file-route'
import { arsredovisningFileBuild } from '@/lib/api/v1/arsredovisning-file'

export const GET = v1ReportFileHandler({
  operation: 'arsredovisning.pdf',
  path: '/api/v1/companies/:companyId/fiscal-periods/:id/arsredovisning/pdf',
  summary: 'The årsredovisning as PDF: the live draft or a frozen version.',
  description:
    'Renders the årsredovisning for the räkenskapsår (K2 or K3 template by the framework) as the dashboard does. Without version_id it is the live draft from the books, named ...-utkast.pdf; with version_id it is that immutable version with the signatures recorded on it, named ...-papperskopia.pdf once signed. Nothing is sent to Bolagsverket.',
  useWhen: 'A printable copy for the board to sign on paper, the archive, or a review.',
  doNotUseFor: 'The inline XBRL document for digital filing (GET .../arsredovisning/ixbrl) or the report as JSON (gnubok_preview_arsredovisning).',
  pitfalls: [
    'The live draft is refused while an SIE import is unfinished (409); a frozen version stays readable.',
    'An unknown version_id answers 404 NOT_FOUND.',
  ],
  contentType: 'application/pdf',
  errorCodes: ['PERIOD_NOT_FOUND', 'NOT_FOUND', 'VALIDATION_ERROR'],
  query: z.object({
    version_id: z.string().uuid().optional().describe('A frozen version (annual_report_version_id); omit for the live draft.'),
  }),
  build: (ctx, query, path) => arsredovisningFileBuild('pdf', ctx, query, path),
})
