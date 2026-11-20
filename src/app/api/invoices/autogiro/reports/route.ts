import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { attachBgMaxDeposits } from '@/lib/import/bgmax/attach'
import { importAutogiroReport } from '@/lib/invoices/autogiro/import-report'
import { encodeAutogiroFile } from '@/lib/invoices/autogiro/writer'

// A year's payment specifications attach a few hundred deposits; give it the
// deposit specification's budget.
export const maxDuration = 300

const DecisionsSchema = z.record(z.string().regex(/^\d{1,16}$/), z.enum(['approve', 'reject']))

/**
 * POST /api/invoices/autogiro/reports: a report from Bankgirot, downloaded
 * in the bank (lib/invoices/autogiro/import-report.ts). FormData: `file`,
 * `apply` ("true" writes; anything else previews), and for the internet-bank
 * mandates report `decisions` (JSON: payer number to "approve" | "reject").
 *
 * A payment specification's debited deposits are then attached to the bank
 * rows that are those deposits, exactly as a BG Max deposit specification
 * is (lib/import/bgmax/attach.ts): each invoice gets its payment suggested by
 * its OCR and the person confirms the batch allocation. A deposit whose bank
 * row has not synced yet attaches when the same file is uploaded again: the
 * report is read once, its deposits as often as it takes.
 *
 * The answer to internet-bank mandates carries the payers' accounts and
 * personnummer: it is returned here, base64 of the ISO 8859-1 bytes, and
 * never stored.
 */
export const POST = withRouteContext(
  'autogiro.report.import',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const formData = await request.formData()
    const file = formData.get('file')
    const apply = formData.get('apply') === 'true'
    if (!(file instanceof File)) return errorResponseFromCode('BANK_FILE_NO_FILE', log, { requestId })
    if (file.size > 10 * 1024 * 1024) {
      return errorResponseFromCode('BANK_FILE_TOO_LARGE', log, { requestId, details: { sizeMb: Math.round(file.size / 1024 / 1024) } })
    }
    let decisions: Record<string, 'approve' | 'reject'> | undefined
    const rawDecisions = formData.get('decisions')
    if (typeof rawDecisions === 'string' && rawDecisions.trim()) {
      let json: unknown
      try {
        json = JSON.parse(rawDecisions)
      } catch {
        return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { field: 'decisions' } })
      }
      const parsed = DecisionsSchema.safeParse(json)
      if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { field: 'decisions' } })
      decisions = parsed.data
    }

    const content = decodeFileContent(await file.arrayBuffer())
    const result = await importAutogiroReport(supabase, {
      companyId,
      userId: user.id,
      content,
      filename: file.name || null,
      apply,
      today: todayIsoStockholm(),
      decisions,
    })
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId, details: result.details })

    const { ok: _ok, settlement, answer_file, ...outcome } = result
    let attached = null
    if (apply && settlement.length > 0) {
      const summary = await attachBgMaxDeposits(supabase, { companyId, userId: user.id, deposits: settlement, apply: true })
      attached = {
        deposits: summary.deposits,
        matched_deposits: summary.matched_deposits,
        matched_payments: summary.matched_payments,
        no_row: summary.no_row,
        ambiguous: summary.ambiguous,
        ready_rows: summary.ready_rows,
      }
    }
    if (apply) {
      log.info('autogiro report read', { kind: outcome.kind, debits: outcome.debits.length, mandates: outcome.mandates.length, attached })
    }
    return NextResponse.json({
      data: {
        ...outcome,
        filename: file.name,
        settlement: attached,
        answer_file: answer_file
          ? { filename: answer_file.filename, content_base64: encodeAutogiroFile(answer_file.content).toString('base64') }
          : null,
      },
    })
  },
  { requireWrite: true },
)
