import { describe, expect, it } from 'vitest'
import { UpdateInboxItemFieldsSchema } from '@/lib/documents/inbox-item-actions'
import type { DocumentReading } from '@/lib/documents/reading/types'
import svMessages from '@/messages/sv.json'
import enMessages from '@/messages/en.json'
import {
  ALWAYS_SHOWN,
  EDITABLE_FIELDS,
  PANEL_FIELDS,
  buildFieldUpdate,
  editInputValue,
  evidenceLabelKey,
  fieldLabelKey,
  formatFieldValue,
  formatRate,
  isEditableField,
  panelRows,
  personField,
  readingCurrency,
  sourceLabelKey,
  whereRead,
} from '../fields'

function reading(fields: DocumentReading['fields']): DocumentReading {
  return {
    document_id: 'doc-1',
    inbox_item_id: 'item-1',
    fields,
    door: { intake_source: null, sender: null, received_at: null },
    notes: [],
  }
}

const RECEIPT = reading({
  seller_name: { value: 'Kafé Exempel', source: 'vision', evidence: 'stark', corroborated_by: ['second_reading'], page: 1, quote: 'KAFÉ EXEMPEL' },
  invoice_issue_date: { value: '2026-10-02', source: 'vision', evidence: 'trolig' },
  amount_due_for_payment: { value: 148, source: 'person', evidence: 'ditt_val' },
  invoice_currency_code: { value: 'SEK', source: 'vision', evidence: 'trolig' },
  document_type: { value: 'receipt', source: 'vision', evidence: 'trolig' },
})

describe('panelRows', () => {
  it('lists what the reading holds in panel order, the always-shown fields included', () => {
    expect(panelRows(RECEIPT).map((r) => r.name)).toEqual([
      'seller_name',
      'invoice_issue_date',
      'invoice_currency_code',
      'amount_due_for_payment',
    ])
  })

  it('shows the fields booking needs even on an item nothing read, empty and editable', () => {
    const rows = panelRows(reading({}))
    expect(rows.map((r) => r.name)).toEqual(['seller_name', 'invoice_issue_date', 'amount_due_for_payment'])
    expect(rows.every((r) => r.field === null && r.editable)).toBe(true)
    expect(panelRows(null).map((r) => r.name)).toEqual([...ALWAYS_SHOWN].sort((a, b) => PANEL_FIELDS.indexOf(a) - PANEL_FIELDS.indexOf(b)))
  })

  it('asks for the credited invoice on a credit note', () => {
    const credit = reading({ document_type: { value: 'credit_note', source: 'vision', evidence: 'trolig' } })
    expect(panelRows(credit).map((r) => r.name)).toContain('preceding_invoice_reference')
  })

  it('keeps a value a person cleared, and lists document kind nowhere', () => {
    const cleared = reading({ invoice_number: { value: null, source: 'person', evidence: 'ditt_val' } })
    const rows = panelRows(cleared)
    expect(rows.find((r) => r.name === 'invoice_number')?.field).toEqual({ value: null, source: 'person', evidence: 'ditt_val' })
    expect(rows.map((r) => r.name as string)).not.toContain('document_type')
  })

  it('makes nothing editable on a locked item, and the read-only fields never', () => {
    expect(panelRows(RECEIPT, { locked: true }).some((r) => r.editable)).toBe(false)
    const xml = reading({
      seller_country_code: { value: 'SE', source: 'xml', evidence: 'exakt' },
      payment_account_iban: { value: 'SE4550000000058398257466', source: 'xml', evidence: 'exakt' },
      vat_breakdown: { value: [], source: 'xml', evidence: 'exakt' },
      invoice_lines: { value: [], source: 'xml', evidence: 'exakt' },
    })
    const readOnly = panelRows(xml).filter((r) => ['seller_country_code', 'payment_account_iban', 'vat_breakdown', 'invoice_lines'].includes(r.name))
    expect(readOnly).toHaveLength(4)
    expect(readOnly.every((r) => !r.editable)).toBe(true)
  })
})

describe('labels', () => {
  const sv = svMessages as unknown as { inkorg_fields: Record<string, Record<string, string>> }
  const en = enMessages as unknown as { inkorg_fields: Record<string, Record<string, string>> }
  const lookup = (messages: typeof sv, key: string) => {
    const [group, name] = key.split('.')
    return messages.inkorg_fields[group]?.[name]
  }

  it('names every field, source and level in Swedish and English, never as a number', () => {
    const keys = [
      ...PANEL_FIELDS.map(fieldLabelKey),
      ...(['xml', 'text', 'vision', 'door', 'person'] as const).map(sourceLabelKey),
      ...(['exakt', 'stark', 'trolig', 'ditt_val'] as const).map(evidenceLabelKey),
    ]
    for (const key of keys) {
      expect(lookup(sv, key), `sv ${key}`).toBeTruthy()
      expect(lookup(en, key), `en ${key}`).toBeTruthy()
      expect(lookup(sv, key)).not.toMatch(/\d\s*%/)
    }
    expect(lookup(sv, 'field.seller_name')).toBe('Leverantör')
    expect(lookup(sv, 'field.seller_legal_registration_identifier')).toBe('Org.nr')
    expect(lookup(sv, 'field.amount_due_for_payment')).toBe('Att betala')
    expect(lookup(sv, 'source.xml')).toBe('e-faktura')
    expect(lookup(sv, 'source.door')).toBe('brevlåda')
    expect(lookup(sv, 'source.person')).toBe('du')
    expect(lookup(sv, 'evidence.ditt_val')).toBe('Ditt val')
    expect(lookup(en, 'evidence.ditt_val')).toBe('Your choice')
  })
})

