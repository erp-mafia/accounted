/**
 * Already-explained guards for booking a bank row against invoices.
 *
 * A bank feed can deliver several affärshändelser as ONE row (a Bankgirot
 * daily aggregate covering two customers' invoices), and each may already be
 * booked on its own via "Markera som betald". The vouchers that explain the
 * row are then on the ledger with no bank link, and the next door that books
 * the row (a batch allocation, a single invoice match) mints a second
 * verifikat for the same money. The DETECTORS for that live once, in
 * duplicate-payment-detection.ts. This module is the one place that turns a
 * detector's answer into a decision, so every door that books a bank row (the
 * dashboard routes, MCP staging, the pending-operation commit) refuses,
 * overrides and records in exactly the same way. A guard that lived in one
 * door only is how the MCP path booked gecko's Bankgirot aggregate a second
 * time (issue #2294, dashboard fix in PR #2300).
 *
 * Override binding: force=true is honoured only when the caller echoes the
 * exact set (or candidate) detected NOW. A stale or guessed id is refused, so
 * an approval given before another voucher was posted can never wave the
 * guard away at commit time, and an automation cannot sweep through force=true
 * without ever consulting the vouchers.
 *
 * Detection failures fail OPEN (the booking RPCs remain the atomicity
 * boundary); callers log the miss through `onDetectError`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  detectDuplicatePaymentVoucher,
  detectExplainingVoucherSetForTransaction,
  type DuplicateVoucherCandidate,
  type ExplainingVoucher,
  type ExplainingVoucherSet,
  type TransactionForExplaining,
} from './duplicate-payment-detection'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import type { ProcessingHistoryActor } from '@/types'

// ── 1:N: the explaining voucher set (match_batch_allocate) ─────────────────

export interface ExplainedOverride {
  /** Book anyway. Honoured only when expected_journal_entry_ids names the set detected now. */
  force?: boolean
  /** The journal_entry_ids of the set the caller reviewed. */
  expected_journal_entry_ids?: string[]
}

export type AlreadyExplainedOutcome =
  | { status: 'clear' }
  | { status: 'blocked'; set: ExplainingVoucherSet; force_rejected: boolean }
  | { status: 'overridden'; set: ExplainingVoucherSet }
  /**
   * force=true, but the detector failed, so the binding could not be
   * re-verified. Never a pass: callers refuse it (BATCH_TX_EXPLAINED_CHECK_FAILED).
   * Without force the same failure is 'clear' (fail-open; the caller logs and
   * surfaces it).
   */
  | { status: 'unverifiable'; error: unknown }

/** The details block every door hands back, so the dialog and the agent read one shape. */
export interface AlreadyExplainedDetails {
  vouchers: ExplainingVoucher[]
  total: number
  bank_account_number: string
  same_date: boolean
  /** force=true was sent with a stale or missing set: the caller must re-read. */
  force_rejected: boolean
}

/**
 * Pure binding check. Order of the expected ids does not matter; the count
 * and every id must match, so a subset or a superset of the set is refused.
 */
export function bindExplainedOverride(
  set: ExplainingVoucherSet | null,
  override: ExplainedOverride,
): AlreadyExplainedOutcome {
  if (!set) return { status: 'clear' }
  const detectedIds = set.vouchers.map((v) => v.journal_entry_id).sort()
  const expectedIds = [...(override.expected_journal_entry_ids ?? [])].sort()
  const bound =
    override.force === true &&
    detectedIds.length === expectedIds.length &&
    detectedIds.every((id, i) => id === expectedIds[i])
  if (!bound) return { status: 'blocked', set, force_rejected: override.force === true }
  return { status: 'overridden', set }
}

export function alreadyExplainedDetails(
  outcome: Extract<AlreadyExplainedOutcome, { status: 'blocked' }>,
): AlreadyExplainedDetails {
  return {
    vouchers: outcome.set.vouchers,
    total: outcome.set.total,
    bank_account_number: outcome.set.bank_account_number,
    same_date: outcome.set.same_date,
    force_rejected: outcome.force_rejected,
  }
}

const sek = (amount: number): string =>
  `${amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`

/** "A57 + A58 (1930, 2026-07-31, 88 250,00 kr)": the set as a human reads it. */
export function describeExplainingSet(set: ExplainingVoucherSet): string {
  const labels = set.vouchers.map((v) => v.voucher_label).join(' + ')
  const dates = Array.from(new Set(set.vouchers.map((v) => v.entry_date))).sort()
  const when = dates.length === 1 ? dates[0] : `${dates[0]} till ${dates[dates.length - 1]}`
  return `${labels} (${set.bank_account_number}, ${when}, ${sek(set.total)})`
}

export interface GuardOptions {
  /** Called when the detector throws; the guard then fails open. */
  onDetectError?: (err: unknown) => void
}

/**
 * Detect the explaining set for a bank row and bind the caller's override to
 * it. Accepts the transaction id (one fetch) or a row the caller already
 * holds, exactly like the detector. A detector failure fails open without
 * force; with force it is 'unverifiable', because an override that cannot be
 * re-verified against the current set must never be honoured (same rule as
 * guardDuplicatePaymentVoucher below).
 */
export async function guardAlreadyExplained(
  supabase: SupabaseClient,
  companyId: string,
  transaction: string | TransactionForExplaining,
  override: ExplainedOverride,
  options: GuardOptions = {},
): Promise<AlreadyExplainedOutcome> {
  let set: ExplainingVoucherSet | null = null
  try {
    set = await detectExplainingVoucherSetForTransaction(supabase, companyId, transaction)
  } catch (err) {
    options.onDetectError?.(err)
    if (override.force === true) return { status: 'unverifiable', error: err }
  }
  return bindExplainedOverride(set, override)
}

