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
import { getRiskLevel } from '@/lib/pending-operations/risk-tiers'
import {
  complianceWarningOf,
  operationLabel,
  registerBookedInvoiceBulkLine,
  registerBookedSupplierInvoiceBulkLine,
  rowConsentSentence,
  singleActionWarning,
  singleActionWarnings,
} from '../vocabulary'

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

  it('names a part of the quote for convert_invoice with percent or amount (crm#1196)', () => {
    for (const params of [{ invoice_id: 'q-1', percent: 50 }, { invoice_id: 'q-1', amount: 12500 }]) {
      const sentence = singleActionWarning('convert_invoice', params)
      expect(sentence).toContain('F-nummer')
      expect(sentence).toContain('delen av offerten')
    }
  })

  it('ignores params for every other operation type', () => {
    expect(singleActionWarning('credit_invoice', { target: 'order' })).toBe(singleActionWarnings.credit_invoice)
    expect(singleActionWarning('unknown_type', { target: 'order' })).toBe('')
  })

  it('describes a registration of an already-booked invoice, not a draft, for create_invoice in register mode (crm#1094)', () => {
    const sentence = singleActionWarning('create_invoice', { mode: 'register_booked', invoice_number: '1023' })
    expect(sentence).toContain('kundreskontran')
    expect(sentence).toContain('där den redan är bokförd')
    expect(sentence).toContain('Ingen verifikation bokförs')
    expect(sentence).toContain('Registreringen kan inte ångras')
    expect(sentence).not.toContain('utkast')
    expect(singleActionWarning('create_invoice', { customer_id: 'c-1' })).toBe(singleActionWarnings.create_invoice)
  })
})

/**
 * A registration of an already-booked invoice cannot be undone but keeps
 * create_invoice's 'medium' tier, so it is bulk-approvable and approved from
 * the row without a dialog (crm#1094): the row and the bulk line are where
 * the approver reads "kan inte ångras".
 */
describe('rowConsentSentence and the bulk line', () => {
  const registration = { mode: 'register_booked', invoice_number: '1023' }

  it('keeps a registration bulk-approvable: create_invoice\'s medium tier, not high', () => {
    expect(getRiskLevel('create_invoice', registration)).toBe('medium')
  })

  it('shows the registration\'s sentence on its pending row although it is medium risk', () => {
    const sentence = rowConsentSentence({ operation_type: 'create_invoice', status: 'pending', risk_level: 'medium', params: registration })
    expect(sentence).toBe(singleActionWarning('create_invoice', registration))
    expect(sentence).toContain('Registreringen kan inte ångras')
  })

  it('keeps the rest of the rule: high risk shows its sentence, an ordinary medium draft and a resolved row do not', () => {
    expect(rowConsentSentence({ operation_type: 'close_period', status: 'pending', risk_level: 'high', params: {} })).toBe(singleActionWarnings.close_period)
    expect(rowConsentSentence({ operation_type: 'create_invoice', status: 'pending', risk_level: 'medium', params: { customer_id: 'c-1' } })).toBe('')
    expect(rowConsentSentence({ operation_type: 'create_invoice', status: 'committed', risk_level: 'medium', params: registration })).toBe('')
  })

  it('says in the bulk confirmation that registrations cannot be undone', () => {
    expect(registerBookedInvoiceBulkLine(1)).toBe('En redan bokförd faktura registreras i kundreskontran (inget bokförs, kan inte ångras).')
    expect(registerBookedInvoiceBulkLine(12)).toBe('12 redan bokförda fakturor registreras i kundreskontran (inget bokförs, kan inte ångras).')
  })
})

/**
 * The supplier side (crm#1094): gnubok_register_booked_supplier_invoice stages
 * under create_supplier_invoice_from_inbox with the same marker, and every
 * surface reads it the way it reads the kundreskontra registration.
 */
