import type {
  CompanySettings,
  Currency,
  Invoice,
  InvoicePaymentAccount,
} from '@/types'

export const INVOICE_PAYMENT_ACCOUNT_CURRENCIES: readonly Currency[] = [
  'SEK',
  'EUR',
  'USD',
  'GBP',
  'NOK',
  'DKK',
]

const PAYMENT_FIELDS: readonly (keyof InvoicePaymentAccount)[] = [
  'bank_name',
  'clearing_number',
  'account_number',
  'bankgiro',
  'plusgiro',
  'swish',
  'iban',
  'bic',
  'bank_code',
  'foreign_account_number',
]

/**
 * Currencies whose domestic banking systems do not use IBAN. A payment
 * account in one of these may be identified by bank_code + account number +
 * BIC instead of an IBAN (USD: ABA routing number, GBP: sort code). Any
 * other non-SEK currency still requires IBAN. Extend here (and the
 * bank_code label map) when a non-IBAN currency is added to Currency.
 */
export const NON_IBAN_CURRENCIES: readonly Currency[] = ['USD', 'GBP']

export function isNonIbanCurrency(currency: Currency): boolean {
  return NON_IBAN_CURRENCIES.includes(currency)
}

/** The routing identifier's name per currency, for labels and messages. */
export function bankCodeLabelKey(currency: Currency): 'routing_number' | 'sort_code' | 'bank_code' {
  switch (currency) {
    case 'USD': return 'routing_number'
    case 'GBP': return 'sort_code'
    default: return 'bank_code'
  }
}

/** True when a foreign account is fully identified WITHOUT an IBAN. */
export function hasNonIbanForeignRouting(account: Partial<InvoicePaymentAccount> | null): boolean {
  return !!(account?.bank_code && account?.foreign_account_number && account?.bic)
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function legacySekInvoicePaymentAccount(
  company: Pick<CompanySettings, keyof InvoicePaymentAccount>,
): InvoicePaymentAccount {
  return {
    bank_name: clean(company.bank_name),
    clearing_number: clean(company.clearing_number),
    account_number: clean(company.account_number),
    bankgiro: clean(company.bankgiro),
    plusgiro: clean(company.plusgiro),
    swish: clean(company.swish),
    iban: clean(company.iban),
    bic: clean(company.bic),
    bank_code: null,
    foreign_account_number: null,
  }
}

export function normalizeInvoicePaymentAccount(
  account: Partial<InvoicePaymentAccount>,
): InvoicePaymentAccount {
  return {
    bank_name: clean(account.bank_name),
    clearing_number: clean(account.clearing_number),
    account_number: clean(account.account_number),
    bankgiro: clean(account.bankgiro),
    plusgiro: clean(account.plusgiro),
    swish: clean(account.swish),
    iban: clean(account.iban)?.replace(/\s/g, '').toUpperCase() ?? null,
    bic: clean(account.bic)?.replace(/\s/g, '').toUpperCase() ?? null,
    bank_code: clean(account.bank_code)?.replace(/\s/g, '') ?? null,
    foreign_account_number: clean(account.foreign_account_number)?.replace(/\s/g, '') ?? null,
  }
}

export function resolveInvoicePaymentAccount(
  company: CompanySettings,
  currency: Currency,
): InvoicePaymentAccount | null {
  const configured = company.invoice_payment_accounts?.[currency]
  if (configured) return normalizeInvoicePaymentAccount(configured)
  return currency === 'SEK' ? legacySekInvoicePaymentAccount(company) : null
}

export function hasUsableInvoicePaymentAccount(
  account: InvoicePaymentAccount | null,
  currency: Currency,
): boolean {
  if (!account) return false
  if (currency !== 'SEK') {
    // A foreign account is usable with an IBAN, or (for non-IBAN banking
    // systems) with a bank code + account number + BIC. Anything else would
    // print an invoice the customer cannot pay from.
    return !!account.iban || (isNonIbanCurrency(currency) && hasNonIbanForeignRouting(account))
  }
  return !!(
    account.iban
    || account.bankgiro
    || account.plusgiro
    || account.swish
    || (account.clearing_number && account.account_number)
  )
}

export function invoiceRequiresPaymentAccount(
  invoice: Pick<Invoice, 'credited_invoice_id' | 'document_type'>,
): boolean {
  return !invoice.credited_invoice_id
    && invoice.document_type !== 'delivery_note'
    && invoice.document_type !== 'proforma'
}

export function hasRequiredInvoicePaymentAccount(
  company: CompanySettings,
  invoice: Pick<Invoice, 'credited_invoice_id' | 'currency' | 'document_type'>,
): boolean {
  return !invoiceRequiresPaymentAccount(invoice)
    || hasUsableInvoicePaymentAccount(
      resolveInvoicePaymentAccount(company, invoice.currency),
      invoice.currency,
    )
}

export class InvoicePaymentAccountMissingError extends Error {
  readonly code = 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING'
  readonly currency: Currency

  constructor(currency: Currency) {
    super(`Invoice payment account is missing for ${currency}.`)
    this.name = 'InvoicePaymentAccountMissingError'
    this.currency = currency
  }
}

export function assertInvoicePaymentAccountForRender(
  company: CompanySettings,
  currency: Currency,
): void {
  if (
    !hasUsableInvoicePaymentAccount(
      resolveInvoicePaymentAccount(company, currency),
      currency,
    )
  ) {
    throw new InvoicePaymentAccountMissingError(currency)
  }
}

/**
 * Return invoice render settings with only the matching payment account.
 * Foreign invoices never inherit the legacy SEK payment details.
 */
export function companyWithInvoicePaymentAccount(
  company: CompanySettings,
  currency: Currency,
): CompanySettings {
  const account = resolveInvoicePaymentAccount(company, currency)
  const updates = Object.fromEntries(
    PAYMENT_FIELDS.map((field) => [field, account?.[field] ?? null]),
  ) as Pick<CompanySettings, keyof InvoicePaymentAccount>
  return { ...company, ...updates }
}
