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
} from '@/lib/invoices/payment-accounts'

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

/**
 * Bank-type rows only: Stripe (1686), Woo (1680) and Shopify (1584) also live
 * in cash_accounts, and so may a till (1910 Kassa, 1911-1919). A customer is
 * paid to a giro or bank account (BAS 1920-1999), never to a cash till.
 */
export function isBankCashAccount(account: Pick<CashAccount, 'ledger_account'>): boolean {
  return /^19[2-9]\d$/.test(account.ledger_account)
}
