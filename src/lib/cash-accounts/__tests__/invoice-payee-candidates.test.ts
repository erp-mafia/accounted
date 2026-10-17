import { describe, it, expect } from 'vitest'
import type { CashAccount } from '@/types'
import { foreignInvoicePayeeCandidates } from '../invoice-payee-rules'

const IBAN = 'SE4550000000058398257466'

function account(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: 'ca-1',
    company_id: 'company-1',
    bank_connection_id: null,
    external_uid: null,
    iban: null,
    bban: null,
    payee_iban: null,
    bank_name: null,
    clearing_number: null,
    account_number: null,
    bankgiro: null,
    plusgiro: null,
    swish: null,
    bic: null,
    bank_code: null,
    foreign_account_number: null,
    invoice_payee: true,
    name: 'Företagskonto',
    currency: 'SEK',
    ledger_account: '1930',
    balance: null,
    available_balance: null,
    balance_updated_at: null,
    enabled: true,
    is_primary: true,
    source: 'manual',
    voucher_series: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('foreignInvoicePayeeCandidates (crm#1273)', () => {
  it('offers the SEK account that already prints an IBAN for a EUR invoice', () => {
    const sek = account({ payee_iban: IBAN, iban: IBAN, clearing_number: '9710', account_number: '1234567' })
    expect(foreignInvoicePayeeCandidates([sek], 'EUR')).toEqual([{ account: sek, bankIban: null }])
  })

  it('offers a bank-connected account whose IBAN only the connection knows, with that IBAN', () => {
    const connected = account({
      iban: 'se45 5000 0000 0583 9825 7466',
      source: 'enable_banking',
      bank_connection_id: 'conn-1',
      // A connected account is not a payee until someone says so.
      invoice_payee: false,
    })
    expect(foreignInvoicePayeeCandidates([connected], 'EUR')).toEqual([{ account: connected, bankIban: IBAN }])
  })

  it('lists usable accounts before the ones that need their bank IBAN', () => {
    const identityOnly = account({ id: 'ca-2', ledger_account: '1931', is_primary: false, iban: 'SE7280000810340009783242' })
    const usable = account({ payee_iban: IBAN })
    expect(foreignInvoicePayeeCandidates([identityOnly, usable], 'EUR').map((c) => c.account.id)).toEqual(['ca-1', 'ca-2'])
  })

  it('never a SEK invoice: those keep the domestic details and the company fallback', () => {
    expect(foreignInvoicePayeeCandidates([account({ payee_iban: IBAN })], 'SEK')).toEqual([])
    expect(foreignInvoicePayeeCandidates([account({ iban: IBAN })], 'SEK')).toEqual([])
  })

  it('never an account with nothing a foreign payer can pay to', () => {
    // Domestic details only: a bankgiro or clearing number is no use abroad.
    expect(foreignInvoicePayeeCandidates([account({ bankgiro: '5050-1055', clearing_number: '8327', account_number: '1234567' })], 'EUR')).toEqual([])
    // Not an IBAN (a stored BBAN or a typo) is not offered.
    expect(foreignInvoicePayeeCandidates([account({ iban: '83271234567' })], 'EUR')).toEqual([])
  })

  it('never a disabled, hidden-with-details or non-bank account', () => {
    expect(foreignInvoicePayeeCandidates([account({ iban: IBAN, enabled: false })], 'EUR')).toEqual([])
    expect(foreignInvoicePayeeCandidates([account({ payee_iban: IBAN, enabled: false })], 'EUR')).toEqual([])
    // Hidden on invoices while it prints an IBAN: someone chose that.
    expect(foreignInvoicePayeeCandidates([account({ payee_iban: IBAN, invoice_payee: false })], 'EUR')).toEqual([])
    // A PSP clearing account carrying an IBAN is not where a customer pays.
    expect(foreignInvoicePayeeCandidates([account({ ledger_account: '1686', iban: IBAN })], 'EUR')).toEqual([])
  })

  it('USD: an IBAN serves, and so does a usable routing triple', () => {
    expect(foreignInvoicePayeeCandidates([account({ iban: IBAN })], 'USD')).toHaveLength(1)
    const routed = account({ bank_code: '021000021', foreign_account_number: '123456789', bic: 'CHASUS33' })
    expect(foreignInvoicePayeeCandidates([routed], 'USD')).toEqual([{ account: routed, bankIban: null }])
  })
})
