/**
 * The skattekontoutdrag file import over v1, for a company without a
 * Skatteverket connection (self-hosted, or before connecting): the file the
 * user downloads from Skatteverket's Skattekonto e-tjänst, sent as base64.
 * Rules live in lib/import/skattekonto-file/import-file.ts, shared with the
 * dashboard's /api/import/skattekonto-file/execute route.
 *
 * v1 only, no MCP tool: the file itself would be the staged params (stored
 * verbatim in pending_operations) and an agent rarely holds the file; the
 * dashboard and v1 cover the self-hosted case.
 */
import { z } from 'zod'
import { importSkattekontoFile } from '@/lib/import/skattekonto-file/import-file'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

/** ~3 MB of file: the hosted request body limit is 4.5 MB and base64 adds a third. */
const MAX_BASE64_CHARS = 4_000_000

export const importsSkattekontoFile = defineOperation({
  id: 'imports.skattekonto-file',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Import a skattekontoutdrag file (Skatteverket tax account statement) into the skattekonto rows.',
    description:
      'Parses the statement (the CSV export or legacy .skv from Skatteverket\'s Skattekonto e-tjänst, sent as base64), deduplicates it server-side against the skattekonto rows already stored, inserts the new events (source file_import), promotes upcoming rows the statement proves settled and skips duplicates. Books nothing: the rows are booked afterwards through the skattekonto rules, like synced rows. A file already imported is refused; a file naming another organisation number or not summing is refused unless confirmed. Idempotent. Dry-runnable: the dry run parses and counts and writes nothing.',
    useWhen:
      'The company has no Skatteverket connection (self-hosted, or not yet connected) and the skattekonto should be reconciled and booked from the statement file.',
    doNotUseFor:
      'Companies with a Skatteverket connection (the hourly sync fetches the same events), bank statements (POST /imports/bank), or booking the rows (the skattekonto booking tools).',
    pitfalls: [
      'Send the file bytes base64-encoded in content_base64, up to about 3 MB of file; the filename matters for legacy .skv detection.',
      'A file already imported answers 409 SKATTEKONTO_FILE_DUPLICATE with details.import_id.',
      'A header organisation number that is not the company\'s answers 409 SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH: check the file, then resend with confirm_org_number_mismatch=true.',
      'A statement whose saldo markers do not sum (filtered, truncated or edited) answers 409 SKATTEKONTO_FILE_SUM_MISMATCH: resend with confirm_sum_mismatch=true only if the gap is understood.',
      'A file that is not a skattekontoutdrag answers 400 SKATTEKONTO_FILE_NOT_RECOGNIZED: a bank CSV is never accepted here.',
    ],
    example: {
      request: { filename: 'Kontoutdrag 556677-8899 2026-05-03--2026-08-01.csv', content_base64: 'U2thdHRla29udG8…' },
      response: {
        data: {
          import_id: '1f0c…',
          imported: 14,
          duplicates: 2,
          promoted: 1,
          errors: 0,
          date_from: '2026-05-03',
          date_to: '2026-08-01',
          closing_saldo: 23490,
          file_hash: '9a1b…',
          variant: 'csv',
          row_count: 17,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    filename: z.string().trim().min(1).max(255).describe('The file name as downloaded, e.g. "Kontoutdrag 556677-8899 2026-05-03--2026-08-01.csv".'),
    content_base64: z
      .string()
      .min(4)
      .max(MAX_BASE64_CHARS)
      .regex(/^[A-Za-z0-9+/\r\n]+={0,2}\s*$/, 'content_base64 must be base64.')
      .describe('The file\'s bytes, base64-encoded (any encoding Skatteverket exports; decoded server-side).'),
    confirm_org_number_mismatch: z
      .boolean()
      .optional()
      .describe('Import even though the file names another organisation number than the company\'s.'),
    confirm_sum_mismatch: z
      .boolean()
      .optional()
      .describe('Import even though opening saldo plus the events does not equal the closing saldo.'),
  }),
  output: z.object({
    import_id: z.string().uuid(),
    imported: z.number().describe('New skattekonto rows stored.'),
    duplicates: z.number().describe('Events already stored, skipped.'),
    promoted: z.number().describe('Upcoming rows the statement proves settled, flipped to booked status.'),
    errors: z.number().describe('Rows that could not be written.'),
    date_from: z.string(),
    date_to: z.string(),
    closing_saldo: z.number().nullable(),
    file_hash: z.string(),
    variant: z.enum(['csv', 'skv']),
    row_count: z.number(),
  }),
  errorCodes: [
    'SKATTEKONTO_FILE_TOO_LARGE',
    'SKATTEKONTO_FILE_DUPLICATE',
    'SKATTEKONTO_FILE_NOT_RECOGNIZED',
    'SKATTEKONTO_FILE_NO_ROWS',
    'SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH',
    'SKATTEKONTO_FILE_SUM_MISMATCH',
    'SKATTEKONTO_FILE_PARSE_FAILED',
    'SKATTEKONTO_FILE_IMPORT_RECORD_FAILED',
    'SKATTEKONTO_FILE_EXECUTE_FAILED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/imports/skattekonto-file' },
  run: (ctx, input, { dryRun }) => importSkattekontoFile(ctx, input, { dryRun }),
})
