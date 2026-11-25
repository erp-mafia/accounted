import { describe, expect, it } from 'vitest'
import { registrationShownAsFact, registryRegistrationsOf } from '../registry-registrations'

describe('registryRegistrationsOf', () => {
  it('reads both flags and prefers the column date', () => {
    const snapshot = { registration: { fTax: true, vat: false }, fetchedAt: '2026-10-01T08:00:00Z' }
    expect(registryRegistrationsOf(snapshot, '2026-11-12T09:30:00Z')).toEqual({
      fTax: true,
      vat: false,
      readAt: '2026-11-12T09:30:00Z',
    })
  })

  it("falls back to the profile's own fetchedAt when the column is empty", () => {
    expect(registryRegistrationsOf({ registration: { fTax: true, vat: true }, fetchedAt: '2026-10-01T08:00:00Z' }, null)?.readAt).toBe(
      '2026-10-01T08:00:00Z',
    )
  })

  it('reads anything but a boolean as not said', () => {
    expect(registryRegistrationsOf({ registration: { fTax: 'yes', vat: null } })).toEqual({ fTax: null, vat: null, readAt: null })
    expect(registryRegistrationsOf({ companyName: 'Exempel AB' })).toEqual({ fTax: null, vat: null, readAt: null })
  })

  it('has nothing to say without a snapshot', () => {
    expect(registryRegistrationsOf(null)).toBeNull()
    expect(registryRegistrationsOf('not json')).toBeNull()
  })
})

describe('registrationShownAsFact', () => {
  it('is a fact when the registry and the saved setting both say yes', () => {
    expect(registrationShownAsFact(true, true)).toBe(true)
  })

  it('still asks when the registry says no, since a missing flag is stored as false', () => {
    expect(registrationShownAsFact(false, false)).toBe(false)
  })

  it('still asks when the two disagree or the registry did not say', () => {
    expect(registrationShownAsFact(false, true)).toBe(false)
    expect(registrationShownAsFact(true, false)).toBe(false)
    expect(registrationShownAsFact(true, null)).toBe(false)
    expect(registrationShownAsFact(null, true)).toBe(false)
    expect(registrationShownAsFact(undefined, undefined)).toBe(false)
  })
})
