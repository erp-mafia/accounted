import { describe, expect, it } from 'vitest'
import {
  collectionClaim,
  evaluateEligibility,
  missingAddressFields,
  normalizeOrgNumberDigits,
  type EligibilityFacts,
} from '../eligibility'

const TODAY = '2026-10-06'

function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    invoice: {
      id: 'inv-1',
      status: 'sent',
      document_type: 'invoice',
      credited_invoice_id: null,
      is_self_billed: false,
      currency: 'SEK',
      invoice_number: '1042',
      invoice_date: '2026-08-01',
      due_date: '2026-08-31',
      total: 1250,
      vat_amount: 250,
      paid_amount: 0,
      remaining_amount: 1250,
      deduction_total: null,
      deduction_reclaimed_total: null,
      ore_rounding: null,
    },
    customer: {
      id: 'cust-1',
      name: 'Kund AB',
      customer_type: 'swedish_business',
      country: 'SE',
      address_line1: 'Storgatan 1',
      postal_code: '111 22',
      city: 'Stockholm',
      org_number: '556012-5790',
      personalNumber: { status: 'none' },
    },
    today: TODAY,
    companyOreRounding: null,
    connection: { minimum_amount: 100, reminder_fee_terms_since: null },
    features: null,
    openCase: null,
    creditNotes: [],
    delivery: 'delivered',
    imported: false,
    reminderResponse: null,
    ...overrides,
  }
}

const codes = (f: EligibilityFacts) => evaluateEligibility(f).blocks.map((b) => b.code)

