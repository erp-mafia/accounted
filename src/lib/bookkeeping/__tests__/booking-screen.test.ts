import { describe, expect, it } from 'vitest'
import {
  BOOKING_SCREEN_PATH,
  bookingScreenHref,
  bookingScreenOrigin,
  parseBookingScreenBack,
  parseBookingScreenSubject,
  safeReturnPath,
} from '../booking-screen'

const TX = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f'
const ITEM = '8d0f6a52-3b1e-4c7a-9f2d-1a2b3c4d5e6f'

describe('bookingScreenHref', () => {
  it('opens an empty verifikation without a query', () => {
    expect(bookingScreenHref({ kind: 'voucher' })).toBe(BOOKING_SCREEN_PATH)
  })

  it('names the bank row, and the account when one was picked', () => {
    expect(bookingScreenHref({ kind: 'transaction', transactionId: TX, account: null })).toBe(`/bokfor?transaktion=${TX}`)
    expect(bookingScreenHref({ kind: 'transaction', transactionId: TX, account: '5460' })).toBe(`/bokfor?transaktion=${TX}&konto=5460`)
  })
})

describe('the way back to Hem', () => {
  it('returns to Hem and to its Behöver dig view, named after each', () => {
    expect(safeReturnPath('/')).toBe('/')
    expect(safeReturnPath('/?vy=behover')).toBe('/?vy=behover')
    expect(bookingScreenOrigin('/', true)).toBe('/')
    expect(bookingScreenOrigin('/?vy=behover', true)).toBe('/?vy=behover')
    expect(bookingScreenOrigin('/?vy=annat', true)).toBe('/')
  })

  it('still refuses a page it does not return to', () => {
    expect(safeReturnPath('/settings')).toBeNull()
    expect(safeReturnPath('//evil.example')).toBeNull()
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

  it('reads the inbox item found for the row, and drops one that is not a uuid', () => {
    const subject = { kind: 'transaction' as const, transactionId: TX, account: null, foundItemId: ITEM }
    const query = Object.fromEntries(new URL(`https://x${bookingScreenHref(subject)}`).searchParams)
    expect(query.underlag).toBe(ITEM)
    expect(parseBookingScreenSubject(query)).toEqual(subject)
    expect(parseBookingScreenSubject({ transaktion: TX, underlag: 'x' })).not.toHaveProperty('foundItemId')
    expect(parseBookingScreenSubject({ underlag: ITEM })).toEqual({ kind: 'voucher' })
  })
})

describe('safeReturnPath', () => {
  it('keeps the list pages with their own query', () => {
    expect(safeReturnPath('/bookkeeping')).toBe('/bookkeeping')
    expect(safeReturnPath('/bookkeeping?status=draft&sida=2')).toBe('/bookkeeping?status=draft&sida=2')
    expect(safeReturnPath('/transactions?flik=alla')).toBe('/transactions?flik=alla')
  })

  it('drops another host, another page and backslash tricks', () => {
    expect(safeReturnPath('https://evil.example/bookkeeping')).toBeNull()
    expect(safeReturnPath('//evil.example/bookkeeping')).toBeNull()
    expect(safeReturnPath('/\\evil.example')).toBeNull()
    expect(safeReturnPath('/bookkeepingx')).toBeNull()
    expect(safeReturnPath('/settings')).toBeNull()
  })

  it('judges the normalised path, so dot segments cannot climb to another host or page', () => {
    expect(safeReturnPath('/bookkeeping/..//evil.com')).toBeNull()
    expect(safeReturnPath('/bookkeeping/%2e%2e//evil.com')).toBeNull()
    expect(safeReturnPath('/bookkeeping/a/../..//evil.com')).toBeNull()
    expect(safeReturnPath('/bookkeeping/../settings')).toBeNull()
    expect(safeReturnPath('/transactions/./?flik=alla')).toBe('/transactions/?flik=alla')
    expect(safeReturnPath('')).toBeNull()
    expect(safeReturnPath(null)).toBeNull()
  })
})

describe('the return address', () => {
  it('rides along in the address and is read back', () => {
    const href = bookingScreenHref({ kind: 'voucher' }, '/bookkeeping?status=draft')
    expect(href).toBe('/bokfor?tillbaka=%2Fbookkeeping%3Fstatus%3Ddraft')
    const query = Object.fromEntries(new URL(`https://x${href}`).searchParams)
    expect(parseBookingScreenBack(query)).toBe('/bookkeeping?status=draft')
  })

  it('is left out when it is not one the screen may return to', () => {
    expect(bookingScreenHref({ kind: 'voucher' }, '//evil.example')).toBe(BOOKING_SCREEN_PATH)
    expect(parseBookingScreenBack({ tillbaka: 'https://evil.example' })).toBeNull()
  })
})

describe('bookingScreenOrigin', () => {
  it('reads the page the screen was opened from off its return address, with the list query kept', () => {
    expect(bookingScreenOrigin('/att-bokfora', true)).toBe('/att-bokfora')
    expect(bookingScreenOrigin('/transactions?tab=unbooked&sok=sj', true)).toBe('/transactions')
    expect(bookingScreenOrigin('/bookkeeping?serie=A', false)).toBe('/bookkeeping')
  })

  it('without one, a bank row came from Bankrader and a verifikation from Verifikat', () => {
    expect(bookingScreenOrigin(null, true)).toBe('/transactions')
    expect(bookingScreenOrigin(null, false)).toBe('/bookkeeping')
  })
})
