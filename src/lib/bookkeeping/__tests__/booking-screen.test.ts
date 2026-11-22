import { describe, expect, it } from 'vitest'
import { BOOKING_SCREEN_PATH, bookingScreenHref, parseBookingScreenSubject } from '../booking-screen'

const TX = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f'

describe('bookingScreenHref', () => {
  it('opens an empty verifikation without a query', () => {
    expect(bookingScreenHref({ kind: 'voucher' })).toBe(BOOKING_SCREEN_PATH)
  })

  it('names the bank row, and the account when one was picked', () => {
    expect(bookingScreenHref({ kind: 'transaction', transactionId: TX, account: null })).toBe(`/bokfor?transaktion=${TX}`)
    expect(bookingScreenHref({ kind: 'transaction', transactionId: TX, account: '5460' })).toBe(`/bokfor?transaktion=${TX}&konto=5460`)
  })
})

describe('parseBookingScreenSubject', () => {
  it('reads what bookingScreenHref writes', () => {
    const subject = { kind: 'transaction' as const, transactionId: TX, account: '5460' }
    const query = Object.fromEntries(new URL(`https://x${bookingScreenHref(subject)}`).searchParams)
    expect(parseBookingScreenSubject(query)).toEqual(subject)
  })

  it('is a new verifikation without a bank row', () => {
    expect(parseBookingScreenSubject({})).toEqual({ kind: 'voucher' })
  })

  it('drops a transaction id that is not a uuid', () => {
    expect(parseBookingScreenSubject({ transaktion: '42' })).toEqual({ kind: 'voucher' })
    expect(parseBookingScreenSubject({ transaktion: `${TX}' or 1=1` })).toEqual({ kind: 'voucher' })
  })

  it('takes the first value of a repeated parameter and lowercases the id', () => {
    expect(parseBookingScreenSubject({ transaktion: [TX.toUpperCase(), 'x'] })).toEqual({
      kind: 'transaction',
      transactionId: TX,
      account: null,
    })
  })

  it('keeps an account only when it is four digits, as a string', () => {
    expect(parseBookingScreenSubject({ transaktion: TX, konto: '1930' })).toMatchObject({ account: '1930' })
    expect(parseBookingScreenSubject({ transaktion: TX, konto: '193' })).toMatchObject({ account: null })
    expect(parseBookingScreenSubject({ transaktion: TX, konto: 'abcd' })).toMatchObject({ account: null })
  })
})
