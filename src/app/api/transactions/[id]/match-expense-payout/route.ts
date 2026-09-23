import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MatchExpensePayoutSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { createPayoutBatch } from '@/lib/expenses/expense-claims-service'
import { PAYOUT_ERROR_MESSAGES } from '@/lib/expenses/payout-error-messages'
import { hasLiveJournalEntryLink } from '@/lib/transactions/link-journal-entry'
import { hasBankLineJunctionRow } from '@/lib/transactions/is-booked'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-expense-payout
 *
 * Book an outgoing bank row as the repayment of one person's registered
 * utlägg:
 *
 *   Debit  2893 / 2820 / 2018 (the claims' liability account)  [|tx.amount|]
 *   Credit 19xx (the transaction's cash account)               [|tx.amount|]
 *
 * Same booking as POST /api/expense-claims/payouts, but the amount, date and
 * bank account come from the bank row, and the row is linked to the voucher
 * inside the same RPC transaction: the transfer can never be booked twice
 * (once by "Betala ut", once by categorising the bank row). The RPC requires
 * the claims' total to equal the transfer to the öre.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.match_expense_payout',
  async (request, ctx, { params }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchExpensePayoutSchema, {
      log,
      operation: 'transaction.match_expense_payout',
    })
    if (!validation.success) return validation.response
    const { claim_ids: claimIds } = validation.data

    const txLog = log.child({ transactionId, claimCount: claimIds.length })

    // transaction_voucher_links rides along: a row bulk-booked into a
    // samlingsverifikat carries journal_entry_id = NULL and must still refuse.
    const { data: transactionRow, error: fetchTxError } = await supabase
      .from('transactions')
      .select(
        'id, date, amount, currency, journal_entry_id, cash_account_id, transaction_voucher_links(journal_entry_id, role)',
      )
      .eq('id', transactionId)
      .eq('company_id', companyId!)
      .single()

    if (fetchTxError || !transactionRow) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, { requestId })
    }
    const { transaction_voucher_links: junctionLinks, ...transaction } = transactionRow as {
      id: string
      date: string
      amount: number
      currency: string | null
      journal_entry_id: string | null
      cash_account_id: string | null
      transaction_voucher_links?: Array<{ journal_entry_id: string; role?: string | null }> | null
    }

    if (!(transaction.amount < 0)) {
      return errorResponseFromCode('EXPENSE_PAYOUT_MATCH_NOT_EXPENSE', txLog, {
        requestId,
        details: { amount: transaction.amount },
      })
    }

    if ((transaction.currency || 'SEK').toUpperCase() !== 'SEK') {
      return errorResponseFromCode('EXPENSE_PAYOUT_MATCH_CURRENCY', txLog, {
        requestId,
        details: { currency: transaction.currency },
      })
    }

    // Only a LIVE (posted) pointer or a bank_line junction row blocks: a
    // pointer left behind by a storno reads as "utan koppling" in the UI and
    // must stay matchable (same predicate as link-journal-entry, issue #988).
    // The RPC re-checks under its row lock; this is the early, readable answer.
    if (
      hasBankLineJunctionRow(junctionLinks) ||
      (await hasLiveJournalEntryLink(supabase, companyId!, transaction.journal_entry_id))
    ) {
      return errorResponseFromCode('EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingJournalEntryId: transaction.journal_entry_id },
      })
    }

    // Credit the cash account THIS transaction belongs to, never a
    // company-wide default (mirrors match-supplier-invoice).
    const cashAccount = await resolveSettlementAccount(
      supabase,
      companyId!,
      transaction.cash_account_id,
      txLog,
    )

    try {
      const result = await createPayoutBatch(supabase, companyId!, user.id, {
        claim_ids: claimIds,
        payout_date: transaction.date,
        cash_account: cashAccount,
        transaction_id: transactionId,
      })
      if (!result.ok) {
        if (result.code === 'TX_AMOUNT_MISMATCH') {
          return errorResponseFromCode('EXPENSE_PAYOUT_MATCH_AMOUNT', txLog, {
            requestId,
            details: { amount: transaction.amount },
          })
        }
        const mapped = PAYOUT_ERROR_MESSAGES[result.code] ?? {
          message: 'Utbetalningen kunde inte bokföras.',
          status: 500,
        }
        if (mapped.status >= 500) {
          txLog.error('expense payout from bank transaction failed', new Error(result.detail ?? result.code))
        }
        return NextResponse.json({ error: mapped.message, code: result.code }, { status: mapped.status })
      }

      txLog.info('expense payout matched from bank transaction', {
        userId: user.id,
        journalEntryId: result.journal_entry_id,
        batchId: result.batch_id,
        totalSek: result.total_sek,
      })

      return NextResponse.json({
        success: true,
        journal_entry_id: result.journal_entry_id,
        batch_id: result.batch_id,
        voucher_number: result.voucher_number,
        total_sek: result.total_sek,
        claim_count: result.claim_count,
        category: 'expense_other',
      })
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      txLog.error('failed to match expense payout', err as Error)
      return NextResponse.json(
        { error: getErrorMessage(err, { context: 'journal_entry' }) },
        { status: 500 },
      )
    }
  },
  { requireWrite: true },
)