describe('evaluateEligibility', () => {
  it('passes a delivered, overdue business invoice with complete data', () => {
    const result = evaluateEligibility(facts())
    expect(result.eligible).toBe(true)
    expect(result.blocks).toEqual([])
    expect(result.claim).toEqual({ amount: 1250, vatAmount: 250, remaining: 1250 })
    expect(result.overdueDays).toBe(36)
    expect(result.debtorKind).toBe('business')
    expect(result.deliveryAttestation).toBeNull()
  })

  it('refuses a credit note, a quote, a self-billed invoice', () => {
    const base = facts().invoice
    expect(codes(facts({ invoice: { ...base, credited_invoice_id: 'orig' } }))).toContain('elig_credit_note')
    expect(codes(facts({ invoice: { ...base, document_type: 'quote' } }))).toContain('elig_not_invoice')
    expect(codes(facts({ invoice: { ...base, is_self_billed: true } }))).toContain('elig_not_invoice')
  })

  it('refuses an invoice with a draft credit note, or one already credited', () => {
    expect(codes(facts({ creditNotes: [{ status: 'draft' }] }))).toContain('elig_credit_draft')
    expect(codes(facts({ creditNotes: [{ status: 'sent' }] }))).toContain('elig_credited')
  })

  it('refuses drafts and paid invoices', () => {
    const base = facts().invoice
    expect(codes(facts({ invoice: { ...base, status: 'draft' } }))).toContain('elig_not_sent')
    expect(codes(facts({ invoice: { ...base, status: 'paid', paid_amount: 1250, remaining_amount: 0 } }))).toContain('elig_paid')
    expect(codes(facts({ invoice: { ...base, status: 'partially_paid', paid_amount: 1250, remaining_amount: 0 } }))).toContain('elig_paid')
  })

  it('computes overdue from the due date, never from status', () => {
    const base = facts().invoice
    expect(codes(facts({ invoice: { ...base, due_date: TODAY } }))).toContain('elig_not_overdue')
    expect(codes(facts({ invoice: { ...base, status: 'overdue', due_date: '2026-10-30' } }))).toContain('elig_not_overdue')
    expect(evaluateEligibility(facts({ invoice: { ...base, due_date: '2026-10-05' } })).overdueDays).toBe(1)
  })

  it('refuses other currencies and foreign customers', () => {
    const base = facts()
    expect(codes(facts({ invoice: { ...base.invoice, currency: 'EUR' } }))).toContain('elig_currency')
    expect(codes(facts({ customer: { ...base.customer!, country: 'NO' } }))).toContain('elig_foreign')
    expect(codes(facts({ customer: { ...base.customer!, customer_type: 'eu_business' } }))).toContain('elig_foreign')
  })

  it('follows the provider features when the catalogue gives them', () => {
    const features = { currencies: ['SEK'], debtorCountries: ['SE'], privateDebtors: false, minimumAmount: 2000 }
    const consumer = facts({
      features,
      customer: { ...facts().customer!, customer_type: 'individual', org_number: null },
    })
    expect(codes(consumer)).toEqual(expect.arrayContaining(['elig_private_unsupported', 'elig_below_minimum']))
  })

  it('refuses a claim below the company minimum, naming the minimum', () => {
    const result = evaluateEligibility(facts({ connection: { minimum_amount: 5000, reminder_fee_terms_since: null } }))
    expect(result.blocks).toContainEqual({ code: 'elig_below_minimum', params: { amount: 5000 } })
  })

  it('refuses an invoice that already has an open case', () => {
    expect(codes(facts({ openCase: { id: 'case-1', stage: 'reminder' } }))).toContain('elig_open_case')
  })

  it('refuses a customer marked "Skicka aldrig till inkasso", and only that customer', () => {
    const c = facts().customer!
    const marked = evaluateEligibility(facts({ customer: { ...c, collections_excluded: true } }))
    expect(marked.eligible).toBe(false)
    expect(marked.blocks.map((b) => b.code)).toEqual(['debtor_excluded'])
    expect(codes(facts({ customer: { ...c, collections_excluded: false } }))).not.toContain('debtor_excluded')
    expect(evaluateEligibility(facts()).eligible).toBe(true)
  })

  it('refuses a second handover while the provider closed the latest case as paid and the books still show it owed', () => {
    expect(codes(facts({ latestCaseClosedPaid: true }))).toContain('elig_collected_unbooked')
    expect(evaluateEligibility(facts({ latestCaseClosedPaid: true })).eligible).toBe(false)
    // Once the collected payment is booked the invoice is paid: that reason stands alone.
    const booked = codes(facts({ latestCaseClosedPaid: true, invoice: { ...facts().invoice, status: 'paid', remaining_amount: 0 } }))
    expect(booked).toContain('elig_paid')
    expect(booked).not.toContain('elig_collected_unbooked')
    expect(codes(facts({ latestCaseClosedPaid: false }))).not.toContain('elig_collected_unbooked')
  })

  it('needs a complete postal address and a valid org number for a Swedish business', () => {
    const c = facts().customer!
    const missing = evaluateEligibility(facts({ customer: { ...c, address_line1: null, city: ' ' } }))
    expect(missing.blocks).toContainEqual({ code: 'debtor_missing_address', params: { fields: 'address_line1,city' } })
    expect(codes(facts({ customer: { ...c, org_number: null } }))).toContain('debtor_missing_org_number')
    expect(codes(facts({ customer: { ...c, org_number: '556012-5791' } }))).toContain('debtor_invalid_org_number')
    expect(codes(facts({ customer: null }))).toContain('debtor_missing_customer')
  })

  it('hands a consumer over without a personnummer, with a hint, and refuses a minor', () => {
    const consumer = { ...facts().customer!, customer_type: 'individual', org_number: null }
    const none = evaluateEligibility(facts({ customer: { ...consumer, personalNumber: { status: 'none' } } }))
    expect(none.eligible).toBe(true)
    expect(none.debtorKind).toBe('private')
    expect(none.hints).toEqual(['debtor_missing_personal_number'])

    const invalid = evaluateEligibility(facts({ customer: { ...consumer, personalNumber: { status: 'invalid' } } }))
    expect(invalid.eligible).toBe(true)
    expect(invalid.hints).toEqual(['debtor_invalid_personal_number'])

    const minor = evaluateEligibility(facts({ customer: { ...consumer, personalNumber: { status: 'valid', digits: '201212121212', age: 13 } } }))
    expect(minor.blocks.map((b) => b.code)).toContain('elig_minor')
    const adult = evaluateEligibility(facts({ customer: { ...consumer, personalNumber: { status: 'valid', digits: '198001011231', age: 46 } } }))
    expect(adult.eligible).toBe(true)
  })

  it('refuses a claim that may be time-barred: three years for a consumer, ten for a business', () => {
    const base = facts()
    const consumer = { ...base.customer!, customer_type: 'individual', org_number: null }
    expect(codes(facts({ customer: consumer, invoice: { ...base.invoice, invoice_date: '2023-09-01', due_date: '2023-10-05' } }))).toContain(
      'elig_time_barred',
    )
    expect(codes(facts({ customer: consumer, invoice: { ...base.invoice, invoice_date: '2023-09-01', due_date: '2023-10-06' } }))).not.toContain(
      'elig_time_barred',
    )
    expect(codes(facts({ invoice: { ...base.invoice, invoice_date: '2023-09-01', due_date: '2023-10-05' } }))).not.toContain('elig_time_barred')
    expect(codes(facts({ invoice: { ...base.invoice, invoice_date: '2016-09-01', due_date: '2016-10-05' } }))).toContain('elig_time_barred')
  })

  it('refuses a ROT/RUT invoice whose deduction Skatteverket refused, and claims the customer share of others', () => {
    const base = facts().invoice
    expect(codes(facts({ invoice: { ...base, deduction_reclaimed_total: 500 } }))).toContain('elig_rot_rut_reclaimed')
    const rot = evaluateEligibility(facts({ invoice: { ...base, total: 10000, vat_amount: 2000, deduction_total: 3000 } }))
    expect(rot.claim.amount).toBe(7000)
    expect(rot.claim.vatAmount).toBe(1400)
  })

  it('asks for the delivery or import attestation instead of refusing', () => {
    expect(evaluateEligibility(facts({ delivery: 'not_delivered' })).deliveryAttestation).toBe('not_delivered')
    expect(evaluateEligibility(facts({ delivery: 'no_history' })).deliveryAttestation).toBe('imported')
    const imported = evaluateEligibility(facts({ imported: true }))
    expect(imported.deliveryAttestation).toBe('imported')
    expect(imported.eligible).toBe(true)
  })

  it('carries the customer answer to a reminder as an attestation', () => {
    expect(evaluateEligibility(facts({ reminderResponse: 'disputed' })).responseAttestation).toBe('disputed')
  })

  it('agrees a reminder fee per invoice: issued on or after the terms date, never on an import', () => {
    const since = { minimum_amount: 100, reminder_fee_terms_since: '2026-07-01' }
    expect(evaluateEligibility(facts({ connection: since })).reminderFeeAgreed).toBe(true)
    expect(evaluateEligibility(facts({ connection: { ...since, reminder_fee_terms_since: '2026-08-02' } })).reminderFeeAgreed).toBe(false)
    expect(evaluateEligibility(facts({ connection: since, imported: true })).reminderFeeAgreed).toBe(false)
    expect(evaluateEligibility(facts()).reminderFeeAgreed).toBe(false)
  })
})

