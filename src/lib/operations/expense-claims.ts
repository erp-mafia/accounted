/**
 * Expense claim (utlägg) operations: an owner or employee paid a business
 * cost privately and the company owes them. List and read the register,
 * register a claim (which posts its verifikat), delete one (storno, never a
 * deleted verifikat), pay a person back, and book a bank outflow as that
 * repayment. Rules live in lib/expenses/expense-claim-actions.ts and
 * lib/expenses/expense-claims-service.ts.
 */
import { z } from 'zod'
import { CreateExpenseClaimSchema, CreateExpensePayoutSchema, MatchExpensePayoutSchema } from '@/lib/api/schemas'
import {
  createExpenseClaim,
  getExpenseClaim,
  listExpenseClaimsPage,
  matchExpensePayout,
  recordExpensePayout,
  removeExpenseClaim,
  toPublicClaim,
} from '@/lib/expenses/expense-claim-actions'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const ExpenseClaimOut = z.object({
  expense_claim_id: z.string().uuid(),
  employee_id: z.string().uuid().nullable().describe('The employee owed, or null for the owner (or a förening member).'),
  claimant_name: z.string(),
  description: z.string(),
  expense_date: z.string(),
  amount_sek: z.number().describe('Gross amount incl. VAT in SEK: what the company owes the person.'),
  vat_sek: z.number().describe('Deductible ingående moms booked on 2641, in SEK.'),
  currency: z.string().describe('The receipt currency; amounts are booked in SEK.'),
  amount_in_currency: z.number().nullable(),
  exchange_rate: z.number().nullable(),
  expense_account: z.string().describe('BAS cost account (class 4-8), as a string.'),
  liability_account: z
    .string()
    .describe('Who is owed: 2893 AB owner, 2018 EF owner (egen insättning), 2890 förening member, 2820 employee.'),
  document_id: z.string().uuid().nullable(),
  status: z.enum(['registered', 'paid']),
  journal_entry_id: z.string().uuid().nullable().describe('The verifikat that booked the claim.'),
  payout_batch_id: z.string().uuid().nullable().describe('The payout that repaid it, once paid.'),
  created_at: z.string(),
})

const EXPENSE_CLAIM_ID = z.string().uuid().describe('The expense claim id (expense_claim_id from the list).')

const EXAMPLE_CLAIM = {
  expense_claim_id: '5a0a…',
  employee_id: null,
  claimant_name: 'Anna Svensson',
  description: 'USB-hubb',
  expense_date: '2026-09-01',
  amount_sek: 500,
  vat_sek: 100,
  currency: 'SEK',
  amount_in_currency: null,
  exchange_rate: null,
  expense_account: '5410',
  liability_account: '2893',
  document_id: null,
  status: 'registered',
  journal_entry_id: '9c1e…',
  payout_batch_id: null,
  created_at: '2026-09-01T09:12:00Z',
}

export const expenseClaimsList = defineOperation({
  id: 'expense-claims.list',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List expense claims (utlägg): what the company owes owners and employees for private purchases.',
    description:
      'Returns the utlägg register newest first: each claim\'s claimant, SEK amount, VAT, cost and liability account, status (registered = still owed, paid = repaid) and the verifikat that booked it. Filter by status or employee_id. Cursor pagination: pass next_cursor back as cursor; next_cursor is null on the last page.',
    useWhen:
      'You need the open claims before paying someone back or matching a bank transfer, or you are reconciling 2893/2820/2890 against who is owed what.',
    doNotUseFor:
      'Supplier invoices (GET /supplier-invoices) or salary (the payroll endpoints); an utlägg put on a payslip is still listed here as registered until the salary run is booked.',
    pitfalls: [
      'amount_sek is gross incl. VAT: the amount owed, not the cost.',
      'A claim on 2018 (enskild firma owner) is an egen insättning, not a debt; it is listed but is not normally paid back.',
      'The page is in data.expense_claims with data.next_cursor; a cursor that no longer decodes starts from the first page.',
    ],
    example: {
      response: { data: { expense_claims: [EXAMPLE_CLAIM], next_cursor: null }, meta: META },
    },
  },
  input: z.object({
    status: z.enum(['registered', 'paid']).optional().describe('registered = still owed, paid = repaid.'),
    employee_id: z.string().uuid().optional().describe('Only this employee\'s claims.'),
    cursor: z.string().optional().describe('next_cursor from the previous page. Omit for the first page.'),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('Page size, 1-100 (default 50).'),
  }),
  output: z.object({
    expense_claims: z.array(ExpenseClaimOut),
    next_cursor: z.string().nullable(),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/expense-claims' },
  mcp: {
    name: 'gnubok_list_expense_claims',
    title: 'List Expense Claims',
    description:
      'List utlägg (private purchases the company owes an owner or employee for), newest first, with status registered (owed) or paid, amounts in SEK and the liability account. Filter by status or employee_id; paginate with cursor.',
    keywords: ['utlägg', 'utläggsregister', 'privat betalt', 'skuld till ägare', 'skuld till anställd', 'kvitto privat kort'],
  },
  run: (ctx, input) => listExpenseClaimsPage(ctx, input),
})

export const expenseClaimsGet = defineOperation({
  id: 'expense-claims.get',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one expense claim (utlägg).',
    description:
      'Returns one claim: who is owed, the SEK amount and VAT, the cost and liability accounts, its status and the verifikat that booked it (journal_entry_id) and, once paid, the payout batch.',
    useWhen: 'You hold an expense_claim_id (from the list or a create) and need its current status.',
    doNotUseFor: 'Finding claims: list them with GET /expense-claims?status=registered.',
    pitfalls: ['An id from another company answers 404 EXPENSE_CLAIM_NOT_FOUND.'],
    example: { response: { data: EXAMPLE_CLAIM, meta: META } },
  },
  input: z.object({ expense_claim_id: EXPENSE_CLAIM_ID }),
  output: ExpenseClaimOut,
  errorCodes: ['EXPENSE_CLAIM_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/expense-claims/:id',
    pathParams: { id: 'expense_claim_id' },
  },
  run: (ctx, { expense_claim_id }) => getExpenseClaim(ctx, expense_claim_id),
})

