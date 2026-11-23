import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { attachDepositSpecificationFile } from '@/lib/import/deposit-specification'
import { sessionFailureResponse } from '@/lib/operations/session'

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
 * bank sync. The rules live in lib/import/deposit-specification.ts, shared
 * with the v1 operation imports.deposit-specification.
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

    const outcome = await attachDepositSpecificationFile(
      { supabase, companyId, userId: user.id, log },
      { filename: file.name, content: decodeFileContent(await file.arrayBuffer()) },
      { dryRun: !apply },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)

    // The preview and the applied answer are the same summary; `applied` tells them apart.
    return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
  },
  { requireWrite: true },
)
