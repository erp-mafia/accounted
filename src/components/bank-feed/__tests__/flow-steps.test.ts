import { describe, expect, it } from 'vitest'
import { dismissPolicy, firstStep, nextStep, offersFileImport, stepPosition, stepsFor } from '../flow-steps'

describe('stepsFor', () => {
  it('a switch opens with what changes, a new connection and a renewal start at the bank', () => {
    expect(stepsFor('switch', true)).toEqual(['intro', 'bank', 'bankid', 'accounts', 'payments', 'done'])
    expect(stepsFor('new', true)).toEqual(['bank', 'bankid', 'accounts', 'payments', 'done'])
    expect(stepsFor('renew', true)).toEqual(['bank', 'bankid', 'accounts', 'payments', 'done'])
  })

  it('leaves the payments offer out once payments are known not to be on offer', () => {
    expect(stepsFor('new', false)).toEqual(['bank', 'bankid', 'accounts', 'done'])
    // Not known yet: counted, so the total does not jump down mid-flow when the answer lands late.
    expect(stepsFor('new', null)).toContain('payments')
  })
})

describe('firstStep', () => {
  it('starts each mode where it belongs', () => {
    expect(firstStep('switch')).toBe('intro')
    expect(firstStep('new')).toBe('bank')
    expect(firstStep('renew')).toBe('bank')
    expect(firstStep('resume')).toBe('bankid')
  })
})

describe('stepPosition', () => {
  it('counts Bank as step 1 of 5 with the payments offer and of 4 without', () => {
    expect(stepPosition('bank', 'new', true)).toEqual({ n: 1, total: 5 })
    expect(stepPosition('accounts', 'new', false)).toEqual({ n: 3, total: 4 })
    expect(stepPosition('payments', 'switch', true)).toEqual({ n: 4, total: 5 })
  })

  it('shows nothing on the intro and the finished screen', () => {
    expect(stepPosition('intro', 'switch', true)).toBeNull()
    expect(stepPosition('done', 'new', true)).toBeNull()
  })
})

describe('nextStep', () => {
  it('walks the mode in order and ends after Klart', () => {
    expect(nextStep('intro', 'switch', true)).toBe('bank')
    expect(nextStep('accounts', 'new', false)).toBe('done')
    expect(nextStep('accounts', 'new', true)).toBe('payments')
    expect(nextStep('done', 'new', true)).toBeNull()
  })
})

describe('dismissPolicy', () => {
  it('asks before closing over a running BankID or an activation, closes freely elsewhere', () => {
    expect(dismissPolicy('bankid')).toBe('confirm')
    expect(dismissPolicy('accounts')).toBe('confirm')
    for (const step of ['intro', 'bank', 'payments', 'done'] as const) expect(dismissPolicy(step)).toBe('free')
  })

  it('closes a refused BankID at once: nothing is running to interrupt', () => {
    expect(dismissPolicy('bankid', true)).toBe('free')
    expect(dismissPolicy('bankid', false)).toBe('confirm')
    // A refusal is a state of the BankID step only: an unsaved selection still asks.
    expect(dismissPolicy('accounts', true)).toBe('confirm')
  })
})

describe('offersFileImport', () => {
  it('points a refused BankID on to bank file import from the settings pages', () => {
    expect(offersFileImport('banking')).toBe(true)
    expect(offersFileImport('connections')).toBe(true)
    expect(offersFileImport(null)).toBe(true)
  })

  it('does not from onboarding, which has its own way on, or from the signatory page, whose reader has no login', () => {
    expect(offersFileImport('onboarding')).toBe(false)
    expect(offersFileImport('koppla')).toBe(false)
  })
})
