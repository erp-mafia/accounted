import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { validateBody } from '@/lib/api/validate'
import { MoveTransactionCashAccountSchema } from '@/lib/api/schemas'
import { guardSandbox } from '@/lib/sandbox/guard'
import { updateTransaction } from '@/lib/transactions/manage'

/**
 * PATCH /api/transactions/[id]/cash-account
 *
 * Move an unbooked bank transaction to another of the company's cash accounts
 * (cash_accounts row, addressed by its BAS 19xx ledger account). This is the
 * escape hatch for rows that ingested under the wrong account or with no
 * account at all (legacy connections, own-account transfers the backfills
 * deliberately skipped): such a row surfaces under the primary account's
 * reconciliation and can never be matched on the account it belongs to.
 *
 * Only a mutable staging row may move: NOT booked (journal_entry_id), NOT
 * confirmed-matched (invoice_id / supplier_invoice_id), and NOT anchored via
 * transaction_voucher_links (bulk-book N>1 links transactions to a verifikat
 * WITHOUT setting journal_entry_id). Once anchored, the voucher's own 19xx
 * line is ground truth for which account the money moved on (see the repair
 * backfill 20260609120000), so the binding must not be editable.
 */
export const PATCH = withRouteContext(
  'transaction.moveCashAccount',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId, user } = ctx

    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked

    const validation = await validateBody(request, MoveTransactionCashAccountSchema, {
      log,
      operation: 'transaction.moveCashAccount',
    })
    if (!validation.success) return validation.response

    // Rules (unbooked, unmatched, not voucher-linked, same currency, known
    // account; a disabled unused target is re-enabled first) live in
    // lib/transactions/manage.ts, shared with
    // PATCH /api/v1/companies/{companyId}/transactions/{id}.
    const outcome = await updateTransaction(
      { supabase, companyId, userId: user.id, log },
      id,
      { account_number: validation.data.account_number },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    return NextResponse.json({ data: { id: outcome.data.id, cash_account_id: outcome.data.cash_account_id } })
  },
  { requireWrite: true },
)
