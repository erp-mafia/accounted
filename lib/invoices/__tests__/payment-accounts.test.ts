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

  it('accepts a USD account identified by routing number + account number + BIC without an IBAN', () => {
    // gnubok_feedback 2026-08-03: a Wise US receiving account has no IBAN
    // (US banking does not use them); the only way past the old validation
    // was pasting an IBAN from another currency, which then printed on the
    // invoice and misrouted the payment.
    const usd = resolveInvoicePaymentAccount(company({
      invoice_payment_accounts: {
        USD: {
          bank_name: 'Wise US Inc',
          clearing_number: null,
          account_number: null,
          bankgiro: null,
          plusgiro: null,
          swish: null,
          iban: null,
          bic: 'TRWIUS35XXX',
          bank_code: '084009519',
          foreign_account_number: '9600001234567890',
        },
      },
    }), 'USD')

    expect(hasUsableInvoicePaymentAccount(usd, 'USD')).toBe(true)
    expect(usd?.bank_code).toBe('084009519')
    expect(usd?.foreign_account_number).toBe('9600001234567890')

    const rendered = companyWithInvoicePaymentAccount(company({
      invoice_payment_accounts: {
        USD: {
          bank_name: 'Wise US Inc',
          clearing_number: null,
          account_number: null,
          bankgiro: null,
          plusgiro: null,
          swish: null,
          iban: null,
          bic: 'TRWIUS35XXX',
          bank_code: '084009519',
          foreign_account_number: '9600001234567890',
        },
      },
    }), 'USD')
    expect(rendered.iban).toBeNull()
    expect(rendered.bank_code).toBe('084009519')
    expect(rendered.foreign_account_number).toBe('9600001234567890')
  })

  it('still requires an IBAN for a non-IBAN-currency account that lacks the routing triple', () => {
    const partial = resolveInvoicePaymentAccount(company({
      invoice_payment_accounts: {
        GBP: {
          bank_name: 'UK bank',
          clearing_number: null,
          account_number: null,
          bankgiro: null,
          plusgiro: null,
          swish: null,
          iban: null,
          bic: null,
          bank_code: '12-34-56',
          foreign_account_number: '12345678',
        },
      },
    }), 'GBP')
    // Sort code + account number but no BIC: not payable from abroad.
    expect(hasUsableInvoicePaymentAccount(partial, 'GBP')).toBe(false)
  })

  it('does not accept the routing triple for an IBAN currency', () => {
    const eur = resolveInvoicePaymentAccount(company({
      invoice_payment_accounts: {
        EUR: {
          bank_name: 'EUR bank',
          clearing_number: null,
          account_number: null,
          bankgiro: null,
          plusgiro: null,
          swish: null,
          iban: null,
          bic: 'DEUTDEFF',
          bank_code: '37040044',
          foreign_account_number: '0532013000',
        },
      },
    }), 'EUR')
    expect(hasUsableInvoicePaymentAccount(eur, 'EUR')).toBe(false)
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
