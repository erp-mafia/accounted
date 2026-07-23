import { describe, expect, it } from 'vitest'
import {
  InvoicePaymentAccountMissingError,
  assertInvoicePaymentAccountForRender,
  companyWithInvoicePaymentAccount,
  hasRequiredInvoicePaymentAccount,
  hasUsableInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
  resolveInvoicePaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { makeInvoice } from '@/tests/helpers'
import type { CompanySettings } from '@/types'

function company(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return {
    bank_name: 'Legacy bank',
    clearing_number: '1234',
    account_number: '1234567',
    bankgiro: '123-4567',
    plusgiro: null,
    swish: null,
    iban: 'SE0011111111111111111111',
    bic: 'LEGASESS',
    ...overrides,
  } as CompanySettings
}

describe('invoice payment accounts', () => {
  it('uses legacy payment details for SEK only', () => {
    const settings = company()

    expect(resolveInvoicePaymentAccount(settings, 'SEK')?.iban).toBe('SE0011111111111111111111')
    expect(resolveInvoicePaymentAccount(settings, 'EUR')).toBeNull()
  })

  it('selects the account matching the invoice currency', () => {
    const settings = company({
      invoice_payment_accounts: {
        EUR: {
          bank_name: 'EUR bank',
          clearing_number: null,
          account_number: null,
          bankgiro: null,
          plusgiro: null,
          swish: null,
          iban: 'SE0022222222222222222222',
          bic: 'EURRSESS',
        },
      },
    })

    const rendered = companyWithInvoicePaymentAccount(settings, 'EUR')
    expect(rendered.bank_name).toBe('EUR bank')
    expect(rendered.iban).toBe('SE0022222222222222222222')
    expect(rendered.bankgiro).toBeNull()
  })

  it('clears legacy SEK details when a foreign account is missing', () => {
    const rendered = companyWithInvoicePaymentAccount(company(), 'EUR')

    expect(rendered.iban).toBeNull()
    expect(rendered.bankgiro).toBeNull()
  })

  it('requires an IBAN for a foreign-currency payment account', () => {
    const withoutIban = resolveInvoicePaymentAccount(company({
      invoice_payment_accounts: {
        EUR: {
          bank_name: 'EUR bank',
          clearing_number: '1234',
          account_number: '1234567',
          bankgiro: null,
          plusgiro: null,
          swish: null,
          iban: null,
          bic: null,
        },
      },
    }), 'EUR')

    expect(hasUsableInvoicePaymentAccount(withoutIban, 'EUR')).toBe(false)
  })

  it('blocks payable rendering in every currency without a usable account', () => {
    const emptySettings = company({
      clearing_number: null,
      account_number: null,
      bankgiro: null,
      plusgiro: null,
      swish: null,
      iban: null,
    })

    expect(() => assertInvoicePaymentAccountForRender(company(), 'EUR')).toThrow(
      InvoicePaymentAccountMissingError,
    )
    expect(() => assertInvoicePaymentAccountForRender(emptySettings, 'SEK')).toThrow(
      InvoicePaymentAccountMissingError,
    )
    expect(() => assertInvoicePaymentAccountForRender(company(), 'SEK')).not.toThrow()
  })

  it('requires payment accounts only for payable invoice documents', () => {
    expect(invoiceRequiresPaymentAccount(makeInvoice())).toBe(true)
    expect(invoiceRequiresPaymentAccount(makeInvoice({ credited_invoice_id: 'invoice-original' }))).toBe(false)
    expect(invoiceRequiresPaymentAccount(makeInvoice({ document_type: 'delivery_note' }))).toBe(false)
    expect(invoiceRequiresPaymentAccount(makeInvoice({ document_type: 'proforma' }))).toBe(false)
  })

  it('accepts non-payable documents without an account', () => {
    const emptySettings = company({
      clearing_number: null,
      account_number: null,
      bankgiro: null,
      plusgiro: null,
      swish: null,
      iban: null,
    })

    expect(hasRequiredInvoicePaymentAccount(
      emptySettings,
      makeInvoice({ document_type: 'proforma' }),
    )).toBe(true)
    expect(hasRequiredInvoicePaymentAccount(emptySettings, makeInvoice())).toBe(false)
  })
})
