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
//
// The same operation ignores a skattekonto row (crm#1178): its params name
// the row as skattekonto_transaction_id, and the executor hands it to
// setItemIgnored (lib/reconciliation/actions.ts), the function the
// Avstämning page and the v1 ignore route call. Exactly one of the two ids.
// Operations staged before carry transaction_id only and parse unchanged.

export const IgnoreTransactionParamsSchema = z
  .object({
    transaction_id: z.string().uuid().optional(),
    skattekonto_transaction_id: z.string().uuid().optional(),
    // true = ignore (default), false = restore a previously ignored row.
    ignored: z.boolean().default(true),
  })
  .refine((p) => Boolean(p.transaction_id) !== Boolean(p.skattekonto_transaction_id), {
    message: 'exactly one of transaction_id or skattekonto_transaction_id is required',
    path: ['transaction_id'],
  })
