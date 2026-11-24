/**
 * Booking an incoming payment against its customer invoice without a person
 * (crm#2226), for a company that switched it on
 * (company_settings.auto_book_customer_payments, default off).
 *
 * The rule is the payer's own word. The bank row's reference field holds an
 * OCR-shaped number (digits only, at least MIN_REFERENCE_KEY_DIGITS of them,
 * and a distinctive key of the invoice: distinctiveReferenceKeys), and it
 * names exactly one open customer invoice (invoicesNamedByReference, the
 * reading the suggestion and the invoice PDF share), in the row's currency.
 * Then the match is booked through bookCustomerBankMatch, the function a
 * person's confirmation books with, so every refusal it has holds here too:
 * a row already booked, an invoice no longer open, a possible duplicate
 * verifikat, an excess of a krona or more (no account is named for it), a
 * partial payment of an unbooked invoice under kontantmetoden, a closed or
 * locked period. A payment below what is left books as a partial payment. A
 * match nobody confirmed is also refused when a verifikat it posts would
 * move a ruta of a momsdeklaration already filed. A refusal leaves the row
 * with the suggestion it gets today.
 *
 * A Bankgirot deposit whose split explains the whole row (splitIsComplete),
 * with every part naming its own invoice by the same rule, is booked as one
 * samlingsverifikat through matchTransactionBatch, once its dry run has
 * passed the same filed momsdeklaration check.
 *
 * Both book as the system actor, so the verifikat says Accounted booked it,
 * and reversing it opens the invoice and the bank row again (the reversal
 * hooks, lib/bookkeeping/payment-sync.ts). Inside a request made with a key
 * the key stays the actor, so its unattended ceiling still caps the booking:
 * bookCustomerBankMatch prices its payment, and the split prices every
 * verifikat of its dry run before the batch posts any.
 * A reference found only in the free text, an amount with a name, or any
 * other reading of the matcher stays a suggestion.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getActor, type CommitActor } from '@/lib/bookkeeping/actor-context'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { actorUnattendedCeiling, debitTotal, unattendedCeilingRefusal } from '@/lib/bookkeeping/unattended-ceiling'
import { createLogger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'
import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'
import type { DepositSplitBooking } from '@/lib/transactions/deposit-split-booking'
import type { PartSuggestion } from '@/lib/transactions/part-suggestions'
import { matchTransactionBatch, type MatchBatchInput } from '@/lib/transactions/match-batch'
import { amountToOre } from '@/lib/transactions/external-id'
import { filedPeriodVoucherWarning } from '@/lib/vat/voucher-filed-period-warning'
import type { BankTransactionPartInput, Transaction } from '@/types'
import { bookCustomerBankMatch, type BookCustomerBankMatchResult } from './book-customer-bank-match'
import { normalizeCurrencyCode } from './duplicate-guard-currency'
import { CONFIDENCE, type MatchableInvoice } from './invoice-matching'
import { distinctiveReferenceKeys, invoicesNamedByReference, MIN_REFERENCE_KEY_DIGITS } from './ocr-keys'

const log = createLogger('invoices/customer-payment-auto-book')

/** payment_match_log.match_method of a payment booked by this rule. */
export const AUTO_BOOK_MATCH_METHOD = 'auto_exact_reference'
/** link_evidence.rule_id of a payment booked by this rule. */
export const AUTO_BOOK_RULE_ID = 'customer_payment_exact_reference'
/** The label the system actor commits under. */
export const AUTO_BOOK_ACTOR_LABEL = 'Kundbetalning med OCR'

/** The credentials whose own ceiling and record a booking keeps. */
const KEY_ACTORS: ReadonlySet<CommitActor['type']> = new Set(['api_key', 'mcp_oauth', 'service_account'])

/**
 * The company's switch. A company without a settings row and a database the
 * migration has not reached yet read off, and so does any failed read: an
 * unreadable switch never books.
 */
export async function readCustomerPaymentAutoBook(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('auto_book_customer_payments')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) {
    if (!isMissingColumnError(error)) {
      log.warn('auto-book switch unreadable; payments stay suggestions', { companyId, error: error.message })
    }
    return false
  }
  return (data as { auto_book_customer_payments?: boolean | null } | null)?.auto_book_customer_payments === true
}

