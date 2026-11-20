// How the generic approval preview writes a staged operation's plain fields
// (GenericPreview in OperationPreview.tsx). preview_data keys are the staging
// tools' own field names, so the card shows a field only under a label the
// approver can read, and a number the way an approver reads money: never
// "total amount 192264" (crm#1104).

import { formatAmount, formatCurrency } from '@/lib/utils'

// A field is money when one of its snake_case words says so: amount,
// total_amount, invoice_remaining, price_excl_vat, monthly_salary. Counts,
// rates, days and numbers stay plain numbers.
const MONEY_WORDS = new Set([
  'amount',
  'total',
  'subtotal',
  'remaining',
  'price',
  'salary',
  'fee',
  'balance',
  'sum',
  'belopp',
  'aktiekapital',
])

export function isMoneyField(key: string): boolean {
  return key.split('_').some((word) => MONEY_WORDS.has(word))
}

function currencyCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null
}

/**
 * The currency a money field is stated in: its own (`transaction_amount` →
 * `transaction_currency`), else the preview's `currency`, else SEK when the
 * preview names no currency at all (the ledger's currency). null when only
 * some other field's currency is named: which one applies is unknown, so the
 * amount is shown without a unit rather than under a wrong one.
 */
export function currencyForField(key: string, data: Record<string, unknown>): string | null {
  const own = currencyCode(data[`${key.split('_')[0]}_currency`])
  if (own) return own
  const shared = currencyCode(data.currency)
  if (shared) return shared
  return Object.keys(data).some((k) => k === 'currency' || k.endsWith('_currency')) ? null : 'SEK'
}

/** A numeric preview field as the approver reads it. */
export function formatPreviewNumber(key: string, value: number, data: Record<string, unknown>): string {
  if (!isMoneyField(key)) return new Intl.NumberFormat('sv-SE').format(value)
  const currency = currencyForField(key, data)
  return currency ? formatCurrency(value, currency) : formatAmount(value)
}
