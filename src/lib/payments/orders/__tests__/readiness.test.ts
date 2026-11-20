/**
 * The bank-payment readiness (../readiness.ts): one answer for every surface
 * that decides whether the company can pay through the bank, and the one
 * step a person can take about its verification.
 */
import { describe, expect, it } from 'vitest'
import {
  paymentsReadiness,
  verificationReadiness,
  verificationRequiredFor,
  verificationStep,
  type ReadinessAccount,
} from '../readiness'
import { VERIFICATION_STATES, type VerificationState } from '../verification-state'

const corporate: ReadinessAccount = { payable: true, account_context: 'corporate' }
const personal: ReadinessAccount = { payable: true, account_context: 'private' }
const unpayable: ReadinessAccount = { payable: false, account_context: 'corporate' }

describe('verificationRequiredFor', () => {
  it('asks for the verification in the corporate context only, as the signing gate does', () => {
    expect(verificationRequiredFor('corporate')).toBe(true)
    expect(verificationRequiredFor('private')).toBe(false)
  })
})

describe('verificationReadiness', () => {
  it.each<[VerificationState, ReturnType<typeof verificationReadiness>]>([
    ['not_started', 'verification_needed'],
    ['form_open', 'verification_pending'],
    ['awaiting_signatory', 'verification_pending'],
    ['link_expired', 'verification_needed'],
    ['valid', 'ready'],
    ['expiring', 'ready'],
    ['expired', 'verification_needed'],
  ])('%s reads %s', (state, readiness) => {
    expect(verificationReadiness(state)).toBe(readiness)
  })

  it('covers every verification state', () => {
    for (const state of VERIFICATION_STATES) expect(verificationReadiness(state)).toMatch(/^(ready|verification_)/)
  })

  it('is unknown when the verification could not be read', () => {
    expect(verificationReadiness(null)).toBe('verification_unknown')
  })
})

describe('paymentsReadiness', () => {
  const verified = { state: 'valid' as const }
  const notStarted = { state: 'not_started' as const }

  it('is unavailable whatever else is known when payments are not open to the company', () => {
    expect(paymentsReadiness({ available: false, accounts: [corporate], verification: verified })).toBe('unavailable')
    expect(paymentsReadiness({ available: false, accounts: [], verification: null })).toBe('unavailable')
  })

  it('is no_account when no account can pay, before the verification is asked', () => {
    expect(paymentsReadiness({ available: true, accounts: [], verification: notStarted })).toBe('no_account')
    expect(paymentsReadiness({ available: true, accounts: [unpayable], verification: notStarted })).toBe('no_account')
  })

  it('follows the verification when a payable account pays in the corporate context', () => {
    expect(paymentsReadiness({ available: true, accounts: [corporate], verification: verified })).toBe('ready')
    expect(paymentsReadiness({ available: true, accounts: [corporate], verification: notStarted })).toBe('verification_needed')
    expect(paymentsReadiness({ available: true, accounts: [corporate], verification: { state: 'awaiting_signatory' } })).toBe('verification_pending')
    expect(paymentsReadiness({ available: true, accounts: [corporate], verification: { state: 'expired' } })).toBe('verification_needed')
    expect(paymentsReadiness({ available: true, accounts: [corporate], verification: null })).toBe('verification_unknown')
  })

  it('is ready without the verification when every payable account is the owner\'s private one (today\'s signing)', () => {
    expect(paymentsReadiness({ available: true, accounts: [personal], verification: notStarted })).toBe('ready')
    expect(paymentsReadiness({ available: true, accounts: [personal, unpayable], verification: null })).toBe('ready')
  })

  it('asks for the verification when any payable account needs it', () => {
    expect(paymentsReadiness({ available: true, accounts: [personal, corporate], verification: notStarted })).toBe('verification_needed')
  })
})

describe('verificationStep', () => {
  it.each<[VerificationState, ReturnType<typeof verificationStep>]>([
    ['not_started', 'verify'],
    ['form_open', 'new_link'],
    ['awaiting_signatory', 'wait'],
    ['link_expired', 'new_link'],
    ['valid', 'none'],
    ['expiring', 'renew'],
    ['expired', 'renew'],
  ])('%s without a form at hand: %s', (state, step) => {
    expect(verificationStep(state)).toBe(step)
  })

  it('opens the form again while it is out and its link is at hand', () => {
    expect(verificationStep('form_open', { formAtHand: true })).toBe('open_form')
    expect(verificationStep('awaiting_signatory', { formAtHand: true })).toBe('open_form')
    // A link at hand for a form that is no longer out is not opened.
    expect(verificationStep('link_expired', { formAtHand: true })).toBe('new_link')
    expect(verificationStep('valid', { formAtHand: true })).toBe('none')
  })
})
