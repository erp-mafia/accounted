import { describe, expect, it } from 'vitest'
import {
  attestProgress,
  currentRound,
  eligibleAttesters,
  invoiceNeedsAttest,
  invoiceTotalSek,
  latestRejection,
  mayAttest,
  NO_ATTEST_POLICY,
  paymentWaitsForAttest,
  ruleOnApproval,
  ruleOnRejection,
  type AttestationRecord,
  type AttestPolicy,
} from '../attest-policy'

const ANNA = 'anna'
const BO = 'bo'
const CILLA = 'cilla'

const policy = (overrides: Partial<AttestPolicy> = {}): AttestPolicy => ({
  ...NO_ATTEST_POLICY,
  enabled: true,
  attesters: [ANNA, BO],
  ...overrides,
})

const invoice = (overrides: Partial<{ user_id: string; total: number; currency: string; total_sek: number | null; exchange_rate: number | null; is_credit_note: boolean }> = {}) => ({
  user_id: CILLA,
  total: 10000,
  currency: 'SEK',
  total_sek: null,
  exchange_rate: null,
  is_credit_note: false,
  ...overrides,
})

const approval = (user_id: string, decided_at: string): AttestationRecord => ({ user_id, decision: 'approved', decided_at })
const rejection = (user_id: string, decided_at: string, comment = 'Fel belopp'): AttestationRecord => ({ user_id, decision: 'rejected', decided_at, comment })

describe('invoiceNeedsAttest', () => {
  it('needs nothing without a policy, or with the policy off', () => {
    expect(invoiceNeedsAttest(NO_ATTEST_POLICY, 'accrual', invoice())).toBe(false)
    expect(invoiceNeedsAttest(policy({ enabled: false }), 'accrual', invoice())).toBe(false)
  })

  it('exempts kontantmetoden: it has no attest step', () => {
    expect(invoiceNeedsAttest(policy(), 'cash', invoice())).toBe(false)
    // A company without a setting reads as faktureringsmetoden, as on the pages.
    expect(invoiceNeedsAttest(policy(), null, invoice())).toBe(true)
  })

  it('never asks attest of a credit note', () => {
    expect(invoiceNeedsAttest(policy(), 'accrual', invoice({ is_credit_note: true }))).toBe(false)
  })

  it('requires attest at or above the threshold in SEK, and for every invoice without one', () => {
    expect(invoiceNeedsAttest(policy({ threshold_amount: null }), 'accrual', invoice({ total: 1 }))).toBe(true)
    expect(invoiceNeedsAttest(policy({ threshold_amount: 10000 }), 'accrual', invoice({ total: 10000 }))).toBe(true)
    expect(invoiceNeedsAttest(policy({ threshold_amount: 10000 }), 'accrual', invoice({ total: 9999.99 }))).toBe(false)
  })

  it('judges a foreign invoice in SEK, and fails closed without a rate', () => {
    const p = policy({ threshold_amount: 5000 })
    expect(invoiceNeedsAttest(p, 'accrual', invoice({ currency: 'EUR', total: 400, exchange_rate: 11.5 }))).toBe(false)
    expect(invoiceNeedsAttest(p, 'accrual', invoice({ currency: 'EUR', total: 500, exchange_rate: 11.5 }))).toBe(true)
    expect(invoiceNeedsAttest(p, 'accrual', invoice({ currency: 'EUR', total: 400, total_sek: 6000 }))).toBe(true)
    expect(invoiceNeedsAttest(p, 'accrual', invoice({ currency: 'EUR', total: 1, exchange_rate: null }))).toBe(true)
    expect(invoiceTotalSek(invoice({ currency: 'EUR', total: 1, exchange_rate: null }))).toBeNull()
  })
})

describe('who may attest', () => {
  it('lets only the attesters attest, and not the registrant unless the policy allows it', () => {
    expect(mayAttest(policy(), invoice(), ANNA)).toEqual({ ok: true })
    expect(mayAttest(policy(), invoice(), CILLA)).toEqual({ ok: false, reason: 'not_attester' })
    expect(mayAttest(policy(), invoice({ user_id: ANNA }), ANNA)).toEqual({ ok: false, reason: 'registrant' })
    expect(mayAttest(policy({ preparer_may_attest: true }), invoice({ user_id: ANNA }), ANNA)).toEqual({ ok: true })
  })

  it('counts only attesters still active in the company, and leaves out the registrant', () => {
    expect(eligibleAttesters(policy(), invoice({ user_id: ANNA }))).toEqual([BO])
    expect(eligibleAttesters(policy(), invoice(), new Set([ANNA]))).toEqual([ANNA])
    expect(eligibleAttesters(policy({ preparer_may_attest: true }), invoice({ user_id: ANNA }))).toEqual([ANNA, BO])
  })
})

describe('rounds', () => {
  it('starts a new round after a rejection', () => {
    const trail = [approval(ANNA, '2026-10-01T09:00:00Z'), rejection(BO, '2026-10-02T09:00:00Z'), approval(BO, '2026-10-03T09:00:00Z')]
    expect(currentRound(trail).map((r) => r.user_id)).toEqual([BO])
    expect(latestRejection(trail)?.comment).toBe('Fel belopp')
    expect(latestRejection([approval(ANNA, '2026-10-01T09:00:00Z')])).toBeNull()
  })
})

