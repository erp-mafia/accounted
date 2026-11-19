import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { normalizeOcrReference } from '@/lib/invoices/duplicate-payment-guard'
import { customerNameMatches, descriptionMentionsReference } from '@/lib/invoices/invoice-matching'
import { distinctiveReferenceKeys, invoiceReferenceKeys } from '@/lib/invoices/ocr-keys'

/**
 * "May this invoice already be paid?" Run when the handover dialog opens and
 * again inside the commit, and before every escalation the company approves
 * (start, approve_step, confirm_not_paid). Its own query, deliberately not
 * findDuplicatePaymentCandidatesForInvoice (a mark-paid guard that searches
 * 60 days around a payment date and only business rows).
 *
 * Two questions:
 *
 * - Candidates: inbound bank rows the books have not explained (not linked
 *   to an invoice, a supplier invoice or a voucher, not ignored, business or
 *   not yet classified), dated from the invoice date to today, that could be
 *   this invoice's payment: the printed OCR or the invoice number in the
 *   reference or text (any amount), the customer's name with an amount up to
 *   what is left to pay (partial payments count), or the matcher's own hint.
 *   A candidate the user marked "not a payment of this invoice" is listed
 *   but does not block.
 * - Freshness: the bank account the invoice tells the customer to pay to is
 *   connected and was synced within the last 24 hours. Bank sync runs hourly
 *   and syncs each connection once per 23 hours, so 24 hours is the longest
 *   a healthy connection goes unsynced.
 *
 * Outcome: candidates (blocks until each is booked or dismissed), else
 * stale or no_bank (the web dialog asks a person to attest; the batch and
 * the API refuse), else pass.
 */

export const BANK_FRESHNESS_HOURS = 24
/** Öresavrundning: a customer may pay the rounded amount, up to one krona above what is left. */
const NAME_MATCH_TOLERANCE = 1
/** Bank row ids per invoice_payments lookup. */
const EXPLAINED_LOOKUP_CHUNK = 150

export type BankCheckOutcome = 'pass' | 'candidates' | 'stale' | 'no_bank'
export type BankFreshness = 'fresh' | 'stale' | 'no_bank'

export interface BankCheckPayeeAccount {
  cashAccountId: string
  name: string | null
  ledgerAccount: string
  bankConnectionId: string | null
  syncedAt: string | null
  fresh: boolean
}

export type BankCandidateReason = 'hint' | 'reference' | 'name'

export interface BankCheckCandidate {
  transactionId: string
  date: string
  amount: number
  description: string
  reason: BankCandidateReason
  dismissed: boolean
}

export interface BankCheckResult {
  outcome: BankCheckOutcome
  freshness: BankFreshness
  checkedAt: string
  payeeAccounts: BankCheckPayeeAccount[]
  candidates: BankCheckCandidate[]
  /** The oldest sync among the payee accounts (what the dialog names); null when none is connected. */
  lastSyncedAt: string | null
}

export interface BankCheckInvoice {
  id: string
  invoice_number: string | null
  invoice_date: string
  currency: string
  payment_cash_account_id: string | null
}

export interface BankCandidateRow {
  id: string
  date: string
  amount: number
  description: string | null
  original_description?: string | null
  merchant_name: string | null
  reference: string | null
  potential_invoice_id: string | null
}

