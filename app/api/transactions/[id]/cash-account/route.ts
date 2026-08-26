import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MoveTransactionCashAccountSchema } from '@/lib/api/schemas'
import { guardSandbox } from '@/lib/sandbox/guard'

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
    const { account_number: accountNumber } = validation.data

    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('id, currency, cash_account_id, journal_entry_id, invoice_id, supplier_invoice_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    // Gate: movable only when neither booked nor confirmed-matched (a confirmed
    // invoice match also sets journal_entry_id, but check all three for
    // defense-in-depth, mirroring the title route).
    if (transaction.journal_entry_id || transaction.invoice_id || transaction.supplier_invoice_id) {
      return errorResponseFromCode('TRANSACTION_MOVE_BOOKED', log, { requestId })
    }

    // Bulk-book (N>1) anchors a transaction to a verifikat via
    // transaction_voucher_links WITHOUT setting journal_entry_id, so the gate
    // above misses it. PostgREST cannot express NOT EXISTS in an update filter,
    // so this runs as a pre-check query instead of being re-asserted in the
    // UPDATE below. That leaves no extra TOCTOU risk: a tvl row appearing
    // concurrently implies the booking flow ran, and that flow sets its own
    // transaction state as part of the same operation.
    const { data: voucherLinks, error: tvlError } = await supabase
      .from('transaction_voucher_links')
      .select('transaction_id')
      .eq('company_id', companyId)
      .eq('transaction_id', id)
      .limit(1)

    if (tvlError) {
      return errorResponse(tvlError, log, { requestId })
    }
    if ((voucherLinks ?? []).length > 0) {
      return errorResponseFromCode('TRANSACTION_MOVE_BOOKED', log, { requestId })
    }

    const { data: targetAccount, error: accountError } = await supabase
      .from('cash_accounts')
      .select('id, ledger_account, currency')
      .eq('company_id', companyId)
      .eq('ledger_account', accountNumber)
      .maybeSingle<{ id: string; ledger_account: string; currency: string }>()

    if (accountError) {
      return errorResponse(accountError, log, { requestId })
    }
    if (!targetAccount) {
      return errorResponseFromCode('TRANSACTION_MOVE_UNKNOWN_ACCOUNT', log, { requestId })
    }

    // A cross-currency move would strand the row: every report scope pins
    // .eq('currency', accountCurrency), so the row would vanish from BOTH the
    // old and the new account's reconciliation. Hard-reject.
    if (transaction.currency.toUpperCase() !== targetAccount.currency.toUpperCase()) {
      return errorResponseFromCode('TRANSACTION_MOVE_CURRENCY_MISMATCH', log, { requestId })
    }

    const { data: updated, error: updateError } = await supabase
      .from('transactions')
      .update({ cash_account_id: targetAccount.id })
      .eq('id', id)
      .eq('company_id', companyId)
      // Re-assert the movable gate atomically against a concurrent book or
      // auto-match (ingest's supplier auto-match can set supplier_invoice_id
      // WITHOUT journal_entry_id), mirroring PATCH /api/transactions/[id].
      // The tvl part of the gate lives in the pre-check above; see the comment
      // there for why that is safe.
      .is('journal_entry_id', null)
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      .select('id, cash_account_id')
      .maybeSingle<{ id: string; cash_account_id: string }>()

    if (updateError) {
      return errorResponse(updateError, log, { requestId })
    }
    if (!updated) {
      // 0 rows updated: the row was booked/matched between read and write.
      return errorResponseFromCode('TRANSACTION_MOVE_BOOKED', log, { requestId })
    }

    // Behandlingshistorik (BFNAR 2013:2 kap 8): light-touch for a pre-verifikat
    // staging binding, same weight as the title route. updated_at (trigger)
    // captures "when"; from/to ids record which way the row moved.
    log.info('transaction moved to another cash account', {
      transactionId: id,
      actor: user.id,
      fromCashAccountId: transaction.cash_account_id,
      toCashAccountId: targetAccount.id,
      toLedgerAccount: targetAccount.ledger_account,
    })

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
