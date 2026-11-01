/**
 * Behandlingshistorik for a deliberately bypassed payment guard.
 *
 * The duplicate-payment guard warns before a payment is booked and the caller
 * can override it (dashboard dialog and v1 `force: true`, MCP
 * `allow_duplicate`). Until this helper the override existed only as a server
 * log line, so the books carried no trace that the user was warned and booked
 * anyway: BFNAR 2013:2 p. 9.16 wants the processing history to show exactly
 * that, and behandlingshistorik is reported out of `audit_log` (DECISIONS
 * 2026-08-21), not out of `processing_history`. So the record goes to
 * audit_log, which is immutable, company-scoped and already the archive's
 * revision/behandlingshistorik.json. One record on both sides of the ledger,
 * on every door: the settlement writes it, not the door.
 *
 * The detector is re-run on the bypass path (it is skipped when force is set)
 * so the record can NAME the bank row or voucher that was bypassed rather than
 * just assert that something was. An empty result is still recorded: "the
 * guard found nothing at that moment" is itself the fact an auditor needs.
 *
 * Nothing here is allowed to break a payment that is already posted: every
 * failure is logged and swallowed. The function never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditLogEntry } from '@/types'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import {
  findDuplicatePaymentCandidatesForInvoice,
  findDuplicatePaymentCandidatesForSupplierInvoice,
  type DuplicatePaymentCandidate,
} from '@/lib/invoices/duplicate-payment-candidates'

const log = createLogger('invoices/duplicate-guard-history')

/** `audit_log.action` for "a guard warned, the user booked anyway" (migration 20260914150102). */
export const GUARD_BYPASSED_ACTION = 'GUARD_BYPASSED' as const

/**
 * `new_state.guard` discriminator. The behandlingshistorik renderer maps it to
 * the Swedish event label, so the string is a stable contract, not a message.
 */
export const SUPPLIER_INVOICE_DUPLICATE_PAYMENT_GUARD = 'supplier_invoice_duplicate_payment' as const
export const INVOICE_DUPLICATE_PAYMENT_GUARD = 'invoice_duplicate_payment' as const

/** Who overrode the guard, in the vocabulary of the audit_log actor columns. */
export interface DuplicateGuardBypassActor {
  /** Supabase auth user the override is attributed to. */
  user_id: string | null
  /** API key id when the call came through a machine surface. */
  actor_id?: string | null
  actor_type?: NonNullable<AuditLogEntry['actor_type']>
  /** Human label for a non-user actor, e.g. the API key name. */
  actor_label?: string | null
}

/** What both sides record: the payment, the voucher and who overrode. */
interface GuardBypassPayment {
  companyId: string
  /** The payment being booked, denominated in the invoice's currency. */
  paymentAmount: number
  paymentDate: string
  /**
   * BAS account the caller named for the payment, or null when it named none
   * or supplied custom lines. Null never guesses: the voucher named by
   * `journalEntryId` is the authority on what was credited.
   */
  paymentAccount?: string | null
  /** The posted payment voucher the override produced. */
  journalEntryId: string
  actor: DuplicateGuardBypassActor
}

export interface SupplierInvoiceGuardBypassInput extends GuardBypassPayment {
  /**
   * The same fields the detector reads, plus the invoice id. Shaped like the
   * detector's own input so the two cannot drift: a payment that was banded in
   * one currency must be re-detected in that currency.
   */
  invoice: {
    id: string
    supplier_invoice_number: string | null
    payment_reference?: string | null
    supplier_name: string | null | undefined
    currency: string | null
    total: number | null
    total_sek: number | null
    exchange_rate: number | null
  }
}

export interface InvoiceGuardBypassInput extends GuardBypassPayment {
  /** As SupplierInvoiceGuardBypassInput: the detector's fields plus the id. */
  invoice: {
    id: string
    invoice_number: string | null
    customer_name: string | null | undefined
    currency: string | null
    total: number | null
    total_sek: number | null
    exchange_rate: number | null
  }
}

/** The candidate fields worth keeping in the statutory record. */
interface RecordedCandidate {
  transaction_id: string
  date: string
  amount: number
  match_reason: DuplicatePaymentCandidate['match_reason']
  match_confidence: number
  /** Set iff `match_reason` is `already_booked`: the verifikat the bank row already carries. */
  journal_entry_id: string | null
}

/**
 * Re-run the detector and append the audit row. An unevaluated candidate set
 * is not a clean "no duplicate": the override is recorded anyway and says the
 * check could not be re-run.
 */
