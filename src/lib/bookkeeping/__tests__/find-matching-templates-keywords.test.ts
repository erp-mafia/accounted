import { describe, expect, it } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import { findMatchingTemplates } from '../booking-templates'

const top = (description: string) =>
  findMatchingTemplates(makeTransaction({ description, merchant_name: null, amount: -1230.97, mcc_code: null }))[0]?.template.id

describe('findMatchingTemplates keyword matching', () => {
  it('does not read "el" out of "vercel" or "hotel"', () => {
    expect(top('Vercel Aug')).not.toBe('premises_electricity')
    expect(top('HOTEL HANSSON K3667')).not.toBe('premises_electricity')
  })

  it('still matches a whole-word short keyword and the long ones', () => {
    expect(top('Vattenfall el 2026-08')).toBe('premises_electricity')
    expect(top('Fjärrvärme Göteborg Energi')).toBe('premises_electricity')
  })
})

// accounted#92: "representation" and "kund" matched anywhere inside a word,
// so a gift was still proposed as a meal (6072, 12 %) after accounted#86.
describe('a gift is not a meal', () => {
  const MEALS = ['representation_external', 'representation_internal']
  const matches = (description: string, mcc_code: number | null = null) =>
    findMatchingTemplates(makeTransaction({ description, merchant_name: null, amount: -450, mcc_code }))
  const matchIds = (description: string, mcc_code: number | null = null) =>
    matches(description, mcc_code).map((m) => m.template.id)
  const confidenceOf = (description: string, id: string) =>
    matches(description).find((m) => m.template.id === id)?.confidence

  it.each([
    'Representationsgåva',
    'Gåva till kund',
    'Representation, gåva till kund',
    'Julgåvor personal',
    'Present till kund',
    'Gift card',
  ])('no meal template matches "%s"', (description) => {
    expect(matchIds(description).filter((id) => MEALS.includes(id))).toEqual([])
  })

  it('keeps the meal templates out of a gift bought at a restaurant (MCC 5812)', () => {
    expect(matchIds('Presentkort', 5812).filter((id) => MEALS.includes(id))).toEqual([])
    // The restaurant MCC alone still proposes the meal.
    expect(matchIds('PIZZERIA EXEMPEL', 5812)).toContain('representation_external')
  })

  it('counts "representation" only as a whole word', () => {
    expect(matchIds('Representation 3/10')).toContain('representation_external')
    // A compound is what its last part names: "representationsmiddag" is a
    // middag, matched through 'middag' alone; the modifier adds nothing.
    expect(matchIds('Representationsmiddag')).toContain('representation_external')
    expect(confidenceOf('Representationsmiddag', 'representation_external')).toBe(
      confidenceOf('Middag', 'representation_external'),
    )
  })

  it('no longer reads a meal out of "kund"', () => {
    expect(matchIds('Telebolaget kundreskontra')).not.toContain('representation_external')
    expect(matchIds('Kund betalade två gånger')).not.toContain('representation_external')
  })

  it('still matches the meals', () => {
    expect(matchIds('Kundlunch Restaurang Exempel')).toContain('representation_external')
    expect(matchIds('Affärslunch')).toContain('representation_external')
    expect(matchIds('Representation lunch')).toContain('representation_external')
    expect(matchIds('Teamlunch')).toContain('representation_internal')
  })
})