describe('formatFieldValue', () => {
  it('formats amounts, dates, org numbers and giro numbers with the repo helpers', () => {
    expect(formatFieldValue('amount_due_for_payment', 1234.5)).toEqual({ kind: 'text', text: '1 234,50 kr', numeric: true })
    expect(formatFieldValue('amount_due_for_payment', 99, 'EUR')).toMatchObject({ kind: 'text', text: '99 €' })
    expect(formatFieldValue('invoice_issue_date', '2026-10-02')).toMatchObject({ text: '2026-10-02' })
    expect(formatFieldValue('seller_legal_registration_identifier', '5500000001')).toMatchObject({ text: '550000-0001' })
    expect(formatFieldValue('payment_account_bankgiro', '1234566')).toMatchObject({ text: '123-4566' })
    expect(formatFieldValue('payment_account_plusgiro', '45674')).toMatchObject({ text: '4567-4' })
    expect(formatFieldValue('payment_account_iban', 'se4550000000058398257466')).toMatchObject({ text: 'SE45 5000 0000 0583 9825 7466' })
    expect(formatFieldValue('seller_name', 'Kafé Exempel')).toEqual({ kind: 'text', text: 'Kafé Exempel', numeric: false })
  })

  it('reads an absent or cleared value as empty', () => {
    expect(formatFieldValue('seller_name', null)).toEqual({ kind: 'empty' })
    expect(formatFieldValue('invoice_number', '')).toEqual({ kind: 'empty' })
    expect(formatFieldValue('amount_due_for_payment', 'nope')).toEqual({ kind: 'empty' })
    expect(formatFieldValue('vat_breakdown', [])).toEqual({ kind: 'empty' })
  })

  it('lists the VAT breakdown per rate and the lines with their amounts', () => {
    expect(
      formatFieldValue('vat_breakdown', [
        { vat_category_rate: 25, vat_category_taxable_amount: 1000, vat_category_tax_amount: 250 },
        { vat_category_rate: 12.5, vat_category_taxable_amount: 100, vat_category_tax_amount: 12.5 },
      ]),
    ).toEqual({
      kind: 'vat',
      rows: [
        { rate: '25 %', base: '1 000 kr', tax: '250 kr' },
        { rate: '12,5 %', base: '100 kr', tax: '12,50 kr' },
      ],
    })
    expect(
      formatFieldValue('invoice_lines', [
        {
          invoice_line_identifier: '1',
          item_name: 'Konsulttimme',
          invoiced_quantity: 2,
          item_net_price: 500,
          invoice_line_net_amount: 1000,
          invoiced_item_vat_category_code: 'S',
          invoiced_item_vat_rate: 25,
        },
      ]),
    ).toEqual({ kind: 'lines', rows: [{ name: 'Konsulttimme', quantity: '2', amount: '1 000 kr' }] })
    expect(formatRate(6)).toBe('6 %')
  })

  it('takes the currency from the reading, SEK when it has none', () => {
    expect(readingCurrency(RECEIPT)).toBe('SEK')
    expect(readingCurrency(reading({ invoice_currency_code: { value: 'EUR', source: 'xml', evidence: 'exakt' } }))).toBe('EUR')
    expect(readingCurrency(null)).toBe('SEK')
  })
})

describe('whereRead', () => {
  it('answers the page and quote when a reading located the value, else null', () => {
    expect(whereRead(RECEIPT.fields.seller_name!)).toEqual({ page: 1, quote: 'KAFÉ EXEMPEL' })
    expect(whereRead(RECEIPT.fields.invoice_issue_date!)).toBeNull()
    expect(whereRead({ value: 'x', source: 'vision', evidence: 'trolig', page: 0, quote: '  ' })).toBeNull()
    expect(whereRead(null)).toBeNull()
  })
})

describe('editInputValue', () => {
  it('starts the field in the form a person types it', () => {
    expect(editInputValue('amount_due_for_payment', 1234.5)).toBe('1234,50')
    expect(editInputValue('invoice_issue_date', '2026-10-02')).toBe('2026-10-02')
    expect(editInputValue('seller_name', null)).toBe('')
  })
})

