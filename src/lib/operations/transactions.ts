/**
 * Bank transaction actions served through the machine doors (see ./types.ts):
 * delete an unbooked row typed in by hand, edit the working title or move a
 * row to another cash account, fill in a missing SEK rate, link a row to an
 * already-posted verifikat, allocate one payment across N invoices, and
 * book many rows as one samlingsverifikat.
 *
 * The link, the allocation and the bulk booking are also the MCP tools
 * gnubok_link_transaction_to_journal_entry, gnubok_match_batch_allocate and
 * gnubok_bulk_book_transactions, which stage the same input and whose
 * approval runs the same run(). The rules live in the services the
 * dashboard routes call:
 * lib/transactions/manage.ts, lib/transactions/link-journal-entry.ts,
 * lib/transactions/match-batch.ts, lib/transactions/bulk-book.ts.
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
import { matchTransactionBatch, type MatchBatchInput } from '@/lib/transactions/match-batch'
import { bulkBookTransactions } from '@/lib/transactions/bulk-book'
import { hasScope, type ApiKeyScope } from '@/lib/auth/api-keys'
import { codedRefusal } from '@/lib/errors/refusal'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import {
  describeExplainingSet,
  DUPLICATE_CHECK_FAILED_NOTE,
  type AlreadyExplainedDetails,
} from '@/lib/invoices/already-explained-guard'
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
    'BANK_BOOKING_CURRENCY_MISMATCH',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/transactions/:id/link-journal-entry',
    pathParams: { id: 'transaction_id' },
  },
  mcp: {
    name: 'gnubok_link_transaction_to_journal_entry',
    title: 'Link Transaction to Verifikat',
    // Search-only: the account-keyed gnubok_reconcile_match covers the same
    // link (one pair) for bank AND skattekonto and is the listed tool.
    visibility: 'search',
    keywords: ['koppla transaktion', 'verifikat'],
    description:
      'Stage linking 1 bank tx to an already-posted verifikat (no new bokföring), for an affärshändelse the user booked by hand. Pass invoice_id to also settle a kundfaktura in the same currency.',
    stage: {
      pendingType: 'link_transaction_journal_entry',
      title: (input, preview) => {
        const tx = (preview?.transaction_description as string | null) || String(input.transaction_id).slice(0, 8)
        const link = `Länka ${tx} → verifikat ${String(preview?.voucher_label ?? '')}`
        if (!input.invoice_id) return link
        return `${link} + faktura ${(preview?.invoice_number as string | null) ?? String(input.invoice_id).slice(0, 8)}`
      },
      // Staged before the operation existed with invoice_id: null when none.
      upgradeParams: (params) => {
        if (params.invoice_id !== null) return params
        const { invoice_id: _none, ...rest } = params
        return rest
      },
      // The approval card's rows; the verifikat's own text stays out (it can
      // carry counterparty free text, and the label identifies it).
      preview: (_input, p) => ({
        transaction_description: p.transaction_description,
        transaction_amount: p.transaction_amount,
        transaction_currency: p.transaction_currency,
        transaction_date: p.transaction_date,
        voucher_label: p.voucher_label,
        voucher_date: p.voucher_date,
        invoice_id: p.invoice_id,
        invoice_number: p.invoice_number,
        invoice_remaining_after: p.remaining_amount,
        will_be_fully_paid: p.invoice_status == null ? null : p.invoice_status === 'paid',
      }),
      extras: (input, p) => {
        const txDate = String(p.transaction_date ?? '')
        const jeDate = String(p.voucher_date ?? '')
        return {
          next: input.invoice_id
            ? {
                description:
                  'After approval the tx attaches to the existing verifikat and the invoice flips to paid/partially_paid. No new bokföring. Verify with gnubok_get_ar_ledger.',
                tool: 'gnubok_get_ar_ledger',
              }
            : {
                description: 'After approval the tx attaches to the existing verifikat. No new bokföring. Verify with gnubok_query_journal.',
                tool: 'gnubok_query_journal',
              },
          // The later of the two dates: a row in an open period linked to a
          // verifikat in a locked one must report the locked one.
          periodDate: jeDate > txDate ? jeDate : txDate,
        }
      },
    },
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
    if (outcome.dryRun) {
      const subject = outcome.subject
      return {
        ok: true,
        dryRun: true,
        preview: {
          ...data,
          transaction_description: subject.transactionDescription,
          transaction_amount: subject.transactionAmount,
          transaction_currency: subject.transactionCurrency,
          transaction_date: subject.transactionDate,
          voucher_date: subject.voucherDate,
          invoice_number: subject.invoiceNumber,
        },
      }
    }
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
  risk: 'high',
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
  mcp: {
    name: 'gnubok_match_batch_allocate',
    title: 'Batch-Allocate Payment',
    visibility: 'default',
    keywords: ['klumpbetalning', 'fördela betalning', 'matcha betalningar'],
    description:
      'Stage booking 1 bank tx against N customer OR N supplier invoices in one verifikat (samlingsbetalning, BFL 5 kap 6§). Amounts in the tx currency (cross-currency: the SEK the bank credited). preview.expected_lines = the rows approval posts.',
    stage: {
      pendingType: 'match_batch_allocate',
      title: (input, preview) => {
        const allocations = (input.allocations as unknown[]) ?? []
        // Swedish plurals: kundfaktura → kundfakturor, leverantörsfaktura → leverantörsfakturor.
        const noun = preview?.allocations_kind === 'supplier_invoice' ? 'leverantörsfaktura' : 'kundfaktura'
        const summary = `${allocations.length} ${allocations.length === 1 ? noun : `${noun.slice(0, -1)}or`}`
        return `Fördela: ${(preview?.transaction_description as string | null) || String(input.transaction_id)} → ${summary}`
      },
      // GDPR Art.25: the row's text identifies it for the approver; the
      // invoice ids stay in params (the audit trail), and the lines carry
      // neutral descriptions ("Kundfaktura 1 av 3").
      preview: (input, p) => ({
        transaction_description: p.transaction_description || input.transaction_id,
        transaction_amount: p.transaction_amount,
        transaction_currency: p.transaction_currency,
        transaction_date: p.transaction_date,
        allocations_count: p.allocations_count,
        allocations_kind: p.allocations_kind,
        total_allocated: p.total_allocated,
        expected_entry_date: p.expected_entry_date,
        expected_description: p.expected_description,
        expected_lines: p.expected_lines,
        expected_lines_balanced: p.expected_lines_balanced,
        expected_fx: p.expected_fx,
      }),
      extras: (_input, p) => ({
        next: {
          description:
            'After approval the combined verifikat is created exactly as preview.expected_lines and each invoice is advanced. Verify with gnubok_get_ar_ledger (customer) or gnubok_get_supplier_ledger.',
          tool: p.allocations_kind === 'supplier_invoice' ? 'gnubok_get_supplier_ledger' : 'gnubok_get_ar_ledger',
        },
        periodDate: p.transaction_date as string | undefined,
        // Never silent: an honoured override names the vouchers it books
        // over, and a check that could not run says so.
        ...(p.already_explained_by
          ? { complianceNote: `Bokförs trots att ${String(p.already_explained_by)} redan förklarar raden (force=true).` }
          : p.duplicate_check_failed
            ? { complianceNote: DUPLICATE_CHECK_FAILED_NOTE }
            : {}),
      }),
      refusal: (failure, _input, keyScopes) => {
        if (failure.code === 'BATCH_TX_POSSIBLE_DUPLICATE' && failure.details) {
          return alreadyExplainedRefusal(failure.details as unknown as AlreadyExplainedRefusalDetails, keyScopes)
        }
        if (failure.code === 'BATCH_CASH_METHOD_UNBOOKED_INVOICE') {
          const unbooked = (failure.details?.invoices as Array<{ id: string; invoice_number?: string | null }> | undefined) ?? []
          const numbers = unbooked.map((u) => u.invoice_number ?? u.id).join(', ')
          return codedRefusal(
            failure.code,
            `${getErrorEntry(failure.code)?.message_sv ?? failure.code}` +
              ` Obokförda fakturor: ${numbers}. En faktura som ensam motsvarar beloppet: gnubok_match_transaction_to_invoice.` +
              ' Flera fakturor: markera varje faktura som betald (kundfakturor: gnubok_mark_invoice_as_paid), sedan gnubok_reconcile_match för att koppla transaktionen till verifikaten.',
          )
        }
        return undefined
      },
    },
  },
  run: (ctx, { transaction_id, ...body }, { dryRun }) =>
    matchTransactionBatch(ctx, transaction_id, body as MatchBatchInput, {
      dryRun,
      via: 'api_force',
    }),
})

type AlreadyExplainedRefusalDetails = AlreadyExplainedDetails & {
  transaction_id: string
  cash_account_id: string | null
}

/**
 * The already-explained refusal for gnubok_match_batch_allocate, coded
 * BATCH_TX_POSSIBLE_DUPLICATE (the code every door answers). The MCP error
 * envelope carries no `details`, so the vouchers, the link call that
 * resolves the row and the exact force binding are all in the message: that
 * is what the agent reads. One voucher is also linkable through
 * gnubok_link_transaction_to_journal_entry (which can settle a kundfaktura
 * at the same time); several need the bank 1:N pair on gnubok_reconcile_match.
 *
 * `keyScopes` is the calling key's grant (undefined outside the dispatcher).
 * Without reconciliation:write, gnubok_reconcile_match is not callable, so
 * the refusal says so and points where the key can go: one voucher through
 * gnubok_link_transaction_to_journal_entry (transactions:write, which this
 * tool already needs), several through a person on the Avstämning page or a
 * reconnected connector. Keys minted before the reconciliation scopes existed
 * (#1833) never gain them (feedback seqs 817176, 817189).
 */
