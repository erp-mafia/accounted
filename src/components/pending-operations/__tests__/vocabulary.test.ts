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
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { getRiskLevel, OPERATION_RISK_TIERS, PENDING_OPERATION_TYPES } from '@/lib/pending-operations/risk-tiers'
import {
  complianceWarningOf,
  operationLabel,
  registerBookedInvoiceBulkLine,
  registerBookedSupplierInvoiceBulkLine,
  rowConsentSentence,
  SINGLE_ACTION_WARNING_KEYS,
  singleActionWarning,
  singleActionWarnings,
} from '../vocabulary'

describe('singleActionWarning: rules for automatic booking', () => {
  it("says what a supplier's rule lets through, and keeps the bank-line sentence for a bank-line rule", () => {
    const supplier = singleActionWarning('create_grant', { operation_type: 'create_supplier_invoice_from_inbox', supplier_id: 's-1' })
    expect(supplier).toContain('leverantörens fakturor från inkorgen')
    expect(supplier).toContain('en agent kan aldrig godkänna en regel')
    expect(supplier).not.toMatch(/[\u2013\u2014]/)
    expect(singleActionWarning('create_grant', { operation_type: 'categorize_transaction' })).toBe(singleActionWarnings.create_grant)
    expect(rowConsentSentence({ operation_type: 'create_grant', status: 'pending', risk_level: 'high', params: { operation_type: 'create_supplier_invoice_from_inbox' } }))
      .toBe(supplier)
  })
})