// A provider's name inside another word, or a provider that sells something
// other than the template's thing, proposed that template's VAT: a ride at
// 6 % for a meal delivery, an exempt payment fee for Stripe's taxable
// software, Betald F-skatt for a tax-calculation fee.
describe('a provider name proposes only the thing the template books', () => {
  const ids = (description: string, entityType: 'aktiebolag' | 'enskild_firma' = 'aktiebolag') =>
    findMatchingTemplates(
      makeTransaction({ description, merchant_name: null, amount: -95, mcc_code: null }),
      entityType,
    ).map((m) => m.template.id)

  it('reads "uber" and "bolt" only as whole words', () => {
    expect(ids('HUBER GMBH')).not.toContain('travel_transport')
    expect(ids('Boltzmann Instruments')).not.toContain('travel_transport')
    expect(ids('UBER *TRIP HELP.UBER.COM')).toContain('travel_transport')
    expect(ids('BOLT.EU/O/2611')).toContain('travel_transport')
  })

  it('does not propose a ride for a meal delivery', () => {
    expect(ids('UBER *EATS')).not.toContain('travel_transport')
    expect(ids('Uber Eats Stockholm')).not.toContain('travel_transport')
    expect(ids('BOLT FOOD')).not.toContain('travel_transport')
  })

  it.each([
    'Stripe: Billing - Usage Fee (2026-10-01 - 2026-10-31)',
    'Stripe: Automatic Taxes (2026-10-01 - 2026-10-31): Automatic tax',
    'Stripe: Radar (2026-10-01 - 2026-10-31): Radar for Fraud Teams',
    'Stripe: Invoicing (2026-10-01 - 2026-10-31): Invoicing Starter',
    'Stripe: Tax Api Calculation (2026-10-01 - 2026-10-31)',
    'Stripe: Identity (2026-10-01 - 2026-10-31): Identity verification',
    'Stripe Tax calculation fee',
    'STRIPE BILLING',
  ])('keeps the exempt Stripe fee off its taxable software: "%s"', (description) => {
    expect(ids(description)).not.toContain('payment_fees_eu')
  })

  it('still proposes the exempt Stripe fee for a processing fee', () => {
    expect(ids('Stripe-avgift (Stripe-betalning ch_3Q)')).toContain('payment_fees_eu')
    expect(ids('STRIPE')).toContain('payment_fees_eu')
    // The payer's name on a fee row is not Stripe's software.
    expect(ids('Stripe-avgift (Stripe-betalning Tax Billing Radar AB)')).toContain('payment_fees_eu')
  })

  it.each([
    'Stripe: Automatic Taxes (2026-10-01 - 2026-10-31): Automatic tax',
    'Tax Api Calculation (2026-10-01 - 2026-10-31)',
    'Stripe Tax calculation fee',
    'Fee-transfer-1234 for Skatteverket tax payment',
    'Avalara Tax Calculation',
    'Avalara Tax service charge',
  ])('does not propose Betald F-skatt for a provider fee: "%s"', (description) => {
    expect(ids(description)).not.toContain('personnel_preliminary_tax')
  })

  it('still proposes Betald F-skatt for a tax payment', () => {
    expect(ids('Tax payment on profit 2026')).toContain('personnel_preliminary_tax')
    expect(ids('Preliminary tax Skatteverket')).toContain('personnel_preliminary_tax')
  })
})

// BAS 2026: 6211 Fast telefoni, 6212 Mobiltelefon. The mobile subscription
// template books 6212, so a landline, VoIP or switchboard bill must not match
// it: "telefon" alone sits inside "fast telefoni" and "IP-telefoni".
describe('a landline bill is not a mobile subscription', () => {
  const ids = (description: string, mcc_code: number | null = null) =>
    findMatchingTemplates(makeTransaction({ description, merchant_name: null, amount: -399, mcc_code })).map((m) => m.template.id)

  it.each([
    'Telia fast telefoni faktura',
    'IP-telefoni Telavox',
    'Telavox VoIP',
    'Telefonväxel november',
    'Telenor växel',
    'Telefon växeltjänst',
    'Telia molnväxel',
  ])('the mobile template does not match "%s"', (description) => {
    expect(ids(description)).not.toContain('telecom_mobile')
    expect(ids(description, 4814)).not.toContain('telecom_mobile')
  })

  it.each(['Hallon mobilabonnemang', 'Tele2 mobil', 'Comviq'])('a mobile bill still matches it: "%s"', (description) => {
    const match = findMatchingTemplates(makeTransaction({ description, merchant_name: null, amount: -199, mcc_code: null }))[0]
    expect(match?.template.id).toBe('telecom_mobile')
    expect(match?.template.debit_account).toBe('6212')
  })
})
