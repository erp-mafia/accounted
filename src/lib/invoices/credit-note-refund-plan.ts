import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'

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
   * ledgerOwed: what paying owed back takes off 1510, which is owed and the
   * öresavrundning the credit note's own verifikat booked when the refund
   * pays the whole open credit back (planCreditNoteRefund's issueOre).
   */
  | { ok: true; owed: number; refunded: number; ledgerOwed: number }
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
 *
 * issueOre is the öresavrundning the credit note's own verifikat booked
 * (bookedOreRounding of its total against what that verifikat put on 1510,
 * 0 when it booked none): a credit of 999,75 issued as Cr 1510 1 000 / Dr
 * 3740 0,25 is 0,25. A refund of the whole open credit takes all of what 1510
 * carries for it (ledgerOwed 1 000, the credit note's "Att betala"); a part
 * refund takes its own kronor and leaves the öre for the last one.
 */
export function planCreditNoteRefund(
  creditNote: RefundPlanCreditNote,
  original: RefundPlanOriginal | null | undefined,
  creditUsed = 0,
  issueOre = 0,
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
  const wholeCredit = roundOre(owed + creditOpen) === 0
  const ledgerOwed = wholeCredit ? roundOre(owed + issueOre) : owed
  return { ok: true, owed, refunded, ledgerOwed }
}
