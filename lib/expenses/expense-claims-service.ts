/**
 * Expense claims (utlägg): out-of-pocket purchases booked against an
 * owner/employee liability, reimbursed later in payout batches.
 *
 * Registering a claim posts a verifikat immediately:
 *
 *   Debit  expense account        (gross − VAT)
 *   Debit  2641 Ingående moms     (VAT, when > 0)
 *   Credit liability              (gross)  2893 owner / 2820 employee / 2018 EF
 *
 * A payout batch reimburses N registered claims for ONE claimant in one bank
 * transfer:
 *
 *   Debit  liability              (batch total)
 *   Credit 19xx cash account      (batch total)
 *
 * Amounts are converted to SEK before booking; the original currency and
 * rate are stored on the claim as provenance (BFL: bokföring i redovisnings-
 * valutan). All rounding through roundOre.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Currency } from '@/types'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput } from '@/types'
import { createJournalEntry, findFiscalPeriod, reverseEntry } from '@/lib/bookkeeping/engine'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { roundOre, sumOre } from '@/lib/money'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'

const log = createLogger('expenses/claims')

export const EXPENSE_LIABILITY_ACCOUNTS = ['2893', '2820', '2018', '2890'] as const
export type ExpenseLiabilityAccount = (typeof EXPENSE_LIABILITY_ACCOUNTS)[number]

export interface ExpenseClaimRow {
  id: string
  company_id: string
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

export interface RegisterExpenseClaimInput {
  description: string
  expense_date: string
  /** Gross amount incl VAT, in `currency`. */
  amount: number
  /** Deductible VAT part of `amount`, in `currency`. */
  vat_amount: number
  currency: Currency
  /** Optional explicit rate; omitted → Riksbanken (cached) for expense_date. */
  exchange_rate?: number
  expense_account: string
  /** Defaults per claimant kind: employee → 2820, otherwise → 2893. */
  employee_id?: string
  /** Required when employee_id is absent (e.g. the owner's name). */
  claimant_name?: string
  document_id?: string
  inbox_item_id?: string
  /**
   * Custom verifikat lines in claim currency (the advanced booking step:
   * reverse charge, templates, manual rows). When present they replace the
   * generated cost/VAT lines entirely. Must balance, and must contain
   * exactly one credit line on the liability account equal to `amount`.
   */
  lines?: ExpenseClaimLineInput[]
}

export interface ExpenseClaimLineInput {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string | null
}

export type RegisterExpenseClaimResult =
  | { ok: true; claim: ExpenseClaimRow }
  | {
      ok: false
      code:
        | 'EMPLOYEE_NOT_FOUND'
        | 'CLAIMANT_REQUIRED'
        | 'RATE_UNAVAILABLE'
        | 'VAT_EXCEEDS_AMOUNT'
        | 'INVALID_LINES'
        | 'FISCAL_PERIOD_NOT_FOUND'
        | 'CLAIM_INSERT_FAILED'
        | 'COMPANY_NOT_FOUND'
        | 'LINK_WRITE_FAILED'
      detail?: string
    }

