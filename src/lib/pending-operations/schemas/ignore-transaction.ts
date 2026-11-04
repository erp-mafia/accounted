import { z } from 'zod'
import { BULK_IGNORE_MAX_ROWS } from '@/lib/transactions/bulk-ignore'

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
//
// gnubok_bulk_ignore_transactions (crm#1647) stages the same operation over
// the unbooked rows of one cash account dated before a cutoff: the ids it
// resolved (at most BULK_IGNORE_MAX_ROWS) with the selection they came from,
// which the executor re-applies (lib/transactions/bulk-ignore.ts). Exactly
// one of the three id fields.

export const IgnoreTransactionParamsSchema = z
  .object({
    transaction_id: z.string().uuid().optional(),
    skattekonto_transaction_id: z.string().uuid().optional(),
    transaction_ids: z.array(z.string().uuid()).min(1).max(BULK_IGNORE_MAX_ROWS).optional(),
    cash_account_id: z.string().uuid().optional(),
    before_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // true = ignore (default), false = restore a previously ignored row.
    ignored: z.boolean().default(true),
  })
  .refine(
    (p) => [p.transaction_id, p.skattekonto_transaction_id, p.transaction_ids].filter(Boolean).length === 1,
    {
      message: 'exactly one of transaction_id, skattekonto_transaction_id or transaction_ids is required',
      path: ['transaction_id'],
    },
  )
  .refine((p) => !p.transaction_ids || (Boolean(p.cash_account_id) && Boolean(p.before_date)), {
    message: 'transaction_ids needs the cash_account_id and before_date they were selected by',
    path: ['transaction_ids'],
  })
