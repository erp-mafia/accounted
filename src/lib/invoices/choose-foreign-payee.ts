/**
 * Make a cash account the payee for invoices in a foreign currency, from the
 * browser (crm#1273, PH 181). The two writes the invoice editor's Betalning
 * section and the send dialog both make when an administrator picks an
 * account for a currency with none chosen:
 *
 *   1. When only the account's bank connection knows its IBAN (bankIban),
 *      print that IBAN on the account first: the same write as typing it
 *      into the account's form under Inställningar, Fakturering.
 *   2. Choose the account as the currency's default payee. The mirror
 *      trigger writes company_settings.invoice_payment_accounts from it,
 *      which is what the send guard reads.
 *
 * The account does not have to be in the invoice currency: a SEK account
 * with an IBAN is the usual EUR payee (the customer pays to the IBAN and the
 * bank converts). Owner/admin only; the routes refuse anyone else. Throws an
 * Error carrying the user-facing message when a write is refused.
 */
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { Currency } from '@/types'

export async function chooseForeignInvoicePayee(input: {
  currency: Currency
  cashAccountId: string
  /** The IBAN the bank connection knows while the account prints none; null when it prints one. */
  bankIban: string | null
  locale: ErrorLocale
}): Promise<void> {
  const send = async (url: string, method: 'PATCH' | 'PUT', body: Record<string, unknown>) => {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(getErrorMessage(json, { locale: input.locale, context: 'settings', statusCode: res.status }))
    }
  }
  if (input.bankIban) {
    await send(`/api/cash-accounts/${input.cashAccountId}`, 'PATCH', { iban: input.bankIban, invoice_payee: true })
  }
  await send('/api/cash-accounts/payee-defaults', 'PUT', {
    currency: input.currency,
    cash_account_id: input.cashAccountId,
  })
}