async function recordGuardBypass(
  input: GuardBypassPayment & { invoice: { id: string; currency: string | null } },
  side: {
    guard: string
    tableName: 'invoices' | 'supplier_invoices'
    numberField: 'invoice_number' | 'supplier_invoice_number'
    idField: 'invoice_id' | 'supplier_invoice_id'
    number: string | null
    label: string
  },
  detect: () => Promise<DuplicatePaymentCandidate[]>,
): Promise<void> {
  const { companyId, invoice, paymentAmount, paymentDate, journalEntryId } = input
  const logContext = { companyId, [side.idField]: invoice.id }

  let candidates: DuplicatePaymentCandidate[] = []
  let detectorFailed = false
  try {
    candidates = await detect()
  } catch (err) {
    detectorFailed = true
    log.warn('duplicate-guard bypass: detector re-run failed, recording without candidates', {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const recorded: RecordedCandidate[] = candidates.map((candidate) => ({
    transaction_id: candidate.id,
    date: candidate.date,
    amount: candidate.amount,
    match_reason: candidate.match_reason,
    match_confidence: candidate.match_confidence,
    journal_entry_id: candidate.journal_entry_id ?? null,
  }))

  const description = detectorFailed
    ? `Duplicate-payment guard bypassed with force on ${side.label} ${side.number ?? invoice.id}: detector could not be re-run`
    : `Duplicate-payment guard bypassed with force on ${side.label} ${side.number ?? invoice.id}: ${recorded.length} candidate transaction(s) at booking time`

  try {
    const { error } = await createServiceClient()
      .from('audit_log')
      .insert({
        user_id: input.actor.user_id,
        company_id: companyId,
        action: GUARD_BYPASSED_ACTION,
        table_name: side.tableName,
        record_id: invoice.id,
        actor_id: input.actor.actor_id ?? null,
        actor_type: input.actor.actor_type ?? 'user',
        actor_label: input.actor.actor_label ?? null,
        old_state: null,
        new_state: {
          guard: side.guard,
          reason: 'force',
          [side.idField]: invoice.id,
          [side.numberField]: side.number,
          payment_amount: roundOre(paymentAmount),
          payment_currency: invoice.currency ?? 'SEK',
          payment_date: paymentDate,
          payment_account: input.paymentAccount ?? null,
          journal_entry_id: journalEntryId,
          detector_failed: detectorFailed,
          candidate_count: recorded.length,
          candidates: recorded,
        },
        description,
      })
    if (error) {
      // error, not warn: warn is suppressed in the prod noise filters and never
      // reaches the observability sink, and a dropped row here is a statutory
      // gap (the override happened and left no durable trace).
      log.error(
        'audit_log insert failed for duplicate-guard bypass',
        new Error(error.message ?? 'audit_log insert failed'),
        { ...logContext, journalEntryId, code: error.code },
      )
    }
  } catch (err) {
    log.error('audit_log insert threw for duplicate-guard bypass', err as Error, { ...logContext, journalEntryId })
  }
}

/**
 * Record that the supplier-invoice duplicate-payment guard was bypassed with
 * force, together with what it would have flagged at that moment.
 *
 * @param supabase the caller's client, used ONLY to re-run the detector (a
 *   company-scoped read). The audit row itself is written with the service
 *   role: audit_log has no INSERT policy, so a session client cannot write it.
 */
export async function recordSupplierInvoiceDuplicateGuardBypass(
  supabase: SupabaseClient,
  input: SupplierInvoiceGuardBypassInput,
): Promise<void> {
  const { companyId, invoice, paymentAmount, paymentDate } = input
  await recordGuardBypass(
    input,
    {
      guard: SUPPLIER_INVOICE_DUPLICATE_PAYMENT_GUARD,
      tableName: 'supplier_invoices',
      numberField: 'supplier_invoice_number',
      idField: 'supplier_invoice_id',
      number: invoice.supplier_invoice_number,
      label: 'supplier invoice',
    },
    () =>
      findDuplicatePaymentCandidatesForSupplierInvoice(supabase, {
        companyId,
        invoice: {
          supplier_invoice_number: invoice.supplier_invoice_number,
          payment_reference: invoice.payment_reference ?? null,
          supplier_name: invoice.supplier_name,
          currency: invoice.currency,
          total: invoice.total,
          total_sek: invoice.total_sek,
          exchange_rate: invoice.exchange_rate,
        },
        paymentAmount,
        paymentDate,
      }),
  )
}

/** The customer side's record: recordSupplierInvoiceDuplicateGuardBypass's twin. */
export async function recordInvoiceDuplicateGuardBypass(
  supabase: SupabaseClient,
  input: InvoiceGuardBypassInput,
): Promise<void> {
  const { companyId, invoice, paymentAmount, paymentDate } = input
  await recordGuardBypass(
    input,
    {
      guard: INVOICE_DUPLICATE_PAYMENT_GUARD,
      tableName: 'invoices',
      numberField: 'invoice_number',
      idField: 'invoice_id',
      number: invoice.invoice_number,
      label: 'invoice',
    },
    () =>
      findDuplicatePaymentCandidatesForInvoice(supabase, {
        companyId,
        invoice: {
          invoice_number: invoice.invoice_number,
          customer_name: invoice.customer_name,
          currency: invoice.currency,
          total: invoice.total,
          total_sek: invoice.total_sek,
          exchange_rate: invoice.exchange_rate,
        },
        paymentAmount,
        paymentDate,
      }),
  )
}