/**
 * The digits of a reference field that reads as an OCR number: digits with
 * at most spaces between them, at least MIN_REFERENCE_KEY_DIGITS long. A
 * field with words in it ("Faktura 1234", "Hyra 2026-11") is a message, not
 * an OCR number, and names nothing here.
 */
export function ocrShapedReference(reference: string | null | undefined): string | null {
  const trimmed = (reference ?? '').trim()
  if (!/^\d[\d ]*$/.test(trimmed)) return null
  const digits = trimmed.replace(/ /g, '')
  return digits.length >= MIN_REFERENCE_KEY_DIGITS ? digits : null
}

/**
 * The one open invoice an OCR-shaped reference names in `currency`, or
 * null: no such reference, no invoice or several named, a key not
 * distinctive enough to trust on its own, or another currency.
 */
export function invoiceNamedExactly(
  reference: string | null | undefined,
  currency: string | null | undefined,
  invoices: readonly MatchableInvoice[],
): MatchableInvoice | null {
  const digits = ocrShapedReference(reference)
  if (!digits) return null
  const named = invoicesNamedByReference(invoices, digits)
  if (named.length !== 1) return null
  const invoice = named[0]!
  if (!distinctiveReferenceKeys(invoice.invoice_number).includes(digits)) return null
  if (normalizeCurrencyCode(invoice.currency) !== normalizeCurrencyCode(currency)) return null
  return invoice
}

/** Run `fn` as the system actor, unless a key is the actor: then its ceiling and record stand. */
function asAutoBooker<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const outer = getActor()
  if (outer && KEY_ACTORS.has(outer.type)) return fn()
  return runWithActor({ type: 'system', label: AUTO_BOOK_ACTOR_LABEL, userId }, fn)
}

/**
 * Book `tx` against `invoice` as a match nobody confirmed. Returns the
 * booking's own outcome; a refusal books nothing and the caller keeps the
 * suggestion.
 */
export async function autoBookCustomerPayment(
  ctx: OperationContext,
  tx: Pick<Transaction, 'id'>,
  invoice: Pick<MatchableInvoice, 'id'>,
): Promise<BookCustomerBankMatchResult> {
  return asAutoBooker(ctx.userId, () =>
    bookCustomerBankMatch(ctx, {
      transactionId: tx.id,
      invoiceId: invoice.id,
      overrideVia: 'auto_exact_reference',
      unattended: {
        match: { method: AUTO_BOOK_MATCH_METHOD, confidence: CONFIDENCE.OCR_REFERENCE_MATCH },
        linkBasis: {
          basis: 'rule_ocr_reference',
          evidence: { rule_id: AUTO_BOOK_RULE_ID, score: CONFIDENCE.OCR_REFERENCE_MATCH },
        },
      },
    }),
  )
}

/** One customer invoice a part of a deposit pays, as matchTransactionBatch takes it. */
export interface SplitAllocation {
  invoice_id: string
  amount: number
}

/**
 * The allocations of a complete Bankgirot deposit split when every part
 * names its invoice exactly (invoiceNamedExactly on the part's reference)
 * and that invoice is the one the split suggested for it, each invoice once,
 * no part above what is left on its invoice; else null. The caller has
 * already found the split complete (splitIsComplete: two or more parts,
 * summing to the row).
 */
export function exactReferenceSplitAllocations(
  parts: readonly BankTransactionPartInput[],
  suggestions: readonly PartSuggestion[],
  invoices: readonly MatchableInvoice[],
): SplitAllocation[] | null {
  if (parts.length < 2 || suggestions.length !== parts.length) return null
  const seen = new Set<string>()
  const allocations: SplitAllocation[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const suggestion = suggestions[i]!
    if (suggestion.suggestion_reason !== 'ocr_exact' || !suggestion.suggested_invoice_id) return null
    const amount = Math.abs(part.amount)
    if (!(amount > 0)) return null
    const invoice = invoiceNamedExactly(part.reference, part.currency, invoices)
    if (!invoice || invoice.id !== suggestion.suggested_invoice_id || seen.has(invoice.id)) return null
    const remaining = Number(invoice.remaining_amount ?? invoice.total ?? 0)
    if (amountToOre(amount) > amountToOre(remaining)) return null
    seen.add(invoice.id)
    allocations.push({ invoice_id: invoice.id, amount })
  }
  return allocations
}

