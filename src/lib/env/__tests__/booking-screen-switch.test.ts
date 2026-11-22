import { describe, expect, it } from 'vitest'
import { bookingScreenRollout, isBookingScreenEnabled } from '../booking-screen-switch'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('bookingScreenRollout', () => {
  it('is nobody when the variable is unset or blank', () => {
    expect(bookingScreenRollout({})).toEqual([])
    expect(bookingScreenRollout({ BOOKING_SCREEN_COMPANY_IDS: '   ' })).toEqual([])
  })

  it('is everyone for a star', () => {
    expect(bookingScreenRollout({ BOOKING_SCREEN_COMPANY_IDS: ' * ' })).toBe('all')
  })

  it('lists each id once, trimmed and lowercased', () => {
    expect(bookingScreenRollout({ BOOKING_SCREEN_COMPANY_IDS: ` ${A.toUpperCase()}, ${B},,${A} ` })).toEqual([A, B])
  })
})

describe('isBookingScreenEnabled', () => {
  it('is off without a company', () => {
    expect(isBookingScreenEnabled(null, { BOOKING_SCREEN_COMPANY_IDS: '*' })).toBe(false)
    expect(isBookingScreenEnabled(undefined, { BOOKING_SCREEN_COMPANY_IDS: '*' })).toBe(false)
  })

  it('is off for everyone while the variable is unset', () => {
    expect(isBookingScreenEnabled(A, {})).toBe(false)
  })

  it('is on for a listed company, whatever the case of its id', () => {
    const env = { BOOKING_SCREEN_COMPANY_IDS: A }
    expect(isBookingScreenEnabled(A, env)).toBe(true)
    expect(isBookingScreenEnabled(A.toUpperCase(), env)).toBe(true)
    expect(isBookingScreenEnabled(B, env)).toBe(false)
  })

  it('is on for every company with a star', () => {
    expect(isBookingScreenEnabled(B, { BOOKING_SCREEN_COMPANY_IDS: '*' })).toBe(true)
  })
})
