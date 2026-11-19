/**
 * Whether a supplier invoice asks to be paid to an account the company does
 * not have for that supplier: the classic invoice fraud (a real-looking
 * invoice, a new bankgiro), caught when the invoice arrives instead of only
 * in the pay dialog.
 *
 * Pure. Accounts compare as keys in the database's own format
 * (payment_order_payee_key: 'bankgiro:50501055', 'plusgiro:1234566',
 * 'bank_account:8327:123456789', 'iban:SE45...'), so a key read here is the
 * key create_payment_orders derives and supplier_payee_confirmations stores.
 *
 *   - same:                 the invoice states no account, or one the card
 *                           already holds (any of its accounts), or only an
 *                           IBAN for a card that pays a domestic account;
 *   - new_supplier_account: the invoice states an account and the card has
 *                           none;
 *   - changed:              the card has accounts and the invoice states
 *                           another one;
 *   - first_payment:        the card holds it, but no payment a person
 *                           approved has gone to it (only when the caller
 *                           knows the paid accounts).
 *
 * Only changed, and new_supplier_account for a supplier the company has
 * already paid, alert: a first invoice from a new supplier has nothing to
 * differ from, and the pay dialog already confirms a first payment.
 *
 * What is compared is the account a payment would use, not every number the
 * invoice prints. An IBAN decides a payment only when the card has no
 * domestic account (resolveSupplierPayee pays a bankgiro, then a plusgiro,
 * then a bank account, never an IBAN beside them), so an IBAN from an
 * invoice's footer beside a card that pays a bankgiro changes nothing: the
 * card may take it (the backfill), and nothing waits for a person (crm#1220).
 */

import { formatBankgiroNumber, formatPlusgiroNumber } from '@/lib/bankgiro/luhn'

export interface StatedPayeeSource {
  payee_bankgiro?: string | null
  payee_plusgiro?: string | null
  payee_clearing?: string | null
  payee_account?: string | null
  payee_iban?: string | null
}

export interface CardPayeeSource {
  bankgiro?: string | null
  plusgiro?: string | null
  clearing_number?: string | null
  account_number?: string | null
  /** Legacy free text, read only when it carries a clearing/account separator ("8327-9 123456789"). */
  bank_account?: string | null
  iban?: string | null
}

export type PayeeChangeKind = 'same' | 'new_supplier_account' | 'changed' | 'first_payment'

/** What alerts: the invoice names an account the company has not confirmed for the supplier. */
export type PayeeAlert = 'changed' | 'new_supplier_account'

export type PayeeDecision = 'confirmed' | 'rejected'

/** Why a payment of the invoice is held back until a person acts. */
export type PayeeHold = 'payee_unconfirmed' | 'payee_rejected'

