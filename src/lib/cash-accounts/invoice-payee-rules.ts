/**
 * Which cash account can be printed on an invoice, and what it prints. Pure
 * (no database, no chart of accounts): the invoice editor and the payment
 * account settings import these from the browser, while invoice-payee.ts
 * keeps the reads and writes.
 */
import type { CashAccount, CashAccountPayeeFields, Currency, InvoicePaymentAccount } from '@/types'
import {
  hasUsableInvoicePaymentAccount,
  normalizeInvoicePaymentAccount,
  summarizeInvoicePaymentAccount,
} from '@/lib/cash-accounts/invoice-payment-accounts'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { paymentDetailsPointAt } from '@/lib/cash-accounts/ledger-slots'
import { resolveDomesticBankAccount } from '@/lib/bankgiro/domestic-account'

/** A cash account's payee columns: the InvoicePaymentAccount keys, with the printed IBAN in payee_iban. */
export type CashAccountPayeeSource = Omit<CashAccountPayeeFields, 'iban'> & { payee_iban: string | null }

/**
 * The payee fields of a cash account in the shape the invoice renderers read.
 * The printed IBAN is payee_iban, never the bank-identity iban column.
 */
export function cashAccountPayee(account: CashAccountPayeeSource): InvoicePaymentAccount {
  return normalizeInvoicePaymentAccount({
    bank_name: account.bank_name,
    clearing_number: account.clearing_number,
    account_number: account.account_number,
    bankgiro: account.bankgiro,
    plusgiro: account.plusgiro,
    swish: account.swish,
    iban: account.payee_iban,
    bic: account.bic,
    bank_code: account.bank_code,
    foreign_account_number: account.foreign_account_number,
  })
}

/**
 * Whether the account can be printed on an invoice in `currency`: enabled,
 * flagged as a payee, and carrying the identifiers that currency needs (an
 * IBAN for anything but SEK, or the USD/GBP routing triple).
 */
export function isUsableInvoicePayee(account: CashAccount, currency: Currency): boolean {
  return account.enabled
    && account.invoice_payee
    && hasUsableInvoicePaymentAccount(cashAccountPayee(account), currency)
}

/** "Företagskonto (1930)", or the bare ledger account when the row has no name. */
export function invoicePayeeAccountLabel(account: Pick<CashAccount, 'name' | 'ledger_account'>): string {
  const name = account.name?.trim()
  return name ? `${name} (${account.ledger_account})` : account.ledger_account
}

/** An account a foreign-currency invoice can be paid to once someone picks it. */
export interface InvoicePayeeCandidate {
  account: CashAccount
  /**
   * The IBAN the bank connection knows for the account while it prints none
   * (payee_iban empty): picking the account also prints this one. Null when
   * the account is usable as it stands.
   */
  bankIban: string | null
}

const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/

/**
 * The accounts that could carry a foreign-currency invoice when the currency
 * has no default account yet (crm#1273). The account does not have to be in
 * that currency: a foreign payer pays to an IBAN, and a SEK account receives
 * the payment there (its bank converts). Usable accounts come first, then
 * enabled bank accounts whose connection knows the IBAN but which print none
 * yet. The ledger currency (SEK) gets none: its invoice falls back to the
 * company's own details, and its domestic payee (bankgiro, clearing and
 * account number) is typed in the settings, not taken from a bank connection.
 */
export function foreignInvoicePayeeCandidates(
  accounts: readonly CashAccount[],
  currency: Currency,
): InvoicePayeeCandidate[] {
  if (isLedgerCurrency(currency)) return []
  const usable = accounts
    .filter((account) => isUsableInvoicePayee(account, currency))
    .map((account) => ({ account, bankIban: null }))
  const withBankIban = accounts.flatMap((account) => {
    if (!account.enabled || !isBankCashAccount(account) || account.payee_iban?.trim()) return []
    const bankIban = account.iban?.replace(/\s/g, '').toUpperCase() ?? ''
    if (!IBAN_SHAPE.test(bankIban)) return []
    const payee = { ...cashAccountPayee(account), iban: bankIban }
    return hasUsableInvoicePaymentAccount(payee, currency) ? [{ account, bankIban }] : []
  })
  return [...usable, ...withBankIban]
}

/** An account whose invoices print another of the company's accounts' bank IBAN. */
export interface PrintedIbanOfOtherAccount {
  account: CashAccount
  /** The account whose bank IBAN (iban) the printed one is. */
  other: CashAccount
  /** The printed IBAN, without spaces and upper case. */
  printedIban: string
  /**
   * The account's own bank IBAN when it has one in IBAN shape: printing it
   * is the one-click fix. Null when only editing the account can fix it.
   */
  ownIban: string | null
}

