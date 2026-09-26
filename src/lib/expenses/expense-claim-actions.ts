/**
 * What a user can do with expense claims (utlägg: an owner or employee paid a
 * business cost privately and the company owes them), as one implementation
 * behind every door: the dashboard routes (/api/expense-claims/**,
 * /api/transactions/[id]/match-expense-payout), the v1 operations and the MCP
 * tools (lib/operations/expense-claims.ts).
 *
 *   - register: the claim row AND its verifikat (cost + ingående moms against
 *     the person's liability account: 2893 AB owner, 2018 EF owner, 2890
 *     förening member, 2820 employee), with the receipt and inbox item
 *     settled as the dashboard does;
 *   - delete: never deletes a verifikat (BFL 5 kap 5 §). A registered claim's
 *     verifikat is reversed with a storno entry and the register row goes; a
 *     paid claim is refused, as is one on a payslip that has left draft;
 *   - payout: the company pays the person back (liability -> 19xx) through
 *     create_expense_payout_batch, which locks the claims and posts in one
 *     transaction;
 *   - match a bank outflow to the claims it repays: the same RPC, with the
 *     transfer's date and cash account, linking the bank row in the same
 *     transaction.
 *
 * A dry run reads, checks and answers a preview; it writes nothing, calls no
 * writing RPC and posts nothing (it is also the MCP staging preview). The
 * registration and payout rules live in lib/expenses/expense-claims-service.ts
 * and the RPC; the dry runs mirror them with reads so an agent's staged
 * operation that could never commit is refused at staging, not at approval.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { decodeDefaultCursor, encodeDefaultCursor } from '@/lib/api/v1/pagination'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { hasBankLineJunctionRow } from '@/lib/transactions/is-booked'
import { hasLiveJournalEntryLink } from '@/lib/transactions/link-journal-entry'
import { findPayslipLineForClaim } from '@/lib/salary/expense-claim-lines'
import { roundOre, sumOre } from '@/lib/money'
import {
  createPayoutBatch,
  deleteExpenseClaim,
  planExpenseClaim,
  registerExpenseClaim,
  type CreatePayoutBatchFailureCode,
  type ExpenseClaimRow,
  type RegisterExpenseClaimFailure,
  type RegisterExpenseClaimInput,
} from '@/lib/expenses/expense-claims-service'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The public shape of a claim: qualified ids, SEK amounts as numbers. */
export interface ExpenseClaimPublic {
  expense_claim_id: string
  employee_id: string | null
  claimant_name: string
  description: string
  expense_date: string
  amount_sek: number
  vat_sek: number
  currency: string
  amount_in_currency: number | null
  exchange_rate: number | null
  expense_account: string
  liability_account: string
  document_id: string | null
  status: 'registered' | 'paid'
  journal_entry_id: string | null
  payout_batch_id: string | null
  created_at: string
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

export function toPublicClaim(row: Partial<ExpenseClaimRow> & { id: string }): ExpenseClaimPublic {
  return {
    expense_claim_id: row.id,
    employee_id: row.employee_id ?? null,
    claimant_name: row.claimant_name ?? '',
    description: row.description ?? '',
    expense_date: row.expense_date ?? '',
    amount_sek: roundOre(Number(row.amount_sek ?? 0)),
    vat_sek: roundOre(Number(row.vat_sek ?? 0)),
    currency: row.currency ?? 'SEK',
    amount_in_currency: nullableNumber(row.amount_in_currency),
    exchange_rate: nullableNumber(row.exchange_rate),
    expense_account: row.expense_account ?? '',
    liability_account: row.liability_account ?? '',
    document_id: row.document_id ?? null,
    status: row.status === 'paid' ? 'paid' : 'registered',
    journal_entry_id: row.journal_entry_id ?? null,
    payout_batch_id: row.payout_batch_id ?? null,
    created_at: row.created_at ?? '',
  }
}

export interface ListExpenseClaimsFilters {
  status?: 'registered' | 'paid'
  employee_id?: string
  cursor?: string
  limit?: number
}

/**
 * One page of claims, newest registration first, keyset on (created_at, id)
 * descending. A cursor that does not decode starts over (v1 convention).
 */
export async function listExpenseClaimsPage(
  ctx: OperationContext,
  filters: ListExpenseClaimsFilters,
): Promise<OperationOutcome<{ expense_claims: ExpenseClaimPublic[]; next_cursor: string | null }>> {
  const limit = filters.limit ?? 50
  const decoded = decodeDefaultCursor(filters.cursor)
  let query = ctx.supabase
    .from('expense_claims')
    .select('id, employee_id, claimant_name, description, expense_date, amount_sek, vat_sek, currency, amount_in_currency, exchange_rate, expense_account, liability_account, document_id, status, journal_entry_id, payout_batch_id, created_at')
    .eq('company_id', ctx.companyId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.employee_id) query = query.eq('employee_id', filters.employee_id)
  if (decoded) {
    query = query.or(`created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`)
  }
  const { data, error } = await query
  if (error) return failed(error)
  const rows = (data ?? []) as unknown as ExpenseClaimRow[]
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    ok: true,
    data: {
      expense_claims: page.map(toPublicClaim),
      next_cursor: rows.length > limit && last ? encodeDefaultCursor(last) : null,
    },
  }
}