describe('buildFieldUpdate', () => {
  it('maps every editable field to its place in the field correction, and nothing else', () => {
    const typed: Record<(typeof EDITABLE_FIELDS)[number], [string, unknown]> = {
      seller_name: ['Kafé Exempel AB', { supplier: { name: 'Kafé Exempel AB' } }],
      seller_legal_registration_identifier: ['550000-0001', { supplier: { orgNumber: '550000-0001' } }],
      seller_vat_identifier: ['SE550000000101', { supplier: { vatNumber: 'SE550000000101' } }],
      invoice_number: ['F-1', { invoice: { invoiceNumber: 'F-1' } }],
      invoice_issue_date: ['2026-10-02', { invoice: { invoiceDate: '2026-10-02' } }],
      payment_due_date: ['2026-11-01', { invoice: { dueDate: '2026-11-01' } }],
      invoice_currency_code: ['eur', { invoice: { currency: 'EUR' } }],
      amount_due_for_payment: ['1 234,50', { totals: { total: 1234.5 } }],
      remittance_information: ['1234567897', { invoice: { paymentReference: '1234567897' } }],
      payment_account_bankgiro: ['123-4566', { supplier: { bankgiro: '123-4566' } }],
      payment_account_plusgiro: ['4567-4', { supplier: { plusgiro: '4567-4' } }],
      preceding_invoice_reference: ['INV-0900', { invoice: { creditedInvoiceNumber: 'INV-0900' } }],
    }
    for (const field of EDITABLE_FIELDS) {
      const [input, body] = typed[field]
      const out = buildFieldUpdate(field, input)
      expect(out, field).toMatchObject({ ok: true, body })
      if (out.ok) expect(UpdateInboxItemFieldsSchema.parse(out.body), field).toEqual(body)
    }
  })

  it('clears a field left empty, except the currency', () => {
    expect(buildFieldUpdate('invoice_number', '   ')).toEqual({ ok: true, body: { invoice: { invoiceNumber: null } }, value: null })
    expect(buildFieldUpdate('payment_due_date', '')).toEqual({ ok: true, body: { invoice: { dueDate: null } }, value: null })
    expect(buildFieldUpdate('amount_due_for_payment', '')).toEqual({ ok: true, body: { totals: { total: null } }, value: null })
    expect(buildFieldUpdate('invoice_currency_code', '')).toEqual({ ok: false, error: 'required' })
  })

  it('refuses what the correction would refuse, or what would pay the wrong place', () => {
    expect(buildFieldUpdate('invoice_issue_date', '2026-02-30')).toEqual({ ok: false, error: 'invalid_date' })
    expect(buildFieldUpdate('invoice_issue_date', '2/10 2026')).toEqual({ ok: false, error: 'invalid_date' })
    expect(buildFieldUpdate('amount_due_for_payment', '1.234.567')).toEqual({ ok: false, error: 'invalid_amount' })
    expect(buildFieldUpdate('amount_due_for_payment', 'tusen')).toEqual({ ok: false, error: 'invalid_amount' })
    expect(buildFieldUpdate('invoice_currency_code', 'kronor')).toEqual({ ok: false, error: 'invalid_currency' })
    expect(buildFieldUpdate('payment_account_bankgiro', '123-4568')).toEqual({ ok: false, error: 'invalid_bankgiro' })
    expect(buildFieldUpdate('payment_account_plusgiro', '4567-5')).toEqual({ ok: false, error: 'invalid_plusgiro' })
    expect(buildFieldUpdate('seller_name', 'x'.repeat(501))).toEqual({ ok: false, error: 'too_long' })
  })

  it('rounds a typed amount to the öre and keeps its sign', () => {
    expect(buildFieldUpdate('amount_due_for_payment', '10,075')).toMatchObject({ value: 10.08 })
    expect(buildFieldUpdate('amount_due_for_payment', '-500')).toMatchObject({ body: { totals: { total: -500 } } })
  })

  it('only offers fields the correction can write', () => {
    expect(isEditableField('payment_account_iban')).toBe(false)
    expect(isEditableField('seller_country_code')).toBe(false)
    expect(isEditableField('seller_name')).toBe(true)
  })
})

describe('personField', () => {
  it('reads a saved value as Ditt val, keeping where it stands when the value did not change', () => {
    const before = RECEIPT.fields.seller_name!
    expect(personField('Kafé Exempel', before)).toEqual({ value: 'Kafé Exempel', source: 'person', evidence: 'ditt_val', page: 1, quote: 'KAFÉ EXEMPEL' })
    expect(personField('Annat', before)).toEqual({ value: 'Annat', source: 'person', evidence: 'ditt_val' })
    expect(personField(null, null)).toEqual({ value: null, source: 'person', evidence: 'ditt_val' })
  })
})