/**
 * The accounts shown on invoices whose printed IBAN (payee_iban) is the bank
 * IBAN (iban) of another of the company's accounts, in list order: invoices
 * tell customers to pay into that other account (crm#1483). A copy of the
 * account's own IBAN that went stale when its bank identity was rewritten, a
 * map entry the 2026-09-04 backfill put on the account, and a typo all end
 * here, so the settings page flags it without guessing which. Computed from
 * the rows the page already loads; nothing is stored.
 */
export function accountsPrintingOtherAccountIban(accounts: readonly CashAccount[]): PrintedIbanOfOtherAccount[] {
  return accounts.flatMap((account) => {
    const printedIban = compactIban(account.payee_iban)
    const ownIdentity = compactIban(account.iban)
    if (!account.invoice_payee || !printedIban || printedIban === ownIdentity) return []
    const other = accounts.find((candidate) => candidate.id !== account.id && compactIban(candidate.iban) === printedIban)
    if (!other) return []
    return [{ account, other, printedIban, ownIban: ownIdentity && IBAN_SHAPE.test(ownIdentity) ? ownIdentity : null }]
  })
}

/** An account whose invoices print another of the company's accounts' clearing and account number. */
export interface PrintedNumberOfOtherAccount {
  account: CashAccount
  /** The account whose bank identity (IBAN or BBAN) the printed number is. */
  other: CashAccount
  /** The printed account number, digits only. */
  printedAccountNumber: string
  /**
   * The account's own account number when its BBAN is the printed clearing
   * number followed by a payable account number: printing it is the
   * one-click fix. Null when only editing the account can fix it (a BBAN
   * without the clearing number, or with another clearing number).
   */
  ownAccountNumber: string | null
}

/**
 * The accounts shown on invoices whose clearing and account number point at
 * another of the company's accounts and not at their own, in list order: the
 * same fault as accountsPrintingOtherAccountIban, for the domestic number.
 * Two accounts the bank names alike get each other's numbers typed in, and
 * customers then pay into the wrong one. Computed from the rows the page
 * already loads; nothing is stored.
 */
export function accountsPrintingOtherAccountNumber(accounts: readonly CashAccount[]): PrintedNumberOfOtherAccount[] {
  return accounts.flatMap((account) => {
    if (!account.invoice_payee) return []
    const printed = { clearing_number: account.clearing_number, account_number: account.account_number }
    if (paymentDetailsPointAt(printed, account)) return []
    const other = accounts.find((candidate) => candidate.id !== account.id && paymentDetailsPointAt(printed, candidate))
    if (!other) return []
    return [{
      account,
      other,
      printedAccountNumber: digitsOf(account.account_number),
      ownAccountNumber: ownAccountNumberFromBban(account),
    }]
  })
}

/**
 * The account number in the account's BBAN after the printed clearing
 * number, when the two together name a payable account. Swedish BBANs come
 * as clearing plus account number, as the account number alone, or padded,
 * so anything else is left to the user.
 */
function ownAccountNumberFromBban(account: Pick<CashAccount, 'bban' | 'clearing_number'>): string | null {
  const bban = digitsOf(account.bban)
  const clearing = digitsOf(account.clearing_number)
  if (!clearing || !bban.startsWith(clearing)) return null
  const accountNumber = bban.slice(clearing.length)
  return resolveDomesticBankAccount(clearing, accountNumber).ok ? accountNumber : null
}

function digitsOf(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

function compactIban(value: string | null | undefined): string | null {
  const compact = value?.replace(/\s/g, '').toUpperCase() ?? ''
  return compact || null
}

/**
 * Bank-type rows only: Stripe (1686), Woo (1680) and Shopify (1584) also live
 * in cash_accounts, and so may a till (1910 Kassa, 1911-1919). A customer is
 * paid to a giro or bank account (BAS 1920-1999), never to a cash till.
 */
export function isBankCashAccount(account: Pick<CashAccount, 'ledger_account'>): boolean {
  return /^19[2-9]\d$/.test(account.ledger_account)
}

/**
 * The account the payment settings fill in first when the user adds a bank
 * account: the company's primary bank account while it prints nothing.
 * Every company is seeded with one (1930), so someone adding "their bank
 * account" there means that account. Creating a second row instead gave the
 * same money a second 19xx ledger, and the IBAN typed on it then blocked the
 * real account (crm#1270). Null when the primary already prints something:
 * a new account is then what the user asked for. No currency test: only an
 * account in the company's own currency can be made primary
 * (make_cash_account_primary).
 */
export function blankPrimaryPayeeAccount(accounts: readonly CashAccount[]): CashAccount | null {
  return accounts.find((account) =>
    account.is_primary
    && account.enabled
    && isBankCashAccount(account)
    && !summarizeInvoicePaymentAccount(cashAccountPayee(account)),
  ) ?? null
}
