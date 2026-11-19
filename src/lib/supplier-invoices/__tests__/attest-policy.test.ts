import { describe, expect, it } from 'vitest'
import {
  attestLevelsOn,
  attestProgress,
  attestStepsRequired,
  currentRound,
  effectiveAttestLimit,
  eligibleAttesters,
  invoiceNeedsAttest,
  invoiceTotalSek,
  latestRejection,
  limitCovers,
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
    expect(ruleOnApproval(policy(), 'accrual', invoice(), trail, ANNA)).toEqual({ kind: 'record', satisfies: true, remainingAfter: [], step: 1, limitSek: null })
  })

  it('says whether the approval completes the policy', () => {
    const p = policy({ mode: 'all' })
    expect(ruleOnApproval(p, 'accrual', invoice(), [], ANNA)).toEqual({ kind: 'record', satisfies: false, remainingAfter: [BO], step: 1, limitSek: null })
    expect(ruleOnApproval(p, 'accrual', invoice(), [approval(ANNA, '2026-10-01T09:00:00Z')], BO)).toEqual({
      kind: 'record',
      satisfies: true,
      remainingAfter: [],
      step: 2,
      limitSek: null,
    })
  })
})

describe('levels (#135): a limit per person, two attesters from an amount', () => {
  const DAN = 'dan'
  // Anna the controller attests up to 50 000 kr, Bo the CEO without a limit, Dan up to 10 000 kr.
  const limits = new Map<string, number | null>([
    [ANNA, 50000],
    [BO, null],
    [DAN, 10000],
  ])
  const levels = { limits }
  const p = (overrides: Partial<AttestPolicy> = {}) => policy({ attesters: [ANNA, BO, DAN], ...overrides })
  const t = (minute: number) => `2026-10-01T09:${String(minute).padStart(2, '0')}:00Z`

  it('reads the building blocks: covering, steps, when levels are on', () => {
    expect(limitCovers(null, null)).toBe(true)
    expect(limitCovers(50000, 50000)).toBe(true)
    expect(limitCovers(50000, 50000.01)).toBe(false)
    expect(limitCovers(50000, null)).toBe(false)
    expect(attestStepsRequired(p(), 1e9)).toBe(1)
    expect(attestStepsRequired(p({ two_step_from_sek: 100000 }), 99999.99)).toBe(1)
    expect(attestStepsRequired(p({ two_step_from_sek: 100000 }), 100000)).toBe(2)
    expect(attestStepsRequired(p({ two_step_from_sek: 100000 }), null)).toBe(2)
    expect(attestLevelsOn(p(), new Map())).toBe(false)
    expect(attestLevelsOn(p(), new Map([[ANNA, null]]))).toBe(false)
    expect(attestLevelsOn(p(), limits)).toBe(true)
    expect(attestLevelsOn(p({ two_step_from_sek: 0 }), new Map())).toBe(true)
    // Only an attester's limit counts: a former attester's row turns nothing on.
    expect(attestLevelsOn(p({ attesters: [BO] }), limits)).toBe(false)
  })

  it('rounds the SEK total to the öre, as the database does', () => {
    expect(invoiceTotalSek(invoice({ currency: 'EUR', total: 0.1, exchange_rate: 3 }))).toBe(0.3)
    expect(invoiceTotalSek(invoice({ total: 1.005 }))).toBe(1.01)
  })

  it('one step: an attester whose limit covers the amount attests alone, one whose limit does not is refused', () => {
    const inv = invoice({ total: 30000 })
    expect(ruleOnApproval(p(), 'accrual', inv, [], ANNA, undefined, levels)).toEqual({
      kind: 'record',
      satisfies: true,
      remainingAfter: [],
      step: 1,
      limitSek: 50000,
    })
    expect(ruleOnApproval(p(), 'accrual', inv, [], DAN, undefined, levels)).toEqual({
      kind: 'refused',
      code: 'ATTEST_LIMIT_EXCEEDED',
      reason: 'limit',
      limit_sek: 10000,
      amount_sek: 30000,
    })
    // Who is still needed: those who cover it.
    expect(attestProgress(p(), 'accrual', inv, [], undefined, limits)).toMatchObject({
      steps: 1,
      remaining: [ANNA, BO],
      approvals_needed: 1,
      needs_covering: true,
      blocked: false,
    })
  })

  it('without limits the rules are what they were', () => {
    expect(ruleOnApproval(p(), 'accrual', invoice({ total: 1e7 }), [], DAN)).toMatchObject({ kind: 'record', satisfies: true })
  })

  it('two steps: someone without a covering limit first, then someone with one', () => {
    const q = p({ two_step_from_sek: 50000 })
    const inv = invoice({ total: 80000 })
    // Anna does not cover 80 000 kr: her approval leaves a covering one to give, Bo's.
    expect(ruleOnApproval(q, 'accrual', inv, [], ANNA, undefined, levels)).toEqual({
      kind: 'record',
      satisfies: false,
      remainingAfter: [BO],
      step: 1,
      limitSek: 50000,
    })
    const trail = [approval(ANNA, t(1))]
    expect(attestProgress(q, 'accrual', inv, trail, undefined, limits)).toMatchObject({ approvals_needed: 1, needs_covering: true, remaining: [BO] })
    // Dan cannot be the second: neither of them covers it.
    expect(ruleOnApproval(q, 'accrual', inv, trail, DAN, undefined, levels)).toMatchObject({ code: 'ATTEST_LIMIT_EXCEEDED', reason: 'limit' })
    expect(ruleOnApproval(q, 'accrual', inv, trail, ANNA, undefined, levels)).toEqual({ kind: 'refused', code: 'ATTEST_ALREADY_GIVEN' })
    expect(ruleOnApproval(q, 'accrual', inv, trail, BO, undefined, levels)).toEqual({
      kind: 'record',
      satisfies: true,
      remainingAfter: [],
      step: 2,
      limitSek: null,
    })
  })

  it('two steps, no fixed order: the covering approval first, then anyone', () => {
    const q = p({ two_step_from_sek: 50000 })
    const inv = invoice({ total: 80000 })
    expect(ruleOnApproval(q, 'accrual', inv, [], BO, undefined, levels)).toEqual({
      kind: 'record',
      satisfies: false,
      remainingAfter: [ANNA, DAN],
      step: 1,
      limitSek: null,
    })
    const trail = [approval(BO, t(1))]
    expect(attestProgress(q, 'accrual', inv, trail, undefined, limits)).toMatchObject({ approvals_needed: 1, needs_covering: false, remaining: [ANNA, DAN] })
    expect(ruleOnApproval(q, 'accrual', inv, trail, DAN, undefined, levels)).toMatchObject({ kind: 'record', satisfies: true, step: 2 })
  })

  it('two steps below the amount is one step; at the amount it is two', () => {
    const q = p({ two_step_from_sek: 50000 })
    expect(ruleOnApproval(q, 'accrual', invoice({ total: 49999.99 }), [], ANNA, undefined, levels)).toMatchObject({ satisfies: true })
    expect(ruleOnApproval(q, 'accrual', invoice({ total: 50000 }), [], ANNA, undefined, levels)).toMatchObject({ satisfies: false })
  })

  it('a rejection starts the round over, levels included', () => {
    const q = p({ two_step_from_sek: 50000 })
    const trail = [approval(ANNA, t(1)), rejection(BO, t(2))]
    expect(ruleOnApproval(q, 'accrual', invoice({ total: 80000 }), trail, DAN, undefined, levels)).toMatchObject({ kind: 'record', satisfies: false, step: 1 })
  })

  it('is blocked when nobody covers the amount, or there are fewer attesters than steps', () => {
    const capped = new Map<string, number | null>([
      [ANNA, 50000],
      [BO, 50000],
    ])
    expect(attestProgress(policy(), 'accrual', invoice({ total: 80000 }), [], undefined, capped)).toMatchObject({ blocked: true })
    expect(attestProgress(policy({ attesters: [BO, ANNA], two_step_from_sek: 0 }), 'accrual', invoice({ user_id: ANNA }), [], undefined, limits)).toMatchObject({
      blocked: true,
      eligible: [BO],
      steps: 2,
    })
  })

  it('mode all: every attester approves whatever their limit, and one of them must cover the amount', () => {
    const q = p({ mode: 'all' })
    const inv = invoice({ total: 80000 })
    expect(ruleOnApproval(q, 'accrual', inv, [], DAN, undefined, levels)).toMatchObject({ kind: 'record', satisfies: false })
    const both = [approval(ANNA, t(1)), approval(DAN, t(2))]
    expect(ruleOnApproval(q, 'accrual', inv, both, BO, undefined, levels)).toMatchObject({ kind: 'record', satisfies: true, step: 3 })
    const nobodyCovers = new Map<string, number | null>([
      [ANNA, 1],
      [BO, 1],
      [DAN, 1],
    ])
    expect(ruleOnApproval(q, 'accrual', inv, both, BO, undefined, { limits: nobodyCovers })).toMatchObject({ kind: 'record', satisfies: false })
  })

  it('a foreign invoice without a rate is covered only by no limit, and needs two from any two-step amount', () => {
    const inv = invoice({ currency: 'EUR', total: 100, exchange_rate: null })
    expect(attestProgress(p({ two_step_from_sek: 1e9 }), 'accrual', inv, [], undefined, limits)).toMatchObject({
      amount_sek: null,
      steps: 2,
      remaining: [ANNA, BO, DAN],
    })
    expect(ruleOnApproval(p(), 'accrual', inv, [], ANNA, undefined, levels)).toMatchObject({ code: 'ATTEST_LIMIT_EXCEEDED', amount_sek: null })
  })

  it('through a key with levels on, the lower of the limit and the key ceiling caps the attest', () => {
    const inv = invoice({ total: 30000 })
    expect(effectiveAttestLimit(p(), BO, { limits, viaKey: true, keyCeiling: 20000 })).toBe(20000)
    expect(effectiveAttestLimit(p(), ANNA, { limits, viaKey: true, keyCeiling: 80000 })).toBe(50000)
    expect(effectiveAttestLimit(p(), BO, { limits, viaKey: true, keyCeiling: null })).toBeNull()
    expect(ruleOnApproval(p(), 'accrual', inv, [], BO, undefined, { limits, viaKey: true, keyCeiling: 20000 })).toEqual({
      kind: 'refused',
      code: 'ATTEST_LIMIT_EXCEEDED',
      reason: 'key_limit',
      limit_sek: 20000,
      amount_sek: 30000,
    })
    expect(ruleOnApproval(p(), 'accrual', inv, [], BO, undefined, { limits, viaKey: true, keyCeiling: 40000 })).toMatchObject({ kind: 'record', limitSek: 40000 })
    // Through a key no step above the person's own limit is given, not even toward two steps.
    const q = p({ two_step_from_sek: 50000 })
    expect(ruleOnApproval(q, 'accrual', invoice({ total: 80000 }), [], ANNA, undefined, { limits, viaKey: true })).toMatchObject({
      reason: 'key_limit',
      limit_sek: 50000,
    })
    // Without levels the key's ceiling is not the attest rules' business.
    expect(ruleOnApproval(p(), 'accrual', inv, [], BO, undefined, { viaKey: true, keyCeiling: 1 })).toMatchObject({ kind: 'record', satisfies: true })
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
