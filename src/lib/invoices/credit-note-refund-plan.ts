import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { bookedOreRounding } from '@/lib/bookkeeping/ore-rounding'
import { ORE_ROUNDING_ACCOUNT, ORE_TOLERANCE, roundOre } from '@/lib/money'

/**
 * What a customer has tillgodo on a kreditfaktura, and whether its refund can
 * be recorded (follow-up of crm#1435). Pure and browser-safe: the credit note
 * page shows "Registrera återbetalning" by the same rule the doors refuse by.
 *
 * A credit note's verifikat credits 1510 for the whole credit (Cr 1510, Dr
 * 30xx/26xx, ML 2023:200 17 kap 22-23 §§), in both accounting methods once
 * the original reached the ledger (creditNoteNeedsJournalEntry). When the
 * original was paid, that credit is money owed back to the customer: 1510
 * stands negative and the kundreskontra lists the credit note as a negative
 * open item until the refund (Dr 1510 / Cr the bank account) clears it.
 *
 * The refund is recorded on the credit note itself, the way a payment is
 * recorded on an invoice: an invoice_payments row (negative, like the credit
 * note's own total) and paid_amount moved by the same amount, so every
 * reskontra reader (total - paid_amount, or the payment rows as of a date)
 * nets the credit note to zero exactly when 1510 does. Its status stays
 * 'sent': invoices_credit_note_not_paid keeps credit notes out of the
 * payment states that ROT/RUT payouts, invoice.paid and the paid stamp read.
 */

/** What the plan reads off the credit note. */
export interface RefundPlanCreditNote {
  status: string
  total: number | string
  paid_amount?: number | string | null
  currency?: string | null
  journal_entry_id?: string | null
  deduction_total?: number | string | null
}

/** What the plan reads off the invoice the credit note credits. */
export interface RefundPlanOriginal {
  total: number | string
  paid_amount?: number | string | null
}

/**
 * Why this door cannot record the refund (the refund is then booked as a
 * verifikat of its own, Dr 1510 / Cr the bank account):
 * - not_issued: a draft or cancelled credit note credited nothing.
 * - not_booked: the credit note has no verifikat, so 1510 holds no credit to
 *   clear (kontantmetoden with an unpaid original, or an older credit note
 *   whose reversal is missing: complete its bookkeeping first).
 * - foreign_currency: the refund would carry an exchange difference against
 *   the credit's booked kronor; not handled here.
 * - rot_rut: part of the credit belongs to Skatteverket (1513), not to the
 *   customer.
 * - no_original: the credited invoice could not be read.
 */
export type CreditNoteRefundUnsupportedReason =
  | 'not_issued'
  | 'not_booked'
  | 'foreign_currency'
  | 'rot_rut'
  | 'no_original'

export type CreditNoteRefundPlan =
  /**
   * owed: kronor still to pay back; refunded: what earlier refunds recorded;
   * settlesCredit: paying owed back settles the credit note's whole open
   * credit (the original is settled), so the refund is the last one.
   */
  | { ok: true; owed: number; refunded: number; settlesCredit: boolean }
  | {
      ok: false
      code: 'CREDIT_NOTE_REFUND_UNSUPPORTED'
      details: { reason: CreditNoteRefundUnsupportedReason }
    }
  | {
      ok: false
      code: 'CREDIT_NOTE_REFUND_NOTHING_OWED'
      details: { refunded: number; credit_used: number }
    }

/** The statuses an issued credit note rests in. */
export const REFUNDABLE_CREDIT_NOTE_STATUSES = ['sent', 'overdue'] as const

const num = (value: number | string | null | undefined): number => Number(value ?? 0) || 0

/**
 * What was paid back on a credit note, in kronor. Only the refund door pays
 * one back and it takes linked notes only: the paid_amount of a note imported
 * without a link is the provider's netting, no refund anyone made.
 */
export function creditNoteRefundedAmount(
  creditNote: { credited_invoice_id?: string | null; paid_amount?: number | null },
): number {
  return creditNote.credited_invoice_id ? roundOre(-(Number(creditNote.paid_amount) || 0)) : 0
}

/**
 * The refund still owed on a credit note.
 *
 * Both documents are read the reskontra's way, outstanding = total -
 * paid_amount: the original's open remainder and the credit note's open
 * credit (negative) net to what the customer has tillgodo from this pair.
 * The credit an earlier set-off used (the credit note's verifikat linked as a
 * payment of another invoice, credit-note-settlement.ts) is no longer the
 * customer's. A refund never exceeds the credit note's own open credit.
 *
 *   original 10 000 paid in full, credited:    owed 10 000
 *   original 10 000 paid 7 000, credited:      owed  7 000
 *   original unpaid, credited:                 owed      0
 */
