import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { detectBgMax, parseBgMax } from '@/lib/import/bgmax/parser'
import { attachBgMaxDeposits, type AttachableDeposit } from '@/lib/import/bgmax/attach'
import { detectCamt054, parseCamt054 } from '@/lib/import/camt054/parser'

// A year's file attaches a few hundred deposits, each a delete, an insert and
// a marker; give it the bank-file import's budget.
export const maxDuration = 300

/**
 * POST /api/import/bank-file/deposit-specification
 *
 * A deposit specification: Bankgirot's BG Max file (crm#1170) or the bank's
 * own notification of incoming payments (ISO 20022 camt.054, crm#1883). Each
 * deposit in the file is attached to the stored bank row that is that
 * deposit, as the row's split (one part per payment with OCR, payer and
 * amount), and each payment gets the open customer invoice its reference
 * names. Never creates or changes a bank row; a deposit with no stored row
 * is reported and attaches when the same file is uploaded after the next
 * bank sync.
 *
 * FormData: `file` (the BG Max or camt.054 file), `apply` ("true" writes;
 * anything else is the preview, which reads and matches only).
 */
export const POST = withRouteContext(
  'bank_file.deposit_specification',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const formData = await request.formData()
    const file = formData.get('file')
    const apply = formData.get('apply') === 'true'

    if (!(file instanceof File)) {
      return errorResponseFromCode('BANK_FILE_NO_FILE', log, { requestId })
    }
    if (file.size > 10 * 1024 * 1024) {
      return errorResponseFromCode('BANK_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: Math.round(file.size / 1024 / 1024) },
      })
    }

    const content = decodeFileContent(await file.arrayBuffer())
    const source = detectBgMax(content) ? 'bgmax' : detectCamt054(content) ? 'camt054' : null
    if (!source) {
      return errorResponseFromCode('BGMAX_NOT_DEPOSIT_FILE', log, { requestId })
    }
    const parsed = source === 'bgmax' ? parseBgMax(content) : parseCamt054(content)
    if ('test_file' in parsed && parsed.test_file) {
      return errorResponseFromCode('BGMAX_TEST_FILE', log, { requestId })
    }
    const deposits: readonly AttachableDeposit[] = parsed.deposits
    if (deposits.length === 0) {
      return errorResponseFromCode(source === 'bgmax' ? 'BGMAX_NO_DEPOSITS' : 'CAMT054_NO_DEPOSITS', log, {
        requestId,
        details: { issues: parsed.issues.slice(0, 5).map((i) => i.message) },
      })
    }

    const summary = await attachBgMaxDeposits(supabase, {
      companyId,
      userId: user.id,
      deposits,
      apply,
      source,
    })
    if (apply) {
      log.info('deposit specification attached', {
        source,
        deposits: summary.deposits,
        matched: summary.matched_deposits,
        noRow: summary.no_row,
        ambiguous: summary.ambiguous,
        ready: summary.ready_rows,
      })
    }

    return NextResponse.json({
      data: {
        filename: file.name,
        date_from: parsed.date_from,
        date_to: parsed.date_to,
        rejected_deposits: parsed.rejected_deposits,
        issues: parsed.issues,
        ...summary,
      },
    })
  },
  { requireWrite: true },
)
