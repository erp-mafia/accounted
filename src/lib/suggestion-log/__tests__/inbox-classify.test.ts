import { describe, it, expect } from 'vitest'
import { bookedTotals, changedFields, classifyInboxDecision, fieldsFromExtraction, resultAccounts } from '../inbox-classify'

const extraction = {
  supplier: { name: 'Telia Sverige AB', orgNumber: '556103-4249' },
  invoice: { invoiceNumber: 'F-123', invoiceDate: '2026-10-01', dueDate: '2026-10-31', paymentReference: '1234 5678', currency: 'SEK' },
  totals: { total: 500, vatAmount: 100, subtotal: 400 },
  lineItems: [{ accountSuggestion: '6212' }, { accountSuggestion: null }],
  confidence: 0.9,
  suggestedTemplateId: 'telecom_mobile',
}

const asRead = {
  supplier_name: 'Telia Sverige AB',
  supplier_org_number: '5561034249',
  invoice_number: 'F-123',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  payment_reference: '12345678',
  currency: 'SEK',
  total: 500,
  vat_amount: 100,
  accounts: ['6212'],
}

function booked(fields = asRead) {
  return { supplier_invoice_id: 'si-1', journal_entry_id: 'je-1', fields, lines: [] }
}

describe('fieldsFromExtraction', () => {
  it('reads the compared fields and the suggested result accounts', () => {
    expect(fieldsFromExtraction(extraction)).toMatchObject({ supplier_name: 'Telia Sverige AB', total: 500, accounts: ['6212'] })
  })

  it('leaves accounts uncompared when the model suggested none', () => {
    expect(fieldsFromExtraction({ ...extraction, lineItems: [] })).not.toHaveProperty('accounts')
  })
})

describe('changedFields', () => {
  it('ignores spacing, case and separators in what a person retypes', () => {
    expect(changedFields(fieldsFromExtraction(extraction), { ...asRead, supplier_name: 'TELIA  sverige ab', supplier_org_number: '556103-4249' })).toEqual([])
  })

  it('names each field that differs, and a field the model missed but the person filled', () => {
    const original = fieldsFromExtraction({ ...extraction, invoice: { ...extraction.invoice, dueDate: null } })
    expect(changedFields(original, { ...asRead, total: 499.5, accounts: ['6211'] })).toEqual(['due_date', 'total', 'accounts'])
  })

  it('does not compare a field the booking does not state', () => {
    expect(changedFields(fieldsFromExtraction(extraction), { total: 500 })).toEqual([])
  })
})

describe('classifyInboxDecision', () => {
  it('accepted: registered as read', () => {
    const out = classifyInboxDecision({ extraction, model: 'claude-sonnet', sourceId: 'doc-1', booked: booked() })
    expect(out).toMatchObject({ outcome: 'accepted', acted_on: 0 })
    expect(out.suggestions[0]).toMatchObject({
      source: 'extraction',
      source_id: 'doc-1',
      confidence: 0.9,
      model: 'claude-sonnet',
      matches_final: true,
      proposal: { suggested_template_id: 'telecom_mobile' },
    })
    expect(out.final?.changed_fields).toEqual([])
  })

  it('changed: a field was corrected before registering', () => {
    const out = classifyInboxDecision({ extraction, model: null, sourceId: 'doc-1', booked: booked({ ...asRead, invoice_number: 'F-124' }) })
    expect(out).toMatchObject({ outcome: 'changed', acted_on: 0, final: { changed_fields: ['invoice_number'] } })
    expect(out.suggestions[0].matches_final).toBe(false)
  })

  it('manual: nothing was read to start from', () => {
    const out = classifyInboxDecision({ extraction: null, model: null, sourceId: 'doc-1', booked: booked() })
    expect(out).toMatchObject({ outcome: 'manual', acted_on: null, suggestions: [] })
  })

  it('dismissed: the item was deleted', () => {
    const out = classifyInboxDecision({ extraction, model: null, sourceId: 'doc-1', booked: null })
    expect(out).toMatchObject({ outcome: 'dismissed', acted_on: null, final: null })
    expect(out.suggestions[0].matches_final).toBe(false)
  })
})

describe('bookedTotals', () => {
  it('reads the gross of a purchase with VAT', () => {
    expect(bookedTotals([
      { account: '6212', debit: 400, credit: 0 },
      { account: '2641', debit: 100, credit: 0 },
      { account: '1930', debit: 0, credit: 500 },
    ])).toEqual({ total: 500, vat_amount: 100 })
  })

  it('does not count the self-assessed pair of a reverse charge', () => {
    expect(bookedTotals([
      { account: '6540', debit: 500, credit: 0 },
      { account: '2645', debit: 125, credit: 0 },
      { account: '2614', debit: 0, credit: 125 },
      { account: '1930', debit: 0, credit: 500 },
    ])).toEqual({ total: 500, vat_amount: 0 })
  })

  it('reads the gross of an asset bought on a balance-sheet account', () => {
    expect(bookedTotals([
      { account: '1220', debit: 800, credit: 0 },
      { account: '2641', debit: 200, credit: 0 },
      { account: '1930', debit: 0, credit: 1000 },
    ])).toEqual({ total: 1000, vat_amount: 200 })
  })
})

describe('resultAccounts', () => {
  it('keeps result accounts only, sorted and unique', () => {
    expect(resultAccounts(['6212', '2641', '1930', '6212', '4010', null, '2440'])).toEqual(['4010', '6212'])
  })
})
