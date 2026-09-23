import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ConfirmJeSuggestionsSchema } from '@/lib/api/schemas'
import {
  confirmJournalEntrySuggestions,
  rejectJournalEntrySuggestions,
} from '@/lib/reconciliation/suggestions'

ensureInitialized()

// A full 500-item batch runs sequentially with several queries per pair
// (revalidation is the point), which can exceed the platform's default
// function budget. Same 5-minute allowance as the bank-file and SIE imports.
export const maxDuration = 300

/**
 * POST /api/reconciliation/bank/confirm-suggestions
 *
 * Bulk confirm (or reject) journal-entry match suggestions written by the
 * SIE reconciliation sweep. Confirming links each transaction to its suggested
 * verifikat via the ordinary manual-link path with full server-side
 * revalidation per pair; pairs that went stale between suggestion and click
 * (entry reversed, verifikat consumed by another row, row booked elsewhere)
 * are skipped and reported rather than failing the batch.
 */
export const POST = withRouteContext(
  'reconciliation.bank.confirm_suggestions',
  async (request, { supabase, user, companyId }) => {
    const validation = await validateBody(request, ConfirmJeSuggestionsSchema)
    if (!validation.success) return validation.response
    const { transaction_ids, action } = validation.data

    const result =
      action === 'confirm'
        ? await confirmJournalEntrySuggestions(supabase, companyId, user.id, transaction_ids)
        : await rejectJournalEntrySuggestions(supabase, companyId, user.id, transaction_ids)

    return NextResponse.json({
      data: {
        confirmed: result.confirmed,
        rejected: result.rejected,
        skipped: result.skipped.map((s) => ({
          transaction_id: s.transactionId,
          reason: s.reason,
          message: s.message,
        })),
      },
    })
  },
  { requireWrite: true },
)
