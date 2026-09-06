import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MatchRotRutPayoutSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import {
  settleRotRutPayoutRequest,
  settleRotRutPayoutRequestSet,
} from '@/lib/invoices/rot-rut-settle'
import { hasLiveJournalEntryLink } from '@/lib/transactions/link-journal-entry'
import { hasBankLineJunctionRow } from '@/lib/transactions/is-booked'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-rot-rut-payout
 *
 * Match an income bank row to the ROT/RUT begäran whose payout it is:
 *
 *   Debit  19xx (the transaction's cash account)  [tx.amount]
 *   Credit 1513 Skattereduktion rot/rut           [tx.amount]
 *
 * Same settle as POST /api/rot-rut/payout-requests/[id]/settle, but amount,
 * date and bank account come from the bank row and the row is linked to the
 * voucher in the same call, so the payout can never be booked twice (once by
 * settle, once by categorising the bank row).
 *
 * Skatteverket bundles the beslut it pays that day into one transfer, so the
 * body may name several begäran (`request_ids`, #2239): then ONE voucher
 * carries one 1513 credit per begäran and the row is linked to it, provided
 * the expected payouts sum to the row exactly.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.match_rot_rut_payout',
  async (request, ctx, { params }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchRotRutPayoutSchema, {
      log,
      operation: 'transaction.match_rot_rut_payout',
    })
    if (!validation.success) return validation.response
    const payoutRequestIds = [
      ...new Set(validation.data.request_ids ?? [validation.data.request_id!]),
    ]

    const txLog = log.child({ transactionId, payoutRequestIds })

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

    if (!(transaction.amount > 0)) {
      return errorResponseFromCode('ROT_RUT_MATCH_NOT_INCOME', txLog, {
        requestId,
        details: { amount: transaction.amount },
      })
    }

    if ((transaction.currency || 'SEK').toUpperCase() !== 'SEK') {
      return errorResponseFromCode('ROT_RUT_MATCH_CURRENCY', txLog, {
        requestId,
        details: { currency: transaction.currency },
      })
    }

    // Only a LIVE (posted) pointer or a bank_line junction row blocks: a
    // pointer left behind by a storno reads as "utan koppling" in the UI and
    // must stay matchable (same predicate as link-journal-entry, issue #988).
    if (
      hasBankLineJunctionRow(junctionLinks) ||
      (await hasLiveJournalEntryLink(supabase, companyId!, transaction.journal_entry_id))
    ) {
      return errorResponseFromCode('ROT_RUT_MATCH_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingJournalEntryId: transaction.journal_entry_id },
      })
    }

    // Debit the cash account THIS transaction belongs to, never a company-wide
    // default (mirrors match-supplier-invoice).
    const bankAccount = await resolveSettlementAccount(
      supabase,
      companyId!,
      transaction.cash_account_id,
      txLog,
    )

    // Shared by both shapes: amount, date and account come from the bank row;
    // the link CAS locks on the pointer read above (null for a free row, or
    // the stale pointer of a reversed entry the guard let through).
    const settleParams = {
      paymentDate: transaction.date,
      amount: transaction.amount,
      bankAccount,
      transactionId,
      previousJournalEntryId: transaction.journal_entry_id,
    }

    const outcome =
      payoutRequestIds.length === 1
        ? await settleRotRutPayoutRequest(supabase, user.id, companyId!, {
            requestId: payoutRequestIds[0],
            ...settleParams,
          })
        : await settleRotRutPayoutRequestSet(supabase, user.id, companyId!, {
            requestIds: payoutRequestIds,
            ...settleParams,
          })

    if (!outcome.ok) {
      if (outcome.kind === 'code') {
        return errorResponseFromCode(outcome.code, txLog, { requestId, details: outcome.details })
      }
      if (outcome.stage === 'book') {
        txLog.error('failed to book rot/rut payout entry', outcome.error as Error)
      }
      return errorResponse(outcome.error, txLog, { requestId })
    }

    txLog.info('rot/rut payout matched from bank transaction', {
      userId: user.id,
      journalEntryId: outcome.journalEntryId,
      amount: outcome.amount,
      fullyPaid: 'fullyPaid' in outcome ? outcome.fullyPaid : true,
    })

    return NextResponse.json({
      success: true,
      journal_entry_id: outcome.journalEntryId,
      ...('request' in outcome ? { request: outcome.request } : { requests: outcome.requests }),
      category: 'income_other',
    })
  },
  { requireWrite: true },
)
