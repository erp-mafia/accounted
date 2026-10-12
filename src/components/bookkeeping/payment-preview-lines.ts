/**
 * The "Bokföring" rows of a payment verifikat that a dialog previews and lets
 * the user edit before booking: the bank-match dialog (InvoiceMatchDialog)
 * and the supplier invoice's payment dialog (SupplierPaymentDialog). Both
 * render them through PaymentPreviewLinesCard; this module is the pure part
 * (the working copy, its validation and the request lines), so the rule is
 * stated and tested once.
 *
 * A working row is one positive amount with a side (debit or credit): that
 * matches how a verifikationsrad is read and cannot hold both sides at once.
 * It converts back to the server's { debit_amount, credit_amount } shape only
 * at submit. Dimension bags follow payment-line-dimensions: a proposed row
 * keeps its bag through every edit, an added row starts with the settled
 * document's bag, and what the grid holds is what gets booked.
 */
import { parseAmountInput, roundOre } from '@/lib/money'
import { withLineDimensions, type LineDimensions } from './payment-line-dimensions'

/** A row as the preview route returns it; amounts are SEK. */
export interface PaymentPreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
  /** The bag the booking gives this line; absent when untagged. */
  dimensions?: LineDimensions
}

/** The string-typed working copy of a row while the user edits it. */
export interface EditablePaymentLine {
  account_number: string
  side: 'debit' | 'credit'
  amount: string
  description: string
  /** Kept through every edit of the row and sent with it. */
  dimensions?: LineDimensions
}

/** A row as the booking routes take it (`lines` on mark-paid and the match routes). */
export interface PaymentLinePayload {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
  dimensions?: LineDimensions
}

export interface PaymentLinesValidation {
  isBalanced: boolean
  accountInvalid: boolean
  isValid: boolean
  /** Debit minus credit. */
  diff: number
  totalDebit: number
  totalCredit: number
}

/** What a dialog that is not editing reports: nothing to block on. */
export const UNEDITED_VALIDATION: PaymentLinesValidation = {
  isBalanced: true,
  accountInvalid: false,
  isValid: true,
  diff: 0,
  totalDebit: 0,
  totalCredit: 0,
}

export function previewToEditable(line: PaymentPreviewLine): EditablePaymentLine {
  const isDebit = line.debit_amount > 0
  return {
    account_number: line.account_number,
    side: isDebit ? 'debit' : 'credit',
    amount: String(isDebit ? line.debit_amount : line.credit_amount),
    description: line.description,
    ...withLineDimensions(line.dimensions),
  }
}

/** A row the user adds: empty, on the debit side, with the settled document's bag. */
export function blankEditableLine(documentDimensions?: LineDimensions | null): EditablePaymentLine {
  return {
    account_number: '',
    side: 'debit',
    amount: '',
    description: '',
    ...withLineDimensions(documentDimensions),
  }
}

/** An amount field as a number; what does not parse counts as 0, as it books nothing. */
function amountOf(line: EditablePaymentLine): number {
  return parseAmountInput(line.amount) ?? 0
}

/**
 * Debit equals credit and both are above zero, and every row has a
 * four-digit account. A dialog keeps its confirm disabled until this holds.
 */
export function validateEditableLines(lines: readonly EditablePaymentLine[]): PaymentLinesValidation {
  const sum = (side: EditablePaymentLine['side']) =>
    roundOre(lines.filter((l) => l.side === side).reduce((s, l) => s + amountOf(l), 0))
  const totalDebit = sum('debit')
  const totalCredit = sum('credit')
  const isBalanced = totalDebit === totalCredit && totalDebit > 0
  const accountInvalid = lines.some((l) => !/^\d{4}$/.test(l.account_number.trim()))
  return {
    isBalanced,
    accountInvalid,
    isValid: isBalanced && !accountInvalid,
    diff: roundOre(totalDebit - totalCredit),
    totalDebit,
    totalCredit,
  }
}

/** The request rows for what the grid holds, each row's bag included. */
export function toLinePayload(lines: readonly EditablePaymentLine[]): PaymentLinePayload[] {
  return lines.map((l) => {
    const amount = roundOre(amountOf(l))
    return {
      account_number: l.account_number.trim(),
      debit_amount: l.side === 'debit' ? amount : 0,
      credit_amount: l.side === 'credit' ? amount : 0,
      line_description: l.description?.trim() || undefined,
      ...withLineDimensions(l.dimensions),
    }
  })
}
