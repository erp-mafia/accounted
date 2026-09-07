import type { BankFeedAdapter, BankFeedSyncInput, BankFeedSyncResult, BookedBankTransaction } from '@/lib/bank-feed/port'
import { convertTransaction, getAllTransactionsWithRaw } from '../api-client'

export const ENABLE_BANKING_PROVIDER = 'enable-banking'

/**
 * Bank feed adapter on this installation's own Enable Banking credentials:
 * the provider paging with its window recovery, then the booked-only filter
 * and normalization. Throws the client's SessionExpiredError and
 * AspspUnavailableError unchanged.
 */
export const enableBankingDirectAdapter: BankFeedAdapter = {
  provider: ENABLE_BANKING_PROVIDER,
  needsSessionId: false,

  async syncBooked(input: BankFeedSyncInput): Promise<BankFeedSyncResult> {
    const fetched = await getAllTransactionsWithRaw(
      input.accountUid,
      input.fromDate,
      input.toDate,
      input.strategy,
      { acceptedHistoryDays: input.acceptedHistoryDays },
    )

    // Only BOOKED transactions: those the bank returned with a real
    // booking_date. Pending entries are unstable across syncs (a later sync
    // returns the same transaction still pending or finally booked, often
    // with a different effective date). Both stored keys the ledger mints are
    // date-derived, so that drift would re-import a row that already exists.
    // booking_date is read from the RAW transaction: convertTransaction's
    // booking_date already falls back to value_date/today and cannot tell
    // booked from pending.
    const transactions: BookedBankTransaction[] = []
    for (const raw of fetched.transactions) {
      const bookingDate = typeof raw.booking_date === 'string' ? raw.booking_date.trim() : ''
      if (!bookingDate) continue
      const tx = convertTransaction(raw, input.accountCurrency)
      transactions.push({
        booking_date: bookingDate,
        amount: tx.amount,
        currency: tx.currency,
        description: tx.description,
        counterparty_name: tx.counterparty_name ?? null,
        counterparty_account: tx.counterparty_account ?? null,
        reference: tx.reference ?? null,
        merchant_category_code: tx.merchant_category_code ?? null,
        bank_transaction_code: tx.bank_transaction_code ?? null,
        proprietary_bank_transaction_code: tx.proprietary_bank_transaction_code ?? null,
      })
    }

    return {
      transactions,
      rawPages: fetched.rawPages,
      skippedPending: fetched.transactions.length - transactions.length,
      effectiveFromDate: fetched.effectiveDateFrom,
      narrowed: fetched.narrowed === true,
    }
  },
}
