/**
 * POST /api/transactions/[id]/link-journal-entry
 *
 * Link a bank transaction to an already-posted journal entry without
 * creating new bookkeeping. Used by the duplicate-payment UI when the user
 * confirms the suggested candidate already books this receipt: typically
 * a manual verifikation made outside the match-invoice flow.
 *
 * Body:
 *   - journal_entry_id (required): the existing posted JE to link to.
 *   - invoice_id (optional): when supplied, also inserts an
 *     invoice_payments row pointing at the existing JE and flips the
 *     invoice status to 'paid' / 'partially_paid'.
 *
 * Effects:
 *   - transactions.journal_entry_id = je_id
 *   - transactions.is_business = true
 *   - transactions.potential_invoice_id = null
 *   - transactions.potential_supplier_invoice_id = null
 *   - if invoice_id provided:
 *     - invoice_payments row inserted (transaction_id, amount, journal_entry_id)
 *     - invoice.status / paid_amount / remaining_amount updated
 *
 * NEVER creates a new journal entry; the underlying double-entry already
 * exists. The match log records 'linked_to_existing_voucher' for audit.
 *
 * Core logic is shared with the MCP commit handler in lib/pending-operations/commit.ts
 * (gnubok_link_transaction_to_journal_entry): see lib/transactions/link-journal-entry.ts.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { LinkTransactionJournalEntrySchema } from '@/lib/api/schemas'
import { ensureInitialized } from '@/lib/init'
import { linkTransactionToJournalEntry } from '@/lib/transactions/link-journal-entry'

ensureInitialized()

export const POST = withRouteContext(
  'transaction.link_journal_entry',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, LinkTransactionJournalEntrySchema, {
      log,
      operation: 'transaction.link_journal_entry',
    })
    if (!validation.success) return validation.response
    const { journal_entry_id, invoice_id } = validation.data

    const txLog = log.child({ transactionId, journalEntryId: journal_entry_id, invoiceId: invoice_id })

    const outcome = await linkTransactionToJournalEntry(supabase, user.id, companyId, {
      transactionId,
      journalEntryId: journal_entry_id,
      invoiceId: invoice_id,
    })

    if (!outcome.ok) {
      // LINK_TX_DB_ERROR is the only code emitted on raw DB failure; route it
      // through the generic errorResponse fallback so the INTERNAL_ERROR envelope
      // matches the rest of the API. Everything else maps to a structured-error
      // entry with the right HTTP status.
      if (outcome.code === 'LINK_TX_DB_ERROR') {
        return errorResponse(new Error(String(outcome.details?.reason ?? 'Database error')), txLog, {
          requestId,
        })
      }
      return errorResponseFromCode(outcome.code, txLog, { requestId, details: outcome.details })
    }

    return NextResponse.json({
      success: true,
      journal_entry_id: outcome.result.journalEntryId,
      voucher_label: outcome.result.voucherLabel,
      invoice_id: outcome.result.invoiceId,
      invoice_status: outcome.result.invoiceStatus,
      paid_amount: outcome.result.paidAmount,
      remaining_amount: outcome.result.remainingAmount,
    })
  },
  { requireWrite: true },
)
