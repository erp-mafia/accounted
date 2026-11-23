/**
 * A deposit specification file over v1: Bankgirot's BG Max or the bank's
 * camt.054 notification of incoming payments, sent as base64. Rules live in
 * lib/import/deposit-specification.ts, shared with the dashboard's
 * /api/import/bank-file/deposit-specification route.
 *
 * v1 only, no MCP tool: the file itself would be the staged params (stored
 * verbatim in pending_operations) and an agent rarely holds the file. An
 * agent reads the result through the bank rows' parts.
 */
import { z } from 'zod'
import { attachDepositSpecificationFile } from '@/lib/import/deposit-specification'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

/** ~3 MB of file: the hosted request body limit is 4.5 MB and base64 adds a third. */
const MAX_BASE64_CHARS = 4_000_000

const outcome = z.object({
  date: z.string().describe('The deposit\'s booking date, YYYY-MM-DD.'),
  amount: z.number(),
  bankgiro: z.string().nullable().describe('The receiving bankgiro; null when the file names none for the deposit.'),
  payments: z.number().describe('Payments in the deposit.'),
  status: z.enum(['matched', 'no_row', 'ambiguous']).describe('matched: attached to a bank row. no_row: no stored bank row is this deposit yet. ambiguous: two or more rows fit equally well, left for a person.'),
  transaction_id: z.string().uuid().nullable().describe('The bank row the deposit attached to (status matched).'),
  suggested: z.number().describe('Payments that got an open customer invoice suggested.'),
})

export const importsDepositSpecification = defineOperation({
  id: 'imports.deposit-specification',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Attach a deposit specification (BG Max or camt.054) to the bank rows that are its deposits.',
    description:
      'Reads Bankgirot\'s BG Max file or the bank\'s ISO 20022 camt.054 notification of incoming payments (sent as base64) and attaches each deposit\'s payments to the stored bank row that is that deposit, as the row\'s parts: payer, organisation number, OCR or invoice number, message and amount per payment. Each payment gets the open customer invoice its reference names as a suggestion; nothing is booked. Never creates a bank row and never changes one\'s amount, date or text. Uploading the same file again writes the same parts.',
    useWhen:
      'A bank row is a deposit of several incoming payments (a bankgiro deposit) or carries no payer and no OCR, and the bank or Bankgirot delivers a file that says who paid what.',
    doNotUseFor:
      'Bank statements that should create bank rows (POST /imports/bank), or booking the payments (match the bank row to its invoices after this).',
    pitfalls: [
      'Send the file bytes as standard, padded base64 in content_base64, up to about 3 MB of file. The format is read from the content, not the file name.',
      'A file cut short still attaches the deposits it holds whole: issues then says the file may be truncated (a BG Max file without its end record, a camt.054 file without its closing element). Send the whole file again to attach the rest.',
      'A deposit whose bank row has not synced yet answers status no_row and attaches nothing: sync the bank and send the same file again.',
      'A deposit that fits two bank rows equally well answers status ambiguous and is left for a person.',
      'A deposit whose payments do not add up to it is left out and counted in rejected_deposits.',
      'A file that is neither format answers 400 BGMAX_NOT_DEPOSIT_FILE; a file with nothing to attach answers 400 BGMAX_NO_DEPOSITS or CAMT054_NO_DEPOSITS with the first issues in details.',
      'dry_run=true reads and matches without writing: the same summary with applied false.',
    ],
    example: {
      request: { filename: 'camt054_20261201.xml', content_base64: 'PD94bWwgdmVyc2lvbj0i…' },
      response: {
        data: {
          filename: 'camt054_20261201.xml',
          format: 'camt054',
          date_from: '2026-12-01',
          date_to: '2026-12-01',
          rejected_deposits: 0,
          issues: [],
          applied: true,
          deposits: 2,
          payments: 4,
          matched_deposits: 1,
          matched_payments: 3,
          suggested_payments: 3,
          ready_rows: 1,
          no_row: 1,
          ambiguous: 0,
          outcomes: [
            { date: '2026-12-01', amount: 1500, bankgiro: '123-4567', payments: 3, status: 'matched', transaction_id: '7c1d…', suggested: 3 },
            { date: '2026-12-01', amount: 250, bankgiro: null, payments: 1, status: 'no_row', transaction_id: null, suggested: 0 },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({
    filename: z.string().trim().min(1).max(255).describe('The file name as delivered, e.g. "camt054_20261201.xml" or "BGMAX_20261201.txt".'),
    content_base64: z
      .string()
      .min(4)
      .max(MAX_BASE64_CHARS)
      .regex(/^[A-Za-z0-9+/\r\n]+={0,2}\s*$/, 'content_base64 must be base64.')
      // An encoding cut off in transport would decode to the first part of the file and attach only that.
      .refine((value) => value.replace(/\s+/g, '').length % 4 === 0, 'content_base64 must be complete, padded base64: its length is not a multiple of 4.')
      .describe('The file\'s bytes as standard, padded base64 (decoded server-side, whatever its text encoding).'),
  }),
  output: z.object({
    filename: z.string(),
    format: z.enum(['bgmax', 'camt054']).describe('What the file was read as.'),
    date_from: z.string().nullable(),
    date_to: z.string().nullable(),
    rejected_deposits: z.number().describe('Deposits left out because their payments do not add up to the deposit.'),
    issues: z.array(z.object({ severity: z.enum(['info', 'warning', 'error']), message: z.string() })).describe('What the reader noted about the file, in Swedish.'),
    applied: z.boolean().describe('True when the parts were written; false for a dry run.'),
    deposits: z.number().describe('Deposits read from the file.'),
    payments: z.number().describe('Payments in those deposits.'),
    matched_deposits: z.number().describe('Deposits whose bank row was found.'),
    matched_payments: z.number(),
    suggested_payments: z.number().describe('Payments that got an open customer invoice suggested.'),
    ready_rows: z.number().describe('Bank rows whose payments all resolved: ready to match in one go.'),
    no_row: z.number().describe('Deposits with no stored bank row yet.'),
    ambiguous: z.number().describe('Deposits that fit two or more bank rows equally well.'),
    outcomes: z.array(outcome).describe('One per deposit, in the file\'s order.'),
  }),
  errorCodes: ['BGMAX_NOT_DEPOSIT_FILE', 'BGMAX_TEST_FILE', 'BGMAX_NO_DEPOSITS', 'CAMT054_NO_DEPOSITS'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/imports/deposit-specification' },
  run: (ctx, input, { dryRun }) => {
    const bytes = Buffer.from(input.content_base64, 'base64')
    const content = decodeFileContent(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer)
    return attachDepositSpecificationFile(ctx, { filename: input.filename, content }, { dryRun })
  },
})
