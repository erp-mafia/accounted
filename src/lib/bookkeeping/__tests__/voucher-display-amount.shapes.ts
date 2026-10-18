/**
 * Voucher shapes for the verifikat list's Belopp (crm#1280), shared by the
 * helper's unit test and the pg test of its SQL mirror, the display_amount
 * computed column (migration 20261018135300) that the list's amount sort
 * orders by. Both must give `expected` for every shape, so the number on
 * screen and the sort order cannot drift apart. Add a shape here when the
 * rule in voucher-display-amount.ts changes.
 */
import type { VoucherDisplayAmount } from '../voucher-display-amount'

export type ShapeLine = [account: string, debit: number | string, credit: number | string]

export interface VoucherShape {
  name: string
  source_type: string
  lines: ShapeLine[]
  /** Cash-account ledgers outside 19xx the company keeps (cash_accounts.ledger_account). */
  extraMoneyAccounts?: string[]
  expected: VoucherDisplayAmount
}

/** A bank payment of an EU service, reverse charge at 25 %, gross method. */
const REVERSE_CHARGE_BANK_PAYMENT: ShapeLine[] = [
  ['2645', 50, 0],
  ['2614', 0, 50],
  ['4535', 200, 0],
  ['4598', 0, 200],
  ['6540', 200, 0],
  ['1930', 0, 200],
]

const PROVIDER_BALANCE_PAYMENT: ShapeLine[] = [
  ['2645', 50, 0],
  ['2614', 0, 50],
  ['6540', 200, 0],
  ['1686', 0, 200],
]

export const VOUCHER_SHAPES: VoucherShape[] = [
  {
    name: 'reverse-charge bank payment',
    source_type: 'bank_transaction',
    lines: REVERSE_CHARGE_BANK_PAYMENT,
    expected: { amount: 200, debitTotal: 450, basis: 'money' },
  },
  {
    name: 'storno of the reverse-charge bank payment',
    source_type: 'storno',
    lines: REVERSE_CHARGE_BANK_PAYMENT.map(([a, d, c]): ShapeLine => [a, c, d]),
    expected: { amount: 200, debitTotal: 450, basis: 'money' },
  },
  {
    name: 'plain sale paid to the bank',
    source_type: 'bank_transaction',
    lines: [
      ['1930', 1250, 0],
      ['3001', 0, 1000],
      ['2611', 0, 250],
    ],
    expected: { amount: 1250, debitTotal: 1250, basis: 'money' },
  },
  {
    name: 'salary payment (net pay left the bank)',
    source_type: 'salary_payment',
    lines: [
      ['7010', 30000, 0],
      ['7510', 9426, 0],
      ['2710', 0, 7000],
      ['2731', 0, 9426],
      ['1930', 0, 23000],
    ],
    expected: { amount: 23000, debitTotal: 39426, basis: 'money' },
  },
  {
    name: 'card payout (receivable on the opposite side)',
    source_type: 'bank_transaction',
    lines: [
      ['1930', 970, 0],
      ['6570', 30, 0],
      ['1580', 0, 1000],
    ],
    expected: { amount: 970, debitTotal: 1000, basis: 'money' },
  },
  {
    name: 'manual voucher without a money line',
    source_type: 'manual',
    lines: [
      ['2645', 50, 0],
      ['2614', 0, 50],
      ['6540', 200, 0],
      ['2440', 0, 200],
    ],
    expected: { amount: 250, debitTotal: 250, basis: 'total' },
  },
  {
    name: 'transfer between two 19xx accounts',
    source_type: 'bank_transaction',
    lines: [
      ['1940', 5000, 0],
      ['1930', 0, 5000],
    ],
    expected: { amount: 5000, debitTotal: 5000, basis: 'total' },
  },
  {
    name: 'sale split over two 19xx accounts',
    source_type: 'bank_transaction',
    lines: [
      ['1930', 600, 0],
      ['1910', 400, 0],
      ['3001', 0, 800],
      ['2611', 0, 200],
    ],
    expected: { amount: 1000, debitTotal: 1000, basis: 'total' },
  },
  {
    name: 'POS day: card receivable plus cash on the same side',
    source_type: 'manual',
    lines: [
      ['1580', 9000, 0],
      ['1910', 1000, 0],
      ['3001', 0, 8000],
      ['2611', 0, 2000],
    ],
    expected: { amount: 10000, debitTotal: 10000, basis: 'total' },
  },
  {
    name: 'ROT invoice paid partly by the customer, partly by Skatteverket',
    source_type: 'invoice_cash_payment',
    lines: [
      ['1513', 5000, 0],
      ['1930', 5000, 0],
      ['3001', 0, 8000],
      ['2611', 0, 2000],
    ],
    expected: { amount: 10000, debitTotal: 10000, basis: 'total' },
  },
  {
    name: 'payment drawn partly from the skattekonto',
    source_type: 'manual',
    lines: [
      ['2710', 7000, 0],
      ['2731', 9000, 0],
      ['1630', 0, 4000],
      ['1930', 0, 12000],
    ],
    expected: { amount: 16000, debitTotal: 16000, basis: 'total' },
  },
  {
    name: 'payment to the skattekonto (asset on the opposite side)',
    source_type: 'bank_transaction',
    lines: [
      ['1630', 16000, 0],
      ['1930', 0, 16000],
    ],
    expected: { amount: 16000, debitTotal: 16000, basis: 'money' },
  },
  {
    name: 'opening balance',
    source_type: 'opening_balance',
    lines: [
      ['1930', 40000, 0],
      ['1510', 10000, 0],
      ['2081', 0, 25000],
      ['2099', 0, 25000],
    ],
    expected: { amount: 50000, debitTotal: 50000, basis: 'total' },
  },
  {
    name: 'payment from a provider balance kept outside 19xx, not a cash account',
    source_type: 'bank_transaction',
    lines: PROVIDER_BALANCE_PAYMENT,
    expected: { amount: 250, debitTotal: 250, basis: 'total' },
  },
  {
    name: 'payment from a provider balance kept as a cash account',
    source_type: 'bank_transaction',
    lines: PROVIDER_BALANCE_PAYMENT,
    extraMoneyAccounts: ['1686'],
    expected: { amount: 200, debitTotal: 250, basis: 'money' },
  },
  {
    name: 'zero money line',
    source_type: 'correction',
    lines: [
      ['1930', 0, 0],
      ['2013', 300, 0],
      ['3305', 0, 300],
    ],
    expected: { amount: 300, debitTotal: 300, basis: 'total' },
  },
  {
    name: 'öre amounts as numeric strings',
    source_type: 'bank_transaction',
    lines: [
      ['2645', '0.1', '0'],
      ['2614', '0', '0.1'],
      ['6540', '0.2', '0'],
      ['1930', '0', '0.2'],
    ],
    expected: { amount: 0.2, debitTotal: 0.3, basis: 'money' },
  },
]
