/**
 * The class/type rule both account write paths apply (the Kontoplan create
 * route and the MCP create_account staging + commit). account_class is
 * derived from the first digit, so a type that contradicts the number would
 * put the account on the wrong side of the balance sheet / income statement.
 */
import { describe, expect, it } from 'vitest'
import { accountClassTypeConflict, CreateAccountParamsSchema } from '../account'

describe('accountClassTypeConflict', () => {
  it('accepts the types each BAS class holds', () => {
    expect(accountClassTypeConflict('1930', 'asset')).toBeNull()
    expect(accountClassTypeConflict('2081', 'equity')).toBeNull()
    expect(accountClassTypeConflict('2440', 'liability')).toBeNull()
    expect(accountClassTypeConflict('3001', 'revenue')).toBeNull()
    expect(accountClassTypeConflict('6570', 'expense')).toBeNull()
    expect(accountClassTypeConflict('8310', 'revenue')).toBeNull()
    expect(accountClassTypeConflict('8410', 'expense')).toBeNull()
  })

  it('keeps untaxed_reserves to the 21xx group (obeskattade reserver)', () => {
    expect(accountClassTypeConflict('2110', 'untaxed_reserves')).toBeNull()
    expect(accountClassTypeConflict('2129', 'untaxed_reserves')).toBeNull()
    expect(accountClassTypeConflict('2150', 'untaxed_reserves')).toBeNull()
    expect(accountClassTypeConflict('2440', 'untaxed_reserves')).toMatch(/21xx/)
    expect(accountClassTypeConflict('2099', 'untaxed_reserves')).toMatch(/21xx/)
    expect(accountClassTypeConflict('5999', 'untaxed_reserves')).toMatch(/21xx/)
  })

  it('refuses a type the class cannot hold', () => {
    expect(accountClassTypeConflict('2999', 'expense')).toMatch(/class 2/)
    expect(accountClassTypeConflict('1930', 'liability')).toMatch(/class 1/)
    expect(accountClassTypeConflict('3001', 'expense')).toMatch(/class 3/)
  })

  it('leaves the free-use classes 0 and 9 unconstrained', () => {
    expect(accountClassTypeConflict('9100', 'expense')).toBeNull()
    expect(accountClassTypeConflict('0100', 'asset')).toBeNull()
  })
})

describe('CreateAccountParamsSchema', () => {
  const base = { account_name: 'Konto', normal_balance: 'credit' as const }

  it('commits a 21xx untaxed_reserves account', () => {
    expect(
      CreateAccountParamsSchema.safeParse({ ...base, account_number: '2129', account_type: 'untaxed_reserves' }).success,
    ).toBe(true)
  })

  it('refuses untaxed_reserves outside 21xx at the commit boundary', () => {
    const r = CreateAccountParamsSchema.safeParse({ ...base, account_number: '2440', account_type: 'untaxed_reserves' })
    expect(r.success).toBe(false)
  })
})