export async function getExpenseClaim(
  ctx: OperationContext,
  claimId: string,
): Promise<OperationOutcome<ExpenseClaimPublic>> {
  const { data, error } = await ctx.supabase
    .from('expense_claims')
    .select('id, employee_id, claimant_name, description, expense_date, amount_sek, vat_sek, currency, amount_in_currency, exchange_rate, expense_account, liability_account, document_id, status, journal_entry_id, payout_batch_id, created_at')
    .eq('id', claimId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) return failed(error)
  if (!data) return { ok: false, code: 'EXPENSE_CLAIM_NOT_FOUND' }
  return { ok: true, data: toPublicClaim(data as unknown as ExpenseClaimRow) }
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

const REGISTER_CODES: Record<RegisterExpenseClaimFailure['code'], string> = {
  EMPLOYEE_NOT_FOUND: 'EMPLOYEE_NOT_FOUND',
  CLAIMANT_REQUIRED: 'EXPENSE_CLAIM_CLAIMANT_REQUIRED',
  RATE_UNAVAILABLE: 'EXPENSE_CLAIM_RATE_UNAVAILABLE',
  VAT_EXCEEDS_AMOUNT: 'EXPENSE_CLAIM_VAT_EXCEEDS_AMOUNT',
  INVALID_LINES: 'EXPENSE_CLAIM_INVALID_LINES',
  FISCAL_PERIOD_NOT_FOUND: 'EXPENSE_CLAIM_NO_FISCAL_PERIOD',
  CLAIM_INSERT_FAILED: 'EXPENSE_CLAIM_SAVE_FAILED',
  COMPANY_NOT_FOUND: 'COMPANY_NOT_FOUND',
  LINK_WRITE_FAILED: 'EXPENSE_CLAIM_LINK_FAILED',
}

function registerFailure(ctx: OperationContext, failure: RegisterExpenseClaimFailure): Failure {
  const code = REGISTER_CODES[failure.code] ?? 'EXPENSE_CLAIM_SAVE_FAILED'
  if (code === 'EXPENSE_CLAIM_SAVE_FAILED' || code === 'EXPENSE_CLAIM_LINK_FAILED') {
    ctx.log.error('expense claim registration failed', new Error(failure.detail ?? failure.code))
  }
  return {
    ok: false,
    code,
    ...(failure.code === 'INVALID_LINES' && failure.detail ? { details: { reason: failure.detail } } : {}),
  }
}

/**
 * The period lock (company lock date, locked or closed year) answered as
 * PERIOD_LOCKED before anything is written. The DB triggers stay the
 * authority; this turns their exception into a readable refusal.
 */
async function periodLockFailure(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
): Promise<Failure | null> {
  const verdict = await checkPeriodLock(supabase, companyId, date)
  if (!verdict.locked) return null
  return {
    ok: false,
    code: 'PERIOD_LOCKED',
    details: { date, reason: verdict.reason, fiscal_period_id: verdict.fiscal_period_id ?? null },
  }
}

/**
 * The receipt and the inbox item must be the company's own. The v1 and MCP
 * doors run as the service role, where no RLS stops a foreign id from being
 * written onto the claim row (and read back through its document join).
 */
async function underlagFailure(ctx: OperationContext, input: RegisterExpenseClaimInput): Promise<Failure | null> {
  if (input.document_id) {
    const { data, error } = await ctx.supabase
      .from('document_attachments')
      .select('id')
      .eq('id', input.document_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) return failed(error)
    if (!data) return { ok: false, code: 'EXPENSE_CLAIM_DOCUMENT_NOT_FOUND', details: { document_id: input.document_id } }
  }
  if (input.inbox_item_id) {
    const { data, error } = await ctx.supabase
      .from('invoice_inbox_items')
      .select('id')
      .eq('id', input.inbox_item_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) return failed(error)
    if (!data) {
      return { ok: false, code: 'EXPENSE_CLAIM_INBOX_ITEM_NOT_FOUND', details: { inbox_item_id: input.inbox_item_id } }
    }
  }
  return null
}

/**
 * Register a claim and post its verifikat. On success answers the claim row
 * as stored (the dashboard reads it raw; the operation maps it).
 */
export async function createExpenseClaim(
  ctx: OperationContext,
  input: RegisterExpenseClaimInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<ExpenseClaimRow>> {
  const { supabase, companyId, userId } = ctx
  try {
    const locked = await periodLockFailure(supabase, companyId, input.expense_date)
    if (locked) return locked
    const underlag = await underlagFailure(ctx, input)
    if (underlag) return underlag

    if (options.dryRun) {
      const planned = await planExpenseClaim(supabase, companyId, input, { dryRun: true })
      if (!planned.ok) return registerFailure(ctx, planned)
      const { plan } = planned
      const totalDebit = sumOre(plan.lines.map((l) => l.debit_amount))
      const totalCredit = sumOre(plan.lines.map((l) => l.credit_amount))
      if (totalDebit !== totalCredit || totalDebit <= 0) {
        return { ok: false, code: 'EXPENSE_CLAIM_INVALID_LINES', details: { reason: 'unbalanced' } }
      }
      return {
        ok: true,
        dryRun: true,
        preview: {
          claimant_name: plan.claimantName,
          employee_id: plan.employeeId,
          liability_account: plan.liabilityAccount,
          expense_date: input.expense_date,
          fiscal_period_id: plan.fiscalPeriodId,
          amount_sek: plan.amountSek,
          vat_sek: plan.vatSek,
          currency: input.currency,
          exchange_rate: input.currency === 'SEK' ? null : plan.rate,
          document_id: input.document_id ?? null,
          inbox_item_id: input.inbox_item_id ?? null,
          verifikat: {
            description: plan.entryDescription,
            lines: plan.lines.map((l) => ({
              account_number: l.account_number,
              debit_amount: l.debit_amount,
              credit_amount: l.credit_amount,
            })),
            total_debit: totalDebit,
            total_credit: totalCredit,
          },
        },
      }
    }

    const result = await registerExpenseClaim(supabase, companyId, userId, input)
    if (!result.ok) return registerFailure(ctx, result)
    return { ok: true, data: result.claim, created: true }
  } catch (err) {
    ctx.log.error('failed to register expense claim', err as Error)
    return failed(err)
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

const DELETE_CODES: Record<string, string> = {
  NOT_FOUND: 'EXPENSE_CLAIM_NOT_FOUND',
  ALREADY_PAID: 'EXPENSE_CLAIM_ALREADY_PAID',
  ON_PAYSLIP: 'EXPENSE_CLAIM_ON_PAYSLIP',
  DELETE_FAILED: 'EXPENSE_CLAIM_DELETE_FAILED',
}

/**
 * Read-only mirror of deleteExpenseClaim's decisions: which verifikat the
 * storno reverses (or that the row goes alone because its entry is gone),
 * and the refusals.
 */
async function previewDeletion(
  ctx: OperationContext,
  claimId: string,
): Promise<OperationOutcome<never>> {
  const { supabase, companyId } = ctx
  const { data: claim, error } = await supabase
    .from('expense_claims')
    .select('id, status, journal_entry_id, claimant_name, amount_sek')
    .eq('id', claimId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return failed(error)
  if (!claim) return { ok: false, code: 'EXPENSE_CLAIM_NOT_FOUND' }
  if (claim.status === 'paid') return { ok: false, code: 'EXPENSE_CLAIM_ALREADY_PAID' }

  const payslip = await findPayslipLineForClaim(supabase, companyId, claimId)
  if (payslip && payslip.run_status !== 'draft') {
    return {
      ok: false,
      code: 'EXPENSE_CLAIM_ON_PAYSLIP',
      details: { salary_run_id: payslip.salary_run_id, salary_run_status: payslip.run_status },
    }
  }

  let entryId = (claim.journal_entry_id as string | null) ?? null
  if (!entryId) {
    const { data: sourced, error: sourcedError } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('source_type', 'expense_claim')
      .eq('source_id', claimId)
      .maybeSingle()
    if (sourcedError) return failed(sourcedError)
    entryId = (sourced?.id as string | undefined) ?? null
  }
  let entryStatus: string | null = null
  if (entryId) {
    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('status, reversed_by_id')
      .eq('id', entryId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (entryError) return failed(entryError)
    entryStatus = (entry?.status as string | undefined) ?? null
  }

  return {
    ok: true,
    dryRun: true,
    preview: {
      expense_claim_id: claimId,
      claimant_name: claim.claimant_name,
      amount_sek: roundOre(Number(claim.amount_sek ?? 0)),
      journal_entry_id: entryId,
      // 'storno': the verifikat is reversed by a new one, never deleted.
      // 'reuse_reversal': an earlier attempt already posted the storno.
      // 'row_only': the verifikat no longer exists; only the register row goes.
      action: !entryId ? 'row_only' : entryStatus === 'reversed' ? 'reuse_reversal' : 'storno',
      removes_draft_payslip_line: payslip ? payslip.line_id : null,
    },
  }
}

export async function removeExpenseClaim(
  ctx: OperationContext,
  claimId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ deleted: true; expense_claim_id: string; reversal_entry_id: string | null }>> {
  try {
    if (options.dryRun) return await previewDeletion(ctx, claimId)
    const result = await deleteExpenseClaim(ctx.supabase, ctx.companyId, ctx.userId, claimId)
    if (!result.ok) {
      const code = DELETE_CODES[result.code] ?? 'EXPENSE_CLAIM_DELETE_FAILED'
      if (code === 'EXPENSE_CLAIM_DELETE_FAILED') {
        ctx.log.error('expense claim delete failed', new Error(result.detail ?? result.code))
      }
      return { ok: false, code }
    }
    return {
      ok: true,
      data: { deleted: true, expense_claim_id: claimId, reversal_entry_id: result.reversal_entry_id },
    }
  } catch (err) {
    ctx.log.error('failed to delete expense claim', err as Error)
    return failed(err)
  }
}

// ---------------------------------------------------------------------------
// Payout
// ---------------------------------------------------------------------------

const PAYOUT_CODES: Record<CreatePayoutBatchFailureCode, string> = {
  NO_CLAIMS: 'EXPENSE_PAYOUT_NO_CLAIMS',
  CLAIMS_NOT_FOUND: 'EXPENSE_PAYOUT_CLAIMS_NOT_FOUND',
  ALREADY_PAID: 'EXPENSE_PAYOUT_ALREADY_PAID',
  MIXED_CLAIMANTS: 'EXPENSE_PAYOUT_MIXED_CLAIMANTS',
  MIXED_LIABILITY: 'EXPENSE_PAYOUT_MIXED_LIABILITY',
  FISCAL_PERIOD_NOT_FOUND: 'EXPENSE_PAYOUT_NO_FISCAL_PERIOD',
  PERIOD_LOCKED: 'PERIOD_LOCKED',
  ACCOUNT_NOT_IN_CHART: 'EXPENSE_PAYOUT_ACCOUNT_NOT_IN_CHART',
  INVALID_CASH_ACCOUNT: 'EXPENSE_PAYOUT_INVALID_CASH_ACCOUNT',
  FORBIDDEN: 'FORBIDDEN',
  TX_NOT_FOUND: 'TX_CATEGORIZE_TX_NOT_FOUND',
  TX_ALREADY_BOOKED: 'EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED',
  TX_CURRENCY: 'EXPENSE_PAYOUT_MATCH_CURRENCY',
  TX_AMOUNT_MISMATCH: 'EXPENSE_PAYOUT_MATCH_AMOUNT',
  ON_PAYSLIP: 'EXPENSE_PAYOUT_ON_PAYSLIP',
  BATCH_INSERT_FAILED: 'EXPENSE_PAYOUT_FAILED',
}

export interface ExpensePayoutResult {
  batch_id: string
  journal_entry_id: string
  voucher_number: number | null
  total_sek: number
  claim_count: number
}

export interface ExpensePayoutInput {
  claim_ids: string[]
  payout_date: string
  cash_account: string
  notes?: string
}

/**
 * Read-only mirror of create_expense_payout_batch's checks, in its order:
 * each claim registered, not on a payslip, one claimant, one liability
 * account, all found; the transfer (bank-line mode) equal to the total; an
 * open, unlocked year; both accounts active in the chart.
 */
async function previewPayout(
  ctx: OperationContext,
  input: ExpensePayoutInput,
  transaction: { transaction_id: string; amount: number } | null,
): Promise<OperationOutcome<never>> {
  const { supabase, companyId } = ctx
  const claimIds = [...new Set(input.claim_ids)]
  if (claimIds.length === 0) return { ok: false, code: 'EXPENSE_PAYOUT_NO_CLAIMS' }
  if (!/^19\d{2}$/.test(input.cash_account)) {
    return { ok: false, code: 'EXPENSE_PAYOUT_INVALID_CASH_ACCOUNT', details: { cash_account: input.cash_account } }
  }

  const { data: claimRows, error } = await supabase
    .from('expense_claims')
    .select('id, status, employee_id, claimant_name, liability_account, amount_sek')
    .eq('company_id', companyId)
    .in('id', claimIds)
  if (error) return failed(error)
  const claims = (claimRows ?? []) as Array<{
    id: string
    status: string
    employee_id: string | null
    claimant_name: string
    liability_account: string
    amount_sek: number | string
  }>

  const notOpen = claims.find((c) => c.status !== 'registered')
  if (notOpen) return { ok: false, code: 'EXPENSE_PAYOUT_ALREADY_PAID', details: { claim_id: notOpen.id } }

  const { data: scheduled, error: scheduledError } = await supabase
    .from('salary_line_items')
    .select('source_expense_claim_id')
    .eq('company_id', companyId)
    .in('source_expense_claim_id', claimIds)
  if (scheduledError) return failed(scheduledError)
  const onPayslip = ((scheduled ?? []) as Array<{ source_expense_claim_id: string | null }>).find(
    (row) => row.source_expense_claim_id,
  )
  if (onPayslip) {
    return { ok: false, code: 'EXPENSE_PAYOUT_ON_PAYSLIP', details: { claim_id: onPayslip.source_expense_claim_id } }
  }

  const claimantKey = (c: (typeof claims)[number]) =>
    c.employee_id ?? `name:${(c.claimant_name ?? '').trim().toLowerCase()}`
  const first = claims[0]
  if (first) {
    if (claims.some((c) => claimantKey(c) !== claimantKey(first))) {
      return { ok: false, code: 'EXPENSE_PAYOUT_MIXED_CLAIMANTS' }
    }
    if (claims.some((c) => c.liability_account !== first.liability_account)) {
      return { ok: false, code: 'EXPENSE_PAYOUT_MIXED_LIABILITY' }
    }
  }
  if (!first || claims.length !== claimIds.length) return { ok: false, code: 'EXPENSE_PAYOUT_CLAIMS_NOT_FOUND' }

  const total = sumOre(claims.map((c) => Number(c.amount_sek)))
  if (transaction && (transaction.amount >= 0 || roundOre(-transaction.amount) !== total)) {
    return {
      ok: false,
      code: 'EXPENSE_PAYOUT_MATCH_AMOUNT',
      details: { transaction_amount: transaction.amount, claims_total: total },
    }
  }

  const verdict = await checkPeriodLock(supabase, companyId, input.payout_date)
  if (verdict.reason === 'no_fiscal_period') return { ok: false, code: 'EXPENSE_PAYOUT_NO_FISCAL_PERIOD' }
  if (verdict.locked) {
    return {
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { date: input.payout_date, reason: verdict.reason, fiscal_period_id: verdict.fiscal_period_id ?? null },
    }
  }

  // An enskild firma owner's claim sits on 2018 (egen insättning); its
  // repayment is an eget uttag on 2013 (DECISIONS 2026-09-06), as in the RPC.
  const debitAccount = first.liability_account === '2018' ? '2013' : first.liability_account
  for (const account of [input.cash_account, debitAccount]) {
    const { data: chartRow, error: chartError } = await supabase
      .from('chart_of_accounts')
      .select('account_number, is_active')
      .eq('company_id', companyId)
      .eq('account_number', account)
      .maybeSingle()
    if (chartError) return failed(chartError)
    if (!chartRow || chartRow.is_active === false) {
      return { ok: false, code: 'EXPENSE_PAYOUT_ACCOUNT_NOT_IN_CHART', details: { account } }
    }
  }

  const description = `Utbetalning utlägg: ${first.claimant_name} (${claimIds.length} st)`
  return {
    ok: true,
    dryRun: true,
    preview: {
      claimant_name: first.claimant_name,
      employee_id: first.employee_id,
      claim_count: claimIds.length,
      total_sek: total,
      payout_date: input.payout_date,
      fiscal_period_id: verdict.fiscal_period_id ?? null,
      ...(transaction ? { transaction_id: transaction.transaction_id } : {}),
      verifikat: {
        description,
        lines: [
          { account_number: debitAccount, debit_amount: total, credit_amount: 0 },
          { account_number: input.cash_account, debit_amount: 0, credit_amount: total },
        ],
      },
    },
  }
}

function payoutFailure(
  ctx: OperationContext,
  result: { code: CreatePayoutBatchFailureCode; detail?: string; error?: unknown },
): Failure {
  // An RPC exception (a period-lock or lock-date trigger) keeps its own
  // error, so the doors classify it (PERIOD_LOCKED, ...) instead of a 500.
  if (result.code === 'BATCH_INSERT_FAILED' && result.error) {
    return { ok: false, code: 'EXPENSE_PAYOUT_FAILED', error: result.error }
  }
  const code = PAYOUT_CODES[result.code] ?? 'EXPENSE_PAYOUT_FAILED'
  if (code === 'EXPENSE_PAYOUT_FAILED') {
    ctx.log.error('expense payout failed', new Error(result.detail ?? result.code))
  }
  return { ok: false, code }
}

/** The company pays one person back for N of their registered claims. */
export async function recordExpensePayout(
  ctx: OperationContext,
  input: ExpensePayoutInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<ExpensePayoutResult>> {
  try {
    if (options.dryRun) return await previewPayout(ctx, input, null)
    const result = await createPayoutBatch(ctx.supabase, ctx.companyId, ctx.userId, input)
    if (!result.ok) return payoutFailure(ctx, result)
    const { ok: _ok, ...data } = result
    return { ok: true, data, created: true }
  } catch (err) {
    ctx.log.error('failed to create expense payout', err as Error)
    return failed(err)
  }
}

// ---------------------------------------------------------------------------
// Match a bank outflow
// ---------------------------------------------------------------------------

export interface ExpensePayoutMatchResult extends ExpensePayoutResult {
  transaction_id: string
}

/**
 * Book an outgoing bank row as the repayment of one person's claims:
 *
 *   Debit  2893 / 2820 / 2890 (2013 for an EF owner's 2018)  [|tx.amount|]
 *   Credit 19xx (the transaction's own cash account)          [|tx.amount|]
 *
 * The amount, date and bank account come from the row, and the row is linked
 * to the verifikat inside the same RPC transaction, so the transfer can never
 * be booked twice. The claims' total must equal the transfer to the öre.
 */
export async function matchExpensePayout(
  ctx: OperationContext,
  input: { transaction_id: string; claim_ids: string[] },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<ExpensePayoutMatchResult>> {
  const { supabase, companyId } = ctx
  const txLog = ctx.log.child({ transactionId: input.transaction_id, claimCount: input.claim_ids.length })
  try {
    // transaction_voucher_links rides along: a row bulk-booked into a
    // samlingsverifikat carries journal_entry_id = NULL and must still refuse.
    const { data: transactionRow, error: fetchTxError } = await supabase
      .from('transactions')
      .select('id, date, amount, currency, journal_entry_id, cash_account_id, transaction_voucher_links(journal_entry_id, role)')
      .eq('id', input.transaction_id)
      .eq('company_id', companyId)
      .single()
    if (fetchTxError || !transactionRow) return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }
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
      return { ok: false, code: 'EXPENSE_PAYOUT_MATCH_NOT_EXPENSE', details: { amount: transaction.amount } }
    }
    if ((transaction.currency || 'SEK').toUpperCase() !== 'SEK') {
      return { ok: false, code: 'EXPENSE_PAYOUT_MATCH_CURRENCY', details: { currency: transaction.currency } }
    }
    // Only a LIVE (posted) pointer or a bank_line junction row blocks: a
    // pointer left behind by a storno reads as "utan koppling" in the UI and
    // must stay matchable (same predicate as link-journal-entry, issue #988).
    // The RPC re-checks under its row lock; this is the early, readable answer.
    if (
      hasBankLineJunctionRow(junctionLinks) ||
      (await hasLiveJournalEntryLink(supabase, companyId, transaction.journal_entry_id))
    ) {
      return {
        ok: false,
        code: 'EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED',
        details: { existingJournalEntryId: transaction.journal_entry_id },
      }
    }

    // Credit the cash account THIS transaction belongs to, never a
    // company-wide default (mirrors match-supplier-invoice).
    const cashAccount = await resolveSettlementAccount(supabase, companyId, transaction.cash_account_id, txLog)
    const payout = { claim_ids: input.claim_ids, payout_date: transaction.date, cash_account: cashAccount }

    if (options.dryRun) {
      return await previewPayout(ctx, payout, { transaction_id: transaction.id, amount: transaction.amount })
    }

    const result = await createPayoutBatch(supabase, companyId, ctx.userId, {
      ...payout,
      transaction_id: input.transaction_id,
    })
    if (!result.ok) {
      if (result.code === 'TX_AMOUNT_MISMATCH') {
        return { ok: false, code: 'EXPENSE_PAYOUT_MATCH_AMOUNT', details: { amount: transaction.amount } }
      }
      return payoutFailure(ctx, result)
    }
    txLog.info('expense payout matched from bank transaction', {
      userId: ctx.userId,
      journalEntryId: result.journal_entry_id,
      batchId: result.batch_id,
      totalSek: result.total_sek,
    })
    const { ok: _ok, ...data } = result
    return { ok: true, data: { ...data, transaction_id: input.transaction_id } }
  } catch (err) {
    txLog.error('failed to match expense payout', err as Error)
    return failed(err)
  }
}
