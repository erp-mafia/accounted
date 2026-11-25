/**
 * The amount a verifikat shows in an overview (the "Belopp" column of the
 * verifikat list), crm#1280.
 *
 * The voucher total (omslutning, the sum of the debit lines) counts every
 * technical line a voucher carries: the fiktiv moms pair of a reverse-charge
 * purchase (2645 debit / 2614 credit), the gross-method basis pair (4535 /
 * 4598), salary withholdings, a correction pair inside an imported voucher. A
 * 154 kr bank payment of an EU service then reads as 347 kr, which is the
 * number nobody recognises: the user looks a voucher up by the money that
 * moved, the amount on their bank statement.
 *
 * So when the voucher records one movement of money through one money
 * account, the overview shows that line's amount. Every other shape falls
 * back to the omslutning, which stays the right number for vouchers that move
 * no money (an invoice, a VAT settlement, a period-end entry):
 *
 *   - Money accounts are the BAS 19xx ledgers (kassa, plusgiro, bank) plus any
 *     ledger the company keeps a cash account on (e.g. a payment provider's
 *     balance on 1686), passed in as `extraMoneyAccounts`.
 *   - Exactly one line may sit on a money account. Two or more (a transfer
 *     between own accounts, a split payout) have no single money amount.
 *   - No other asset may share the money line's side (a card receivable, the
 *     skattekonto, a ROT/RUT receivable): that voucher settles one event
 *     through several channels (a POS day of card plus cash, a ROT invoice
 *     paid partly by the customer and partly by Skatteverket, a payment drawn
 *     partly from the skattekonto), so the bank part alone is not its amount.
 *   - An opening-balance voucher carries balances, not a movement, so its bank
 *     line is a balance and never the amount.
 *   - A zero money line falls back too.
 *
 * Display only: stored data, reports and SIE export are untouched. The list's
 * amount sorts order by public.verifikat_display_amounts (migration
 * 20261125130100), the one SQL mirror of this rule, so a change here must
 * change it too: the shapes in __tests__/voucher-display-amount.shapes.ts are
 * checked against both. `debitTotal` is returned so a caller can keep the
 * omslutning visible.
 */

import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { classifyAccountHeuristic } from '@/lib/bookkeeping/account-classifier-heuristic'
import { roundOre } from '@/lib/money'

export interface VoucherAmountLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

export interface VoucherAmountEntry {
  source_type?: string | null
  lines?: readonly VoucherAmountLine[] | null
}

export interface VoucherDisplayAmount {
  /** What the overview shows. */
  amount: number
  /** The omslutning: sum of the debit lines (equals the credit side). */
  debitTotal: number
  /** 'money' when `amount` is the single money line, 'total' when it is the omslutning. */
  basis: 'money' | 'total'
}

function num(v: number | string | null | undefined): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function voucherDisplayAmount(
  entry: VoucherAmountEntry,
  extraMoneyAccounts?: ReadonlySet<string>,
): VoucherDisplayAmount {
  const lines = entry.lines ?? []
  const debitTotal = roundOre(lines.reduce((sum, l) => sum + num(l.debit_amount), 0))
  const total: VoucherDisplayAmount = { amount: debitTotal, debitTotal, basis: 'total' }

  if (entry.source_type === 'opening_balance') return total

  const isMoney = (account: string) => isCashLedger(account) || !!extraMoneyAccounts?.has(account)
  const moneyLines = lines.filter((l) => isMoney(l.account_number))
  if (moneyLines.length !== 1) return total

  const money = moneyLines[0]
  const net = num(money.debit_amount) - num(money.credit_amount)
  const amount = roundOre(Math.abs(net))
  if (amount === 0) return total

  const moneyIsDebit = net > 0
  const splitSettlement = lines.some(
    (l) =>
      l !== money &&
      (moneyIsDebit ? num(l.debit_amount) > 0 : num(l.credit_amount) > 0) &&
      classifyAccountHeuristic(l.account_number).account_type === 'asset',
  )
  if (splitSettlement) return total

  return { amount, debitTotal, basis: 'money' }
}
