import type { Transaction } from '@/types'

/** Skatteverket's bankgiro for the skattekonto, digits only. */
const SKATTEKONTO_BANKGIRO_DIGITS = '50501055'

const SKATTEVERKET_NAME = /(^|[^\p{L}])skatteverket([^\p{L}]|$)/iu

/** "SKV: Bg-bet. via internet": the bank's short name for Skatteverket, first on the line. */
const SKV_PREFIX = /^\s*skv(\s|:|$)/i

/** "BG 5050-1055", "BG 0000050501055": the bank pads the bankgiro with zeros. */
const SKATTEKONTO_BANKGIRO = /\b(?:bg|bankgiro)\s*0*5050-?1055\b/i

/**
 * Whether a bank line pays Skatteverket: money out, named Skatteverket ("SKATTEVERKET",
 * "SKV:") or sent to the skattekonto's bankgiro 5050-1055 (the number every
 * skattekonto payment goes to, see api/payments/orders/skattekonto).
 *
 * Such a payment moves money to the company's skattekonto and nothing else: it
 * is not earmarked for a tax (SFL 62 kap. 11 §), so the bank line is booked
 * against the skattekonto account and the liabilities it pays (2510, 2650,
 * 2710, 2731) are cleared from the skattekontoutdrag. It never carries moms.
 * See the swedish-daily-bookkeeping skill, references/skattekonto-and-owner.md
 * §1.1 ("the bank line only ever touches 1630").
 *
 * Money in from Skatteverket is left out on purpose: a ROT/RUT payout lands in
 * the bank and settles a receivable or, under kontantmetoden, a sale.
 */
export function isSkatteverketPayment(
  tx: Pick<Transaction, 'amount' | 'merchant_name' | 'original_description' | 'description'> &
    Partial<Pick<Transaction, 'counterparty_account'>>,
): boolean {
  if (!(Number(tx.amount) < 0)) return false
  const texts = [tx.merchant_name, tx.original_description, tx.description].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  )
  if (texts.some((s) => SKATTEVERKET_NAME.test(s) || SKV_PREFIX.test(s) || SKATTEKONTO_BANKGIRO.test(s))) {
    return true
  }
  return (tx.counterparty_account ?? '').replace(/\D/g, '').replace(/^0+/, '') === SKATTEKONTO_BANKGIRO_DIGITS
}
