import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { DashboardBulkBookSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bulkBookTransactions } from '@/lib/transactions/bulk-book'
import { filedPeriodBulkBookWarning } from '@/lib/transactions/filed-vat-bulk-book'
import { recordVoucherWarningsAcknowledged } from '@/lib/bookkeeping/voucher-warnings-guard'

/**
 * POST /api/transactions/bulk-book
 *
 * Bulk-book N bank transactions on the same date into one combined
 * verifikat (samlingsverifikation per BFL 5 kap 6§): link them to an
 * existing voucher, expand a booking template, or pass manual lines. The
 * rules (currency, duplicate guard, chart allowlist, template visibility,
 * dimension rules, the RPC, underlag propagation and events) live in
 * lib/transactions/bulk-book.ts, shared with
 * POST /api/v1/companies/{companyId}/transactions/bulk-book.
 *
 * A new samlingsverifikat dated in a momsperiod whose declaration is filed,
 * with lines that declaration reads, is asked about first: 409
 * BULK_BOOK_VAT_PERIOD_FILED with the warning in details.warnings, until the
 * same request comes back with confirm_filed_vat_period
 * (lib/transactions/filed-vat-bulk-book.ts). The booking made past it is
 * recorded on the verifikat, like a typed verifikat booked past a warning.
 */
export const POST = withRouteContext(
  'transaction.bulk_book',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, DashboardBulkBookSchema, {
      log,
      operation: 'transaction.bulk_book',
    })
    if (!validation.success) return validation.response

    const { confirm_filed_vat_period: confirmedFiledVat, ...body } = validation.data
    const opCtx = { supabase, companyId: companyId!, userId: user.id, log }

    // Asked on every send, so a booking confirmed past it is known as one.
    const filedVat = await filedPeriodBulkBookWarning(opCtx, body)
    if (filedVat && !confirmedFiledVat) {
      return errorResponseFromCode('BULK_BOOK_VAT_PERIOD_FILED', log, { requestId, details: { warnings: [filedVat] } })
    }

    const outcome = await bulkBookTransactions(opCtx, body, { via: 'bulk_book_force' })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    if (filedVat && outcome.data.mode === 'create_new') {
      await recordVoucherWarningsAcknowledged({
        companyId: companyId!,
        userId: user.id,
        journalEntryId: outcome.data.journal_entry_id,
        warnings: [filedVat],
        door: 'dashboard_bulk_book',
        log,
      })
    }

    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
