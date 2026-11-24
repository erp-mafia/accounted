/**
 * A deposit specification file, whole: Bankgirot's BG Max (crm#1170) or the
 * bank's camt.054 notification of incoming payments (crm#1883). Decides what
 * the file is, reads it, and attaches each deposit's payments to the bank row
 * that is the deposit (lib/import/bgmax/attach.ts). The file never creates
 * or changes a bank row.
 *
 * Shared by the dashboard route (/api/import/bank-file/deposit-specification)
 * and the v1 operation imports.deposit-specification
 * (lib/operations/deposit-specification.ts), so the file means the same
 * thing through either door.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { attachBgMaxDeposits, type AttachSummary, type AttachableDeposit } from './bgmax/attach'
import { detectBgMax, parseBgMax } from './bgmax/parser'
import { detectCamt054, parseCamt054 } from './camt054/parser'

export type DepositSpecificationFormat = 'bgmax' | 'camt054'

export interface DepositSpecificationInput {
  /** The file name as uploaded; echoed in the answer. */
  filename: string
  /** The file's text, already decoded (decodeFileContent). */
  content: string
}

export interface DepositSpecificationIssue {
  severity: 'info' | 'warning' | 'error'
  message: string
}

export type DepositSpecificationResult = AttachSummary & {
  filename: string
  format: DepositSpecificationFormat
  date_from: string | null
  date_to: string | null
  /** Deposits the file holds that cannot be trusted (their payments do not add up) and were left out. */
  rejected_deposits: number
  issues: DepositSpecificationIssue[]
}

/** What the content is, by the content alone: the file name says nothing reliable. */
export function detectDepositSpecification(content: string): DepositSpecificationFormat | null {
  return detectBgMax(content) ? 'bgmax' : detectCamt054(content) ? 'camt054' : null
}

/**
 * Read the file and attach its deposits. A dry run reads and matches only:
 * its preview is the same summary with `applied` false and nothing written.
 */
export async function attachDepositSpecificationFile(
  ctx: OperationContext,
  input: DepositSpecificationInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<DepositSpecificationResult>> {
  const { supabase, companyId, userId, log } = ctx
  const format = detectDepositSpecification(input.content)
  if (!format) return { ok: false, code: 'BGMAX_NOT_DEPOSIT_FILE' }

  const parsed = format === 'bgmax' ? parseBgMax(input.content) : parseCamt054(input.content)
  if ('test_file' in parsed && parsed.test_file) return { ok: false, code: 'BGMAX_TEST_FILE' }
  const deposits: readonly AttachableDeposit[] = parsed.deposits
  const issues: DepositSpecificationIssue[] = parsed.issues.map((issue) => ({ severity: issue.severity, message: issue.message }))
  if (deposits.length === 0) {
    return {
      ok: false,
      code: format === 'bgmax' ? 'BGMAX_NO_DEPOSITS' : 'CAMT054_NO_DEPOSITS',
      details: { issues: issues.slice(0, 5).map((issue) => issue.message) },
    }
  }

  const apply = !options.dryRun
  const summary = await attachBgMaxDeposits(supabase, { companyId, userId, deposits, apply, source: format })
  const result: DepositSpecificationResult = {
    filename: input.filename,
    format,
    date_from: parsed.date_from,
    date_to: parsed.date_to,
    rejected_deposits: parsed.rejected_deposits,
    issues,
    ...summary,
  }
  if (!apply) return { ok: true, dryRun: true, preview: { ...result } }

  log.info('deposit specification attached', {
    format,
    deposits: summary.deposits,
    matched: summary.matched_deposits,
    noRow: summary.no_row,
    ambiguous: summary.ambiguous,
    ready: summary.ready_rows,
    booked: summary.booked_rows,
  })
  return { ok: true, data: result }
}