/** Which unexplained inbound rows could be this invoice's payment, and why. Pure. */
export function classifyBankCandidates(
  rows: readonly BankCandidateRow[],
  input: {
    invoice: Pick<BankCheckInvoice, 'id' | 'invoice_number'>
    customerName: string | null
    remaining: number
    dismissedTransactionIds: readonly string[]
  },
): BankCheckCandidate[] {
  const exactKeys = new Set(invoiceReferenceKeys(input.invoice.invoice_number).map((k) => k.key))
  const textKeys = distinctiveReferenceKeys(input.invoice.invoice_number)
  const dismissed = new Set(input.dismissedTransactionIds)
  const out: BankCheckCandidate[] = []
  for (const row of rows) {
    const amount = Number(row.amount)
    if (!(amount > 0)) continue
    const text = [row.description, row.original_description].filter(Boolean).join(' ')
    let reason: BankCandidateReason | null = null
    if (row.potential_invoice_id === input.invoice.id) reason = 'hint'
    else if (
      (row.reference && exactKeys.has(normalizeOcrReference(row.reference))) ||
      textKeys.some((key) => descriptionMentionsReference(text, key) || descriptionMentionsReference(row.reference, key))
    ) {
      reason = 'reference'
    } else if (
      amount <= roundOre(input.remaining + NAME_MATCH_TOLERANCE) &&
      customerNameMatches(input.customerName ?? undefined, text, row.merchant_name)
    ) {
      reason = 'name'
    }
    if (!reason) continue
    out.push({
      transactionId: row.id,
      date: row.date,
      amount: roundOre(amount),
      description: (row.description ?? row.original_description ?? '').slice(0, 200),
      reason,
      dismissed: dismissed.has(row.id),
    })
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** Freshness over the payee accounts. Pure. */
export function bankFreshness(accounts: readonly BankCheckPayeeAccount[]): BankFreshness {
  if (accounts.length === 0 || accounts.some((a) => !a.bankConnectionId)) return 'no_bank'
  return accounts.every((a) => a.fresh) ? 'fresh' : 'stale'
}

export function bankCheckOutcome(freshness: BankFreshness, candidates: readonly BankCheckCandidate[]): BankCheckOutcome {
  if (candidates.some((c) => !c.dismissed)) return 'candidates'
  if (freshness === 'fresh') return 'pass'
  return freshness
}

interface PayeeCashAccountRow {
  id: string
  name: string | null
  ledger_account: string
  bank_connection_id: string | null
}

/** The bank account the invoice asks the customer to pay to: its own choice, else the default for its currency. */
async function loadPayeeCashAccount(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoice: BankCheckInvoice,
): Promise<PayeeCashAccountRow | null> {
  let cashAccountId = invoice.payment_cash_account_id
  if (!cashAccountId) {
    const { data, error } = await db
      .from('invoice_payee_defaults')
      .select('cash_account_id')
      .eq('company_id', companyId)
      .eq('currency', invoice.currency)
      .maybeSingle()
    if (error) throw new Error(`invoice_payee_defaults lookup failed: ${error.message}`)
    cashAccountId = (data as { cash_account_id: string } | null)?.cash_account_id ?? null
  }
  if (!cashAccountId) return null
  const { data, error } = await db
    .from('cash_accounts')
    .select('id, name, ledger_account, bank_connection_id')
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
    .maybeSingle()
  if (error) throw new Error(`cash_accounts lookup failed: ${error.message}`)
  return (data as PayeeCashAccountRow | null) ?? null
}

async function loadPayeeAccounts(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoice: BankCheckInvoice,
  now: Date,
): Promise<BankCheckPayeeAccount[]> {
  const account = await loadPayeeCashAccount(db, companyId, invoice)
  if (!account) return []
  let syncedAt: string | null = null
  let active = false
  if (account.bank_connection_id) {
    const { data, error } = await db
      .from('bank_connections')
      .select('id, status, last_synced_at')
      .eq('company_id', companyId)
      .eq('id', account.bank_connection_id)
      .maybeSingle()
    if (error) throw new Error(`bank_connections lookup failed: ${error.message}`)
    const connection = data as { status: string; last_synced_at: string | null } | null
    syncedAt = connection?.last_synced_at ?? null
    active = connection?.status === 'active'
  }
  const fresh =
    active && syncedAt !== null && now.getTime() - Date.parse(syncedAt) <= BANK_FRESHNESS_HOURS * 3_600_000
  return [
    {
      cashAccountId: account.id,
      name: account.name,
      ledgerAccount: account.ledger_account,
      bankConnectionId: account.bank_connection_id,
      syncedAt,
      fresh,
    },
  ]
}

/**
 * Every unexplained inbound row from the invoice date to today. All of
 * them, paged on the id: a row skipped here is a payment the check never
 * saw, and the oldest rows (a customer who paid near the due date) are the
 * ones a cap would drop first.
 */
export async function loadUnexplainedInboundRows(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoice: BankCheckInvoice,
  today: string,
): Promise<BankCandidateRow[]> {
  return fetchAllRows<BankCandidateRow>(({ from, to }) =>
    db
      .from('open_bank_rows')
      .select('id, date, amount, description, original_description, merchant_name, reference, potential_invoice_id')
      .eq('company_id', companyId)
      .gt('amount', 0)
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      .gte('date', invoice.invoice_date)
      .lte('date', today)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/**
 * The bank rows among `ids` that a batch allocation already applied to an
 * invoice (explained, so not a candidate). Looked up in chunks: hundreds of
 * ids in one query string is past what PostgREST's gateway accepts.
 */
export async function loadAllocatedTransactionIds(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const explained = new Set<string>()
  for (let i = 0; i < ids.length; i += EXPLAINED_LOOKUP_CHUNK) {
    const { data, error } = await db
      .from('invoice_payments')
      .select('transaction_id')
      .eq('company_id', companyId)
      .in('transaction_id', ids.slice(i, i + EXPLAINED_LOOKUP_CHUNK))
    if (error) throw new Error(`invoice_payments lookup failed: ${error.message}`)
    for (const r of (data ?? []) as { transaction_id: string | null }[]) if (r.transaction_id) explained.add(r.transaction_id)
  }
  return explained
}

export interface RunBankCheckInput {
  companyId: string
  invoice: BankCheckInvoice
  customerName: string | null
  /** What is left of the claim (the customer's share). */
  remaining: number
  dismissedTransactionIds: readonly string[]
  /** Today in Europe/Stockholm (YYYY-MM-DD). */
  today: string
  now: Date
}

/** Load and decide. Reads with the client it is given (the caller's own, or the service role with the company filter). */
export async function runBankCheck(db: Pick<SupabaseClient, 'from'>, input: RunBankCheckInput): Promise<BankCheckResult> {
  const [payeeAccounts, rows] = await Promise.all([
    loadPayeeAccounts(db, input.companyId, input.invoice, input.now),
    loadUnexplainedInboundRows(db, input.companyId, input.invoice, input.today),
  ])
  const matched = classifyBankCandidates(rows, {
    invoice: input.invoice,
    customerName: input.customerName,
    remaining: input.remaining,
    dismissedTransactionIds: input.dismissedTransactionIds,
  })
  const allocated = matched.length > 0
    ? await loadAllocatedTransactionIds(db, input.companyId, matched.map((c) => c.transactionId))
    : new Set<string>()
  const candidates = matched.filter((c) => !allocated.has(c.transactionId))
  const freshness = bankFreshness(payeeAccounts)
  const synced = payeeAccounts.map((a) => a.syncedAt).filter((s): s is string => s !== null).sort()
  return {
    outcome: bankCheckOutcome(freshness, candidates),
    freshness,
    checkedAt: input.now.toISOString(),
    payeeAccounts,
    candidates,
    lastSyncedAt: synced[0] ?? null,
  }
}

/** The snapshot stored on the case (collection_cases.bank_check). */
export interface BankCheckSnapshot {
  checked_at: string
  outcome: BankCheckOutcome
  payee_accounts: Array<{ cash_account_id: string; synced_at: string | null }>
  candidate_transaction_ids: string[]
  dismissed: Array<{ transaction_id: string; by: string | null; at: string }>
  attested_by: string | null
  attested_at: string | null
  delivered_outcome: 'delivered' | 'attested' | 'none'
  imported_attestation: boolean
  response_attestation: boolean
}

export function bankCheckSnapshot(
  result: BankCheckResult,
  extra: {
    actorUserId: string | null
    bankAttested: boolean
    deliveredOutcome: BankCheckSnapshot['delivered_outcome']
    importedAttestation: boolean
    responseAttestation: boolean
  },
): BankCheckSnapshot {
  return {
    checked_at: result.checkedAt,
    outcome: result.outcome,
    payee_accounts: result.payeeAccounts.map((a) => ({ cash_account_id: a.cashAccountId, synced_at: a.syncedAt })),
    candidate_transaction_ids: result.candidates.map((c) => c.transactionId),
    dismissed: result.candidates
      .filter((c) => c.dismissed)
      .map((c) => ({ transaction_id: c.transactionId, by: extra.actorUserId, at: result.checkedAt })),
    attested_by: extra.bankAttested ? extra.actorUserId : null,
    attested_at: extra.bankAttested ? result.checkedAt : null,
    delivered_outcome: extra.deliveredOutcome,
    imported_attestation: extra.importedAttestation,
    response_attestation: extra.responseAttestation,
  }
}