describe('collectionClaim', () => {
  it('is the printed amount less what the customer paid, rounded to the krona when öresavrundning is on', () => {
    const invoice = { total: 1250.4, vat_amount: 250.08, currency: 'SEK', paid_amount: 200, deduction_total: null, credited_invoice_id: null, ore_rounding: null }
    expect(collectionClaim(invoice, true)).toEqual({ amount: 1250, vatAmount: 250, remaining: 1050 })
    expect(collectionClaim(invoice, false)).toEqual({ amount: 1250.4, vatAmount: 250.08, remaining: 1050.4 })
  })

  it('never answers a remaining above the claim or below zero', () => {
    const invoice = { total: 100, vat_amount: 20, currency: 'SEK', paid_amount: 150, deduction_total: null, credited_invoice_id: null, ore_rounding: false }
    expect(collectionClaim(invoice, false).remaining).toBe(0)
    expect(collectionClaim({ ...invoice, paid_amount: -10 }, false).remaining).toBe(100)
  })
})

describe('debtor helpers', () => {
  it('lists the address fields a handover needs', () => {
    expect(missingAddressFields({ address_line1: 'Gatan 1', postal_code: '12', city: 'Ort', country: null })).toEqual(['postal_code', 'country'])
  })

  it('normalizes an org number to ten digits with a valid check digit', () => {
    expect(normalizeOrgNumberDigits('556012-5790')).toBe('5560125790')
    expect(normalizeOrgNumberDigits('165560125790')).toBe('5560125790')
    expect(normalizeOrgNumberDigits('556012-5791')).toBeNull()
    expect(normalizeOrgNumberDigits(null)).toBeNull()
  })
})
