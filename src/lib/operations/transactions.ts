/**
 * Bank transaction actions served through the machine doors (see ./types.ts):
 * delete an unbooked row typed in by hand, edit the working title or move a
 * row to another cash account, fill in a missing SEK rate, link a row to an
 * already-posted verifikat, allocate one payment across N invoices, and
 * book many rows as one samlingsverifikat.
 *
 * All v1 only. The last three already have hand-written staged MCP tools
 * (gnubok_link_transaction_to_journal_entry, gnubok_match_batch_allocate,
 * gnubok_bulk_book_transactions) with their own commit executors; a binding
 * here would duplicate them. The rules live in the services the dashboard
 * routes call: lib/transactions/manage.ts, lib/transactions/link-journal-
 * entry.ts, lib/transactions/match-batch.ts, lib/transactions/bulk-book.ts.
 */
import { z } from 'zod'
import {
  BulkBookSchema,
  LinkTransactionJournalEntrySchema,
  MatchBatchSchema,
  MoveTransactionCashAccountSchema,
  UpdateTransactionTitleSchema,
} from '@/lib/api/schemas'
import { deleteTransaction, refreshTransactionExchangeRate, updateTransaction } from '@/lib/transactions/manage'
import { linkTransactionToJournalEntry } from '@/lib/transactions/link-journal-entry'
import { matchTransactionBatch } from '@/lib/transactions/match-batch'
import { bulkBookTransactions } from '@/lib/transactions/bulk-book'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const TRANSACTION_ID = z
  .string()
  .uuid()
  .describe('The bank transaction id (transaction_id from GET /transactions).')

/**
 * `z.object({ transaction_id, ...schema.shape })` that still runs the
 * schema's cross-field refinements: Zod refuses .extend() on a refined
 * object, and the path id must be a named input field.
 */
function withTransactionId<S extends z.ZodObject<z.ZodRawShape>>(schema: S) {
  return z.object({ transaction_id: TRANSACTION_ID, ...schema.shape }).superRefine((value, ctx) => {
    const { transaction_id: _id, ...rest } = value as Record<string, unknown>
    const parsed = schema.safeParse(rest)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      if (issue.code === 'custom') ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
    }
  })
}

// ---------------------------------------------------------------------------
// transactions.delete
// ---------------------------------------------------------------------------

export const transactionsDelete = defineOperation({
  id: 'transactions.delete',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Delete an unbooked transaction that was added by hand (e.g. a duplicate you created).',
    description:
      'Hard-deletes one transaction the company created in Accounted (manual entry or POST /transactions/ingest). Bank-synced and bank-file rows are an external record of money that moved and are never deleted: ignore them (POST /transactions/{id}/ignore). A booked or matched row is räkenskapsinformation and is never deleted either: unlink it or reverse (storno) its verifikat. Idempotent. Dry-runnable.',
    useWhen: 'A manually added or API-ingested row is a mistake or a duplicate and has not been booked.',
    doNotUseFor:
      'Rows from the bank feed or a bank file (POST /transactions/{id}/ignore), booked rows (unlink, or reverse the verifikat), or undoing a whole bank file (POST /imports/bank/{id}/undo).',
    pitfalls: [
      'A booked or matched row returns 409 TRANSACTION_DELETE_BOOKED.',
      'A bank-synced or file-imported row returns 409 TRANSACTION_DELETE_IMPORTED: ignore it instead.',
      'A row with payment match history returns 409 TRANSACTION_DELETE_HAS_AUDIT_TRAIL at commit (the history is append-only); the dry run cannot see it.',
    ],
    example: {
      response: { data: { transaction_id: 'a8f1…', deleted: true }, meta: META },
    },
  },
  input: z.object({ transaction_id: TRANSACTION_ID }),
  output: z.object({ transaction_id: z.string().uuid(), deleted: z.literal(true) }),
  errorCodes: [
    'TX_CATEGORIZE_TX_NOT_FOUND',
    'TRANSACTION_DELETE_BOOKED',
    'TRANSACTION_DELETE_IMPORTED',
    'TRANSACTION_DELETE_HAS_AUDIT_TRAIL',
    'TRANSACTION_DELETE_FAILED',
  ],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/transactions/:id',
    pathParams: { id: 'transaction_id' },
  },
  run: (ctx, { transaction_id }, { dryRun }) => deleteTransaction(ctx, transaction_id, { dryRun }),
})

// ---------------------------------------------------------------------------
// transactions.update
// ---------------------------------------------------------------------------

