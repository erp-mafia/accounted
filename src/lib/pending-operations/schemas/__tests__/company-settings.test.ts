/**
 * The machine-door input of settings.update (gnubok_update_company_settings,
 * PATCH /api/v1/companies/:companyId/settings) and the upgrade of
 * update_company_settings rows staged in the pre-operation shape.
 */
import { describe, it, expect } from 'vitest'
import { settingsUpdate } from '@/lib/operations/company-settings'
import { upgradeLegacyCompanySettingsParams } from '../company-settings'

const parse = (input: Record<string, unknown>) => settingsUpdate.input.parse(input)

describe('settings.update input: field set', () => {
  it('accepts the original banking and reference fields', () => {
    const parsed = parse({
      bank_name: 'Testbanken',
      clearing_number: '1234',
      account_number: '1234567',
      bankgiro: '5050-1055',
      contact_person: 'Test Contact',
    })
    expect(parsed.bankgiro).toBe('5050-1055')
    expect(parsed.contact_person).toBe('Test Contact')
  })

  it('accepts the wider non-legal settings the dashboard writes', () => {
    const parsed = parse({
      company_name: 'Acme AB',
      invoice_email_cc_addresses: ['kopia@example.se'],
      default_voucher_series: 'B',
      reminder_days_level_1: 10,
      quotes_enabled: false,
    })
    expect(parsed.invoice_email_cc_addresses).toEqual(['kopia@example.se'])
    expect(parsed.default_voucher_series).toBe('B')
  })

  it('accepts an empty-string email (clears the value) and rejects a malformed one', () => {
    expect(parse({ email: '' }).email).toBe('')
    expect(() => parse({ email: 'not-an-email' })).toThrow()
  })

  it('accepts null invoice_email_texts (clears every override)', () => {
    expect(parse({ invoice_email_texts: null }).invoice_email_texts).toBeNull()
  })

  it('requires at least one field', () => {
    expect(() => parse({})).toThrow(/at least one/i)
  })

  const excluded: Array<[key: string, value: unknown]> = [
    ['vat_registered', true],
    ['accounting_method', 'cash'],
    ['defer_invoice_booking', true],
    ['bookkeeping_locked_through', '2026-01-31'],
    ['org_number', '556677-8899'],
    ['entity_type', 'aktiebolag'],
    ['default_our_reference', 'Sneaky'],
    ['salary_pay_day', 25],
  ]
  it.each(excluded)('rejects %s (another door, or not writable over the API)', (key, value) => {
    expect(() => parse({ bank_name: 'Testbanken', [key]: value })).toThrow(/unrecognized key/i)
  })
})

describe('settings.update input: machine-door rules', () => {
  it('rejects a Bankgiro number with a wrong check digit', () => {
    expect(() => parse({ bankgiro: '991-2345' })).toThrow(/Invalid Bankgiro number/)
  })

  it('accepts every placeholder in the fixed set, case- and space-insensitive', () => {
    const body =
      'Faktura {fakturanummer} till {kundnamn} ({förnamn}) fran {företag}, forfaller {förfallodatum}, belopp {belopp}.'
    expect(() => parse({ invoice_email_texts: { sv: { body, subject: 'Faktura { Fakturanummer }' } } })).not.toThrow()
  })

  it('rejects an unknown placeholder in any language and field', () => {
    expect(() => parse({ invoice_email_texts: { sv: { body: 'Betala med OCR {ocr}.' } } })).toThrow(
      /unknown placeholder \{ocr\}/i,
    )
    expect(() => parse({ invoice_email_texts: { en: { subject: 'Invoice {faktura_nr}' } } })).toThrow(
      /unknown placeholder \{faktura_nr\}/i,
    )
  })
})

describe('upgradeLegacyCompanySettingsParams', () => {
  it('lifts { changes } to the flat input and renames the reference', () => {
    expect(
      upgradeLegacyCompanySettingsParams({ changes: { bankgiro: '5050-1055', default_our_reference: 'Anna' } }),
    ).toEqual({ bankgiro: '5050-1055', contact_person: 'Anna' })
  })

  it('keeps a null reference (it clears the value)', () => {
    expect(upgradeLegacyCompanySettingsParams({ changes: { default_our_reference: null } })).toEqual({
      contact_person: null,
    })
  })

  it('passes flat params and anything unexpected through untouched', () => {
    expect(upgradeLegacyCompanySettingsParams({ phone: '08-1' })).toEqual({ phone: '08-1' })
    const odd = { changes: { phone: '08-1' }, company_id: 'x' }
    expect(upgradeLegacyCompanySettingsParams(odd)).toBe(odd)
  })
})
