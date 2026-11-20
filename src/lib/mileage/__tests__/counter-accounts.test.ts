import { describe, expect, it } from 'vitest'
import {
  isOwnerDeposit,
  mileageCounterAccounts,
  resolveMileageCounterAccount,
} from '@/lib/mileage/counter-accounts'

describe('mileageCounterAccounts', () => {
  it('credits an enskild firma owner\'s own trips to 2018, never a liability', () => {
    expect(mileageCounterAccounts('enskild_firma', true)).toEqual(['2018', '1930'])
  })

  it('keeps skuld till anställda for an employee of an enskild firma', () => {
    expect(mileageCounterAccounts('enskild_firma', false)).toEqual(['2820', '1930'])
  })

  it('leaves an aktiebolag on 2820, the shareholder account or 1930', () => {
    expect(mileageCounterAccounts('aktiebolag', true)).toEqual(['2820', '2893', '1930'])
    expect(mileageCounterAccounts('aktiebolag', false)).toEqual(['2820', '2893', '1930'])
  })

  it('gives a förening no owner account', () => {
    expect(mileageCounterAccounts('ideell_forening', true)).toEqual(['2820', '1930'])
    expect(mileageCounterAccounts('ekonomisk_forening', true)).toEqual(['2820', '1930'])
  })
})

describe('resolveMileageCounterAccount', () => {
  it('uses the form default when nothing is requested', () => {
    expect(resolveMileageCounterAccount('enskild_firma', true)).toEqual({ ok: true, account: '2018' })
    expect(resolveMileageCounterAccount('aktiebolag', true, null)).toEqual({ ok: true, account: '2820' })
  })

  it('accepts an allowed choice', () => {
    expect(resolveMileageCounterAccount('enskild_firma', true, '1930')).toEqual({
      ok: true,
      account: '1930',
    })
  })

  it('refuses an account the form does not allow for the trips', () => {
    expect(resolveMileageCounterAccount('enskild_firma', true, '2820')).toEqual({
      ok: false,
      allowed: ['2018', '1930'],
    })
    expect(resolveMileageCounterAccount('aktiebolag', true, '2018')).toEqual({
      ok: false,
      allowed: ['2820', '2893', '1930'],
    })
  })
})

describe('isOwnerDeposit', () => {
  it('is the enskild firma owner insättning only', () => {
    expect(isOwnerDeposit('enskild_firma', '2018')).toBe(true)
    expect(isOwnerDeposit('enskild_firma', '2820')).toBe(false)
    expect(isOwnerDeposit('aktiebolag', '2893')).toBe(false)
  })
})
