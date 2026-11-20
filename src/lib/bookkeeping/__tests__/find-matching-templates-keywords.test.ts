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
