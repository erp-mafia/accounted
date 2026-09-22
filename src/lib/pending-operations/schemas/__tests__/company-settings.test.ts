import { describe, it, expect } from 'vitest'
import { UpdateCompanySettingsParamsSchema } from '../company-settings'

const wrap = (changes: Record<string, unknown>) => ({ changes })

describe('UpdateCompanySettingsParamsSchema: widened field set', () => {
  it('accepts the original banking and reference fields', () => {
    const parsed = UpdateCompanySettingsParamsSchema.parse(
      wrap({
        bank_name: 'Testbanken',
        clearing_number: '1234',
        account_number: '1234567',
        bankgiro: '5050-1055',
        default_our_reference: 'Test Contact',
      }),
    )
    expect(parsed.changes.bankgiro).toBe('5050-1055')
    expect(parsed.changes.default_our_reference).toBe('Test Contact')
  })

  it('accepts email, phone and website', () => {
    const parsed = UpdateCompanySettingsParamsSchema.parse(
      wrap({
        email: 'faktura@example.se',
        phone: '08-123 456 78',
        website: 'https://example.se',
      }),
    )
    expect(parsed.changes.email).toBe('faktura@example.se')
    expect(parsed.changes.phone).toBe('08-123 456 78')
    expect(parsed.changes.website).toBe('https://example.se')
  })

  it('accepts an empty-string email (clears the value)', () => {
    const parsed = UpdateCompanySettingsParamsSchema.parse(wrap({ email: '' }))
    expect(parsed.changes.email).toBe('')
  })

  it('rejects a malformed email', () => {
    expect(() =>
      UpdateCompanySettingsParamsSchema.parse(wrap({ email: 'not-an-email' })),
    ).toThrow()
  })

  it('accepts invoice_email_texts overrides for sv and en', () => {
    const parsed = UpdateCompanySettingsParamsSchema.parse(
      wrap({
        invoice_email_texts: {
          sv: { subject: 'Faktura {fakturanummer}', body: 'Tack for fortroendet.' },
          en: { greeting: 'Hi {förnamn},', signoff: 'Best regards' },
        },
      }),
    )
    expect(parsed.changes.invoice_email_texts?.sv?.subject).toBe('Faktura {fakturanummer}')
    expect(parsed.changes.invoice_email_texts?.en?.greeting).toBe('Hi {förnamn},')
  })

  it('accepts null invoice_email_texts (clears every override)', () => {
    const parsed = UpdateCompanySettingsParamsSchema.parse(
      wrap({ invoice_email_texts: null }),
    )
    expect(parsed.changes.invoice_email_texts).toBeNull()
  })

  it('requires at least one field', () => {
    expect(() => UpdateCompanySettingsParamsSchema.parse(wrap({}))).toThrow(/at least one/i)
  })
})

describe('UpdateCompanySettingsParamsSchema: excluded fields stay excluded', () => {
  const excluded: Array<[key: string, value: unknown]> = [
    ['vat_registered', true],
    ['invoice_email_cc_addresses', ['kopia@example.se']],
    ['invoice_email_bcc_addresses', ['dold@example.se']],
    ['defer_invoice_booking', true],
    ['default_voucher_series', 'B'],
    ['org_number', '556677-8899'],
  ]

  it.each(excluded)('rejects %s via .strict()', (key, value) => {
    expect(() =>
      UpdateCompanySettingsParamsSchema.parse(wrap({ bank_name: 'Testbanken', [key]: value })),
    ).toThrow(/unrecognized key/i)
  })
})

describe('UpdateCompanySettingsParamsSchema: placeholder validation', () => {
  it('accepts every placeholder in the fixed set', () => {
    const body =
      'Faktura {fakturanummer} till {kundnamn} ({förnamn}) fran {företag}, forfaller {förfallodatum}, belopp {belopp}.'
    expect(() =>
      UpdateCompanySettingsParamsSchema.parse(
        wrap({ invoice_email_texts: { sv: { body } } }),
      ),
    ).not.toThrow()
  })

  it('normalises placeholder case and whitespace like the renderer does', () => {
    expect(() =>
      UpdateCompanySettingsParamsSchema.parse(
        wrap({ invoice_email_texts: { sv: { subject: 'Faktura { Fakturanummer }' } } }),
      ),
    ).not.toThrow()
  })

  it('rejects an unknown placeholder such as {ocr}', () => {
    expect(() =>
      UpdateCompanySettingsParamsSchema.parse(
        wrap({ invoice_email_texts: { sv: { body: 'Betala med OCR {ocr}.' } } }),
      ),
    ).toThrow(/unknown placeholder \{ocr\}/i)
  })

  it('rejects an invented near-miss placeholder in any language and field', () => {
    expect(() =>
      UpdateCompanySettingsParamsSchema.parse(
        wrap({ invoice_email_texts: { en: { subject: 'Invoice {faktura_nr}' } } }),
      ),
    ).toThrow(/unknown placeholder \{faktura_nr\}/i)
  })
})