type BatchPreviewLine = { account_number: string; debit: number; credit: number }
type SaleEntryPreview = { journal_entry?: { entry_date?: string; lines?: Array<{ account_number: string; debit_amount: number; credit_amount: number }> } }

export type SplitAutoBookResult =
  | { ok: true; journalEntryId: string }
  | { ok: false; code: string; details?: Record<string, unknown> }

/**
 * Book a deposit's split as one samlingsverifikat nobody confirmed: the
 * batch match's dry run first, refused when its verifikat or a sale it books
 * first would move a ruta of a filed momsdeklaration, then the batch match
 * itself as the system actor.
 */
export async function autoBookSplitDeposit(
  ctx: OperationContext,
  tx: Pick<Transaction, 'id'>,
  allocations: readonly SplitAllocation[],
): Promise<SplitAutoBookResult> {
  const input = {
    allocations: allocations.map((a) => ({ kind: 'customer_invoice' as const, invoice_id: a.invoice_id, amount: a.amount })),
  } as MatchBatchInput
  return asAutoBooker(ctx.userId, async () => {
    const dry = await matchTransactionBatch(ctx, tx.id, input, { dryRun: true })
    if (!dry.ok) return { ok: false, code: dry.code, details: dry.details }
    if (!dry.dryRun) return { ok: false, code: 'AUTO_BOOK_DRY_RUN_MISSING' }
    const preview = dry.preview as {
      expected_entry_date?: string
      expected_lines?: BatchPreviewLine[]
      sale_entries?: SaleEntryPreview[]
    }
    const postings: Array<{ entry_date: string; lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }> }> = []
    if (preview.expected_entry_date && preview.expected_lines) {
      postings.push({
        entry_date: preview.expected_entry_date,
        lines: preview.expected_lines.map((l) => ({ account_number: l.account_number, debit_amount: l.debit, credit_amount: l.credit })),
      })
    }
    for (const sale of preview.sale_entries ?? []) {
      const entry = sale.journal_entry
      if (entry?.entry_date && entry.lines) postings.push({ entry_date: entry.entry_date, lines: entry.lines })
    }
    if (postings.length === 0) return { ok: false, code: 'AUTO_BOOK_DRY_RUN_MISSING' }
    // A key's unattended ceiling, on every verifikat the batch posts, before
    // the first: the batch RPC drafts and commits inside one database call,
    // which a key otherwise reaches only through a priced operation
    // (unattended-ceiling.ts).
    if (actorUnattendedCeiling() !== null) {
      for (const posting of postings) {
        const overCeiling = unattendedCeilingRefusal(debitTotal(posting.lines))
        if (overCeiling) {
          return { ok: false, code: overCeiling.code, details: { attempted: overCeiling.attempted, limit: overCeiling.limit } }
        }
      }
    }
    for (const posting of postings) {
      try {
        const filed = await filedPeriodVoucherWarning(ctx.supabase, ctx.companyId, posting, 'bank_row')
        if (filed) return { ok: false, code: 'MATCH_INVOICE_UNATTENDED_FILED_VAT_PERIOD', details: filed.details }
      } catch {
        return { ok: false, code: 'MATCH_INVOICE_UNATTENDED_FILED_VAT_PERIOD', details: { entry_date: posting.entry_date, check_failed: true } }
      }
    }
    const booked = await matchTransactionBatch(ctx, tx.id, input, { via: 'auto_exact_reference' })
    if (!booked.ok) return { ok: false, code: booked.code, details: booked.details }
    if (booked.dryRun) return { ok: false, code: 'AUTO_BOOK_DRY_RUN_MISSING' }
    return { ok: true, journalEntryId: booked.data.journal_entry_id }
  })
}

/** The invoice blocks' answer to ingest's deposit split question (lib/transactions/deposit-split-booking.ts). */
export const depositSplitBooking: DepositSplitBooking = Object.freeze<DepositSplitBooking>({
  isOn: (supabase, companyId) => readCustomerPaymentAutoBook(supabase, companyId),
  allocations: (parts, suggestions, invoices) => exactReferenceSplitAllocations(parts, suggestions, invoices),
  book: (ctx, transactionId, allocations) => autoBookSplitDeposit(ctx, { id: transactionId }, allocations),
})
