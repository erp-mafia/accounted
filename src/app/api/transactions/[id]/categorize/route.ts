/**
 * POST /api/transactions/{id}/categorize: the dashboard's categorize door.
 *
 * Parses the body and renders the outcome of categorizeTransaction
 * (lib/transactions/categorize-core.ts), the one booking path the v1 routes,
 * the approval executor and the MCP tool share. A row a posted verifikat
 * already books gets its flags updated and keeps its verifikat. A row's one
 * click (review_shown false) on a proposal the direct-booking policy sends to
 * a review is refused with TX_CATEGORIZE_REVIEW_REQUIRED, nothing written.
 *
 * A row dated in a momsperiod whose declaration is filed, booked with lines
 * that declaration reads, is asked about first: 409
 * TX_CATEGORIZE_VAT_PERIOD_FILED with the warning in details.warnings, until
 * the same request comes back with confirm_filed_vat_period
 * (lib/transactions/filed-vat-categorize.ts). The booking made past it is
 * recorded on the verifikat, like a typed verifikat booked past a warning.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { AccountsNotInChartError, accountsNotInChartResponse } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { DashboardCategorizeSchema } from '@/lib/api/schemas'
import { categorizeTransaction } from '@/lib/transactions/categorize-core'
import { filedPeriodCategorizeWarning } from '@/lib/transactions/filed-vat-categorize'
import { recordVoucherWarningsAcknowledged } from '@/lib/bookkeeping/voucher-warnings-guard'

export const POST = withRouteContext(
  'transaction.categorize',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, DashboardCategorizeSchema, {
      log,
      operation: 'transaction.categorize',
    })
    if (!validation.success) return validation.response

    const { in_bulk: inBulk, confirm_filed_vat_period: confirmedFiledVat, ...booking } = validation.data
    const coreOptions = { onBooked: 'update_flags' as const, ...(inBulk ? { withoutReview: true } : {}) }

    // Asked on every send, so a booking confirmed past it is known as one. A
    // private marking carries no moms and is never asked. One of a selection
    // (in_bulk) is refused like any other: the page names the reason once
    // for the rows it holds back, and each is confirmed for itself.
    const filedVat = booking.is_business
      ? await filedPeriodCategorizeWarning(supabase, user.id, companyId, id, booking, { ...coreOptions, log })
      : null
    if (filedVat && !confirmedFiledVat) {
      return errorResponseFromCode('TX_CATEGORIZE_VAT_PERIOD_FILED', log, { requestId, details: { warnings: [filedVat] } })
    }

    const outcome = await categorizeTransaction(supabase, user.id, companyId, id, booking, { ...coreOptions, log })

    if (!outcome.ok) {
      // The dashboard reads account_numbers from the top level as well as
      // from details, so this refusal keeps its own envelope.
      if (outcome.code === 'ACCOUNTS_NOT_IN_CHART') {
        return accountsNotInChartResponse(
          new AccountsNotInChartError((outcome.details?.account_numbers as string[] | undefined) ?? []),
        )
      }
      return errorResponseFromCode(outcome.code, log, {
        requestId,
        details: outcome.details,
        // Both locales or neither (errorResponseFromCode's contract).
        ...(outcome.message?.en ? { messageSv: outcome.message.sv, messageEn: outcome.message.en } : {}),
      })
    }
    if (outcome.dryRun) throw new Error('categorize: unexpected dry-run outcome')

    const booked = outcome.booked
    if (filedVat && booked.journal_entry_created && booked.journal_entry_id) {
      await recordVoucherWarningsAcknowledged({
        companyId,
        userId: user.id,
        journalEntryId: booked.journal_entry_id,
        warnings: [filedVat],
        door: 'dashboard_categorize',
        log,
      })
    }
    return NextResponse.json({
      success: true,
      journal_entry_created: booked.journal_entry_created,
      journal_entry_id: booked.journal_entry_id,
      // Always null: a verifikat that cannot be created is refused with a
      // typed 409 (issue #1947). Kept for client compatibility.
      journal_entry_error: null,
      category: booked.category,
      ...(booked.already_had_journal_entry ? { already_had_journal_entry: true } : {}),
    })
  },
  { requireWrite: true },
)
