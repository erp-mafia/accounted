/**
 * Data-layer tests for generateAgiDeclaration (issue #315).
 *
 * An F-skatt payee's cash compensation must reach the AGI as FK131
 * (KontantErsattningEjUlagSA) ONLY. Before the fix, grossSalary was passed
 * through unconditionally, so the same payment was double-reported as
 * FK011 (underlag arbetsgivaravgifter) AND FK131 in the same IU.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateAgiDeclaration } from '../agi/generate-declaration'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'

vi.mock('../personnummer', () => ({
  decryptPersonnummer: (encrypted: string) => {
    if (encrypted === 'emp1_encrypted') return '199001011234'
    if (encrypted === 'emp2_encrypted') return '198506159876'
    return '000000000000'
  },
}))

const log = {
  child: () => log,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger

const RUN = {
  id: 'run-1',
  company_id: 'company-1',
  status: 'approved',
  period_year: 2026,
  period_month: 6,
  payment_date: '2026-06-25',
  total_gross: 55000,
  total_tax: 12000,
  calculation_params: {},
}

const COMPANY = { name: 'Test AB', org_number: '556123-4567' }
const SETTINGS = {
  company_name: 'Test AB',
  org_number: '556123-4567',
  phone: '0701234567',
  email: 'agi@test.se',
}
const PROFILE = { full_name: 'Anna Admin', email: 'anna@test.se' }

const REGULAR_ROW = {
  employee_id: '11111111-1111-4111-8111-111111111111',
  monthly_salary: 40000,
  gross_salary: 40000,
  tax_withheld: 12000,
  avgifter_basis: 40000,
  avgifter_amount: 12568,
  avgifter_rate: 0.3142,
  avgifter_category: 'standard',
  employee: {
    personnummer: 'emp1_encrypted',
    specification_number: 1,
    f_skatt_status: 'a_skatt',
  },
  line_items: [],
}

// Mirrors calculation-engine output for f_skatt: avgifter_basis is already 0
// (the payment forms no underlag for arbetsgivaravgifter) and no tax is
// withheld. gross_salary still carries the paid amount.
const F_SKATT_ROW = {
  employee_id: '22222222-2222-4222-8222-222222222222',
  monthly_salary: null,
  gross_salary: 15000,
  tax_withheld: 0,
  avgifter_basis: 0,
  avgifter_amount: 0,
  avgifter_rate: 0.3142,
  avgifter_category: 'standard',
  employee: {
    personnummer: 'emp2_encrypted',
    specification_number: 2,
    f_skatt_status: 'f_skatt',
  },
  line_items: [],
}

function enqueueHappyPath(
  enqueueMany: (results: { data?: unknown; error?: unknown }[]) => void,
  roster: unknown[],
) {
  enqueueMany([
    { data: RUN }, // salary_runs select
    { data: COMPANY }, // companies select
    { data: SETTINGS }, // company_settings select
    { data: PROFILE }, // profiles select
    { data: roster }, // salary_run_employees select
    { data: [] }, // salary_absence_days select
    { data: null }, // agi_declarations maybeSingle (first generation)
    { data: { id: 'agi-1' } }, // agi_declarations insert
    { data: null }, // salary_runs update (agi_generated_at stamp)
  ])
}

function iuBlockFor(xml: string, personnummer: string): string {
  const block = xml
    .split('<gem:IU>')
    .slice(1)
    .find((b) => b.includes(personnummer))
  expect(block, `IU for ${personnummer} should exist`).toBeDefined()
  return block as string
}

const ARGS = {
  companyId: 'company-1',
  userId: 'user-1',
  userEmail: 'anna@test.se',
  salaryRunId: 'run-1',
  log,
  requestId: 'req-1',
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('generateAgiDeclaration: redovisningsperiod follows the payout month (#2191)', () => {
  it('declares an August run paid 25 September under 202609, in the XML and the stored row', async () => {
    const { supabase, enqueueMany, findCall, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { ...RUN, period_month: 8, payment_date: '2026-09-25' } }, // salary_runs select
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: [REGULAR_ROW] },
      { data: [] }, // salary_absence_days
      { data: null }, // agi_declarations maybeSingle (first generation)
      { data: { id: 'agi-1' } }, // agi_declarations insert
      { data: null }, // salary_runs update
    ])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.periodYear).toBe(2026)
    expect(result.periodMonth).toBe(9)
    expect(result.xml).toContain('<gem:RedovisningsPeriod faltkod="006">202609</gem:RedovisningsPeriod>')

    // The lookup and the stored declaration key on the payout month too, so
    // the kvittens and skattekonto flows (which read agi_declarations) agree
    // with what Skatteverket answers for.
    const eqCalls = findCalls('agi_declarations', 'eq')
    expect(eqCalls).toContainEqual(['period_month', 9])
    expect(findCall('agi_declarations', 'insert')).toEqual([
      expect.objectContaining({ period_year: 2026, period_month: 9, salary_run_id: 'run-1' }),
    ])
  })

  it('refuses to overwrite another live run declared for the same payout month', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: { ...RUN, period_month: 8, payment_date: '2026-09-25' } },
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: [REGULAR_ROW] },
      { data: [] },
      { data: { id: 'agi-other', salary_run_id: 'run-2' } }, // 202609 already declared by run-2
      { data: { id: 'run-2', status: 'booked', period_year: 2026, period_month: 9 } },
    ])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('AGI_PERIOD_CONFLICT')
    expect(result.details).toMatchObject({ period: '2026-09', other_salary_run_id: 'run-2' })
    expect(findCall('agi_declarations', 'update')).toBeUndefined()
    expect(findCall('agi_declarations', 'insert')).toBeUndefined()
  })

  it('still treats a corrected run\'s declaration as the one to replace', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: { ...RUN, period_month: 8, payment_date: '2026-09-25', is_correction: true, corrects_run_id: 'run-0' } },
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: [REGULAR_ROW] },
      { data: [] },
      { data: { id: 'agi-0', salary_run_id: 'run-0' } }, // declared by the run this one corrects
      { data: null }, // agi_declarations update
      { data: null }, // salary_runs update
    ])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.isCorrection).toBe(true)
    expect(findCall('agi_declarations', 'update')).toEqual([
      expect.objectContaining({ is_correction: true, salary_run_id: 'run-1' }),
    ])
  })
})

describe('generateAgiDeclaration: F-skatt payee (FK131 only, issue #315)', () => {
  it('reports F-skatt cash on FK131 only, never FK011/FK001, in a mixed roster', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [REGULAR_ROW, F_SKATT_ROW])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The F-skatt IU is kept (not dropped by the empty-IU filter).
    expect(result.employeeCount).toBe(2)

    const fSkattIu = iuBlockFor(result.xml, '198506159876')
    expect(fSkattIu).toContain(
      '<gem:KontantErsattningEjUlagSA faltkod="131">15000</gem:KontantErsattningEjUlagSA>',
    )
    expect(fSkattIu).not.toContain('faltkod="011"')
    expect(fSkattIu).not.toContain('faltkod="001"')
  })

  it('leaves the regular employee IU unchanged (FK011 + FK001, no FK131)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [REGULAR_ROW, F_SKATT_ROW])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const regularIu = iuBlockFor(result.xml, '199001011234')
    expect(regularIu).toContain(
      '<gem:KontantErsattningUlagAG faltkod="011">40000</gem:KontantErsattningUlagAG>',
    )
    expect(regularIu).toContain('<gem:AvdrPrelSkatt faltkod="001">12000</gem:AvdrPrelSkatt>')
    expect(regularIu).not.toContain('faltkod="131"')
  })

  it('excludes the F-skatt payment from FK487/avgifter totals', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [REGULAR_ROW, F_SKATT_ROW])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Only the regular employee contributes to the avgifter basis and amount.
    expect(result.totals.totalAvgifterBasis).toBe(40000)
    expect(result.totals.totalAvgifterAmount).toBe(12568)
    expect(result.xml).toContain(
      '<gem:SummaArbAvgSlf faltkod="487">12568</gem:SummaArbAvgSlf>',
    )
    expect(result.xml).toContain(
      '<gem:SummaSkatteavdr faltkod="497">12000</gem:SummaSkatteavdr>',
    )
  })

  it('keeps an F-skatt-only roster as a real IU declaration, not a nolldeklaration', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [F_SKATT_ROW])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.employeeCount).toBe(1)
    expect(result.xml).toContain(
      '<gem:KontantErsattningEjUlagSA faltkod="131">15000</gem:KontantErsattningEjUlagSA>',
    )
    // Nothing on this declaration reports the payment as AG underlag.
    expect(result.xml).not.toContain('faltkod="011"')
  })
})

describe('generateAgiDeclaration: avgifter overrides on an F-skatt row are ignored', () => {
  // Regression for the CodeRabbit finding on #1402: computed avgifter are
  // already 0 for f_skatt rows, but advanced-mode overrides used to coalesce
  // past that (override ?? computed) at three aggregation points, restoring
  // social charges for pay whose IU simultaneously asserts FK131.
  const REGULAR_OVERRIDE_ROW = {
    ...REGULAR_ROW,
    avgifter_basis_override: 30000,
    avgifter_amount_override: 9426,
  }
  const F_SKATT_OVERRIDE_ROW = {
    ...F_SKATT_ROW,
    avgifter_basis_override: 15000,
    avgifter_amount_override: 4713,
  }

  it('excludes F-skatt overrides from FK487, totals and avgifterByCategory while regular overrides still apply', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [REGULAR_OVERRIDE_ROW, F_SKATT_OVERRIDE_ROW])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The regular employee's override flows through (the override mechanism
    // itself must keep working); the F-skatt row's override is ignored.
    expect(result.totals.totalAvgifterBasis).toBe(30000)
    expect(result.totals.totalAvgifterAmount).toBe(9426)
    expect(result.totals.avgifterByCategory).toEqual({
      standard: { basis: 30000, amount: 9426 },
    })
    expect(result.xml).toContain(
      '<gem:SummaArbAvgSlf faltkod="487">9426</gem:SummaArbAvgSlf>',
    )

    // The F-skatt IU itself is unchanged: FK131 with the payment, no FK011.
    const fSkattIu = iuBlockFor(result.xml, '198506159876')
    expect(fSkattIu).toContain(
      '<gem:KontantErsattningEjUlagSA faltkod="131">15000</gem:KontantErsattningEjUlagSA>',
    )
    expect(fSkattIu).not.toContain('faltkod="011"')
  })
})

describe('generateAgiDeclaration: whole-krona amounts (öretal bortfaller)', () => {
  // Öre-bearing roster: hourly-wage taxes and 31,42 % avgifter rarely land on
  // whole kronor. AGI amounts are declared in whole kronor with the öre
  // dropped (SFF 2011:1261 22 kap. 1 §).
  const ORE_ROW_1 = {
    ...REGULAR_ROW,
    gross_salary: 51158,
    tax_withheld: 12268.6,
    avgifter_basis: 51158,
    avgifter_amount: 16073.84,
  }
  const ORE_ROW_2 = {
    ...REGULAR_ROW,
    employee_id: '22222222-2222-4222-8222-222222222222',
    gross_salary: 10000.9,
    tax_withheld: 4000.6,
    avgifter_basis: 10000.9,
    avgifter_amount: 3141.93,
    employee: {
      personnummer: 'emp2_encrypted',
      specification_number: 2,
      f_skatt_status: 'a_skatt',
    },
  }

  it('declares FK497 as the sum of per-IU truncated taxes, not the truncated sum', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [ORE_ROW_1, ORE_ROW_2])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Per-IU FK001 truncates each employee's tax: 12 268 and 4 000.
    expect(iuBlockFor(result.xml, '199001011234')).toContain(
      '<gem:AvdrPrelSkatt faltkod="001">12268</gem:AvdrPrelSkatt>',
    )
    expect(iuBlockFor(result.xml, '198506159876')).toContain(
      '<gem:AvdrPrelSkatt faltkod="001">4000</gem:AvdrPrelSkatt>',
    )
    // FK497 must equal the sum of the truncated FK001 values (16 268), NOT
    // the truncated öre-exact sum (trunc(16 269,20) = 16 269): the HU total
    // has to agree with what the IUs actually declare.
    expect(result.totals.totalTax).toBe(16268)
    expect(result.xml).toContain(
      '<gem:SummaSkatteavdr faltkod="497">16268</gem:SummaSkatteavdr>',
    )
  })

  it('declares FK487 and per-IU underlag in whole kronor', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [ORE_ROW_1, ORE_ROW_2])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // FK011 truncates the öre-bearing gross: 10 000,90 declares as 10 000.
    expect(iuBlockFor(result.xml, '198506159876')).toContain(
      '<gem:KontantErsattningUlagAG faltkod="011">10000</gem:KontantErsattningUlagAG>',
    )
    // FK487 is Skatteverket's own computation (IK587): per sats on the
    // whole-krona underlag sum. trunc((51 158 + 10 000) × 31,42 %) =
    // trunc(19 215,84) = 19 215. This is the same number the salary booking
    // credits on 2731 and the skattekonto draw settles.
    expect(result.totals.totalAvgifterBasis).toBe(61158)
    expect(result.totals.totalAvgifterAmount).toBe(19215)
    expect(result.xml).toContain(
      '<gem:SummaArbAvgSlf faltkod="487">19215</gem:SummaArbAvgSlf>',
    )
  })

  it('computes FK487 per sats on summed underlag, not by truncating the öre-exact sum', async () => {
    // Two employees at 30 000,99 kr: öre-exact avgifter are 9 426,51 each
    // (18 853,02 in total), but Skatteverket declares 30 000 per IU and
    // computes trunc(60 000 × 31,42 %) = 18 852: one whole krona below the
    // truncated öre-exact sum. The filed FK487 must be Skatteverket's
    // number, or kontroll B_006 flags the filing and the skattekonto draw
    // diverges from the booked 2731.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [
      { ...ORE_ROW_1, gross_salary: 30000.99, avgifter_basis: 30000.99, avgifter_amount: 9426.51, tax_withheld: 9000 },
      { ...ORE_ROW_2, gross_salary: 30000.99, avgifter_basis: 30000.99, avgifter_amount: 9426.51, tax_withheld: 9000 },
    ])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.totals.totalAvgifterBasis).toBe(60000)
    expect(result.totals.totalAvgifterAmount).toBe(18852)
    expect(result.xml).toContain(
      '<gem:SummaArbAvgSlf faltkod="487">18852</gem:SummaArbAvgSlf>',
    )
    // The category breakdown cross-foots exactly against the total.
    expect(result.totals.avgifterByCategory).toEqual({
      standard: { basis: 60000, amount: 18852 },
    })
  })

  it('keeps colleagues SKV-exact when one employee carries an amount override', async () => {
    // FoU-style override on E1 must not cost E2 its per-sats declared
    // amount: E2 declares trunc(30 000 × 31,42 %) = 9 426 from its filed
    // underlag while E1 contributes its manual 7 855.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [
      { ...ORE_ROW_1, avgifter_amount_override: 7855 },
      { ...ORE_ROW_2, gross_salary: 30000.99, avgifter_basis: 30000.99, avgifter_amount: 9426.51 },
    ])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.totals.totalAvgifterAmount).toBe(7855 + 9426)
    expect(result.xml).toContain(
      `<gem:SummaArbAvgSlf faltkod="487">${7855 + 9426}</gem:SummaArbAvgSlf>`,
    )
    const catSum = Object.values(result.totals.avgifterByCategory).reduce(
      (s, c) => s + (c?.amount ?? 0),
      0,
    )
    expect(catSum).toBe(result.totals.totalAvgifterAmount)
  })

  it('a basis-only override is inert on FK487 and the stored totals (filed underlag rules)', async () => {
    // An avgifter_basis_override never reaches the filed IU fields: FK011
    // stays the un-overridden gross, and Skatteverket computes IK587 from
    // that. Letting the override steer FK487 would file 12 568 against IUs
    // that prove 16 073 and underpay the skattekonto by 3 505 kr.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [
      {
        ...ORE_ROW_1,
        avgifter_basis_override: 40000,
        avgifter_amount_override: null,
      },
    ])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(iuBlockFor(result.xml, '199001011234')).toContain(
      '<gem:KontantErsattningUlagAG faltkod="011">51158</gem:KontantErsattningUlagAG>',
    )
    expect(result.totals.totalAvgifterBasis).toBe(51158)
    expect(result.totals.totalAvgifterAmount).toBe(16073)
    expect(result.xml).toContain(
      '<gem:SummaArbAvgSlf faltkod="487">16073</gem:SummaArbAvgSlf>',
    )
  })
})
