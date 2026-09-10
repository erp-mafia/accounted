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
