import { describe, it, expect } from 'vitest'
import {
  buildEditorPaymentSummary,
  foreignPayeeChoice,
  type EditorPaymentSummaryInput,
} from '@/lib/invoices/editor/payment-summary'
import { cashAccountPayee } from '@/lib/cash-accounts/invoice-payee-rules'
import { makeCompanySettings } from '@/tests/helpers'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { CashAccount, CompanySettings, Currency } from '@/types'

const IBAN = 'SE4550000000058398257466'
const label = (account: CashAccount) => `${account.name} (${account.ledger_account})`

function account(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: 'ca-1',
    company_id: 'company-1',
    bank_connection_id: 'conn-1',
    external_uid: null,
    iban: IBAN,
    bban: null,
    payee_iban: IBAN,
    bank_name: 'Exempelbanken',
    clearing_number: '9710',
    account_number: '1234567',
    bankgiro: null,
    plusgiro: null,
    swish: null,
    bic: 'EXMPSESS',
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
    source: 'enable_banking',
    voucher_series: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/**
 * crm#1273's shape, invented values: one SEK bank account printing its IBAN,
 * chosen as the SEK default (the mirror wrote the SEK entry and the legacy
 * columns), and no account chosen for EUR.
 */
function settings(primary: CashAccount, overrides: Partial<CompanySettings> = {}): CompanySettings {
  const sek = cashAccountPayee(primary)
  return makeCompanySettings({
    org_number: '5566778899',
    bank_name: sek.bank_name,
    clearing_number: sek.clearing_number,
    account_number: sek.account_number,
    iban: sek.iban,
    bic: sek.bic,
    invoice_payment_accounts: { SEK: sek },
    ...overrides,
  })
}

function summaryFor(companySettings: CompanySettings, currency: Currency) {
  const input: EditorPaymentSummaryInput = {
    settings: companySettings,
    currency,
    payee: null,
    customer: { customer_type: 'eu_business', country: 'DE' },
    lang: 'sv',
    autoPaymentLink: false,
    invoice: {
      invoice_number: null,
      document_type: 'invoice',
      total: 1000,
      deduction_total: 0,
      ore_rounding: false,
      qr_mode: null,
      payment_link_url: null,
      due_date: '2026-11-15',
      invoice_date: '2026-10-16',
    },
  }
  return buildEditorPaymentSummary(input)
}

describe('foreignPayeeChoice (crm#1273: EUR invoice, one SEK account with an IBAN)', () => {
  it('offers the SEK account for the EUR invoice instead of the SEK details form', () => {
    const primary = account()
    const summary = summaryFor(settings(primary), 'EUR')
    // The dead end: nothing is chosen for EUR, so nothing prints.
    expect(summary.payeeMissing).toBe(true)
    expect(summary.storedAccountUsable).toBe(false)

    const choice = foreignPayeeChoice({ summary, currency: 'EUR', accounts: [primary], canEditCompany: true, label })
    expect(choice).toEqual({
      currency: 'EUR',
      options: [{ id: 'ca-1', label: 'Företagskonto (1930)', printed: 'IBAN SE45 5000 0000 0583 9825 7466', bankIban: null }],
    })
  })

  it('once the account is the EUR default the invoice prints its IBAN and nothing is offered', () => {
    const primary = account()
    const companySettings = settings(primary)
    const chosen = settings(primary, {
      invoice_payment_accounts: { SEK: cashAccountPayee(primary), EUR: cashAccountPayee(primary) },
    })
    const summary = summaryFor(chosen, 'EUR')
    expect(summary.payeeMissing).toBe(false)
    expect(summary.methods.map((row) => row.key)).toContain('iban')
    expect(foreignPayeeChoice({ summary, currency: 'EUR', accounts: [primary], canEditCompany: true, label })).toBeNull()
    // The SEK default, and so a SEK invoice, is untouched by the choice.
    expect(summaryFor(companySettings, 'SEK')).toEqual(summaryFor(chosen, 'SEK'))
  })

  it('a SEK invoice never gets the foreign choice: its own fix (the details form) stays', () => {
    const primary = account()
    const summary = summaryFor(settings(primary), 'SEK')
    expect(summary.payeeMissing).toBe(false)
    expect(foreignPayeeChoice({ summary, currency: 'SEK', accounts: [primary], canEditCompany: true, label })).toBeNull()

    const bare = makeCompanySettings({ org_number: '5566778899' })
    const missing = summaryFor(bare, 'SEK')
    expect(missing.payeeMissing).toBe(true)
    expect(foreignPayeeChoice({ summary: missing, currency: 'SEK', accounts: [primary], canEditCompany: true, label })).toBeNull()
  })

  it('an account whose IBAN only the bank connection knows: offered to an administrator with that IBAN, never to a member', () => {
    const connected = account({ payee_iban: null, invoice_payee: false })
    const summary = summaryFor(makeCompanySettings({ org_number: '5566778899' }), 'EUR')
    const admin = foreignPayeeChoice({ summary, currency: 'EUR', accounts: [connected], canEditCompany: true, label })
    expect(admin?.options).toEqual([
      { id: 'ca-1', label: 'Företagskonto (1930)', printed: 'IBAN SE45 5000 0000 0583 9825 7466', bankIban: IBAN },
    ])
    // A member cannot write payee details: told to ask an administrator.
    expect(foreignPayeeChoice({ summary, currency: 'EUR', accounts: [connected], canEditCompany: false, label }))
      .toEqual({ currency: 'EUR', options: [] })
  })

  it('no account with an IBAN at all: the choice is empty, so the section points to the settings', () => {
    const domestic = account({ iban: null, payee_iban: null, bankgiro: '5050-1055' })
    const summary = summaryFor(makeCompanySettings({ org_number: '5566778899', bankgiro: '5050-1055' }), 'EUR')
    expect(summary.payeeMissing).toBe(true)
    expect(foreignPayeeChoice({ summary, currency: 'EUR', accounts: [domestic], canEditCompany: true, label }))
      .toEqual({ currency: 'EUR', options: [] })
  })

  it('the section\'s strings exist in both languages', () => {
    const keys = [
      'foreign_missing', 'foreign_missing_no_iban', 'foreign_use_account', 'foreign_use_account_here',
      'foreign_open_settings', 'foreign_chosen_title', 'foreign_chosen_description', 'foreign_choose_failed',
    ]
    for (const messages of [sv.invoice_editor_pay, en.invoice_editor_pay] as Record<string, string>[]) {
      for (const key of keys) expect(messages[key], key).toBeTruthy()
    }
  })
})