function alreadyExplainedRefusal(details: AlreadyExplainedRefusalDetails, keyScopes?: readonly ApiKeyScope[]): Error {
  const set = details
  const transactionId = details.transaction_id
  const ids = set.vouchers.map((v) => v.journal_entry_id)
  const accountKey = `bank:${details.cash_account_id ?? '<cash_account_id>'}`
  const canReconcile = !keyScopes || hasScope([...keyScopes], 'reconciliation:write')
  const linkOne = `gnubok_link_transaction_to_journal_entry (transaction_id="${transactionId}", journal_entry_id="${ids[0]}", invoice_id om en kundfaktura ska markeras betald samtidigt)`
  const missingScope =
    'den här API-nyckeln saknar behörigheten reconciliation:write, så gnubok_reconcile_match går inte att anropa med den'
  const link = !canReconcile
    ? ids.length === 1
      ? `${linkOne}. Obs: ${missingScope}; användaren kan också koppla raden på sidan Avstämning i Accounted, eller koppla om connectorn så att den nya nyckeln får behörigheten`
      : `användaren kopplar den på sidan Avstämning i Accounted, eller kopplar om connectorn så att den nya nyckeln får behörigheten (${missingScope})`
    : ids.length === 1
      ? `${linkOne} eller gnubok_reconcile_match (account_key "${accountKey}", pairs [{ external_ids: ["${transactionId}"], journal_entry_ids: ["${ids[0]}"] }])`
      : `gnubok_reconcile_match (account_key "${accountKey}", pairs [{ external_ids: ["${transactionId}"], journal_entry_ids: ${JSON.stringify(ids)}, allocations: [{ journal_entry_id, amount }] per verifikat, summan = radens belopp })`
  const message = details.force_rejected
    ? `force=true avvisad: expected_journal_entry_ids är inte exakt de verifikat som förklarar raden just nu (${describeExplainingSet(set)}). ` +
      `Koppla raden till dem i stället: ${link}. Om raden verkligen är en separat affärshändelse: anropa igen med force=true och expected_journal_entry_ids=${JSON.stringify(ids)}.`
    : `Transaktionen ser redan ut att vara bokförd som ${describeExplainingSet(set)}: bokförda verifikat utan bankkoppling på kontot summerar exakt till beloppet. ` +
      `Bokför inte igen; koppla raden till dem: ${link}. Endast om raden verkligen är en separat affärshändelse: anropa igen med force=true och expected_journal_entry_ids=${JSON.stringify(ids)}.`
  // The registry hint names gnubok_reconcile_match; a key that cannot call it
  // gets one it can act on.
  const remediation = canReconcile
    ? undefined
    : ids.length === 1
      ? {
          description:
            'This key lacks the reconciliation:write scope, so gnubok_reconcile_match is not callable. Link the row to the one voucher with gnubok_link_transaction_to_journal_entry (reach it through gnubok_stage_tool when it is not in tools/list). Do not book the row again.',
          tool: 'gnubok_link_transaction_to_journal_entry',
          args: { transaction_id: transactionId, journal_entry_id: ids[0] },
        }
      : {
          description:
            'This key lacks the reconciliation:write scope, and one bank row against several vouchers links only through gnubok_reconcile_match. Ask the user to link the row to the listed vouchers on the Avstämning page in Accounted, or to reconnect the connector so its new key carries reconciliation:write. Do not book the row again.',
        }
  return codedRefusal('BATCH_TX_POSSIBLE_DUPLICATE', message, remediation)
}

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
    'BULK_BOOK_TX_ZERO_AMOUNT',
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
  mcp: {
    name: 'gnubok_bulk_book_transactions',
    title: 'Bulk-Book Transactions',
    visibility: 'default',
    keywords: ['bokför', 'kontera', 'massbokföring', 'banktransaktioner'],
    description:
      'Stage booking N SEK bank txs of one date and direction as 1 samlingsverifikat (BFL 5 kap 6§): link to a posted verifikat, expand a template, or post manual_lines. Dimensions: code or name.',
    stage: {
      pendingType: 'bulk_book_transactions',
      // The queue title is what a reviewer approves from (often on a phone):
      // amount, direction, date and the first row's counterparty
      // (feedback seq 261545); preview_data stays aggregate-only.
      title: (input, p) => {
        const count = (input.tx_ids as unknown[]).length
        const sum = Number(p?.tx_sum ?? 0)
        const amount =
          `${p?.direction === 'income' ? '+' : '-'}` +
          `${Math.abs(sum).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ` +
          `${String(p?.currency ?? 'SEK')}`
        const lead = String(p?.lead_description ?? '')
        const rest = count > 1 ? ` (+${count - 1} till)` : ''
        return input.existing_journal_entry_id
          ? `Länka ${count} transaktioner ${amount} ${String(p?.tx_date ?? '')} till verifikat: ${lead}${rest}`
          : `Samlingsverifikation ${amount} ${String(p?.tx_date ?? '')}: ${lead}${rest}`
      },
      // Staged before the operation existed: new_entry {description, lines}
      // for a new verifikat and allow_duplicate for the reviewed override.
      upgradeParams: (params) => {
        if (!('new_entry' in params) && !('allow_duplicate' in params)) return params
        const { new_entry, allow_duplicate, existing_journal_entry_id, ...rest } = params as {
          new_entry?: { description?: string; lines?: unknown[] } | null
          allow_duplicate?: boolean
          existing_journal_entry_id?: string | null
        } & Record<string, unknown>
        return {
          ...rest,
          ...(existing_journal_entry_id ? { existing_journal_entry_id } : {}),
          ...(new_entry ? { entry_description: new_entry.description, manual_lines: new_entry.lines } : {}),
          ...(allow_duplicate === true ? { force: true } : {}),
        }
      },
      // What the approver saw is what posts: manual lines staged with the
      // dimension codes the names resolved to and the account rules applied,
      // a template's default bag with the resolved codes.
      pinParams: (input, p) => {
        const lines = p.lines as Array<Record<string, unknown>> | undefined
        if (input.manual_lines && lines) {
          const { default_dimensions: _merged, ...rest } = input
          return {
            ...rest,
            manual_lines: lines.map((l) => ({
              account_number: l.account_number,
              debit_amount: l.debit_amount,
              credit_amount: l.credit_amount,
              currency: l.currency,
              ...(l.line_description ? { line_description: l.line_description } : {}),
              ...(l.dimensions && Object.keys(l.dimensions as object).length > 0 ? { dimensions: l.dimensions } : {}),
            })),
          }
        }
        const defaults = input.default_dimensions as Record<string, string> | undefined
        const firstBag = lines?.[0]?.dimensions as Record<string, string> | undefined
        if (defaults && firstBag) {
          const pinned = Object.fromEntries(Object.keys(defaults).map((k) => [k, firstBag[k] ?? defaults[k]!]))
          return { ...input, default_dimensions: pinned }
        }
        return input
      },
      // The approval card's rows (BulkBookPreview): aggregates and the
      // kontering, named; no per-row texts or counterparty ids.
      preview: (_input, p) => ({
        tx_count: p.tx_count,
        tx_date: p.tx_date,
        tx_sum: p.tx_sum,
        currency: p.currency,
        direction: p.direction,
        mode: p.mode,
        ...(Array.isArray(p.lines)
          ? {
              entry_description: p.entry_description ?? null,
              lines: (p.lines as Array<Record<string, unknown>>).map((l) => ({
                account_number: l.account_number,
                account_name: l.account_name ?? null,
                debit_amount: l.debit_amount,
                credit_amount: l.credit_amount,
                line_description: l.line_description ?? null,
              })),
            }
          : {}),
        ...(p.dimension_resolutions ? { dimension_resolutions: p.dimension_resolutions } : {}),
      }),
      extras: (_input, p) => {
        const txDate = String(p.tx_date ?? '')
        const jeDate = String(p.existing_entry_date ?? '')
        return {
          next: {
            description:
              'After approval the verifikat carries the combined business event. Verify with gnubok_query_journal or gnubok_get_reconciliation_status.',
            tool: 'gnubok_query_journal',
          },
          // The later of the two dates: rows in an open period linked to a
          // verifikat in a locked one must report the locked one.
          periodDate: jeDate > txDate ? jeDate : txDate,
        }
      },
      // The legal limits read as legal limits, with the split that works: a
      // reader who takes them for technical ones proposes a monthly
      // samlingsverifikat next (feedback seq 378710 / 382660).
      refusal: (failure) => {
        switch (failure.code) {
          case 'BULK_BOOK_DATE_MISMATCH':
            return codedRefusal(
              failure.code,
              'All transactions must share the same date: BFL 5 kap 6 § tredje stycket allows a gemensam verifikation only for likartade affärshändelser on the same day, ' +
                'so a monthly samlingsverifikat is not a legal option. Group the tx_ids by date and call gnubok_bulk_book_transactions once per date.',
            )
          case 'BULK_BOOK_DIRECTION_MISMATCH':
            return codedRefusal(
              failure.code,
              'All transactions must share the same direction (all income or all expense): BFL 5 kap 6 § tredje stycket allows a gemensam verifikation only for likartade affärshändelser, ' +
                'and an inflow and an outflow are not alike. Call gnubok_bulk_book_transactions once for the income rows and once for the expense rows.',
            )
          case 'BULK_BOOK_MIXED_CURRENCY':
            return codedRefusal(
              failure.code,
              'All transactions must share the same currency. For cross-currency allocations, use gnubok_match_batch_allocate (which handles the FX diff on 7960/3960).',
            )
          case 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE': {
            const details = failure.details as
              | { transaction_id?: string; candidate?: { voucher_label?: string; entry_date?: string; amount_verified?: boolean } }
              | undefined
            const dup = details?.candidate
            if (!dup) return undefined
            return codedRefusal(
              failure.code,
              `Possible double booking: transaction ${details?.transaction_id} looks already booked by verifikat ${dup.voucher_label} (${dup.entry_date})` +
                `${dup.amount_verified ? '' : ', though the amounts could not be compared in SEK'}. ` +
                'Link the transaction to that verifikat instead. Call again with force=true only after the user confirms it is a genuinely separate business event.',
            )
          }
          default:
            return undefined
        }
      },
    },
  },
  run: (ctx, input, { dryRun }) =>
    bulkBookTransactions(ctx, input, { dryRun, via: 'api_force' }),
})