export const expenseClaimsCreate = defineOperation({
  id: 'expense-claims.create',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Register an expense claim (utlägg) and post its verifikat.',
    description:
      'Books a business cost someone paid privately: Debit the cost account (net), Debit 2641 (vat_amount), Credit the person\'s liability account (gross), in one verifikat posted immediately. The liability account follows the claimant: employee_id books 2820; otherwise the owner\'s account for the legal form (2893 aktiebolag, 2018 enskild firma as egen insättning, 2890 förening member) with claimant_name. Foreign currency converts at exchange_rate or Riksbanken\'s rate for expense_date. lines replaces the generated rows (reverse charge, templates) and must credit the liability account with exactly amount. document_id attaches the receipt to the verifikat; inbox_item_id marks the inbox item booked. Idempotent. Dry-runnable.',
    useWhen:
      'A receipt was paid with a private card or cash: the answer to "Vem betalade?" is the owner or an employee, not the company account.',
    doNotUseFor:
      'A purchase the company paid itself (categorize the bank transaction or register a supplier invoice), an unpaid supplier invoice (POST /supplier-invoices) or mileage (körjournal).',
    pitfalls: [
      'amount is gross incl. VAT and vat_amount must be below it; foreign VAT is not deductible on 2641, so send vat_amount 0 for a foreign receipt.',
      'The verifikat is posted at once and is immutable: undo it with DELETE /expense-claims/{id}, which posts a storno.',
      'employee_id wins over claimant_name: the employee\'s own name is stored.',
      'A date in a locked period or behind the company lock date returns 400 PERIOD_LOCKED; no open fiscal year returns EXPENSE_CLAIM_NO_FISCAL_PERIOD.',
      'expense_account is a STRING in class 4-8 ("5410"), never a number.',
    ],
    example: {
      request: {
        description: 'USB-hubb',
        expense_date: '2026-09-01',
        amount: 500,
        vat_amount: 100,
        expense_account: '5410',
        claimant_name: 'Anna Svensson',
      },
      response: { data: EXAMPLE_CLAIM, meta: META },
    },
  },
  input: CreateExpenseClaimSchema,
  output: ExpenseClaimOut,
  errorCodes: [
    'PERIOD_LOCKED',
    'EMPLOYEE_NOT_FOUND',
    'EXPENSE_CLAIM_CLAIMANT_REQUIRED',
    'EXPENSE_CLAIM_VAT_EXCEEDS_AMOUNT',
    'EXPENSE_CLAIM_INVALID_LINES',
    'EXPENSE_CLAIM_RATE_UNAVAILABLE',
    'EXPENSE_CLAIM_NO_FISCAL_PERIOD',
    'EXPENSE_CLAIM_DOCUMENT_NOT_FOUND',
    'EXPENSE_CLAIM_INBOX_ITEM_NOT_FOUND',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/expense-claims' },
  mcp: {
    name: 'gnubok_create_expense_claim',
    title: 'Create Expense Claim',
    description:
      'Stage an utlägg: a cost the owner or an employee paid privately. Approval posts the verifikat (cost + 2641 against 2893/2018/2890 owner or 2820 employee) and opens the claim. Pass document_id to attach the receipt.',
    keywords: ['utlägg', 'registrera utlägg', 'privat betalt', 'betalade privat', 'eget kort', 'kvitto privat', 'vem betalade'],
    stage: {
      pendingType: 'create_expense_claim',
      title: (input) => `Utlägg: ${String(input.description)}`,
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await createExpenseClaim(
      ctx,
      {
        ...input,
        employee_id: input.employee_id ?? undefined,
        document_id: input.document_id ?? undefined,
        inbox_item_id: input.inbox_item_id ?? undefined,
      },
      { dryRun },
    )
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ...outcome, data: toPublicClaim(outcome.data) }
  },
})

