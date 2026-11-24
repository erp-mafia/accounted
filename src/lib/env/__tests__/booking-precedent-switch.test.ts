import { describe, expect, it } from 'vitest'
import { bookingPrecedentRollout, isBookingPrecedentEnabled } from '../booking-precedent-switch'

const A = 'AAAAAAAA-0000-4000-8000-000000000001'

describe('booking precedent switch (BOOKING_PRECEDENT_COMPANY_IDS)', () => {
  it('is off for everybody while unset or blank', () => {
    expect(bookingPrecedentRollout({})).toEqual([])
    expect(isBookingPrecedentEnabled(A, {})).toBe(false)
    expect(isBookingPrecedentEnabled(A, { BOOKING_PRECEDENT_COMPANY_IDS: '  ' })).toBe(false)
  })

  it('opens for the listed companies only, whatever the case', () => {
    const env = { BOOKING_PRECEDENT_COMPANY_IDS: `${A.toLowerCase()}, other , other` }
    expect(bookingPrecedentRollout(env)).toEqual([A.toLowerCase(), 'other'])
    expect(isBookingPrecedentEnabled(A, env)).toBe(true)
    expect(isBookingPrecedentEnabled('third', env)).toBe(false)
    expect(isBookingPrecedentEnabled(null, env)).toBe(false)
    expect(isBookingPrecedentEnabled(undefined, env)).toBe(false)
  })

  it('opens for everyone with *', () => {
    expect(bookingPrecedentRollout({ BOOKING_PRECEDENT_COMPANY_IDS: '*' })).toBe('all')
    expect(isBookingPrecedentEnabled(A, { BOOKING_PRECEDENT_COMPANY_IDS: '*' })).toBe(true)
    expect(isBookingPrecedentEnabled('', { BOOKING_PRECEDENT_COMPANY_IDS: '*' })).toBe(false)
  })
})