describe('attestProgress', () => {
  it('any: one approval by an eligible attester satisfies the policy', () => {
    const progress = attestProgress(policy(), 'accrual', invoice(), [approval(BO, '2026-10-01T09:00:00Z')])
    expect(progress).toMatchObject({ required: true, satisfied: true, approved_by: [BO], remaining: [], blocked: false })
  })

  it('all: every eligible attester must approve, and an outsider approval does not count', () => {
    const p = policy({ mode: 'all' })
    const one = attestProgress(p, 'accrual', invoice(), [approval(ANNA, '2026-10-01T09:00:00Z'), approval(CILLA, '2026-10-01T10:00:00Z')])
    expect(one).toMatchObject({ satisfied: false, approved_by: [ANNA], remaining: [BO] })
    const both = attestProgress(p, 'accrual', invoice(), [approval(ANNA, '2026-10-01T09:00:00Z'), approval(BO, '2026-10-01T10:00:00Z')])
    expect(both).toMatchObject({ satisfied: true, remaining: [] })
  })

  it('all, without the registrant: the others are everyone', () => {
    const progress = attestProgress(policy({ mode: 'all' }), 'accrual', invoice({ user_id: ANNA }), [approval(BO, '2026-10-01T09:00:00Z')])
    expect(progress).toMatchObject({ satisfied: true, eligible: [BO] })
  })

  it('is blocked when the only attester registered the invoice', () => {
    const progress = attestProgress(policy({ attesters: [ANNA] }), 'accrual', invoice({ user_id: ANNA }), [])
    expect(progress).toMatchObject({ required: true, satisfied: false, blocked: true, eligible: [] })
  })

  it('a rejection voids the approvals before it', () => {
    const trail = [approval(ANNA, '2026-10-01T09:00:00Z'), rejection(BO, '2026-10-02T09:00:00Z')]
    expect(attestProgress(policy(), 'accrual', invoice(), trail)).toMatchObject({ satisfied: false, approved_by: [] })
  })

  it('says nothing is required when the policy does not govern the invoice', () => {
    expect(attestProgress(policy(), 'cash', invoice(), [])).toMatchObject({ required: false, satisfied: false, remaining: [], blocked: false })
  })
})

describe('ruleOnApproval', () => {
  it('is unrestricted where the policy does not govern the invoice', () => {
    expect(ruleOnApproval(NO_ATTEST_POLICY, 'accrual', invoice(), [], CILLA)).toEqual({ kind: 'unrestricted' })
    expect(ruleOnApproval(policy({ threshold_amount: 50000 }), 'accrual', invoice(), [], CILLA)).toEqual({ kind: 'unrestricted' })
  })

  it('refuses a non-attester, the registrant, a former member and a second approval in the round', () => {
    expect(ruleOnApproval(policy(), 'accrual', invoice(), [], CILLA)).toMatchObject({ code: 'ATTEST_NOT_ALLOWED', reason: 'not_attester' })
    expect(ruleOnApproval(policy(), 'accrual', invoice({ user_id: ANNA }), [], ANNA)).toMatchObject({ code: 'ATTEST_NOT_ALLOWED', reason: 'registrant' })
    expect(ruleOnApproval(policy(), 'accrual', invoice(), [], ANNA, new Set([BO]))).toMatchObject({ code: 'ATTEST_NOT_ALLOWED', reason: 'not_member' })
    expect(ruleOnApproval(policy({ mode: 'all' }), 'accrual', invoice(), [approval(ANNA, '2026-10-01T09:00:00Z')], ANNA)).toEqual({
      kind: 'refused',
      code: 'ATTEST_ALREADY_GIVEN',
    })
  })

  it('lets an attester approve again after a rejection restarted the round', () => {
    const trail = [approval(ANNA, '2026-10-01T09:00:00Z'), rejection(BO, '2026-10-02T09:00:00Z')]
    expect(ruleOnApproval(policy(), 'accrual', invoice(), trail, ANNA)).toEqual({ kind: 'record', satisfies: true, remainingAfter: [] })
  })

  it('says whether the approval completes the policy', () => {
    const p = policy({ mode: 'all' })
    expect(ruleOnApproval(p, 'accrual', invoice(), [], ANNA)).toEqual({ kind: 'record', satisfies: false, remainingAfter: [BO] })
    expect(ruleOnApproval(p, 'accrual', invoice(), [approval(ANNA, '2026-10-01T09:00:00Z')], BO)).toEqual({ kind: 'record', satisfies: true, remainingAfter: [] })
  })
})

describe('ruleOnRejection', () => {
  it('lets whoever may approve reject', () => {
    expect(ruleOnRejection(NO_ATTEST_POLICY, 'accrual', invoice(), CILLA)).toEqual({ kind: 'unrestricted' })
    expect(ruleOnRejection(policy(), 'accrual', invoice(), ANNA)).toEqual({ kind: 'record' })
    expect(ruleOnRejection(policy(), 'accrual', invoice(), CILLA)).toMatchObject({ code: 'ATTEST_NOT_ALLOWED' })
    expect(ruleOnRejection(policy(), 'accrual', invoice({ user_id: ANNA }), ANNA)).toMatchObject({ reason: 'registrant' })
  })
})

describe('paymentWaitsForAttest', () => {
  it('waits only while the policy requires attest and approved_at is unset', () => {
    expect(paymentWaitsForAttest(policy(), 'accrual', { ...invoice(), approved_at: null })).toBe(true)
    expect(paymentWaitsForAttest(policy(), 'accrual', { ...invoice(), approved_at: '2026-10-01T09:00:00Z' })).toBe(false)
    expect(paymentWaitsForAttest(policy({ enabled: false }), 'accrual', { ...invoice(), approved_at: null })).toBe(false)
    expect(paymentWaitsForAttest(policy(), 'cash', { ...invoice(), approved_at: null })).toBe(false)
  })
})