export const expenseClaimsDelete = defineOperation({
  id: 'expense-claims.delete',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Delete a registered expense claim; its verifikat is reversed by storno, never deleted.',
    description:
      'Removes an unpaid claim from the register. The verifikat that booked it stays (BFL 5 kap 5 §): a storno verifikat reverses it and the receipt stays on the original. A claim scheduled on a draft payslip has that line removed first. Paid claims and claims on a payslip past draft are refused. Answers reversal_entry_id (null when the original verifikat no longer exists). Idempotent. Dry-runnable.',
    useWhen: 'A claim was registered by mistake (wrong person, duplicate receipt) and has not been paid back.',
    doNotUseFor:
      'Correcting an amount or account on a booked claim (delete and register again, or correct the verifikat), or undoing a payout.',
    pitfalls: [
      'A paid claim returns 409 EXPENSE_CLAIM_ALREADY_PAID; a claim on a payslip past draft returns 409 EXPENSE_CLAIM_ON_PAYSLIP.',
      'The storno is a new verifikat with its own number: the original number is never freed.',
      'A locked period for the storno date surfaces as PERIOD_LOCKED from the engine.',
    ],
    example: {
      response: {
        data: { deleted: true, expense_claim_id: '5a0a…', reversal_entry_id: 'b7d2…' },
        meta: META,
      },
    },
  },
  input: z.object({ expense_claim_id: EXPENSE_CLAIM_ID }),
  output: z.object({
    deleted: z.literal(true),
    expense_claim_id: z.string().uuid(),
    reversal_entry_id: z.string().uuid().nullable().describe('The storno verifikat, or null when no verifikat remained.'),
  }),
  errorCodes: ['EXPENSE_CLAIM_NOT_FOUND', 'EXPENSE_CLAIM_ALREADY_PAID', 'EXPENSE_CLAIM_ON_PAYSLIP'],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/expense-claims/:id',
    pathParams: { id: 'expense_claim_id' },
  },
  mcp: {
    name: 'gnubok_delete_expense_claim',
    title: 'Delete Expense Claim',
    description:
      'Stage deleting an unpaid utlägg. Approval reverses its verifikat with a storno (never deletes it) and removes the claim. Refused for a paid claim or one on a payslip past draft.',
    keywords: ['ta bort utlägg', 'radera utlägg', 'fel utlägg', 'makulera utlägg'],
    stage: { pendingType: 'delete_expense_claim', title: () => 'Ta bort utlägg' },
  },
  run: (ctx, { expense_claim_id }, { dryRun }) => removeExpenseClaim(ctx, expense_claim_id, { dryRun }),
})

const PayoutOut = z.object({
  batch_id: z.string().uuid(),
  journal_entry_id: z.string().uuid(),
  voucher_number: z.number().int().nullable(),
  total_sek: z.number(),
  claim_count: z.number().int(),
})