export const transactionsUpdate = defineOperation({
  id: 'transactions.update',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Edit an unbooked transaction: its working title, or which bank account it belongs to.',
    description:
      'description replaces the working title (the bank\'s original stays in original_description; sending it back restores the "not edited" state). account_number (a BAS 19xx account of one of the company\'s cash accounts, as a string) moves the row to that account, for rows that landed on the wrong account or on none; a disabled, unconnected target is turned back on. Only rows that are neither booked nor matched. Idempotent. Dry-runnable.',
    useWhen:
      'A bank label is cryptic and the user wants a readable title before booking, or a row sits under the wrong bank account and can never be reconciled there.',
    doNotUseFor:
      'Booked rows (reverse the verifikat and rebook), changing the amount or date (bank data is never edited), or categorizing (POST /transactions/{id}/categorize).',
    pitfalls: [
      'Send at least one of description or account_number.',
      'A booked or matched row returns 409 TRANSACTION_TITLE_LOCKED (title) or TRANSACTION_MOVE_BOOKED (move); a row bulk-booked into a samlingsverifikat also returns TRANSACTION_MOVE_BOOKED for a move.',
      'account_number is a STRING like "1931", never a number; an account that is not one of the company\'s cash accounts returns 404 TRANSACTION_MOVE_UNKNOWN_ACCOUNT, one in another currency 400 TRANSACTION_MOVE_CURRENCY_MISMATCH.',
    ],
    example: {
      request: { description: 'Lunch med kund' },
      response: {
        data: { id: 'a8f1…', description: 'Lunch med kund', title_edited_at: '2026-06-01T10:00:00Z', cash_account_id: '7f3a…' },
        meta: META,
      },
    },
  },
  input: z
    .object({
      transaction_id: TRANSACTION_ID,
      description: UpdateTransactionTitleSchema.shape.description.optional().describe('New working title (1-500 characters).'),
      account_number: MoveTransactionCashAccountSchema.shape.account_number
        .optional()
        .describe('Target cash account by its BAS 19xx ledger account, e.g. "1931".'),
    })
    .refine((body) => body.description !== undefined || body.account_number !== undefined, {
      message: 'Send description, account_number, or both.',
    }),
  output: z.object({
    id: z.string().uuid(),
    description: z.string().nullable(),
    title_edited_at: z.string().nullable(),
    cash_account_id: z.string().uuid().nullable(),
  }),
  errorCodes: [
    'TX_CATEGORIZE_TX_NOT_FOUND',
    'TRANSACTION_TITLE_LOCKED',
    'TRANSACTION_MOVE_BOOKED',
    'TRANSACTION_MOVE_UNKNOWN_ACCOUNT',
    'TRANSACTION_MOVE_CURRENCY_MISMATCH',
  ],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/transactions/:id',
    pathParams: { id: 'transaction_id' },
  },
  run: (ctx, { transaction_id, description, account_number }, { dryRun }) =>
    updateTransaction(ctx, transaction_id, { description, account_number }, { dryRun }),
})

// ---------------------------------------------------------------------------
// transactions.refresh-exchange-rate
// ---------------------------------------------------------------------------

const RateOut = z.object({
  transaction_id: z.string().uuid(),
  currency: z.string(),
  amount: z.number(),
  amount_sek: z.number().nullable(),
  exchange_rate: z.number().nullable(),
  exchange_rate_date: z.string().nullable(),
  refreshed: z.boolean().describe('False when nothing was needed (SEK, or the rate was already there).'),
})

