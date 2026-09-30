/**
 * GET /api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/ixbrl:
 * the K2 årsredovisning as inline XBRL (XHTML), byte-identical to the
 * dashboard's download. The live draft holds the SIE import read lease; a
 * frozen version (version_id) is served as versioned.
 */
import { z } from 'zod'
import { v1ReportFileHandler } from '@/lib/api/v1/report-file-route'
import { arsredovisningFileBuild } from '@/lib/api/v1/arsredovisning-file'

export const GET = v1ReportFileHandler({
  operation: 'arsredovisning.ixbrl',
  path: '/api/v1/companies/:companyId/fiscal-periods/:id/arsredovisning/ixbrl',
  summary: 'The K2 årsredovisning as an inline XBRL (XHTML) document.',
  description:
    'Generates the iXBRL document Bolagsverket\'s digital filing takes (K2, Bolagsverket taxonomy), for the live draft or a frozen version (version_id). The XHTML is also the human-readable document. It is not a filing: digital filing goes through connected software with the fastställelseintyg signed by BankID, which this API does not do.',
  useWhen: 'Archiving the digital document, or validating it with external tools.',
  doNotUseFor: 'The pre-flight result as JSON (GET .../arsredovisning/ixbrl/validate) or a printable copy (GET .../arsredovisning/pdf).',
  pitfalls: [
    'K2 aktiebolag only.',
    'The live draft is refused while an SIE import is unfinished (409); a frozen version stays readable.',
    'proposed_dividend (whole SEK) applies to the live draft only.',
  ],
  contentType: 'application/xhtml+xml',
  errorCodes: ['PERIOD_NOT_FOUND', 'NOT_FOUND', 'VALIDATION_ERROR'],
  query: z.object({
    version_id: z.string().uuid().optional().describe('A frozen version (annual_report_version_id); omit for the live draft.'),
    proposed_dividend: z.coerce
      .number()
      .min(0)
      .optional()
      .describe('Live draft only: proposed dividend in whole SEK for the resultatdisposition.'),
  }),
  build: (ctx, query, path) => arsredovisningFileBuild('ixbrl', ctx, query, path),
})
