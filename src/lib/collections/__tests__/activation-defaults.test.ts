/**
 * Activation on one screen: the rules start from defaults (editable under
 * Regler once active), consent goes before the application in the same
 * click, and the button waits for both consents and a payout account.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MINIMUM_AMOUNT,
  activationCanSubmit,
  activationRequests,
  defaultActivationRules,
  kycDescriptionShown,
  payoutNumberText,
  validateRulesStep,
} from '../activation-form'

describe('defaultActivationRules', () => {
  it('starts with a reminder, 100 kr, no fee date or agreed interest, and the morning proposals on', () => {
    expect(defaultActivationRules(true)).toEqual({
      minimumAmount: 100,
      defaultStartStep: 'reminder',
      reminderFeeTermsSince: null,
      lateInterest: null,
      ladderMode: 'staged',
    })
    expect(DEFAULT_MINIMUM_AMOUNT).toBe(100)
  })

  it('leaves the proposals off where the installation does not offer them', () => {
    expect(defaultActivationRules(false).ladderMode).toBe('off')
  })

  it('passes the same rule validation the route runs', () => {
    expect(validateRulesStep(defaultActivationRules(true), { today: '2026-10-09', requireLadderChoice: true })).toEqual({})
    expect(validateRulesStep(defaultActivationRules(false), { today: '2026-10-09', requireLadderChoice: false })).toEqual({})
  })
})

describe('activationRequests', () => {
  it('sends the consent before the application when there is no connection yet', () => {
    expect(activationRequests(false)).toEqual(['consent', 'onboarding'])
  })

  it('sends only the application once the consent is recorded', () => {
    expect(activationRequests(true)).toEqual(['onboarding'])
  })
})

describe('activationCanSubmit', () => {
  const base = { connected: false, acceptTerms: true, acceptDataSharing: true, payoutOptions: 1 }

  it('needs both consents before the connection exists', () => {
    expect(activationCanSubmit(base)).toBe(true)
    expect(activationCanSubmit({ ...base, acceptTerms: false })).toBe(false)
    expect(activationCanSubmit({ ...base, acceptDataSharing: false })).toBe(false)
  })

  it('does not ask again once consented', () => {
    expect(activationCanSubmit({ ...base, connected: true, acceptTerms: false, acceptDataSharing: false })).toBe(true)
  })

  it('needs somewhere for payouts to land', () => {
    expect(activationCanSubmit({ ...base, payoutOptions: 0 })).toBe(false)
  })
})

describe('kycDescriptionShown', () => {
  it('shows the "Beskriv" box of a question only after the answer Ja', () => {
    expect(kycDescriptionShown(true)).toBe(true)
    expect(kycDescriptionShown(false)).toBe(false)
    expect(kycDescriptionShown(null)).toBe(false)
  })
})

describe('payoutNumberText', () => {
  it('writes a giro number with its hyphen, like the rest of the app', () => {
    expect(payoutNumberText({ kind: 'bankgiro', number: '55551238' })).toBe('5555-1238')
    expect(payoutNumberText({ kind: 'bankgiro', number: '1234566' })).toBe('123-4566')
    expect(payoutNumberText({ kind: 'plusgiro', number: '45674' })).toBe('4567-4')
    expect(payoutNumberText({ kind: 'bank_account', number: '8327-123456789' })).toBe('8327-123456789')
  })
})