export const transactionsRefreshExchangeRate = defineOperation({
  id: 'transactions.refresh-exchange-rate',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Fill in the Riksbanken rate and SEK amount of an unbooked foreign-currency transaction.',
    description:
      'For an unbooked non-SEK row with no amount_sek/exchange_rate, fetches the Riksbanken rate for the transaction date and stores amount_sek, exchange_rate and exchange_rate_date. A SEK row, or one that already has both, is answered unchanged with refreshed=false. Idempotent. Dry-runnable (the dry run does not call Riksbanken).',
    useWhen: 'A foreign-currency row shows no SEK amount (the rate lookup failed at ingest) and it is about to be booked.',
    doNotUseFor: 'Booked rows (the verifikat carries the rate; correct it with storno) or overriding a rate that is already set.',
    pitfalls: [
      'A booked row returns 409 TX_EXCHANGE_RATE_BOOKED.',
      'Riksbanken unavailable returns 502 TX_EXCHANGE_RATE_UNAVAILABLE (retryable).',
    ],
    example: {
      response: {
        data: {
          transaction_id: 'a8f1…',
          currency: 'EUR',
          amount: -100,
          amount_sek: -1150.4,
          exchange_rate: 11.504,
          exchange_rate_date: '2026-05-12',
          refreshed: true,
        },
        meta: META,
      },
    },
  },
  input: z.object({ transaction_id: TRANSACTION_ID }),
  output: RateOut,
  errorCodes: ['TX_CATEGORIZE_TX_NOT_FOUND', 'TX_EXCHANGE_RATE_BOOKED', 'TX_EXCHANGE_RATE_UNAVAILABLE'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/transactions/:id/refresh-exchange-rate',
    pathParams: { id: 'transaction_id' },
  },
  run: async (ctx, { transaction_id }, { dryRun }) => {
    const outcome = await refreshTransactionExchangeRate(ctx, transaction_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const tx = outcome.data.transaction as {
      id: string
      currency: string
      amount: number
      amount_sek: number | null
      exchange_rate: number | null
      exchange_rate_date?: string | null
    }
    return {
      ok: true,
      data: {
        transaction_id: tx.id,
        currency: tx.currency,
        amount: tx.amount,
        amount_sek: tx.amount_sek ?? null,
        exchange_rate: tx.exchange_rate ?? null,
        exchange_rate_date: tx.exchange_rate_date ?? null,
        refreshed: outcome.data.refreshed,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// transactions.link-journal-entry
// ---------------------------------------------------------------------------

const LinkOut = z.object({
  transaction_id: z.string().uuid(),
  journal_entry_id: z.string().uuid(),
  voucher_label: z.string().describe('Verifikat label, e.g. "A-12".'),
  invoice_id: z.string().uuid().nullable(),
  invoice_status: z.enum(['paid', 'partially_paid']).nullable(),
  paid_amount: z.number().nullable(),
  remaining_amount: z.number().nullable(),
})

export const transactionsLinkJournalEntry = defineOperation({
  id: 'transactions.link-journal-entry',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Link a bank transaction to a verifikat that already books it (no new bookkeeping).',
    description:
      'Anchors the row to an existing POSTED journal entry: the row counts as booked and leaves the to-book list, and nothing new is posted. With invoice_id the customer invoice is also settled against that same verifikat (an invoice_payments row, status paid or partially_paid), same currency only. A dry run answers the result the link would produce. Idempotent. Dry-runnable.',
    useWhen:
      'The affärshändelse was already booked by hand (a manual verifikat, a payment registered before the bank row arrived) and the bank row must point at it instead of being booked twice.',
    doNotUseFor:
      'Booking the row (POST /transactions/{id}/categorize), matching it to an invoice with a new payment verifikat (POST /transactions/{id}/match-invoice), or one row against several vouchers (reconciliation links).',
    pitfalls: [
      'A row already linked to a posted verifikat returns 409 LINK_TX_TX_ALREADY_LINKED; a pointer left by a storno does not count.',
      'The verifikat must be posted: LINK_TX_JE_NOT_POSTED otherwise.',
      'invoice_id: the invoice must be open (sent, overdue, partially_paid), not a credit note, and in the transaction currency (LINK_TX_INVOICE_CURRENCY_MISMATCH); cross-currency payments go through match-invoice.',
    ],
    example: {
      request: { journal_entry_id: '4d2a…' },
      response: {
        data: {
          transaction_id: 'a8f1…',
          journal_entry_id: '4d2a…',
          voucher_label: 'A-12',
          invoice_id: null,
          invoice_status: null,
          paid_amount: null,
          remaining_amount: null,
        },
        meta: META,
      },
    },
  },
  input: LinkTransactionJournalEntrySchema.extend({ transaction_id: TRANSACTION_ID }),
  output: LinkOut,
  errorCodes: [
    'TX_CATEGORIZE_TX_NOT_FOUND',
    'LINK_TX_TX_ALREADY_LINKED',
    'LINK_TX_JE_NOT_FOUND',
    'LINK_TX_JE_NOT_POSTED',
    'LINK_TX_INVOICE_NOT_FOUND',
    'LINK_TX_INVOICE_NOT_OPEN',
    'LINK_TX_INVOICE_CREDIT_NOTE',
    'LINK_TX_INVOICE_CURRENCY_MISMATCH',
    'LINK_TX_INVOICE_RACE',
    'MATCH_INVOICE_RECORD_PAYMENT_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/transactions/:id/link-journal-entry',
    pathParams: { id: 'transaction_id' },
  },
  run: async (ctx, { transaction_id, journal_entry_id, invoice_id }, { dryRun }) => {
    const outcome = await linkTransactionToJournalEntry(
      ctx.supabase,
      ctx.userId,
      ctx.companyId,
      { transactionId: transaction_id, journalEntryId: journal_entry_id, invoiceId: invoice_id },
      { dryRun },
    )
    if (!outcome.ok) {
      if (outcome.code === 'LINK_TX_DB_ERROR') {
        return { ok: false, code: 'UNKNOWN_ERROR', error: new Error(String(outcome.details?.reason ?? 'Database error')) }
      }
      return { ok: false, code: outcome.code, details: outcome.details }
    }
    const r = outcome.result
    const data = {
      transaction_id: r.transactionId,
      journal_entry_id: r.journalEntryId,
      voucher_label: r.voucherLabel,
      invoice_id: r.invoiceId,
      invoice_status: r.invoiceStatus,
      paid_amount: r.paidAmount,
      remaining_amount: r.remainingAmount,
    }
    if (outcome.dryRun) return { ok: true, dryRun: true, preview: data }
    return { ok: true, data }
  },
})

// ---------------------------------------------------------------------------
// transactions.match-batch
// ---------------------------------------------------------------------------

const BatchAllocationOut = z.object({
  kind: z.enum(['customer_invoice', 'supplier_invoice']),
  invoice_id: z.string().uuid().optional(),
  supplier_invoice_id: z.string().uuid().optional(),
  payment_id: z.string().uuid(),
  status: z.enum(['paid', 'partially_paid']),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  amount: z.number(),
})

export const transactionsMatchBatch = defineOperation({
  id: 'transactions.match-batch',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Book one bank payment against several customer invoices, or several supplier invoices, in one verifikat.',
    description:
      'Allocates the transaction across N invoices of one kind: one samlingsverifikation (bank against 1510 or 2440, kursdifferens on 3960/7960 for foreign invoices, öresavrundning on 3740) and one payment row per invoice, atomically. The allocations must sum to the transaction amount. The dry run answers the exact lines (expected_lines) the verifikat would carry. Idempotent. Dry-runnable.',
    useWhen: 'One incoming payment covers several customer invoices, or one outgoing transfer pays several supplier invoices.',
    doNotUseFor:
      'One invoice (POST /transactions/{id}/match-invoice or match-supplier-invoice), mixing customer and supplier invoices, or invoices never booked under kontantmetoden.',
    pitfalls: [
      'The allocation amounts must sum to |amount| of the transaction: BATCH_AMOUNT_EXCEEDS_TX / BATCH_AMOUNT_BELOW_TX otherwise.',
      'A row that posted vouchers already explain (each invoice marked paid by hand) returns 409 BATCH_TX_POSSIBLE_DUPLICATE with the vouchers: link the row to them instead. force=true needs expected_journal_entry_ids naming exactly that set.',
      'Under kontantmetoden an invoice with no booking yet returns 400 BATCH_CASH_METHOD_UNBOOKED_INVOICE.',
      'Proformas and quotes return 400 MATCH_INVOICE_NOT_INVOICE_TYPE.',
    ],
    example: {
      request: {
        allocations: [
          { kind: 'customer_invoice', invoice_id: '2b1c…', amount: 500 },
          { kind: 'customer_invoice', invoice_id: '3c2d…', amount: 750 },
        ],
      },
      response: {
        data: {
          journal_entry_id: '4d2a…',
          voucher_series: 'A',
          voucher_number: 12,
          allocations: [],
          total_allocated: 1250,
          leftover: 0,
        },
        meta: META,
      },
    },
  },
  input: withTransactionId(MatchBatchSchema),
  output: z.object({
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string(),
    voucher_number: z.number(),
    allocations: z.array(BatchAllocationOut),
    total_allocated: z.number(),
    leftover: z.number(),
  }),
  errorCodes: [
    'MATCH_INVOICE_NOT_INVOICE_TYPE',
    'BATCH_TX_POSSIBLE_DUPLICATE',
    'BATCH_TX_EXPLAINED_CHECK_FAILED',
    'BATCH_CASH_METHOD_UNBOOKED_INVOICE',
    'BATCH_TX_NOT_FOUND',
    'BATCH_TX_ALREADY_BOOKED',
    'BATCH_TX_ZERO_AMOUNT',
    'BATCH_DIRECTION_MISMATCH',
    'BATCH_INVOICE_NOT_FOUND',
    'BATCH_SUPPLIER_INVOICE_NOT_FOUND',
    'BATCH_INVOICE_NOT_OPEN',
    'BATCH_SUPPLIER_INVOICE_NOT_OPEN',
    'BATCH_AMOUNT_EXCEEDS_TX',
    'BATCH_AMOUNT_BELOW_TX',
    'BATCH_PERIOD_LOCKED',
    'BATCH_RPC_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/transactions/:id/match-batch',
    pathParams: { id: 'transaction_id' },
  },
  run: (ctx, { transaction_id, ...body }, { dryRun }) =>
    matchTransactionBatch(ctx, transaction_id, body as Parameters<typeof matchTransactionBatch>[2], {
      dryRun,
      via: 'api_force',
    }),
})

// ---------------------------------------------------------------------------
// transactions.bulk-book
// ---------------------------------------------------------------------------

export const transactionsBulkBook = defineOperation({
  id: 'transactions.bulk-book',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book several same-day SEK bank transactions as one samlingsverifikat.',
    description:
      'Books up to 200 transactions of the same date into ONE verifikat (samlingsverifikation, BFL 5 kap 6 §), in exactly one of three ways: existing_journal_entry_id links them to an already-posted voucher whose bank net equals their sum (nothing new is posted); template_id + mode + entry_description expands a booking template per row (one_line_per_tx) or on the sum (sum_per_account); manual_lines + entry_description posts caller-built balanced lines. SEK only. The dry run answers the lines and the signed sum (tx_sum). Idempotent. Dry-runnable.',
    useWhen: 'Many small same-day rows of one kind (Swish sales, card fees, a daily settlement) should be one verifikat.',
    doNotUseFor:
      'Rows on different dates, foreign-currency rows (book them one by one), or one row against invoices (POST /transactions/{id}/match-batch).',
    pitfalls: [
      'All rows must share one date and direction, and currency SEK: BULK_BOOK_MIXED_CURRENCY / BULK_BOOK_FOREIGN_CURRENCY otherwise.',
      'A row that looks already booked returns 409 TRANSACTION_BOOK_POSSIBLE_DUPLICATE naming it; resend with force=true only after reviewing the candidate (each dismissal is logged in behandlingshistorik).',
      'manual_lines accounts must be active in the company\'s chart (BULK_BOOK_INVALID_ACCOUNT) and balance; amounts are kronor, account numbers strings.',
      'A posted samlingsverifikat is permanent: undo with storno (POST /journal-entries/{id}/reverse).',
    ],
    example: {
      request: {
        tx_ids: ['a8f1…', 'b9e2…'],
        template_id: '5e4f…',
        mode: 'sum_per_account',
        entry_description: 'Swish-försäljning 2026-05-12',
      },
      response: {
        data: {
          mode: 'create_new',
          journal_entry_id: '4d2a…',
          voucher_series: 'A',
          voucher_number: 57,
          linked_tx_count: 2,
          tx_sum: 1250,
          docs_linked: 0,
        },
        meta: META,
      },
    },
  },
  input: BulkBookSchema,
  output: z.object({
    mode: z.enum(['link_existing', 'create_new']),
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    linked_tx_count: z.number(),
    tx_sum: z.number().describe('Signed SEK sum of the booked rows.'),
    docs_linked: z.number(),
  }),
  errorCodes: [
    'BULK_BOOK_TXS_NOT_FOUND',
    'BULK_BOOK_MIXED_CURRENCY',
    'BULK_BOOK_FOREIGN_CURRENCY',
    'TRANSACTION_BOOK_POSSIBLE_DUPLICATE',
    'BULK_BOOK_INVALID_ACCOUNT',
    'BULK_BOOK_TEMPLATE_NOT_FOUND',
    'BULK_BOOK_TX_ALREADY_BOOKED',
    'BULK_BOOK_DATE_MISMATCH',
    'BULK_BOOK_DIRECTION_MISMATCH',
    'BULK_BOOK_VOUCHER_NOT_FOUND',
    'BULK_BOOK_VOUCHER_NOT_POSTED',
    'BULK_BOOK_AMOUNT_MISMATCH',
    'BULK_BOOK_UNBALANCED',
    'BULK_BOOK_PERIOD_LOCKED',
    'BULK_BOOK_RPC_FAILED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/transactions/bulk-book' },
  run: (ctx, input, { dryRun }) =>
    bulkBookTransactions(ctx, input as Parameters<typeof bulkBookTransactions>[1], { dryRun, via: 'api_force' }),
})