export async function registerExpenseClaim(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: RegisterExpenseClaimInput,
): Promise<RegisterExpenseClaimResult> {
  if (!input.lines && (input.vat_amount < 0 || input.vat_amount >= input.amount)) {
    return { ok: false, code: 'VAT_EXCEEDS_AMOUNT' }
  }

  // Resolve claimant + liability account. Entity type drives the owner
  // account, same resolver as the privately-paid supplier-invoice path:
  // AB owners are creditors (2893), enskild firma owners make egna
  // insättningar (2018); employees are 2820 regardless of entity type.
  const { data: company } = await supabase
    .from('companies')
    .select('entity_type')
    .eq('id', companyId)
    .single()
  if (!company?.entity_type) return { ok: false, code: 'COMPANY_NOT_FOUND' }
  const ownerLiability = company.entity_type === 'enskild_firma' ? '2018' : '2893'
  let claimantName = input.claimant_name?.trim() ?? ''
  let employeeId: string | null = null
  let liability: string = ownerLiability
  if (input.employee_id) {
    const { data: emp } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .eq('id', input.employee_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!emp) return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
    employeeId = emp.id
    // The employee row is the authority: a caller must not be able to pair
    // one employee_id with another person's name, which would book 2820 for
    // the employee while payout lists and descriptions name someone else.
    claimantName = `${emp.first_name} ${emp.last_name}`.trim()
    liability = '2820'
  }
  if (!claimantName) return { ok: false, code: 'CLAIMANT_REQUIRED' }

  // Custom lines: validate in claim currency before any conversion.
  if (input.lines) {
    const lines = input.lines
    if (lines.length < 2 || lines.length > 20) {
      return { ok: false, code: 'INVALID_LINES', detail: 'line count' }
    }
    for (const line of lines) {
      const debit = line.debit_amount || 0
      const credit = line.credit_amount || 0
      if (!ACCOUNT_NUMBER_RE.test(line.account_number)) {
        return { ok: false, code: 'INVALID_LINES', detail: `account ${line.account_number}` }
      }
      if (debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) {
        return { ok: false, code: 'INVALID_LINES', detail: 'each line needs exactly one side' }
      }
    }
    const sumDebit = sumOre(lines.map((l) => l.debit_amount || 0))
    const sumCredit = sumOre(lines.map((l) => l.credit_amount || 0))
    if (Math.abs(sumDebit - sumCredit) > 0.005) {
      return { ok: false, code: 'INVALID_LINES', detail: 'unbalanced' }
    }
    // The payout flow reimburses claim.amount_sek from the liability account,
    // so the verifikat must carry exactly that credit: one line, right
    // account, right amount.
    const liabilityLines = lines.filter((l) => l.account_number === liability && (l.credit_amount || 0) > 0)
    if (liabilityLines.length !== 1 || Math.abs((liabilityLines[0].credit_amount || 0) - input.amount) > 0.005) {
      return { ok: false, code: 'INVALID_LINES', detail: `liability line must credit ${liability} with the gross amount` }
    }
  }

  // Convert to SEK. The claim total is gross; VAT converts at the same rate
  // so the split stays internally consistent to the öre.
  let rate = 1
  if (input.currency !== 'SEK') {
    if (input.exchange_rate && input.exchange_rate > 0) {
      rate = input.exchange_rate
    } else {
      const fetched = await fetchExchangeRate(
        input.currency,
        new Date(input.expense_date),
        supabase,
      )
      if (!fetched) return { ok: false, code: 'RATE_UNAVAILABLE' }
      rate = fetched.rate
    }
  }
  const amountSek = roundOre(input.amount * rate)
  // With custom lines the claim's displayed VAT is the actually debited
  // 2641 side (reverse-charge 2614/2645 pairs net to zero and stay out).
  const vatSek = input.lines
    ? roundOre(
        sumOre(
          input.lines
            .filter((l) => l.account_number.startsWith('2641'))
            .map((l) => (l.debit_amount || 0) * rate),
        ),
      )
    : roundOre(input.vat_amount * rate)
  const netSek = roundOre(amountSek - vatSek)

  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, input.expense_date)
  if (!fiscalPeriodId) return { ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' }

  // Claim row first, then the verifikat with source_id pointing back at it;
  // a failed booking removes the orphan row again.
  const { data: claim, error: insertError } = await supabase
    .from('expense_claims')
    .insert({
      company_id: companyId,
      user_id: userId,
      employee_id: employeeId,
      claimant_name: claimantName,
      description: input.description,
      expense_date: input.expense_date,
      amount_sek: amountSek,
      vat_sek: vatSek,
      currency: input.currency,
      amount_in_currency: input.currency === 'SEK' ? null : roundOre(input.amount),
      exchange_rate: input.currency === 'SEK' ? null : rate,
      expense_account: input.expense_account,
      liability_account: liability,
      document_id: input.document_id ?? null,
      status: 'registered',
    })
    .select('*')
    .single()
  if (insertError || !claim) {
    return { ok: false, code: 'CLAIM_INSERT_FAILED', detail: insertError?.message }
  }

  const desc = `Utlägg: ${input.description} (${claimantName})`

  let customLines: CreateJournalEntryLineInput[] | null = null
  if (input.lines) {
    // Convert each custom line at the claim rate; the per-line öre rounding
    // can leave a residual, which lands on the largest non-liability line so
    // the liability credit stays exactly amount_sek (the payout contract).
    const converted = input.lines.map((l) => ({
      account_number: l.account_number,
      debit_amount: (l.debit_amount || 0) > 0 ? roundOre(l.debit_amount * rate) : 0,
      credit_amount:
        l.account_number === liability
          ? amountSek
          : (l.credit_amount || 0) > 0
            ? roundOre(l.credit_amount * rate)
            : 0,
      line_description: l.line_description?.trim() || desc,
    }))
    const residual = roundOre(
      sumOre(converted.map((l) => l.debit_amount)) - sumOre(converted.map((l) => l.credit_amount)),
    )
    if (residual !== 0) {
      const target = converted
        .filter((l) => l.account_number !== liability)
        .sort((a, b) => (b.debit_amount + b.credit_amount) - (a.debit_amount + a.credit_amount))[0]
      if (!target) return { ok: false, code: 'INVALID_LINES', detail: 'no adjustable line' }
      if (target.debit_amount > 0) target.debit_amount = roundOre(target.debit_amount - residual)
      else target.credit_amount = roundOre(target.credit_amount + residual)
      if (target.debit_amount < 0 || target.credit_amount < 0) {
        return { ok: false, code: 'INVALID_LINES', detail: 'rounding residual exceeds line' }
      }
    }
    customLines = converted.map((l) => ({
      account_number: l.account_number,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
      line_description: l.line_description,
      ...(input.currency !== 'SEK' && l.account_number === liability
        ? { currency: input.currency, amount_in_currency: roundOre(input.amount), exchange_rate: rate }
        : {}),
    }))
  }

  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: input.expense_account,
      debit_amount: netSek,
      credit_amount: 0,
      line_description: desc,
      ...(input.currency !== 'SEK'
        ? {
            currency: input.currency,
            amount_in_currency: roundOre(input.amount - input.vat_amount),
            exchange_rate: rate,
          }
        : {}),
    },
  ]
  if (vatSek > 0) {
    lines.push({
      account_number: '2641',
      debit_amount: vatSek,
      credit_amount: 0,
      line_description: `Ingående moms, ${desc}`,
    })
  }
  lines.push({
    account_number: liability,
    debit_amount: 0,
    credit_amount: amountSek,
    line_description: desc,
  })

  const entryInput: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: input.expense_date,
    description: desc,
    source_type: 'expense_claim',
    source_id: claim.id,
    lines: customLines ?? lines,
  }

  let journalEntryId: string
  try {
    const entry = await createJournalEntry(supabase, companyId, userId, entryInput)
    journalEntryId = entry.id
  } catch (err) {
    await supabase.from('expense_claims').delete().eq('id', claim.id).eq('company_id', companyId)
    throw err
  }

  const { error: linkError } = await supabase
    .from('expense_claims')
    .update({ journal_entry_id: journalEntryId })
    .eq('id', claim.id)
    .eq('company_id', companyId)
  if (linkError) {
    // The verifikat is posted and immutable; without the back-link the claim
    // cannot be storno-deleted or paid out safely, so surface it loudly.
    return {
      ok: false,
      code: 'LINK_WRITE_FAILED',
      detail: `claim ${claim.id} posted as entry ${journalEntryId}: ${linkError.message}`,
    }
  }

  // Attach the receipt to the verifikat and settle the inbox item, both
  // best-effort: the booking above is the legally significant part.
  if (input.document_id) {
    try {
      const { data: doc } = await supabase
        .from('document_attachments')
        .select('journal_entry_id, user_id, storage_path, file_name, file_size_bytes, mime_type, sha256_hash, uploaded_by, upload_source')
        .eq('id', input.document_id)
        .eq('company_id', companyId)
        .maybeSingle()
      const anchoredTo = (doc?.journal_entry_id as string | null) ?? null
      if (doc && anchoredTo === null) {
        await linkToJournalEntry(supabase, companyId, input.document_id, journalEntryId)
      } else if (doc && anchoredTo !== journalEntryId) {
        // Anchored to another verifikat (typically a stornoed booking that
        // this claim replaces). BFL 5 kap 6 § forbids re-pointing an anchored
        // document, so reference the same stored file from a new attachment
        // row instead of stealing the old one.
        const { data: copy, error: copyError } = await supabase
          .from('document_attachments')
          .insert({
            company_id: companyId,
            user_id: doc.user_id,
            storage_path: doc.storage_path,
            file_name: doc.file_name,
            file_size_bytes: doc.file_size_bytes,
            mime_type: doc.mime_type,
            sha256_hash: doc.sha256_hash,
            uploaded_by: doc.uploaded_by,
            upload_source: doc.upload_source,
            journal_entry_id: journalEntryId,
          })
          .select('id')
          .single()
        if (copyError || !copy) {
          throw new Error(copyError?.message ?? 'attachment copy insert failed')
        }
        await supabase
          .from('expense_claims')
          .update({ document_id: copy.id })
          .eq('id', claim.id)
          .eq('company_id', companyId)
      }
    } catch (err) {
      log.warn('expense claim receipt could not be attached to the verifikat', {
        claim_id: claim.id,
        document_id: input.document_id,
        journal_entry_id: journalEntryId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (input.inbox_item_id) {
    // "Processed" is derived from created_journal_entry_id; the status column
    // only tracks the extraction pipeline (received/processing/error).
    await supabase
      .from('invoice_inbox_items')
      .update({ created_journal_entry_id: journalEntryId })
      .eq('id', input.inbox_item_id)
      .eq('company_id', companyId)
  }

  return {
    ok: true,
    claim: { ...(claim as ExpenseClaimRow), journal_entry_id: journalEntryId },
  }
}

export interface ListExpenseClaimsOptions {
  status?: 'registered' | 'paid'
}

export async function listExpenseClaims(
  supabase: SupabaseClient,
  companyId: string,
  options: ListExpenseClaimsOptions = {},
): Promise<ExpenseClaimRow[]> {
  let query = supabase
    .from('expense_claims')
    .select('*, document:document_attachments(id, file_name), batch:expense_payout_batches(id, payout_date, journal_entry_id)')
    .eq('company_id', companyId)
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false })
  if (options.status) query = query.eq('status', options.status)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list expense claims: ${error.message}`)
  return (data ?? []) as ExpenseClaimRow[]
}

export type DeleteExpenseClaimResult =
  | { ok: true; reversal_entry_id: string | null }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_PAID' | 'UNLINKED' | 'DELETE_FAILED'; detail?: string }

/**
 * Remove a registered claim. The booked verifikat is never deleted: it is
 * reversed with a storno entry (BFL 5 kap 5 §), then the register row goes.
 * The receipt stays linked to the original entry, so the 7-year archive is
 * untouched. Paid claims are refused: undo the payout first.
 */
export async function deleteExpenseClaim(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  claimId: string,
): Promise<DeleteExpenseClaimResult> {
  const { data: claim, error } = await supabase
    .from('expense_claims')
    .select('id, status, journal_entry_id')
    .eq('id', claimId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return { ok: false, code: 'DELETE_FAILED', detail: error.message }
  if (!claim) return { ok: false, code: 'NOT_FOUND' }
  if (claim.status === 'paid') return { ok: false, code: 'ALREADY_PAID' }

  if (!claim.journal_entry_id) {
    // Registered claims always book a verifikat; a missing link means the
    // back-link write failed. Hard-deleting would orphan the posted entry.
    return { ok: false, code: 'UNLINKED', detail: `claim ${claimId} has no journal_entry_id` }
  }
  // Retry safety: if a previous attempt posted the storno but failed to
  // delete the register row, the entry is already 'reversed' and
  // reverseEntry would refuse it (CannotReverseNonPostedError). Reuse the
  // existing reversal and finish the delete instead of dead-ending the row.
  const { data: entry } = await supabase
    .from('journal_entries')
    .select('status, reversed_by_id')
    .eq('id', claim.journal_entry_id)
    .eq('company_id', companyId)
    .maybeSingle()

  let reversalEntryId: string | null
  if (entry?.status === 'reversed') {
    reversalEntryId = entry.reversed_by_id ?? null
  } else {
    const reversal = await reverseEntry(supabase, companyId, userId, claim.journal_entry_id)
    reversalEntryId = reversal.id
  }

  const { error: deleteError } = await supabase
    .from('expense_claims')
    .delete()
    .eq('id', claimId)
    .eq('company_id', companyId)
  if (deleteError) {
    // The storno is already posted; report the register desync loudly rather
    // than pretending nothing happened.
    return { ok: false, code: 'DELETE_FAILED', detail: deleteError.message }
  }

  return { ok: true, reversal_entry_id: reversalEntryId }
}

export interface CreatePayoutBatchInput {
  claim_ids: string[]
  payout_date: string
  cash_account: string
  notes?: string
}

export type CreatePayoutBatchFailureCode =
  | 'NO_CLAIMS'
  | 'CLAIMS_NOT_FOUND'
  | 'ALREADY_PAID'
  | 'MIXED_CLAIMANTS'
  | 'MIXED_LIABILITY'
  | 'FISCAL_PERIOD_NOT_FOUND'
  | 'PERIOD_LOCKED'
  | 'ACCOUNT_NOT_IN_CHART'
  | 'INVALID_CASH_ACCOUNT'
  | 'FORBIDDEN'
  | 'BATCH_INSERT_FAILED'

export type CreatePayoutBatchResult =
  | {
      ok: true
      batch_id: string
      journal_entry_id: string
      voucher_number: number | null
      total_sek: number
      claim_count: number
    }
  | { ok: false; code: CreatePayoutBatchFailureCode; detail?: string }

const PAYOUT_RPC_CODES: ReadonlySet<string> = new Set<CreatePayoutBatchFailureCode>([
  'NO_CLAIMS',
  'CLAIMS_NOT_FOUND',
  'ALREADY_PAID',
  'MIXED_CLAIMANTS',
  'MIXED_LIABILITY',
  'FISCAL_PERIOD_NOT_FOUND',
  'PERIOD_LOCKED',
  'ACCOUNT_NOT_IN_CHART',
  'INVALID_CASH_ACCOUNT',
  'FORBIDDEN',
])

interface PayoutRpcRow {
  ok: boolean
  code?: string
  details?: unknown
  batch_id?: string
  journal_entry_id?: string
  voucher_number?: number | null
  total_sek?: number | string
  claim_count?: number
}

/**
 * Reimburse N registered claims for one claimant in one bank transfer.
 *
 * Everything happens inside the create_expense_payout_batch RPC (migration
 * 20260904171000): the claims are locked FOR UPDATE, the liability -> cash
 * verifikat is posted through commit_journal_entry, the batch is linked and
 * the claims are marked paid, all in one transaction. A concurrent or
 * retried request for the same claims queues on the lock and is refused
 * with ALREADY_PAID, so a double click can never book a second transfer.
 * The claimant/liability/status rules are enforced by the RPC and echoed
 * here as result codes.
 */
export async function createPayoutBatch(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreatePayoutBatchInput,
): Promise<CreatePayoutBatchResult> {
  const claimIds = [...new Set(input.claim_ids)]
  if (claimIds.length === 0) return { ok: false, code: 'NO_CLAIMS' }

  const { data, error } = await supabase.rpc('create_expense_payout_batch', {
    p_company_id: companyId,
    p_claim_ids: claimIds,
    p_payout_date: input.payout_date,
    p_cash_account: input.cash_account,
    p_notes: input.notes ?? null,
    // Honored only for service-role callers (API-key / MCP paths run on the
    // cookieless service client where auth.uid() is NULL); an authenticated
    // caller is pinned to its own auth.uid() by the RPC.
    p_user_id: userId,
  })
  if (error) {
    // Period-lock and lock-date triggers surface here as Postgres errors;
    // the message is the trigger's own text, which the route maps for the
    // user. Sanitised log: code + message only.
    log.error('create_expense_payout_batch RPC error', {
      companyId,
      code: (error as { code?: string }).code,
      message: error.message,
    })
    return { ok: false, code: 'BATCH_INSERT_FAILED', detail: error.message }
  }

  const row = (data ?? null) as PayoutRpcRow | null
  if (!row) return { ok: false, code: 'BATCH_INSERT_FAILED', detail: 'empty RPC response' }
  if (!row.ok) {
    const code = row.code && PAYOUT_RPC_CODES.has(row.code)
      ? (row.code as CreatePayoutBatchFailureCode)
      : 'BATCH_INSERT_FAILED'
    return {
      ok: false,
      code,
      detail: row.details ? JSON.stringify(row.details) : row.code,
    }
  }
  if (!row.batch_id || !row.journal_entry_id) {
    return { ok: false, code: 'BATCH_INSERT_FAILED', detail: 'RPC returned ok without ids' }
  }

  return {
    ok: true,
    batch_id: row.batch_id,
    journal_entry_id: row.journal_entry_id,
    voucher_number: row.voucher_number ?? null,
    total_sek: roundOre(Number(row.total_sek ?? 0)),
    claim_count: row.claim_count ?? claimIds.length,
  }
}

export async function listPayoutBatches(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .from('expense_payout_batches')
    .select('*')
    .eq('company_id', companyId)
    .order('payout_date', { ascending: false })
  if (error) throw new Error(`Failed to list payout batches: ${error.message}`)
  return data ?? []
}