describe('singleActionWarning', () => {
  // crm#1281: a kontantfaktura staged by gnubok_mark_invoice_as_sent ends
  // paid, with one cash verifikat; the plain mark-sent keeps its sentence.
  it('says a mark_invoice_sent with paid_at_issue issues the invoice already paid', () => {
    const sentence = singleActionWarning('mark_invoice_sent', { invoice_id: 'i-1', paid_at_issue: { account_number: '1930' } })
    expect(sentence).toContain('redan betald')
    expect(sentence).toContain('utan kundfordran')
    expect(sentence).not.toMatch(/[\u2013\u2014]/)
    expect(singleActionWarning('mark_invoice_sent', { invoice_id: 'i-1' })).toBe(singleActionWarnings.mark_invoice_sent)
  })

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
 * crm#1605: a change of two invoice texts was approved under "Betalningsuppgifterna
 * styr vart kunderna betalar kommande fakturor", though no payment detail
 * changed. The clause is said only when a payee field changes.
 */
describe('singleActionWarning: company settings (crm#1605)', () => {
  const t = (key: string) => (sv.pending as unknown as Record<string, string>)[key]
  const PAYMENT_CLAUSE = 'Betalningsuppgifterna styr vart kunderna betalar kommande fakturor.'

  it('leaves the payment clause out of a change without payment details', () => {
    const sentence = singleActionWarning('update_company_settings', { invoice_footer_text: 'Tack', invoice_late_fee_text: 'Ränta' }, t)
    expect(sentence).toBe('Genom att klicka godkänn så ändras företagsinställningarna.')
    expect(singleActionWarning('update_company_settings', { invoice_show_bankgiro: false, invoice_qr_mode: 'none' }, t)).not.toContain(PAYMENT_CLAUSE)
  })

  it('says it for every field of the invoice payment account and for the per-currency map', () => {
    for (const field of ['bank_name', 'clearing_number', 'account_number', 'bankgiro', 'plusgiro', 'swish', 'iban', 'bic', 'invoice_payment_accounts']) {
      expect(singleActionWarning('update_company_settings', { [field]: null }, t), field).toContain(PAYMENT_CLAUSE)
    }
  })

  it('reads a row staged before settings.update under its changes, and keeps the clause when the params are unknown', () => {
    expect(singleActionWarning('update_company_settings', { changes: { bankgiro: '991-2346' } }, t)).toContain(PAYMENT_CLAUSE)
    expect(singleActionWarning('update_company_settings', { changes: { email: 'a@b.se' } }, t)).not.toContain(PAYMENT_CLAUSE)
    expect(singleActionWarning('update_company_settings', null, t)).toContain(PAYMENT_CLAUSE)
  })

  it('has both sentences in English too', () => {
    expect(en.pending.warning_update_company_settings).toBeTruthy()
    expect(en.pending.warning_update_company_settings_payment).toBeTruthy()
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

describe('keyed consequence sentences (crm#1367)', () => {
  const messages = (lang: 'sv' | 'en') =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'messages', `${lang}.json`), 'utf8')) as {
      pending: Record<string, string>
    }

  it("reads the set-off's sentence from the user's language, in the dialog and the row", () => {
    const en = messages('en').pending
    const t = (key: string) => en[key] ?? key
    const sentence = singleActionWarning('book_counterparty_setoff', {}, t)
    expect(sentence).toBe(en.warning_book_counterparty_setoff)
    expect(sentence).toMatch(/^By clicking approve/)
    expect(rowConsentSentence({ operation_type: 'book_counterparty_setoff', status: 'pending', risk_level: 'high', params: {} }, t)).toBe(sentence)
  })

  it('has every keyed sentence in both languages and no literal beside it', () => {
    const sv = messages('sv').pending
    const en = messages('en').pending
    for (const [type, key] of Object.entries(SINGLE_ACTION_WARNING_KEYS)) {
      expect(sv[key], `sv pending.${key}`).toBeTruthy()
      expect(en[key], `en pending.${key}`).toBeTruthy()
      expect(singleActionWarnings[type], `${type} literal`).toBeUndefined()
    }
  })
})

/**
 * A high-tier approval opens a dialog whose sentence is the consent: what the
 * approval books, sends or files. Eight high types once had none, so the
 * dialog and the Granskning row showed nothing (accounted#22). The list comes
 * from the tier table, so a new high type fails here until it has one.
 */
describe('a consent sentence for every high-tier operation (accounted#22)', () => {
  const messages = (lang: 'sv' | 'en') =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'messages', `${lang}.json`), 'utf8')) as {
      pending: Record<string, string>
    }
  const translator = (lang: 'sv' | 'en') => {
    const pending = messages(lang).pending
    return (key: string) => pending[key] ?? ''
  }
  const highTypes = PENDING_OPERATION_TYPES.filter((type) => OPERATION_RISK_TIERS[type] === 'high')

  it('shows a sentence on the pending row and in the dialog of every high type, in both languages', () => {
    expect(highTypes.length).toBeGreaterThan(50)
    for (const lang of ['sv', 'en'] as const) {
      const t = translator(lang)
      const missing = highTypes.filter((type) => {
        const row = rowConsentSentence({ operation_type: type, status: 'pending', risk_level: 'high', params: {} }, t)
        return !row.trim() || singleActionWarning(type, {}, t) !== row
      })
      expect(missing, lang).toEqual([])
    }
  })

  it('says what the filings and payroll approvals do, without dashes', () => {
    const sv = messages('sv').pending
    const en = messages('en').pending
    const expectations: Record<string, { sv: string; en: string }> = {
      submit_vat_declaration: { sv: 'inlämnad först när', en: 'filed only once' },
      submit_agi: { sv: 'inlämnad först när', en: 'filed only once' },
      generate_agi: { sv: 'Inget skickas till Skatteverket', en: 'Nothing is sent to Skatteverket' },
      book_salary_run: { sv: 'markeras som utbetald', en: 'marked as paid' },
      settle_rot_rut_payout: { sv: 'ROT/RUT-utbetalning', en: 'ROT/RUT payout' },
      post_kontantmetod_cutoff: { sv: 'räkenskapsårets sista dag', en: 'last day of the financial year' },
      vacation_year_close: { sv: 'Avslutet kan inte ångras', en: 'cannot be undone' },
      bulk_book_inbox_items: { sv: 'hoppas över', en: 'skipped' },
    }
    for (const [type, expected] of Object.entries(expectations)) {
      const key = SINGLE_ACTION_WARNING_KEYS[type]
      expect(key, type).toBe(`warning_${type}`)
      expect(sv[key]).toMatch(/^Genom att klicka godkänn så /)
      expect(sv[key]).toContain(expected.sv)
      expect(en[key]).toMatch(/^By clicking approve, /)
      expect(en[key]).toContain(expected.en)
      expect(`${sv[key]} ${en[key]}`).not.toMatch(/[\u2013\u2014]/)
    }
  })

  it('warns that a recurring schedule with auto_send emails every run, exactly when that raises it to high', () => {
    for (const lang of ['sv', 'en'] as const) {
      const t = translator(lang)
      const expected = messages(lang).pending.warning_recurring_schedule_auto_send
      expect(expected).toBeTruthy()
      for (const type of ['create_recurring_schedule', 'update_recurring_schedule']) {
        expect(getRiskLevel(type, { auto_send: true })).toBe('high')
        expect(singleActionWarning(type, { auto_send: true }, t)).toBe(expected)
        expect(rowConsentSentence({ operation_type: type, status: 'pending', risk_level: 'high', params: { auto_send: true } }, t)).toBe(expected)
        // Without auto_send the schedule stays medium and its row shows nothing.
        expect(getRiskLevel(type, { auto_send: false })).toBe('medium')
        expect(singleActionWarning(type, { auto_send: false }, t)).toBe('')
      }
    }
    expect(messages('sv').pending.warning_recurring_schedule_auto_send).toContain('mejlas till kunden')
  })
})
