/**
 * Which account a bank payment goes to.
 *
 * Two sources can name the payee: the supplier card (the account the company
 * has on file) and the invoice document itself (supplier_invoices.payee_*,
 * what the scan, Peppol or a person read off this invoice). Both are resolved
 * with the same strict rules the payment file uses (resolveSupplierPayee), so
 * a payee a bank payment accepts is one a file could carry too.
 *
 *   - only one source names a payee: pay it;
 *   - both name the same account: pay the card's;
 *   - they disagree: the default is the card, the account the company has on
 *     file; paying the invoice's account is a deliberate choice
 *     (useStatedPayee), and the other account is returned so a person can
 *     compare them.
 *
 * How sure we are about the account is not decided here: create_payment_orders
 * derives payee_check in the database ('changed' when the sources disagree,
 * 'known' only after a person approved a payment to it, else 'new') and
 * refuses a payee that is not the account its source names. 'new' and
 * 'changed' need a person's confirmation at approval: a changed account on an
 * otherwise familiar invoice is the classic invoice fraud, and an account
 * backfilled onto the card from this very invoice is no confirmation at all.
 */

import { resolveSupplierPayee, type SupplierPayee, type SupplierPayeeSource } from '@/lib/payments/supplier-payee'

export interface StatedPayeeFields {
  payee_bankgiro?: string | null
  payee_plusgiro?: string | null
  payee_clearing?: string | null
  payee_account?: string | null
}

export type OrderPayeeResolution =
  | {
      ok: true
      payee: SupplierPayee
      source: 'invoice' | 'supplier'
      /** The other account when the sources disagree, so the UI can show both. */
      alternative: SupplierPayee | null
    }
  | { ok: false; reason: 'payee_missing' | 'payee_invalid' }

function samePayee(a: SupplierPayee, b: SupplierPayee): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'bankgiro':
      return a.bankgiro === (b as typeof a).bankgiro
    case 'plusgiro':
      return a.plusgiro === (b as typeof a).plusgiro
    case 'bank_account':
      return a.clearing === (b as typeof a).clearing && a.account === (b as typeof a).account
  }
}

function hasStatedPayee(invoice: StatedPayeeFields): boolean {
  return Boolean(
    invoice.payee_bankgiro?.trim() ||
      invoice.payee_plusgiro?.trim() ||
      invoice.payee_clearing?.trim() ||
      invoice.payee_account?.trim(),
  )
}

export function resolveOrderPayee(
  invoice: StatedPayeeFields,
  supplier: SupplierPayeeSource,
  options: { useStatedPayee?: boolean } = {},
): OrderPayeeResolution {
  const card = resolveSupplierPayee(supplier)
  const stated = hasStatedPayee(invoice)
    ? resolveSupplierPayee({
        bankgiro: invoice.payee_bankgiro ?? null,
        plusgiro: invoice.payee_plusgiro ?? null,
        bank_account: null,
        clearing_number: invoice.payee_clearing ?? null,
        account_number: invoice.payee_account ?? null,
      })
    : null

  if (stated?.ok && card.ok) {
    if (samePayee(stated.payee, card.payee)) {
      return { ok: true, payee: card.payee, source: 'supplier', alternative: null }
    }
    return options.useStatedPayee
      ? { ok: true, payee: stated.payee, source: 'invoice', alternative: card.payee }
      : { ok: true, payee: card.payee, source: 'supplier', alternative: stated.payee }
  }
  if (stated?.ok) return { ok: true, payee: stated.payee, source: 'invoice', alternative: null }
  if (card.ok) return { ok: true, payee: card.payee, source: 'supplier', alternative: null }
  // Neither resolves: the card's reason wins (it is what the person can fix),
  // unless the card is simply empty and the invoice's payee was invalid.
  if (card.reason === 'payee_missing' && stated && !stated.ok) return { ok: false, reason: stated.reason }
  return { ok: false, reason: card.reason }
}