export interface OverrideAudit {
  actor: ProcessingHistoryActor
  /** Which door honoured the override (e.g. 'dashboard', 'pending_operation_commit'). */
  via: string
}

/**
 * Durable record of an honoured override, written AFTER the booking succeeded
 * (BFNAR 2013:2 p. 9.16: the decision to book over vouchers that already
 * explain the row must be reconstructible). Best-effort: a failure here never
 * undoes the booking. Payload is PII-safe by construction: ids, labels,
 * amounts and dates only, never descriptions or counterparty names.
 */
export async function recordExplainedOverride(
  companyId: string,
  transactionId: string,
  set: ExplainingVoucherSet,
  audit: OverrideAudit,
  onError?: (err: unknown) => void,
): Promise<void> {
  try {
    await appendProcessingHistory({
      companyId,
      correlationId: transactionId,
      aggregateType: 'BankTransaction',
      aggregateId: transactionId,
      eventType: 'BankTransactionDuplicateDismissed',
      payload: {
        transaction_id: transactionId,
        dismissed_journal_entry_ids: set.vouchers.map((v) => v.journal_entry_id),
        dismissed_voucher_labels: set.vouchers.map((v) => v.voucher_label),
        total_ore: Math.round(set.total * 100),
        bank_account_number: set.bank_account_number,
        same_date: set.same_date,
        via: audit.via,
      },
      actor: audit.actor,
      occurredAt: new Date(),
    })
  } catch (err) {
    onError?.(err)
  }
}

// ── 1:1: the single duplicate candidate (match_transaction_invoice) ────────

export interface DuplicateCandidateOverride {
  force?: boolean
  /** The journal_entry_id of the candidate the caller reviewed. Required with force. */
  expected_journal_entry_id?: string
}

export type DuplicateCandidateOutcome =
  | { status: 'clear' }
  | { status: 'blocked'; candidate: DuplicateVoucherCandidate }
  /** force=true, but the candidate detected now is not the one echoed (or there is none). */
  | { status: 'mismatch'; expected_journal_entry_id: string | null; detected_journal_entry_id: string | null }
  | { status: 'overridden'; candidate: DuplicateVoucherCandidate }

/**
 * Pure binding check, same semantics as the dashboard and v1 match-invoice
 * routes: without force a candidate blocks; with force the candidate detected
 * now must be exactly the echoed one, and "no candidate" under force is a
 * mismatch too (force is moot: the caller should retry without it).
 */
export function bindDuplicateCandidateOverride(
  candidate: DuplicateVoucherCandidate | null,
  override: DuplicateCandidateOverride,
): DuplicateCandidateOutcome {
  if (override.force !== true) {
    return candidate ? { status: 'blocked', candidate } : { status: 'clear' }
  }
  const expected = override.expected_journal_entry_id ?? null
  if (!candidate || !expected || candidate.journal_entry_id !== expected) {
    return {
      status: 'mismatch',
      expected_journal_entry_id: expected,
      detected_journal_entry_id: candidate?.journal_entry_id ?? null,
    }
  }
  return { status: 'overridden', candidate }
}

/** The transaction columns the 1:1 detector needs. */
export interface TransactionForDuplicate {
  id: string
  date: string
  amount: number
  currency: string | null
  amount_sek?: number | null
  exchange_rate?: number | null
}

/**
 * Detect the 1:1 duplicate candidate for an inbound bank row and bind the
 * caller's override to it. A detection failure fails open without force; with
 * force it is a mismatch, because an override that cannot be re-verified must
 * not be honoured.
 */
export async function guardDuplicatePaymentVoucher(
  supabase: SupabaseClient,
  companyId: string,
  transaction: TransactionForDuplicate,
  override: DuplicateCandidateOverride,
  options: GuardOptions = {},
): Promise<DuplicateCandidateOutcome> {
  let candidate: DuplicateVoucherCandidate | null = null
  try {
    candidate = await detectDuplicatePaymentVoucher(supabase, {
      companyId,
      transactionId: transaction.id,
      transactionDate: transaction.date,
      transactionAmount: Number(transaction.amount),
      transactionCurrency: transaction.currency ?? null,
      transactionAmountSek: transaction.amount_sek ?? null,
      transactionExchangeRate: transaction.exchange_rate ?? null,
    })
  } catch (err) {
    options.onDetectError?.(err)
    if (override.force === true) {
      return {
        status: 'mismatch',
        expected_journal_entry_id: override.expected_journal_entry_id ?? null,
        detected_journal_entry_id: null,
      }
    }
  }
  return bindDuplicateCandidateOverride(candidate, override)
}

/** Same durable record for the 1:1 override; the singular payload shape categorize-core writes. */
export async function recordDuplicateCandidateOverride(
  companyId: string,
  transactionId: string,
  candidate: DuplicateVoucherCandidate,
  audit: OverrideAudit,
  onError?: (err: unknown) => void,
): Promise<void> {
  try {
    await appendProcessingHistory({
      companyId,
      correlationId: transactionId,
      aggregateType: 'BankTransaction',
      aggregateId: transactionId,
      eventType: 'BankTransactionDuplicateDismissed',
      payload: {
        transaction_id: transactionId,
        dismissed_journal_entry_id: candidate.journal_entry_id,
        dismissed_voucher_label: candidate.voucher_label,
        amount_ore: Math.round(candidate.amount * 100),
        entry_date: candidate.entry_date,
        amount_verified: candidate.amount_verified,
        unverified_reason: candidate.unverified_reason,
        via: audit.via,
      },
      actor: audit.actor,
      occurredAt: new Date(),
    })
  } catch (err) {
    onError?.(err)
  }
}