describe('a registration of an already-booked supplier invoice', () => {
  const registration = { mode: 'register_booked', supplier_invoice_number: '7781' }
  const t = (key: string) => `t:${key}`

  it('stays bulk-approvable at the inbox type\'s medium tier, and its row says it cannot be undone', () => {
    expect(getRiskLevel('create_supplier_invoice_from_inbox', registration)).toBe('medium')
    const sentence = rowConsentSentence({ operation_type: 'create_supplier_invoice_from_inbox', status: 'pending', risk_level: 'medium', params: registration })
    expect(sentence).toBe(singleActionWarning('create_supplier_invoice_from_inbox', registration))
    expect(sentence).toContain('leverantörsreskontran')
    expect(sentence).toContain('där den redan är bokförd')
    expect(sentence).toContain('fakturans rader hämtas från verifikationen')
    expect(sentence).toContain('Ingen verifikation bokförs')
    expect(sentence).toContain('Registreringen kan inte ångras')
    expect(sentence).not.toContain('kundreskontran')
  })

  it('leaves an ordinary inbox conversion as it was', () => {
    const inbox = { inbox_item_id: 'item-1', supplier_id: 's-1' }
    expect(rowConsentSentence({ operation_type: 'create_supplier_invoice_from_inbox', status: 'pending', risk_level: 'medium', params: inbox })).toBe('')
    expect(singleActionWarning('create_supplier_invoice_from_inbox', inbox)).toBe('')
    expect(operationLabel('create_supplier_invoice_from_inbox', t, inbox)).toBe('t:type_create_supplier_invoice_from_inbox')
  })

  it('has its own label, in both languages, and its own bulk line', () => {
    expect(operationLabel('create_supplier_invoice_from_inbox', t, registration)).toBe('t:type_register_booked_supplier_invoice')
    // The marker means a registration only under the two types that carry one.
    expect(operationLabel('credit_supplier_invoice', t, registration)).toBe('t:type_credit_supplier_invoice')
    for (const locale of ['sv', 'en']) {
      const messages = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8')) as {
        pending: Record<string, unknown> & { preview_field: Record<string, unknown> }
      }
      expect(messages.pending.type_register_booked_supplier_invoice, locale).toBeTruthy()
      expect(messages.pending.preview_field.arrival_number, locale).toBeTruthy()
    }
    expect(registerBookedSupplierInvoiceBulkLine(1)).toBe('En redan bokförd leverantörsfaktura registreras i leverantörsreskontran (inget bokförs, kan inte ångras).')
    expect(registerBookedSupplierInvoiceBulkLine(3)).toBe('3 redan bokförda leverantörsfakturor registreras i leverantörsreskontran (inget bokförs, kan inte ångras).')
  })

  it('reads its Swedish note as written', () => {
    const note = 'Verifikation D45 nämner inte fakturanummer 7781: kontrollera att det är fakturans verifikation.'
    expect(
      complianceWarningOf({ operation_type: 'create_supplier_invoice_from_inbox', preview_data: { compliance_warning: note } }),
    ).toEqual({ kind: 'note', text: note })
  })
})

describe('operationLabel', () => {
  const t = (key: string) => `t:${key}`

  it('labels a create_invoice in register mode as a registration, not a new invoice (crm#1094)', () => {
    expect(operationLabel('create_invoice', t, { mode: 'register_booked' })).toBe('t:type_register_booked_invoice')
    expect(operationLabel('create_invoice', t, { customer_id: 'c-1' })).toBe('t:type_create_invoice')
    expect(operationLabel('create_invoice', t)).toBe('t:type_create_invoice')
    expect(operationLabel('credit_invoice', t, { mode: 'register_booked' })).toBe('t:type_credit_invoice')
  })

  it('has the registration label in both languages', () => {
    for (const locale of ['sv', 'en']) {
      const messages = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8')) as {
        pending: Record<string, unknown>
      }
      expect(messages.pending.type_register_booked_invoice, locale).toBeTruthy()
    }
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

  it('reads a registration\'s Swedish note as written: it has no VAT explanation (crm#1094)', () => {
    const note = 'Verifikation B45 nämner inte fakturanummer 1023: kontrollera att det är fakturans verifikation.'
    expect(
      complianceWarningOf({ operation_type: 'create_invoice', preview_data: { mode: 'register_booked', compliance_warning: note } }),
    ).toEqual({ kind: 'note', text: note })
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
