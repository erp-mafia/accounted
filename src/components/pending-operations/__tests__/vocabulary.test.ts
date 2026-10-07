/**
 * singleActionWarning: the consequence sentence the approver consents to
 * must describe what the commit executor will actually do. convert_invoice
 * is the one type whose outcome depends on its params (target 'order').
 *
 * complianceWarningOf: the one reading of a staged compliance warning that the
 * Granskning row, the bulk confirmation and the preview share (crm#1003).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { complianceWarningOf, singleActionWarning, singleActionWarnings } from '../vocabulary'

describe('singleActionWarning', () => {
  it('promises a faktura with F-number for convert_invoice without a target (and with target invoice)', () => {
    expect(singleActionWarning('convert_invoice')).toContain('F-nummer')
    expect(singleActionWarning('convert_invoice', { invoice_id: 'q-1' })).toContain('F-nummer')
    expect(singleActionWarning('convert_invoice', { invoice_id: 'q-1', target: 'invoice' })).toContain('F-nummer')
  })

  it('describes a draft kundorder and no booking for convert_invoice with target order', () => {
    const sentence = singleActionWarning('convert_invoice', { invoice_id: 'q-1', target: 'order' })
    expect(sentence).toContain('kundorder')
    expect(sentence).toContain('Ingen faktura')
    expect(sentence).not.toContain('F-nummer')
  })

  it('ignores params for every other operation type', () => {
    expect(singleActionWarning('credit_invoice', { target: 'order' })).toBe(singleActionWarnings.credit_invoice)
    expect(singleActionWarning('unknown_type', { target: 'order' })).toBe('')
  })
})

describe('complianceWarningOf', () => {
  const sharedDocumentNote =
    'Samma underlag är redan kopplat eller föreslaget: förslag 1a2b3c4d (verifikat 5e6f7a8b). Ett underlag hör normalt till ett köp.'

  it('returns null when the operation carries no warning', () => {
    expect(complianceWarningOf({ operation_type: 'link_document_to_voucher', preview_data: {} })).toBeNull()
    expect(complianceWarningOf({ operation_type: 'link_document_to_voucher', preview_data: null })).toBeNull()
    expect(complianceWarningOf({ operation_type: 'link_document_to_voucher' })).toBeNull()
  })

  it('treats a blank or non-string compliance_warning as no warning', () => {
    expect(
      complianceWarningOf({ operation_type: 'attach_document_to_transaction', preview_data: { compliance_warning: '   ' } }),
    ).toBeNull()
    expect(
      complianceWarningOf({ operation_type: 'attach_document_to_transaction', preview_data: { compliance_warning: true } }),
    ).toBeNull()
  })

  it('passes the staged note through as written for the document link types', () => {
    for (const operationType of ['link_document_to_voucher', 'attach_document_to_transaction', 'match_transaction_invoice']) {
      expect(
        complianceWarningOf({ operation_type: operationType, preview_data: { compliance_warning: ` ${sharedDocumentNote} ` } }),
      ).toEqual({ kind: 'note', text: sharedDocumentNote })
    }
  })

  it('reads create_voucher\'s English agent note as the missing-underlag warning the UI words itself', () => {
    expect(
      complianceWarningOf({
        operation_type: 'create_voucher',
        preview_data: { compliance_warning: 'No underlag attached (document_attached: false). Restage with inbox_item_id.' },
      }),
    ).toEqual({ kind: 'missing_underlag' })
  })

  it('reads invoice VAT explanations from the Swedish vat_warnings, never the English compliance_warning', () => {
    const preview = {
      compliance_warning: 'EU_CUSTOMER_SWEDISH_VAT: Swedish VAT on an EU customer.',
      vat_warnings: [
        { code: 'EU_CUSTOMER_SWEDISH_VAT', message_sv: 'Kunden är ett EU-företag men fakturan har svensk moms.' },
        { code: 'BROKEN' },
      ],
    }
    expect(complianceWarningOf({ operation_type: 'create_invoice', preview_data: preview })).toEqual({
      kind: 'vat',
      text: 'Kunden är ett EU-företag men fakturan har svensk moms.',
    })
    expect(complianceWarningOf({ operation_type: 'update_invoice', preview_data: preview })).toEqual({
      kind: 'vat',
      text: 'Kunden är ett EU-företag men fakturan har svensk moms.',
    })
    // An invoice op without the Swedish list has nothing the approver can read.
    expect(
      complianceWarningOf({
        operation_type: 'create_invoice',
        preview_data: { compliance_warning: 'EU_CUSTOMER_SWEDISH_VAT: Swedish VAT on an EU customer.' },
      }),
    ).toBeNull()
  })
})

/**
 * GenericPreview labels preview_data keys through pending.preview_field with a
 * dynamic key, which the message-keys suite cannot resolve statically: pin
 * that both locales label the same keys, so no key reads Swedish in one
 * locale and as a raw field name in the other.
 */
describe('pending.preview_field labels', () => {
  const read = (locale: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8')) as {
      pending: { preview_field: Record<string, string> }
    }

  it('labels the same keys in sv and en', () => {
    const sv = read('sv').pending.preview_field
    const en = read('en').pending.preview_field
    expect(Object.keys(sv).sort()).toEqual(Object.keys(en).sort())
    for (const value of [...Object.values(sv), ...Object.values(en)]) {
      expect(value.trim()).not.toBe('')
    }
  })

  it('labels every field link_document_to_voucher and its sibling link types stage', () => {
    const sv = read('sv').pending.preview_field
    for (const key of [
      'voucher_label',
      'voucher_date',
      'voucher_description',
      'voucher_status',
      'document_file_name',
      'document_mime_type',
      'transaction_description',
      'transaction_date',
      'transaction_amount',
      'invoice_number',
      'will_be_fully_paid',
    ]) {
      expect(sv[key], key).toBeTruthy()
    }
  })
})
