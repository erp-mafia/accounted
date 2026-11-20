/**
 * Ordered attest steps and substitutes (#192) in the TypeScript rules
 * (attest-policy.ts): förattest per project first, then the attest, and a
 * substitute attesting in an attester's place. The SQL twin is proven to
 * agree in tests/pg/supplier-invoice-attest-steps.pg.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  actsFor,
  attestAskees,
  attestProgress,
  attestsAtAnyStep,
  invoiceProjects,
  NO_ATTEST_POLICY,
  preAttestGroups,
  ruleOnApproval,
  ruleOnRejection,
  type AttestationRecord,
  type AttestPolicy,
} from '../attest-policy'

// Projektledare Petra (P100) and Pål (P200), ekonomi Eva and the CEO Ville, Cilla registers.
const PETRA = 'p-petra'
const PAL = 'p-pal'
const EVA = 'e-eva'
const VILLE = 'v-ville'
const CILLA = 'c-cilla'
const BOSSE = 'b-bosse'

const policy = (overrides: Partial<AttestPolicy> = {}): AttestPolicy => ({
  ...NO_ATTEST_POLICY,
  enabled: true,
  attesters: [EVA, VILLE],
  project_attesters: { P100: [PETRA], P200: [PAL] },
  ...overrides,
})

const invoice = (projects: Array<string | null> | undefined, overrides: Partial<{ user_id: string; total: number }> = {}) => ({
  user_id: CILLA,
  total: 10000,
  currency: 'SEK',
  total_sek: null,
  exchange_rate: null,
  is_credit_note: false,
  ...(projects ? { projects } : {}),
  ...overrides,
})

let clock = 0
const at = () => new Date(Date.UTC(2026, 10, 7, 9, clock++)).toISOString()
const pre = (user_id: string, on_behalf_of: string | null = null): AttestationRecord => ({ user_id, decision: 'approved', decided_at: at(), stage: 'pre', on_behalf_of })
const fin = (user_id: string, on_behalf_of: string | null = null): AttestationRecord => ({ user_id, decision: 'approved', decided_at: at(), stage: 'final', on_behalf_of })

describe('invoiceProjects', () => {
  it("reads each line's project, else the invoice's, and the invoice's own without lines", () => {
    expect(invoiceProjects({ '6': 'P100' }, [])).toEqual(['P100'])
    expect(invoiceProjects(null, [])).toEqual([null])
    expect(invoiceProjects({ '6': 'P100' }, [{ dimensions: { '6': 'P200' } }, { dimensions: {} }, { dimensions: { '1': 'KS1' } }])).toEqual(['P200', 'P100'])
    expect(invoiceProjects({}, [{ dimensions: { '6': ' P200 ' } }, { dimensions: { '6': '' } }])).toEqual(['P200', null])
    // As the verifikat books it: an empty value on a line clears the invoice's project.
    expect(invoiceProjects({ '6': 'P100' }, [{ dimensions: { '6': '' } }, { dimensions: { '6': 'P200' } }])).toEqual([null, 'P200'])
  })
})

describe('preAttestGroups', () => {
  it('routes each project to its attesters and lines without one to the default förattestants', () => {
    const p = policy({ pre_attesters: [BOSSE] })
    expect(preAttestGroups(p, invoice(['P200', 'P100']))).toEqual([
      { project: 'P100', attesters: [PETRA] },
      { project: 'P200', attesters: [PAL] },
    ])
    expect(preAttestGroups(p, invoice(['P100', null]))).toEqual([
      { project: 'P100', attesters: [PETRA] },
      { project: null, attesters: [BOSSE] },
    ])
    // A project nobody is named for goes to the default förattestants, once however many there are.
    expect(preAttestGroups(p, invoice(['P900', 'P901']))).toEqual([{ project: null, attesters: [BOSSE] }])
    expect(preAttestGroups(p, invoice(undefined))).toEqual([{ project: null, attesters: [BOSSE] }])
  })

  it('asks no förattest of a line without a routed project when there are no default förattestants', () => {
    expect(preAttestGroups(policy(), invoice([null]))).toEqual([])
    expect(preAttestGroups(policy(), invoice(['P100', null]))).toEqual([{ project: 'P100', attesters: [PETRA] }])
    expect(preAttestGroups(NO_ATTEST_POLICY, invoice(['P100']))).toEqual([])
  })
})

describe('ordered steps: the project leader first, then ekonomi', () => {
  it('lets only the project leader approve first, and ekonomi after', () => {
    const p = policy()
    const inv = invoice(['P100'])
    expect(ruleOnApproval(p, 'accrual', inv, [], EVA)).toEqual({ kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'other_step' })
    expect(ruleOnApproval(p, 'accrual', inv, [], PAL)).toEqual({ kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'not_attester' })
    expect(ruleOnApproval(p, 'accrual', inv, [], PETRA)).toEqual({
      kind: 'record',
      satisfies: false,
      remainingAfter: [EVA, VILLE],
      step: 1,
      limitSek: null,
      stage: 'pre',
    })
    const trail = [pre(PETRA)]
    expect(attestProgress(p, 'accrual', inv, trail)).toMatchObject({ stage: 'final', remaining: [EVA, VILLE], pre_approved_by: [PETRA], satisfied: false })
    expect(ruleOnApproval(p, 'accrual', inv, trail, PETRA)).toEqual({ kind: 'refused', code: 'ATTEST_ALREADY_GIVEN' })
    expect(ruleOnApproval(p, 'accrual', inv, trail, EVA)).toEqual({ kind: 'record', satisfies: true, remainingAfter: [], step: 2, limitSek: null, stage: 'final' })
  })

  it('needs a förattest for every project on the invoice, one approval covering every group its giver is in', () => {
    const p = policy()
    const inv = invoice(['P100', 'P200'])
    const afterPetra = attestProgress(p, 'accrual', inv, [pre(PETRA)])
    expect(afterPetra).toMatchObject({ stage: 'pre', remaining: [PAL], approvals_needed: 2 })
    expect(afterPetra.pre_groups?.map((g) => g.done)).toEqual([true, false])
    expect(ruleOnApproval(p, 'accrual', inv, [pre(PETRA)], EVA)).toMatchObject({ kind: 'refused', reason: 'other_step' })
    expect(attestProgress(p, 'accrual', inv, [pre(PETRA), pre(PAL)])).toMatchObject({ stage: 'final', remaining: [EVA, VILLE] })
    // Petra leads both projects: her one approval is both förattests.
    const both = policy({ project_attesters: { P100: [PETRA], P200: [PETRA, PAL] } })
    expect(attestProgress(both, 'accrual', inv, [pre(PETRA)])).toMatchObject({ stage: 'final' })
  })

  it('never lets one person give both steps of an invoice', () => {
    // Eva is project leader of P100 and an attester: her förattest leaves the attest to Ville.
    const p = policy({ project_attesters: { P100: [EVA] } })
    const inv = invoice(['P100'])
    expect(ruleOnApproval(p, 'accrual', inv, [], EVA)).toMatchObject({ kind: 'record', stage: 'pre', satisfies: false, remainingAfter: [VILLE] })
    const trail = [pre(EVA)]
    expect(ruleOnApproval(p, 'accrual', inv, trail, EVA)).toEqual({ kind: 'refused', code: 'ATTEST_ALREADY_GIVEN' })
    expect(attestProgress(p, 'accrual', inv, trail)).toMatchObject({ eligible: [VILLE], remaining: [VILLE], blocked: false })
    // Under mode all, whoever förattested is no longer asked to attest.
    expect(ruleOnApproval({ ...p, mode: 'all' }, 'accrual', inv, trail, VILLE)).toMatchObject({ kind: 'record', satisfies: true })
    // With nobody left for the attest, the invoice is blocked.
    expect(attestProgress({ ...p, attesters: [EVA] }, 'accrual', inv, trail)).toMatchObject({ blocked: true, satisfied: false })
  })

  it('keeps the registrant out of the förattest and blocks a project nobody else can förattest', () => {
    const p = policy()
    const inv = invoice(['P100'], { user_id: PETRA })
    expect(ruleOnApproval(p, 'accrual', inv, [], PETRA)).toEqual({ kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'registrant' })
    expect(attestProgress(p, 'accrual', inv, [])).toMatchObject({ stage: 'pre', blocked: true, remaining: [] })
    expect(attestProgress({ ...p, preparer_may_attest: true }, 'accrual', inv, [])).toMatchObject({ blocked: false, remaining: [PETRA] })
  })

  it('applies no limit to a förattest, and the limits to the attest after it', () => {
    const limits = new Map([
      [PETRA, 1000],
      [EVA, 5000],
    ])
    const p = policy()
    const inv = invoice(['P100'], { total: 20000 })
    expect(ruleOnApproval(p, 'accrual', inv, [], PETRA, undefined, { limits })).toMatchObject({ kind: 'record', stage: 'pre', limitSek: null })
    expect(ruleOnApproval(p, 'accrual', inv, [], PETRA, undefined, { limits, viaKey: true, keyCeiling: 50000 })).toMatchObject({ kind: 'record', stage: 'pre' })
    const trail = [pre(PETRA)]
    expect(ruleOnApproval(p, 'accrual', inv, trail, EVA, undefined, { limits })).toMatchObject({ kind: 'refused', code: 'ATTEST_LIMIT_EXCEEDED', reason: 'limit' })
    expect(attestProgress(p, 'accrual', inv, trail, undefined, limits)).toMatchObject({ remaining: [VILLE], needs_covering: true })
  })

  it('completes the policy with the förattest when the attest was given before the förattest was asked for', () => {
    const p = policy()
    const inv = invoice(['P100'])
    // Eva attested before the company named project attesters.
    const trail: AttestationRecord[] = [{ user_id: EVA, decision: 'approved', decided_at: at() }]
    expect(attestProgress(p, 'accrual', inv, trail)).toMatchObject({ stage: 'pre', approved_by: [EVA], satisfied: false })
    expect(ruleOnApproval(p, 'accrual', inv, trail, PETRA)).toMatchObject({ kind: 'record', stage: 'pre', satisfies: true, step: 2 })
  })

  it('starts the förattest over after a rejection, which any step may give', () => {
    const p = policy()
    const inv = invoice(['P100'])
    expect(ruleOnRejection(p, 'accrual', inv, EVA)).toEqual({ kind: 'record' })
    expect(ruleOnRejection(p, 'accrual', inv, PETRA)).toEqual({ kind: 'record' })
    expect(ruleOnRejection(p, 'accrual', inv, PAL)).toEqual({ kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'not_attester' })
    const trail: AttestationRecord[] = [pre(PETRA), { user_id: EVA, decision: 'rejected', decided_at: at() }]
    expect(attestProgress(p, 'accrual', inv, trail)).toMatchObject({ stage: 'pre', remaining: [PETRA] })
  })
})

describe('substitutes', () => {
  const away = (user_id: string, substitute_user_id: string) => ({ user_id, substitute_user_id })

  it('lets the substitute attest in the attester\'s place, with their limit, recorded for them', () => {
    const limits = new Map([
      [EVA, 50000],
      [BOSSE, 1000],
    ])
    const p = policy({ project_attesters: {}, substitutes: [away(EVA, BOSSE)] })
    const inv = invoice(undefined, { total: 20000 })
    expect(actsFor(p, BOSSE)).toEqual([BOSSE, EVA])
    expect(attestsAtAnyStep(p, BOSSE)).toBe(true)
    expect(ruleOnApproval(p, 'accrual', inv, [], BOSSE, undefined, { limits })).toEqual({
      kind: 'record',
      satisfies: true,
      remainingAfter: [],
      step: 1,
      limitSek: 50000,
      onBehalfOf: EVA,
    })
    // Eva's place is taken: neither she nor another substitute of hers gives it again.
    const trail = [fin(BOSSE, EVA)]
    expect(attestProgress({ ...p, mode: 'all' }, 'accrual', inv, trail, undefined, limits)).toMatchObject({ approved_by: [EVA], remaining: [VILLE] })
    expect(ruleOnApproval({ ...p, mode: 'all' }, 'accrual', inv, trail, EVA, undefined, { limits })).toEqual({ kind: 'refused', code: 'ATTEST_ALREADY_GIVEN' })
  })

  it('stands in for a project leader at the förattest, and the mail and Att göra ask the substitute', () => {
    const p = policy({ substitutes: [away(PETRA, BOSSE)] })
    const inv = invoice(['P100'])
    const progress = attestProgress(p, 'accrual', inv, [])
    expect(progress.stand_ins).toEqual([{ user_id: BOSSE, for_user_id: PETRA }])
    expect(attestAskees(progress)).toEqual([PETRA, BOSSE])
    expect(ruleOnApproval(p, 'accrual', inv, [], BOSSE)).toMatchObject({ kind: 'record', stage: 'pre', onBehalfOf: PETRA })
    expect(ruleOnRejection(p, 'accrual', inv, BOSSE)).toEqual({ kind: 'record', onBehalfOf: PETRA })
  })

  it('is still one person: an attester in their own right uses their own place, and approves once', () => {
    // Ville stands in for Eva and attests in his own right too.
    const p = policy({ project_attesters: {}, two_step_from_sek: 0, substitutes: [away(EVA, VILLE)] })
    const inv = invoice(undefined)
    expect(ruleOnApproval(p, 'accrual', inv, [], VILLE)).toMatchObject({ kind: 'record', satisfies: false, step: 1 })
    expect((ruleOnApproval(p, 'accrual', inv, [], VILLE) as { onBehalfOf?: string }).onBehalfOf).toBeUndefined()
    // Having approved as himself, he cannot approve again as Eva: two steps need two people.
    expect(ruleOnApproval(p, 'accrual', inv, [fin(VILLE)], VILLE)).toEqual({ kind: 'refused', code: 'ATTEST_ALREADY_GIVEN' })
    expect(attestProgress(p, 'accrual', inv, [fin(VILLE)]).stand_ins).toBeUndefined()
  })

  it('never lets the registrant stand in for anyone', () => {
    const p = policy({ project_attesters: {}, substitutes: [away(EVA, CILLA)] })
    const inv = invoice(undefined)
    expect(ruleOnApproval(p, 'accrual', inv, [], CILLA)).toEqual({ kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'registrant' })
    expect(attestProgress(p, 'accrual', inv, []).stand_ins).toBeUndefined()
  })

  it('lets nobody stand in through a member who left', () => {
    const p = policy({ project_attesters: {}, substitutes: [away(EVA, BOSSE)] })
    const members = new Set([EVA, VILLE, CILLA])
    expect(ruleOnApproval(p, 'accrual', invoice(undefined), [], BOSSE, members)).toEqual({ kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'not_member' })
    expect(attestProgress(p, 'accrual', invoice(undefined), [], members).stand_ins).toBeUndefined()
  })
})

describe('opt-in: a company that names none of it is ruled exactly as before', () => {
  /** A deterministic sequence in [0, 1). */
  function sequence(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }

  it('answers the same rulings and progress, key for key, with the new fields empty or left out', () => {
    const random = sequence(192)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
    const people = [EVA, VILLE, CILLA, PETRA, BOSSE]
    for (let i = 0; i < 400; i++) {
      const before: AttestPolicy = {
        ...NO_ATTEST_POLICY,
        enabled: random() < 0.9,
        threshold_amount: pick([null, 1000, 50000]),
        mode: pick(['any', 'all'] as const),
        attesters: people.filter(() => random() < 0.6),
        preparer_may_attest: random() < 0.3,
        two_step_from_sek: pick([null, 0, 20000]),
      }
      const empty: AttestPolicy = { ...before, pre_attesters: [], project_attesters: {}, substitutes: [] }
      const limits = new Map(people.filter(() => random() < 0.4).map((id) => [id, pick([null, 1000, 30000])] as const))
      const inv = { ...invoice(pick([undefined, ['P100'], [null]]), { user_id: pick(people), total: pick([500, 10000, 40000]) }) }
      const trail: AttestationRecord[] = []
      for (let k = Math.floor(random() * 4); k > 0; k--) trail.push({ user_id: pick(people), decision: random() < 0.8 ? 'approved' : 'rejected', decided_at: at() })
      const members = random() < 0.5 ? new Set(people.filter(() => random() < 0.8)) : undefined
      expect(attestProgress(empty, 'accrual', inv, trail, members, limits)).toEqual(attestProgress(before, 'accrual', inv, trail, members, limits))
      expect(Object.keys(attestProgress(empty, 'accrual', inv, trail, members, limits)).sort()).toEqual(
        ['required', 'mode', 'satisfied', 'approved_by', 'remaining', 'eligible', 'blocked', 'amount_sek', 'steps', 'approvals_needed', 'needs_covering'].sort(),
      )
      for (const actor of people) {
        const levels = { limits, viaKey: random() < 0.3, keyCeiling: pick([null, 20000]) }
        const a = ruleOnApproval(empty, 'accrual', inv, trail, actor, members, levels)
        expect(a).toEqual(ruleOnApproval(before, 'accrual', inv, trail, actor, members, levels))
        expect(a).not.toHaveProperty('stage')
        expect(a).not.toHaveProperty('onBehalfOf')
        expect(ruleOnRejection(empty, 'accrual', inv, actor, members)).toEqual(ruleOnRejection(before, 'accrual', inv, actor, members))
      }
    }
  })
})