export interface PayeeChange {
  kind: PayeeChangeKind
  /** The account the invoice states, as a key; null when it states none. */
  statedKey: string | null
  /** The card's payment account (its first in the payment priority), as a key; null when it has none. */
  cardKey: string | null
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

function giroKey(type: 'bankgiro' | 'plusgiro', value: string | null | undefined): string | null {
  const d = digits(value)
  return d ? `${type}:${d}` : null
}

function bankAccountKey(clearing: string | null | undefined, account: string | null | undefined): string | null {
  const c = digits(clearing)
  const a = digits(account)
  return c && a ? `bank_account:${c}:${a}` : null
}

function ibanKey(value: string | null | undefined): string | null {
  const iban = (value ?? '').replace(/\s/g, '').toUpperCase()
  return iban ? `iban:${iban}` : null
}

/** Same pattern as resolveSupplierPayee and payment_order_payee_check: an explicit separator, never a guessed split. */
const FREE_TEXT_BANK_ACCOUNT = /^(\d{4}|8\d{4})[-\s]+([\d\s-]{5,15})$/

/**
 * The account an invoice states, in the order payment_order_payee_check
 * reads it (bankgiro, plusgiro, clearing and account, IBAN); null when the
 * invoice states none.
 */
export function statedPayeeKey(invoice: StatedPayeeSource): string | null {
  return (
    giroKey('bankgiro', invoice.payee_bankgiro) ??
    giroKey('plusgiro', invoice.payee_plusgiro) ??
    bankAccountKey(invoice.payee_clearing, invoice.payee_account) ??
    ibanKey(invoice.payee_iban)
  )
}

/** Every account the supplier card holds, in payment priority (the first is the one a payment uses). */
export function cardPayeeKeys(card: CardPayeeSource): string[] {
  const free = FREE_TEXT_BANK_ACCOUNT.exec((card.bank_account ?? '').trim())
  const keys = [
    giroKey('bankgiro', card.bankgiro),
    giroKey('plusgiro', card.plusgiro),
    bankAccountKey(card.clearing_number, card.account_number),
    free ? bankAccountKey(free[1], free[2]) : null,
    ibanKey(card.iban),
  ]
  return [...new Set(keys.filter((k): k is string => k !== null))]
}

export function classifyPayeeChange(input: {
  invoice: StatedPayeeSource
  card: CardPayeeSource
  /**
   * Accounts a payment a person approved has gone to for this supplier.
   * Undefined when the caller did not read them: first_payment is then
   * never answered, which changes no alert.
   */
  paidPayeeKeys?: readonly string[]
}): PayeeChange {
  const statedKey = statedPayeeKey(input.invoice)
  const cardKeys = cardPayeeKeys(input.card)
  const cardKey = cardKeys[0] ?? null
  if (!statedKey) return { kind: 'same', statedKey: null, cardKey }
  if (!cardKey) return { kind: 'new_supplier_account', statedKey, cardKey }
  // The account a payment of the invoice would use: what the invoice states,
  // unless that is only an IBAN and the card pays a domestic account, which a
  // payment then keeps using.
  const paidTo = isIbanKey(statedKey) && !isIbanKey(cardKey) ? cardKey : statedKey
  if (!cardKeys.includes(paidTo)) return { kind: 'changed', statedKey, cardKey }
  if (input.paidPayeeKeys && !input.paidPayeeKeys.includes(paidTo)) return { kind: 'first_payment', statedKey, cardKey }
  return { kind: 'same', statedKey, cardKey }
}

function isIbanKey(key: string): boolean {
  return key.startsWith('iban:')
}

/**
 * Whether the change alerts: a changed account always; a new account on an
 * empty card only for a supplier the company has paid before (it was paid
 * somewhere, and this is not it).
 */
export function payeeAlertFor(kind: PayeeChangeKind, hasPaidHistory: boolean): PayeeAlert | null {
  if (kind === 'changed') return 'changed'
  if (kind === 'new_supplier_account' && hasPaidHistory) return 'new_supplier_account'
  return null
}

/**
 * What a payment of the invoice waits for: nothing once a person confirmed
 * the account for the supplier, a person's confirmation while nobody
 * decided, and a person's fix once someone rejected it.
 */
export function payeeHoldFor(alert: PayeeAlert | null, decision: PayeeDecision | null): PayeeHold | null {
  if (!alert || decision === 'confirmed') return null
  return decision === 'rejected' ? 'payee_rejected' : 'payee_unconfirmed'
}

/** A key as people read it: "BG 5050-1055", "PG 123456-6", "8327 123456789", "IBAN SE45...". */
export function payeeKeyLabel(key: string): string {
  const [type, a = '', b = ''] = key.split(':')
  switch (type) {
    case 'bankgiro':
      return `BG ${a.slice(0, a.length - 4)}-${a.slice(-4)}`
    case 'plusgiro':
      return `PG ${a.slice(0, a.length - 1)}-${a.slice(-1)}`
    case 'bank_account':
      return `${a} ${b}`
    case 'iban':
      return `IBAN ${a.replace(/(.{4})/g, '$1 ').trim()}`
    default:
      return key
  }
}

/** The giro a key names, for a Bankgiro lookup of the registered name; null for an account or IBAN. */
export function payeeKeyGiro(key: string): { giro: string; type: 'bankgiro' | 'plusgiro' } | null {
  const [type, value = ''] = key.split(':')
  if (type === 'bankgiro' || type === 'plusgiro') return { giro: value, type }
  return null
}

/**
 * The supplier card columns that make the stated account the card's payment
 * account: its own column(s) set, the columns a payment would read before it
 * cleared (resolveSupplierPayee reads bankgiro, then plusgiro, then clearing
 * and account, then the free text). The lower ones stay: they no longer
 * decide anything. An IBAN is added beside the domestic accounts, which keep
 * deciding a SEK payment. Null for a key this cannot write.
 */
export function cardColumnsForKey(key: string): Record<string, string | null> | null {
  const [type, a = '', b = ''] = key.split(':')
  switch (type) {
    case 'bankgiro':
      return a ? { bankgiro: formatBankgiroNumber(a) } : null
    case 'plusgiro':
      return a ? { bankgiro: null, plusgiro: formatPlusgiroNumber(a) } : null
    case 'bank_account':
      return a && b ? { bankgiro: null, plusgiro: null, clearing_number: a, account_number: b } : null
    case 'iban':
      return a ? { iban: a } : null
    default:
      return null
  }
}
