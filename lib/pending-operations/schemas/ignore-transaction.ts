import { z } from 'zod'

// Commit-boundary re-validation for the staged ignore_transaction operation
// (gnubok_ignore_transaction, issue #1661). Ignoring writes no verifikat: it
// flips transactions.is_ignored so a row that is not an affärshändelse (a
// PSD2 ghost row, a duplicate from a reconnect, a transfer that never
// executed) leaves the "to book" funnels. The DB CHECK
// transactions_is_ignored_no_journal_entry guarantees an ignored row is
// unbooked, and lib/transactions/ignore.ts refuses a booked row through the
// three anchors (journal_entry_id, payment allocations, voucher links), so
// this schema only has to bound the shape.

export const IgnoreTransactionParamsSchema = z.object({
  transaction_id: z.string().uuid(),
  // true = ignore (default), false = restore a previously ignored row.
  ignored: z.boolean().default(true),
})

export type IgnoreTransactionParams = z.infer<typeof IgnoreTransactionParamsSchema>