export function planCreditNoteRefund(
  creditNote: RefundPlanCreditNote,
  original: RefundPlanOriginal | null | undefined,
  creditUsed = 0,
): CreditNoteRefundPlan {
  const unsupported = (reason: CreditNoteRefundUnsupportedReason): CreditNoteRefundPlan => ({
    ok: false,
    code: 'CREDIT_NOTE_REFUND_UNSUPPORTED',
    details: { reason },
  })
  if (!(REFUNDABLE_CREDIT_NOTE_STATUSES as readonly string[]).includes(creditNote.status)) {
    return unsupported('not_issued')
  }
  if (!creditNote.journal_entry_id) return unsupported('not_booked')
  if (!isLedgerCurrency(creditNote.currency)) return unsupported('foreign_currency')
  if (num(creditNote.deduction_total) > 0) return unsupported('rot_rut')
  if (!original) return unsupported('no_original')

  // + 0 turns a -0 (nothing refunded) into 0.
  const refunded = roundOre(-num(creditNote.paid_amount)) + 0
  const creditOpen = roundOre(num(creditNote.total) - num(creditNote.paid_amount) + creditUsed)
  const originalOpen = roundOre(num(original.total) - num(original.paid_amount))
  const owed = roundOre(Math.min(-creditOpen, -(originalOpen + creditOpen)))
  if (!(owed > 0.005)) {
    return { ok: false, code: 'CREDIT_NOTE_REFUND_NOTHING_OWED', details: { refunded, credit_used: creditUsed } }
  }
  return { ok: true, owed, refunded, settlesCredit: roundOre(owed + creditOpen) === 0 }
}

/** The receivable the credit note's verifikat credits and the refund debits: 1510. */
export const RECEIVABLE_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable')

/** A line of the credit note's own verifikat. */
export interface CreditNoteVoucherLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

/**
 * The öresavrundning a kreditfaktura's own verifikat booked: its total
 * against what that verifikat credited 1510, when the gap is inside the öre
 * band (bookedOreRounding) and is exactly what the same verifikat booked on
 * 3740. A credit of 999,75 issued as Cr 1510 1 000 / Dr 3740 0,25 (the
 * mirror of an original whose issue verifikat booked its rounding, the way
 * Fortnox books it) is 0,25; one issued as Cr 1510 1 000 / Cr 3740 0,25 on a
 * credit of 1 000,25 is -0,25. 0 when the verifikat booked no öre, or when
 * 1510 and 3740 disagree: then the refund pays back the credit note's own
 * figure, as it always did.
 */
export function creditNoteBookedOre(
  total: number | string | null | undefined,
  lines: readonly CreditNoteVoucherLine[],
): number {
  let receivable = 0
  let ore = 0
  for (const line of lines) {
    const net = num(line.debit_amount) - num(line.credit_amount)
    if (line.account_number === RECEIVABLE_ACCOUNT) receivable += net
    else if (line.account_number === ORE_ROUNDING_ACCOUNT) ore += net
  }
  const booked = bookedOreRounding(roundOre(num(total)), roundOre(receivable))
  return booked !== 0 && booked === roundOre(ore) ? booked : 0
}

/**
 * What the refund takes off 1510 when it pays `plan.owed` back.
 *
 * The kundreskontra reads the credit note at its total, but when the credit
 * note's own verifikat booked its öresavrundning (creditNoteBookedOre), 1510
 * was credited the rounded figure: Cr 1510 1 000 for a credit of 999,75,
 * which is also what the customer paid for the original. The refund that
 * settles the whole open credit pays that figure back, so nothing is left on
 * 1510 and the öre on 3740 stands as the credit note booked it. A part refund
 * pays its own kronor and leaves the öre for the last one.
 *
 *   credit 999,75 booked Cr 1510 1 000 / Dr 3740 0,25, original paid:  1 000
 *   the same after a part refund of 400:                                  600
 *   a credit note that booked no öre:                                  owed
 *
 * Never below zero: when earlier refunds already took all of what 1510
 * carries, nothing more is paid out.
 */
export function refundLedgerAmount(
  plan: { owed: number; settlesCredit: boolean },
  bookedOre: number,
): number {
  if (!plan.settlesCredit || bookedOre === 0) return plan.owed
  const amount = roundOre(plan.owed + bookedOre)
  return amount > ORE_TOLERANCE ? amount : 0
}
