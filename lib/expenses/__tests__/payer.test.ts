import { describe, it, expect } from 'vitest'
import {
  OWNER_FALLBACK_NAME,
  PAYER_ORDER,
  isPersonPayer,
  resolveExpenseLiabilityAccount,
} from '../payer'

describe('resolveExpenseLiabilityAccount', () => {
  it('an employee is always 2820, whatever the entity type', () => {
    expect(resolveExpenseLiabilityAccount('aktiebolag', 'employee')).toBe('2820')
    expect(resolveExpenseLiabilityAccount('enskild_firma', 'employee')).toBe('2820')
    expect(resolveExpenseLiabilityAccount(null, 'employee')).toBe('2820')
  })

  it('the owner is a creditor in an AB (2893) and makes an egen insättning in an EF (2018)', () => {
    expect(resolveExpenseLiabilityAccount('aktiebolag', 'owner')).toBe('2893')
    expect(resolveExpenseLiabilityAccount('enskild_firma', 'owner')).toBe('2018')
  })

  it('an unknown entity type falls back to the AB rule, never to 2018', () => {
    expect(resolveExpenseLiabilityAccount(undefined, 'owner')).toBe('2893')
    expect(resolveExpenseLiabilityAccount('handelsbolag', 'owner')).toBe('2893')
  })
})

describe('isPersonPayer', () => {
  it('only owner and employee are people', () => {
    expect(isPersonPayer('owner')).toBe(true)
    expect(isPersonPayer('employee')).toBe(true)
    expect(isPersonPayer('company')).toBe(false)
    expect(isPersonPayer('unpaid')).toBe(false)
    expect(isPersonPayer(null)).toBe(false)
  })

  it('the select lists every answer exactly once', () => {
    expect([...PAYER_ORDER].sort()).toEqual(['company', 'employee', 'owner', 'unpaid'])
  })

  it('the owner fallback label is the one Hem groups on', () => {
    expect(OWNER_FALLBACK_NAME).toBe('Ägare')
  })
})