export const expenseClaimsRecordPayout = defineOperation({
  id: 'expense-claims.record-payout',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Record that the company paid a person back for their expense claims.',
    description:
      'Books one repayment of N registered claims of ONE person: Debit the liability account (2013 eget uttag for an enskild firma owner\'s 2018), Credit cash_account (19xx), for the claims\' total, and marks them paid, all in one transaction that locks the claims. No money moves: this records a transfer made outside Accounted. Idempotent. Dry-runnable.',
    useWhen:
      'The person was paid back from an account without a bank feed, or the transfer cannot be matched to a bank row.',
    doNotUseFor:
      'A repayment that is a bank transaction in Accounted: match it (POST /transactions/{id}/match-expense-payout), or the row gets booked twice. Repayment through salary is the payroll flow.',
    pitfalls: [
      'All claims must belong to one person and one liability account (400 EXPENSE_PAYOUT_MIXED_CLAIMANTS / MIXED_LIABILITY).',
      'A paid claim returns 409 EXPENSE_PAYOUT_ALREADY_PAID; one on a payslip returns 409 EXPENSE_PAYOUT_ON_PAYSLIP.',
      'cash_account is a STRING 19xx ("1930") that must be active in the chart.',
      'Partial payouts are not supported: pay whole claims.',
    ],
    example: {
      request: { claim_ids: ['5a0a…'], payout_date: '2026-09-05', cash_account: '1930' },
      response: {
        data: { batch_id: 'e1f0…', journal_entry_id: '4d2a…', voucher_number: 118, total_sek: 500, claim_count: 1 },
        meta: META,
      },
    },
  },
  input: CreateExpensePayoutSchema,
  output: PayoutOut,
  errorCodes: [
    'EXPENSE_PAYOUT_CLAIMS_NOT_FOUND',
    'EXPENSE_PAYOUT_ALREADY_PAID',
    'EXPENSE_PAYOUT_MIXED_CLAIMANTS',
    'EXPENSE_PAYOUT_MIXED_LIABILITY',
    'EXPENSE_PAYOUT_ON_PAYSLIP',
    'EXPENSE_PAYOUT_NO_FISCAL_PERIOD',
    'EXPENSE_PAYOUT_ACCOUNT_NOT_IN_CHART',
    'PERIOD_LOCKED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/expense-claims/payouts' },
  mcp: {
    name: 'gnubok_record_expense_payout',
    title: 'Record Expense Payout',
    description:
      'Stage recording that one person was paid back for their utlägg: approval books liability against a 19xx account and marks the claims paid. For a bank row in Accounted use gnubok_match_expense_payout instead.',
    keywords: ['betala ut utlägg', 'återbetala utlägg', 'utbetalning utlägg', 'ersätt utlägg'],
    stage: {
      pendingType: 'record_expense_payout',
      title: (input) =>
        `Utbetalning av ${Array.isArray(input.claim_ids) ? input.claim_ids.length : 0} utlägg`,
    },
  },
  run: (ctx, input, { dryRun }) => recordExpensePayout(ctx, input, { dryRun }),
})

export const transactionsMatchExpensePayout = defineOperation({
  id: 'transactions.match-expense-payout',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Book an outgoing bank transaction as the repayment of one person\'s expense claims.',
    description:
      'Books the bank row as the payout of the given registered claims: Debit their liability account (2013 for an enskild firma owner\'s 2018), Credit the transaction\'s own cash account, dated the transaction date, and links the row to the verifikat in the same transaction, so it can never be booked twice. The claims\' total must equal the outflow to the öre. Idempotent. Dry-runnable.',
    useWhen: 'An unbooked SEK outflow is the transfer that paid an owner or employee back for their utlägg.',
    doNotUseFor:
      'A transfer with no bank row in Accounted (POST /expense-claims/payouts), partial repayments, or salary.',
    pitfalls: [
      'The sum of the picked claims must equal |amount| exactly: 400 EXPENSE_PAYOUT_MATCH_AMOUNT otherwise.',
      'Only unbooked outgoing SEK rows: incoming returns EXPENSE_PAYOUT_MATCH_NOT_EXPENSE, another currency EXPENSE_PAYOUT_MATCH_CURRENCY, an already booked row EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED.',
      'All claims must belong to one person and one liability account.',
    ],
    example: {
      request: { claim_ids: ['5a0a…', '7b1c…'] },
      response: {
        data: {
          transaction_id: '1f2e…',
          batch_id: 'e1f0…',
          journal_entry_id: '4d2a…',
          voucher_number: 119,
          total_sek: 1596,
          claim_count: 2,
        },
        meta: META,
      },
    },
  },
  input: MatchExpensePayoutSchema.extend({
    transaction_id: z.string().uuid().describe('The bank transaction (transaction_id), an unbooked SEK outflow.'),
  }),
  output: PayoutOut.extend({ transaction_id: z.string().uuid() }),
  errorCodes: [
    'TX_CATEGORIZE_TX_NOT_FOUND',
    'EXPENSE_PAYOUT_MATCH_NOT_EXPENSE',
    'EXPENSE_PAYOUT_MATCH_CURRENCY',
    'EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED',
    'EXPENSE_PAYOUT_MATCH_AMOUNT',
    'EXPENSE_PAYOUT_ALREADY_PAID',
    'EXPENSE_PAYOUT_MIXED_CLAIMANTS',
    'EXPENSE_PAYOUT_ON_PAYSLIP',
    'PERIOD_LOCKED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/transactions/:id/match-expense-payout',
    pathParams: { id: 'transaction_id' },
  },
  mcp: {
    name: 'gnubok_match_expense_payout',
    title: 'Match Expense Payout',
    description:
      'Stage booking an outgoing bank transaction as the repayment of one person\'s utlägg (claim_ids from gnubok_list_expense_claims). The claims must sum to the outflow exactly; approval books and links the row.',
    keywords: ['matcha utlägg', 'utbetalning utlägg', 'återbetalning utlägg', 'överföring till ägare', 'överföring till anställd'],
    stage: { pendingType: 'match_expense_payout', title: () => 'Matcha transaktion mot utlägg' },
  },
  run: (ctx, input, { dryRun }) => matchExpensePayout(ctx, input, { dryRun }),
})
