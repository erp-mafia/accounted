/**
 * The amount a "Koppla till verifikat" link states, for LinkVoucherPicker
 * (customer and supplier invoices). Pure, so the rules are tested without a
 * DOM.
 *
 * A candidate's amount (`ar_credit_amount` / `ap_debit_amount`) is what the
 * verifikat has LEFT after the invoices already linked to it
 * (`already_linked`); `link_amount` is set when that is more than the invoice
 * needs, and is then the invoice's remainder (crm#1434). So the largest share
 * a link can state is `link_amount ?? left`: the smaller of the invoice's
 * remainder and what the verifikat has left. The person may lower it, never
 * raise it. The server is the authority and answers the same refusals with
 * structured codes (LINK_VOUCHER_AMOUNT_* / LINK_SI_VOUCHER_AMOUNT_*).
 */
import { parseAmountInput, roundOre } from '@/lib/money'

/** Below this two amounts are the same öre (the server's AMOUNT_TOLERANCE). */
const TOLERANCE = 0.005

export interface LinkableVoucher {
  journal_entry_id: string
  ar_credit_amount?: number
  ap_debit_amount?: number
  link_amount?: number
  already_linked?: number
  whole_remainder?: true
}

/** What the verifikat has left to settle. */
export function voucherLeft(c: LinkableVoucher): number {
  return c.ar_credit_amount ?? c.ap_debit_amount ?? 0
}

/** The verifikat's whole settlement side: what is left plus what other
 *  invoices already use. */
export function voucherTotal(c: LinkableVoucher): number {
  return roundOre(voucherLeft(c) + (c.already_linked ?? 0))
}

/** The proposed share: the invoice's remainder or what the verifikat has
 *  left, whichever is smaller. Also the largest share a link may state. */
export function defaultLinkAmount(c: LinkableVoucher): number {
  return c.link_amount ?? voucherLeft(c)
}

/** Whether the person may choose the amount. Not on the SEK-booked fallback:
 *  that link settles the invoice's whole remainder and refuses a share. */
export function canChooseAmount(c: LinkableVoucher): boolean {
  return c.whole_remainder !== true
}

export type LinkAmountCheck =
  | { ok: true; amount: number }
  | { ok: false; reason: 'invalid' | 'exceeds_invoice' | 'exceeds_voucher'; max: number }

/** Read the amount field against the candidate. */
export function checkLinkAmount(c: LinkableVoucher, text: string): LinkAmountCheck {
  const max = defaultLinkAmount(c)
  if (!canChooseAmount(c)) return { ok: true, amount: max }
  const amount = parseAmountInput(text)
  if (amount === null || !(amount > 0)) return { ok: false, reason: 'invalid', max }
  if (amount > voucherLeft(c) + TOLERANCE) return { ok: false, reason: 'exceeds_voucher', max: voucherLeft(c) }
  if (amount > max + TOLERANCE) return { ok: false, reason: 'exceeds_invoice', max }
  return { ok: true, amount }
}

/** Whether linking `amount` leaves part of the verifikat for other invoices. */
export function leavesPartOfVoucher(c: LinkableVoucher, amount: number): boolean {
  return voucherLeft(c) - amount > TOLERANCE
}

/**
 * The body of POST .../link-to-voucher. `amount` is sent only when the link
 * needs it: the verifikat has more left than the invoice needs, or the person
 * links less than all it has left. Otherwise the request reads as it always
 * did, which also keeps the SEK-booked fallback (that refuses a share) working.
 */
export function linkRequestBody(
  c: LinkableVoucher,
  amount: number,
): { journal_entry_id: string; amount?: number } {
  if (!canChooseAmount(c)) return { journal_entry_id: c.journal_entry_id }
  if (c.link_amount != null || leavesPartOfVoucher(c, amount)) {
    return { journal_entry_id: c.journal_entry_id, amount: roundOre(amount) }
  }
  return { journal_entry_id: c.journal_entry_id }
}
