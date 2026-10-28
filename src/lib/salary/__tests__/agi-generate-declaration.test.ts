/**
 * Data-layer tests for generateAgiDeclaration (issue #315, #82).
 *
 * An F-skatt payee's cash compensation must reach the AGI as FK125
 * (KontantErsattningUlagEA, inkomst av tjänst for a mottagare med F-skatt)
 * ONLY. Before #315 grossSalary was passed through unconditionally, so the
 * same payment was double-reported as FK011 (underlag arbetsgivaravgifter)
 * and a second field in the same IU; before #82 that second field was FK131.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideAgiWrite, generateAgiDeclaration } from '../agi/generate-declaration'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { roundOre } from '@/lib/money'
import { declaredAvgifterForRun } from '../declared-avgifter'
import { effectiveRunTotals } from '../effective-figures'
import type { Logger } from '@/lib/logger'

vi.mock('../personnummer', () => ({
  decryptPersonnummer: (encrypted: string) => {
    if (encrypted === 'emp1_encrypted') return '199001011234'
    if (encrypted === 'emp2_encrypted') return '198506159876'
    if (encrypted === 'emp3_encrypted') return '197703031234'
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

describe('generateAgiDeclaration: kontaktperson (agent feedback seq 948847)', () => {
  function enqueueWithSettings(
    enqueueMany: (results: { data?: unknown; error?: unknown }[]) => void,
    settings: Record<string, unknown>,
  ) {
    enqueueMany([
      { data: RUN },
      { data: COMPANY },
      { data: settings },
      { data: PROFILE },
      { data: [REGULAR_ROW] },
      { data: [] }, // salary_absence_days
      { data: null }, // agi_declarations maybeSingle
      { data: { id: 'agi-1' } }, // agi_declarations insert
      { data: null }, // salary_runs update
    ])
  }

  it('uses the tax contact when the company has no phone, instead of refusing for telefon', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueWithSettings(enqueueMany, {
      ...SETTINGS,
      phone: null,
      tax_contact_name: 'Kim Kontakt',
      tax_contact_phone: '08-123 45 67',
      tax_contact_email: 'skatt@test.se',
    })

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<gem:Namn>Kim Kontakt</gem:Namn>')
    expect(result.xml).toContain('<gem:Telefon>08-123 45 67</gem:Telefon>')
    expect(result.xml).toContain('<gem:Epostadress>skatt@test.se</gem:Epostadress>')
  })

  it('prefers the tax contact over the company contact details', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueWithSettings(enqueueMany, {
      ...SETTINGS,
      tax_contact_name: 'Kim Kontakt',
      tax_contact_phone: '08-123 45 67',
      tax_contact_email: null,
    })

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<gem:Telefon>08-123 45 67</gem:Telefon>')
    expect(result.xml).not.toContain('0701234567')
    // No tax contact e-mail: falls back to the company e-mail.
    expect(result.xml).toContain('<gem:Epostadress>agi@test.se</gem:Epostadress>')
  })

  it('still refuses with AGI_INCOMPLETE_DATA when neither the company nor the tax contact has a phone', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueWithSettings(enqueueMany, { ...SETTINGS, phone: null, tax_contact_phone: '  ' })

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('AGI_INCOMPLETE_DATA')
    expect((result.details as { missing_fields: string[] }).missing_fields).toContain('telefon')
  })
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
      { data: { id: 'agi-0', salary_run_id: 'run-0', status: 'generated', submitted_at: null } }, // declared by the run this one corrects
      { data: [{ id: 'agi-0' }] }, // agi_declarations update
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

describe('generateAgiDeclaration: a correction run starts its declaration unfiled', () => {
  function enqueueOver(
    enqueueMany: (results: { data?: unknown; error?: unknown }[]) => void,
    run: Record<string, unknown>,
    stored: Record<string, unknown>,
  ) {
    enqueueMany([
      { data: run },
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: [REGULAR_ROW] },
      { data: [] }, // salary_absence_days
      { data: stored }, // agi_declarations for the period
      { data: [{ id: stored.id }] }, // agi_declarations update
      { data: null }, // salary_runs agi_generated_at stamp
    ])
  }

  it("resets the filing state of the original's filed row it takes over: the correction is not filed yet", async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    // The period's row is the original's, filed: status submitted, its kvittens.
    enqueueOver(enqueueMany, { ...RUN, status: 'booked', is_correction: true, corrects_run_id: 'run-0' }, {
      id: 'agi-0',
      salary_run_id: 'run-0',
      status: 'submitted',
      submitted_at: '2026-07-09T08:30:00Z',
    })

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Same row, the correction's content, and unfiled: the submit flips it to
    // pending_signature and the kvittens reconciliation promotes it on the
    // correction's own kvittens. The original's receipt lives on in
    // agi_kvittenser and on its run's agi_submitted_at.
    expect(findCall('agi_declarations', 'update')).toEqual([
      expect.objectContaining({
        xml_content: result.xml,
        salary_run_id: 'run-1',
        is_correction: true,
        status: 'generated',
        kvittensnummer: null,
        submitted_at: null,
        submitted_by: null,
        response_data: null,
      }),
    ])
    expect(findCall('agi_declarations', 'insert')).toBeUndefined()
  })

  it("leaves the filing state alone when a run regenerates its own declaration", async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueOver(enqueueMany, RUN, { id: 'agi-1', salary_run_id: 'run-1', status: 'generated', submitted_at: null })

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    const update = findCall('agi_declarations', 'update')?.[0] as Record<string, unknown>
    expect(update).toMatchObject({ salary_run_id: 'run-1' })
    for (const column of ['status', 'kvittensnummer', 'submitted_at', 'submitted_by', 'response_data']) {
      expect(update).not.toHaveProperty(column)
    }
  })
})

describe('generateAgiDeclaration: F-skatt payee (FK125 only, issue #315, #82)', () => {
  it('reports F-skatt cash on FK125 only, never FK011 or FK131, with FK001 as 0, in a mixed roster', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [REGULAR_ROW, F_SKATT_ROW])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The F-skatt IU is kept (not dropped by the empty-IU filter).
    expect(result.employeeCount).toBe(2)

    const fSkattIu = iuBlockFor(result.xml, '198506159876')
    expect(fSkattIu).toContain(
      '<gem:KontantErsattningUlagEA faltkod="125">15000</gem:KontantErsattningUlagEA>',
    )
    expect(fSkattIu).not.toContain('faltkod="011"')
    expect(fSkattIu).not.toContain('faltkod="131"')
    // No tax withheld still needs a skattefält (kontroll S_183, crm#1265).
    expect(fSkattIu).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
  })

  it('leaves the regular employee IU unchanged (FK011 + FK001, no FK125 or FK131)', async () => {
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
    expect(regularIu).not.toContain('faltkod="125"')
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
      '<gem:KontantErsattningUlagEA faltkod="125">15000</gem:KontantErsattningUlagEA>',
    )
    // Nothing on this declaration reports the payment as AG underlag.
    expect(result.xml).not.toContain('faltkod="011"')
  })
})

describe('generateAgiDeclaration: no tax withheld still files FK001 (kontroll S_183, crm#1265)', () => {
  // A-skatt employee paid below the tax table threshold (or jämkad to 0 %):
  // wage on FK011, nothing withheld.
  const ZERO_TAX_ROW = {
    ...REGULAR_ROW,
    employee_id: '33333333-3333-4333-8333-333333333333',
    monthly_salary: 9000,
    gross_salary: 9000,
    tax_withheld: 0,
    avgifter_basis: 9000,
    avgifter_amount: 2827.8,
    employee: { personnummer: 'emp2_encrypted', specification_number: 2, f_skatt_status: 'a_skatt' },
  }
  // On the roster but paid nothing this month: no IU at all.
  const NO_PAY_ROW = {
    ...REGULAR_ROW,
    employee_id: '44444444-4444-4444-8444-444444444444',
    monthly_salary: 0,
    gross_salary: 0,
    tax_withheld: 0,
    avgifter_basis: 0,
    avgifter_amount: 0,
    employee: { personnummer: 'emp3_encrypted', specification_number: 3, f_skatt_status: 'a_skatt' },
  }

  async function generate(roster: unknown[]) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, roster)
    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    return result
  }

  it('declares FK011 and FK001 = 0 for the employee with nothing withheld', async () => {
    const result = await generate([REGULAR_ROW, ZERO_TAX_ROW, NO_PAY_ROW])
    const iu = iuBlockFor(result.xml, '198506159876')
    expect(iu).toContain('<gem:KontantErsattningUlagAG faltkod="011">9000</gem:KontantErsattningUlagAG>')
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
  })

  it('leaves the employee with withheld tax unchanged, and FK497 at the withheld sum', async () => {
    const result = await generate([REGULAR_ROW, ZERO_TAX_ROW, NO_PAY_ROW])
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:KontantErsattningUlagAG faltkod="011">40000</gem:KontantErsattningUlagAG>')
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">12000</gem:AvdrPrelSkatt>')
    expect(result.xml).toContain('<gem:SummaSkatteavdr faltkod="497">12000</gem:SummaSkatteavdr>')
  })

  it('still files no IU for the employee paid nothing at all', async () => {
    const result = await generate([REGULAR_ROW, ZERO_TAX_ROW, NO_PAY_ROW])
    expect(result.employeeCount).toBe(2)
    expect(result.xml.split('<gem:IU>')).toHaveLength(3)
    expect(result.xml).not.toContain('197703031234')
  })

  it('keeps a roster of only unpaid employees a nolldeklaration without IU', async () => {
    const result = await generate([NO_PAY_ROW])
    expect(result.employeeCount).toBe(0)
    expect(result.xml).not.toContain('<gem:IU>')
    expect(result.xml).not.toContain('faltkod="001"')
  })
})

describe('generateAgiDeclaration: avgifter overrides on an F-skatt row are ignored', () => {
  // Regression for the CodeRabbit finding on #1402: computed avgifter are
  // already 0 for f_skatt rows, but advanced-mode overrides used to coalesce
  // past that (override ?? computed) at three aggregation points, restoring
  // social charges for pay whose IU simultaneously declares it in FK125.
  // A regular row's amount override (FoU-style). A partial basis override
  // is refused since #91, so the regular row carries none; the F-skatt row
  // keeps one to prove it is ignored there too.
  const REGULAR_OVERRIDE_ROW = {
    ...REGULAR_ROW,
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
    expect(result.totals.totalAvgifterBasis).toBe(40000)
    expect(result.totals.totalAvgifterAmount).toBe(9426)
    expect(result.totals.avgifterByCategory).toEqual({
      standard: { basis: 40000, amount: 9426 },
    })
    expect(result.xml).toContain(
      '<gem:SummaArbAvgSlf faltkod="487">9426</gem:SummaArbAvgSlf>',
    )

    // The F-skatt IU itself is unchanged: FK125 with the payment, no FK011,
    // and its basis override of 15 000 does not move it to FK131 either.
    const fSkattIu = iuBlockFor(result.xml, '198506159876')
    expect(fSkattIu).toContain(
      '<gem:KontantErsattningUlagEA faltkod="125">15000</gem:KontantErsattningUlagEA>',
    )
    expect(fSkattIu).not.toContain('faltkod="131"')
    expect(fSkattIu).not.toContain('faltkod="011"')
  })
})

describe('generateAgiDeclaration: an avgiftsunderlag override of 0 is declared as no underlag (crm#1372)', () => {
  // SAL 2 kap. 14 §: ersättning to a person that stays under 1 000 kr in the
  // year forms no underlag for arbetsgivaravgifter, and Teknisk beskrivning
  // 1.1.18.2 avsnitt 5.4 declares it (benefits included) in FK131/FK132/FK133.
  // The reviewer states it in avancerat läge with an underlag of 0 kr and an
  // avgift of 0 kr. Before the fix the IU still declared the pay in
  // FK011/FK012, so Skatteverket charged avgifter the booking never carried.
  const MEALS_450 = { item_type: 'benefit_meals', amount: 450, quantity: 3 }
  const TRAKTAMENTE = { item_type: 'traktamente_taxfree', amount: 600 }
  const BENEFIT_ONLY_ROW = {
    ...REGULAR_ROW,
    monthly_salary: 0,
    gross_salary: 0,
    benefit_values: 450,
    tax_withheld: 135,
    tax_withheld_override: 0,
    avgifter_basis: 450,
    avgifter_amount: 141.39,
    avgifter_basis_override: 0,
    avgifter_amount_override: 0,
    line_items: [{ item_type: 'hourly_salary', amount: 0 }, TRAKTAMENTE, MEALS_450],
  }

  async function generate(roster: unknown[]) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, roster)
    return generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
  }

  it('declares a kost-only payslip in FK132 with FK001 = 0 and no avgift anywhere', async () => {
    const result = await generate([BENEFIT_ONLY_ROW])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplOvrigaFormanerEjUlagSA faltkod="132">450</gem:SkatteplOvrigaFormanerEjUlagSA>')
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
    for (const fk of ['011', '012', '013', '018', '131']) {
      expect(iu).not.toContain(`faltkod="${fk}"`)
    }
    // Nothing for Skatteverket to charge, and FK487 says the same.
    expect(result.xml).not.toContain('faltkod="487"')
    expect(result.xml).not.toContain('faltkod="497"')
    expect(result.totals.totalAvgifterAmount).toBe(0)
    expect(result.totals.totalAvgifterBasis).toBe(0)
    // The booking and the run page read the same zero.
    expect(declaredAvgifterForRun([BENEFIT_ONLY_ROW], {}).totalAmount).toBe(0)
    expect(effectiveRunTotals([{ ...BENEFIT_ONLY_ROW, net_salary: 0, vacation_accrual: 0, vacation_accrual_avgifter: 0 }]).total_avgifter).toBe(0)
  })

  it('declares cash in FK131 only, never FK011, next to a regular colleague', async () => {
    const result = await generate([
      REGULAR_ROW,
      {
        ...REGULAR_ROW,
        employee_id: '33333333-3333-4333-8333-333333333333',
        monthly_salary: 800,
        gross_salary: 800,
        tax_withheld: 0,
        avgifter_basis: 800,
        avgifter_amount: 251.36,
        avgifter_basis_override: 0,
        avgifter_amount_override: 0,
        employee: { ...REGULAR_ROW.employee, personnummer: 'emp3_encrypted', specification_number: 3 },
      },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const iu = iuBlockFor(result.xml, '197703031234')
    expect(iu).toContain('<gem:KontantErsattningEjUlagSA faltkod="131">800</gem:KontantErsattningEjUlagSA>')
    expect(iu).not.toContain('faltkod="011"')
    // The colleague is untouched and alone in the avgift.
    expect(iuBlockFor(result.xml, '199001011234')).toContain(
      '<gem:KontantErsattningUlagAG faltkod="011">40000</gem:KontantErsattningUlagAG>',
    )
    expect(result.totals.totalAvgifterBasis).toBe(40000)
    expect(result.xml).toContain('<gem:SummaArbAvgSlf faltkod="487">12568</gem:SummaArbAvgSlf>')
  })

  it('refuses an underlag of 0 whose avgift is still charged, instead of filing both', async () => {
    const result = await generate([{ ...BENEFIT_ONLY_ROW, avgifter_amount_override: null }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('AGI_INCOMPLETE_DATA')
    const details = result.details as { missing_fields: string[]; message: string }
    expect(details.missing_fields).toEqual(['avgifter_amount_override'])
    expect(details.message).toContain('avgiftsunderlaget är justerat till 0 kr')
  })

  it('accepts an underlag of 0 without an amount override when the computed avgift is already 0', async () => {
    // Born 1937 or earlier: sats 0, so there is no avgift to contradict.
    const result = await generate([
      { ...BENEFIT_ONLY_ROW, avgifter_amount: 0, avgifter_rate: 0, avgifter_category: 'exempt', avgifter_amount_override: null },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(iuBlockFor(result.xml, '199001011234')).toContain('faltkod="132">450<')
  })

  it('leaves a payslip without overrides on FK012, avgift included', async () => {
    const result = await generate([
      { ...BENEFIT_ONLY_ROW, tax_withheld_override: null, avgifter_basis_override: null, avgifter_amount_override: null },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplOvrigaFormanerUlagAG faltkod="012">450</gem:SkatteplOvrigaFormanerUlagAG>')
    expect(iu).not.toContain('faltkod="132"')
    expect(result.xml).toContain('<gem:SummaArbAvgSlf faltkod="487">141</gem:SummaArbAvgSlf>')
  })
})

describe('generateAgiDeclaration: field family per payee kind (#82)', () => {
  const MEALS = { item_type: 'benefit_meals', amount: 1200 }

  async function generate(roster: unknown[]) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, roster)
    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('AGI refused')
    return result
  }

  it('keeps an F-skatt payee on FK125/FK126 even with an avgiftsunderlag override of 0', async () => {
    // Pay to a mottagare med F-skatt stays underlag for egenavgifter: the
    // override speaks of arbetsgivaravgifter, which are 0 for the row anyway.
    const result = await generate([
      { ...F_SKATT_ROW, avgifter_basis_override: 0, avgifter_amount_override: 0, line_items: [MEALS] },
    ])
    const iu = iuBlockFor(result.xml, '198506159876')
    expect(iu).toContain('<gem:KontantErsattningUlagEA faltkod="125">15000</gem:KontantErsattningUlagEA>')
    expect(iu).toContain('<gem:SkatteplOvrigaFormanerUlagEA faltkod="126">1200</gem:SkatteplOvrigaFormanerUlagEA>')
    expect(iu).not.toContain('faltkod="131"')
    expect(iu).not.toContain('faltkod="132"')
  })

  it('files FK048 with the benefit it qualifies, and drops it from an IU without one', async () => {
    const result = await generate([
      { ...REGULAR_ROW, benefits_adjusted: true },
      { ...F_SKATT_ROW, benefits_adjusted: true, line_items: [MEALS] },
    ])
    expect(iuBlockFor(result.xml, '199001011234')).not.toContain('faltkod="048"')
    const fSkattIu = iuBlockFor(result.xml, '198506159876')
    expect(fSkattIu).toContain('<gem:FormanHarJusterats faltkod="048">1</gem:FormanHarJusterats>')
    expect(fSkattIu).toContain('faltkod="126">1200<')
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

  it('refuses a partial basis override instead of filing an IU that contradicts the booking (#91)', async () => {
    // An underlag above 0 but below the pay has no IU field: FK011 would keep
    // the full 51 158 while an avgift override (the reason to set the basis)
    // books and files less. The save refuses it; a row stored before that
    // is refused here, with or without an avgift override, and nothing is
    // written.
    for (const avgifter_amount_override of [null, 12568]) {
      const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
      enqueueHappyPath(enqueueMany, [
        { ...ORE_ROW_1, avgifter_basis_override: 40000, avgifter_amount_override },
      ])

      const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('AGI_INCOMPLETE_DATA')
      expect(result.details).toMatchObject({ missing_fields: ['avgifter_basis_override'] })
      expect(JSON.stringify(result.details)).toContain('delvis belopp')
      expect(findCalls('agi_declarations', 'insert')).toHaveLength(0)
      expect(findCalls('agi_declarations', 'update')).toHaveLength(0)
    }
  })
})

describe('generateAgiDeclaration: the declared figure the run page shows is the one filed (crm#1149)', () => {
  // The run page and the Lönesammanställning show "Deklarerad avgift (hela
  // kronor)" next to the öre-exact avgift through declaredAvgifterForRun.
  // For any roster it must equal the FK487 the generator files and stores.
  const ORE_ROW = {
    ...REGULAR_ROW,
    gross_salary: 3456.78,
    tax_withheld: 0,
    net_salary: 3456.78,
    avgifter_basis: 3456.78,
    avgifter_amount: 1086.12,
    vacation_accrual: 0,
    vacation_accrual_avgifter: 0,
  }

  async function filedAvgifter(roster: Array<Record<string, unknown>>) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, roster)
    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('AGI generation failed')
    return result
  }

  it('1 086,12 computed is 1 085 declared, on the screen and in FK487 alike', async () => {
    const roster = [ORE_ROW]
    const result = await filedAvgifter(roster)

    expect(effectiveRunTotals(roster).total_avgifter).toBe(1086.12)
    const shown = declaredAvgifterForRun(roster, RUN.calculation_params)
    expect(shown.totalAmount).toBe(1085)
    expect(result.totals.totalAvgifterAmount).toBe(shown.totalAmount)
    expect(result.totals.totalAvgifterBasis).toBe(shown.totalUnderlag)
    expect(result.xml).toContain('<gem:SummaArbAvgSlf faltkod="487">1085</gem:SummaArbAvgSlf>')
  })

  it('agrees on a mixed roster: öre wages, an amount override, a no-underlag row, F-skatt and a borttag', async () => {
    const roster = [
      ORE_ROW,
      { ...REGULAR_ROW, employee_id: '33333333-3333-4333-8333-333333333333', gross_salary: 30000.99, avgifter_basis: 30000.99, avgifter_amount: 9426.51, employee: { ...REGULAR_ROW.employee, personnummer: 'emp3_encrypted', specification_number: 3 } },
      { ...REGULAR_ROW, employee_id: '44444444-4444-4444-8444-444444444444', avgifter_amount_override: 7855.4, employee: { ...REGULAR_ROW.employee, personnummer: 'emp4_encrypted', specification_number: 4 } },
      { ...REGULAR_ROW, employee_id: '55555555-5555-4555-8555-555555555555', gross_salary: 51158, avgifter_basis: 51158, avgifter_amount: 16073.84, avgifter_basis_override: 0, avgifter_amount_override: 0, employee: { ...REGULAR_ROW.employee, personnummer: 'emp5_encrypted', specification_number: 5 } },
      { ...F_SKATT_ROW, avgifter_basis_override: 15000, avgifter_amount_override: 4713 },
      { ...REGULAR_ROW, employee_id: '66666666-6666-4666-8666-666666666666', removed_from_agi: true, employee: { ...REGULAR_ROW.employee, personnummer: 'emp6_encrypted', specification_number: 6 } },
    ]
    const result = await filedAvgifter(roster)

    const shown = declaredAvgifterForRun(roster, RUN.calculation_params)
    // trunc((3 456 + 30 000) × 31,42 %) = 10 511 for the computing rows,
    // plus the overrides' trunc(7 855,40 + 0) = 7 855: the no-underlag row
    // (underlag 0, avgift 0) is declared in FK131 and adds nothing.
    expect(shown.totalAmount).toBe(10511 + 7855)
    expect(result.totals.totalAvgifterAmount).toBe(shown.totalAmount)
    expect(result.totals.totalAvgifterBasis).toBe(shown.totalUnderlag)
    expect(result.xml).toContain(
      `<gem:SummaArbAvgSlf faltkod="487">${shown.totalAmount}</gem:SummaArbAvgSlf>`,
    )
  })
})

describe('generateAgiDeclaration: utlägg repaid with the salary (#2331)', () => {
  // FK011 KontantErsattningUlagAG comes from sre.gross_salary, which the
  // engine computes WITHOUT tax-free reimbursements; the only line types the
  // builder reads are the benefit_* ones. An expense_reimbursement line must
  // therefore leave FK011, FK001 and FK487 untouched, and never surface as a
  // benefit field.
  it('excludes an expense_reimbursement line from FK011 and every other IU field', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    const withUtlagg = {
      ...REGULAR_ROW,
      line_items: [
        {
          item_type: 'monthly_salary',
          amount: 40000,
          is_taxable: true,
          is_avgift_basis: true,
        },
        {
          item_type: 'expense_reimbursement',
          amount: 1234.5,
          is_taxable: false,
          is_avgift_basis: false,
          source_expense_claim_id: 'claim-1',
        },
      ],
    }
    enqueueHappyPath(enqueueMany, [withUtlagg])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:KontantErsattningUlagAG faltkod="011">40000</gem:KontantErsattningUlagAG>')
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">12000</gem:AvdrPrelSkatt>')
    expect(iu).not.toContain('41234')
    expect(iu).not.toContain('41235')
    // No benefit field is derived from the line (FK012/FK013/FK018).
    for (const code of ['012', '013', '018']) {
      expect(iu).not.toContain(`faltkod="${code}"`)
    }
    // The employer's FK487 underlag is the same as without the line.
    expect(result.xml).toContain('faltkod="487">12568<')
  })
})

describe('generateAgiDeclaration: tax-free milersättning and traktamente set FK050 / FK051', () => {
  // Bilaga Fältlista 1.1.18.1: FK050 Bilersattning "om du har betalat ut
  // ersättning för resor med privat bil i tjänsten", FK051 Traktamente "om du
  // har betalat ut traktamentsersättning för resor i tjänsten"; in both "den
  // överskjutande delen" above the schablon is lön. The tax-free rows are
  // capped at the schablon; the *_taxable rows carry the excess and are
  // already in gross_salary.
  const FK050 = '<gem:Bilersattning faltkod="050">1</gem:Bilersattning>'
  const FK051 = '<gem:Traktamente faltkod="051">1</gem:Traktamente>'
  const reimbursement = (item_type: string, amount: number) => ({
    item_type,
    amount,
    is_taxable: false,
    is_avgift_basis: false,
  })
  const MILEAGE = reimbursement('mileage_taxfree', 2497.5)
  const TRAKTAMENTE = reimbursement('traktamente_taxfree', 900)
  const row = (lineItems: unknown[]) => ({
    ...REGULAR_ROW,
    line_items: [{ item_type: 'monthly_salary', amount: 40000 }, ...lineItems],
  })

  async function iuFor(roster: unknown[]): Promise<string> {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, roster)
    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
    expect(result.ok).toBe(true)
    if (!result.ok) return ''
    return iuBlockFor(result.xml, '199001011234')
  }

  it('milersättning only: FK050, no FK051', async () => {
    const iu = await iuFor([row([MILEAGE])])
    expect(iu).toContain(FK050)
    expect(iu).not.toContain('faltkod="051"')
  })

  it('traktamente only: FK051, no FK050', async () => {
    const iu = await iuFor([row([TRAKTAMENTE])])
    expect(iu).toContain(FK051)
    expect(iu).not.toContain('faltkod="050"')
  })

  it('both: one FK050 and one FK051, whatever the number of rows', async () => {
    const iu = await iuFor([row([MILEAGE, reimbursement('mileage_taxfree', 702.05), TRAKTAMENTE])])
    expect(iu.split(FK050)).toHaveLength(2)
    expect(iu.split(FK051)).toHaveLength(2)
  })

  it('neither: no flag, and the IU is otherwise unchanged', async () => {
    const iu = await iuFor([row([])])
    expect(iu).not.toContain('faltkod="050"')
    expect(iu).not.toContain('faltkod="051"')
    expect(iu).toContain('<gem:KontantErsattningUlagAG faltkod="011">40000</gem:KontantErsattningUlagAG>')
  })

  it('a taxable excess only: no flag, the excess is lön in FK011', async () => {
    const withExcess = {
      ...row([
        { item_type: 'mileage_taxable', amount: 500, is_taxable: true, is_avgift_basis: true },
        { item_type: 'traktamente_taxable', amount: 300, is_taxable: true, is_avgift_basis: true },
      ]),
      gross_salary: 40800,
      avgifter_basis: 40800,
      avgifter_amount: roundOre(40800 * 0.3142),
    }
    const iu = await iuFor([withExcess])
    expect(iu).not.toContain('faltkod="050"')
    expect(iu).not.toContain('faltkod="051"')
    expect(iu).toContain('<gem:KontantErsattningUlagAG faltkod="011">40800</gem:KontantErsattningUlagAG>')
  })

  it('a tax-free row reversed to a net 0 kr pays nothing and sets no flag', async () => {
    const iu = await iuFor([row([MILEAGE, reimbursement('mileage_taxfree', -2497.5)])])
    expect(iu).not.toContain('faltkod="050"')
  })

  it('an utlägg repaid with the salary is no bilersättning or traktamente', async () => {
    const iu = await iuFor([row([{ ...reimbursement('expense_reimbursement', 1234.5), source_expense_claim_id: 'claim-1' }])])
    expect(iu).not.toContain('faltkod="050"')
    expect(iu).not.toContain('faltkod="051"')
  })

  it('files an IU for a person paid only a tax-free traktamente this month', async () => {
    const travelOnly = {
      ...REGULAR_ROW,
      monthly_salary: null,
      gross_salary: 0,
      tax_withheld: 0,
      avgifter_basis: 0,
      avgifter_amount: 0,
      line_items: [TRAKTAMENTE],
    }
    const iu = await iuFor([travelOnly])
    expect(iu).toContain(FK051)
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
    expect(iu).not.toContain('faltkod="011"')
  })
})

describe('generateAgiDeclaration: kostförmån is declared in FK012 (#81)', () => {
  // Skatteverket's XML schema (arbetsgivardeklaration_component_1.1.xsd) and
  // Bilaga Fältlista 1.1.18.1 define no kostförmån field: FK012 "Övriga
  // skattepliktiga förmåner" carries every benefit except bil and drivmedel,
  // kost included (FK126 for an F-skatt payee, FK132 when no underlag). The
  // generator used to emit KostformanUlagAG faltkod 015, which no schema has.
  const MEALS = { item_type: 'benefit_meals', amount: 1200 }
  const BIKE = { item_type: 'benefit_bike', amount: 300 }

  async function generate(roster: unknown[]) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, roster)
    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('AGI refused')
    return result
  }

  it('sums kost with the other benefits in FK012 and emits no kostförmån field', async () => {
    const result = await generate([
      {
        ...REGULAR_ROW,
        benefit_values: 1500,
        avgifter_basis: 41500,
        avgifter_amount: roundOre(41500 * 0.3142),
        line_items: [{ item_type: 'monthly_salary', amount: 40000 }, MEALS, BIKE],
      },
    ])
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplOvrigaFormanerUlagAG faltkod="012">1500</gem:SkatteplOvrigaFormanerUlagAG>')
    expect(result.xml).not.toContain('Kostforman')
    expect(result.xml).not.toContain('faltkod="015"')
  })

  it('files a kost-only IU with FK012 and FK001 = 0', async () => {
    const result = await generate([
      { ...REGULAR_ROW, monthly_salary: 0, gross_salary: 0, tax_withheld: 0, benefit_values: 1200, avgifter_basis: 1200, avgifter_amount: roundOre(1200 * 0.3142), line_items: [MEALS] },
    ])
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplOvrigaFormanerUlagAG faltkod="012">1200</gem:SkatteplOvrigaFormanerUlagAG>')
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
    expect(iu).not.toContain('faltkod="015"')
  })

  it("declares an F-skatt payee's kost in FK126, never FK132 or FK139 (#82)", async () => {
    const result = await generate([{ ...F_SKATT_ROW, line_items: [MEALS] }])
    const iu = iuBlockFor(result.xml, '198506159876')
    expect(iu).toContain('<gem:SkatteplOvrigaFormanerUlagEA faltkod="126">1200</gem:SkatteplOvrigaFormanerUlagEA>')
    expect(iu).not.toContain('faltkod="132"')
    expect(iu).not.toContain('faltkod="139"')
    expect(iu).not.toContain('Kostforman')
  })
})

describe('generateAgiDeclaration: sjuklön never reaches the HU', () => {
  // FK499 TotalSjuklonekostnad fed högkostnadsskyddet för sjuklönekostnader,
  // abolished 2024-07-01. Skatteverket's schema only allows the field up to
  // period 202406 and rejects the whole file for any later period, so a run
  // with sick pay must declare exactly like one without it.
  it('omits FK499 for a run with sjuklön days and a karensavdrag', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    const withSjuklon = {
      ...REGULAR_ROW,
      line_items: [
        { item_type: 'monthly_salary', amount: 40000, is_taxable: true, is_avgift_basis: true },
        { item_type: 'sick_karens', amount: -1523, quantity: 1, is_taxable: true, is_avgift_basis: true },
        { item_type: 'sick_day2_14', amount: -1904.76, quantity: 5, is_taxable: true, is_avgift_basis: true },
      ],
    }
    enqueueHappyPath(enqueueMany, [withSjuklon])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.xml).not.toContain('faltkod="499"')
    expect(result.xml).not.toContain('TotalSjuklonekostnad')
    expect(result.totals).not.toHaveProperty('totalSjuklonekostnad')
    // The other HU totals are untouched by the sick rows.
    expect(result.xml).toContain('faltkod="497">12000<')
    expect(result.xml).toContain('faltkod="487">12568<')
  })
})

describe('generateAgiDeclaration: växa-stöd never reaches the IU (Lag 2025:1334)', () => {
  // FK062 ForstaAnstalld and FK063 VaxaStod have no valid period after 202512
  // (Teknisk beskrivning 1.1.18.2): from 202601 the IU carries the full
  // avgifter and the employer applies for the refund separately. The flag used
  // to fire from the employee boolean alone, whatever the run's category.
  const VAXA_EMPLOYEE = {
    ...REGULAR_ROW.employee,
    vaxa_stod_eligible: true,
    employment_start: '2025-06-01',
  }

  function enqueueSeptemberPayout(
    enqueueMany: (results: { data?: unknown; error?: unknown }[]) => void,
    roster: unknown[],
  ) {
    enqueueMany([
      { data: { ...RUN, period_month: 8, payment_date: '2026-09-25' } }, // redovisningsperiod 202609
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: roster },
      { data: [] }, // salary_absence_days
      { data: null }, // agi_declarations maybeSingle (first generation)
      { data: { id: 'agi-1' } }, // agi_declarations insert
      { data: null }, // salary_runs update
    ])
  }

  it('declares an eligible employee in 202609 with full avgifter and no FK062/FK063', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueSeptemberPayout(enqueueMany, [{ ...REGULAR_ROW, employee: VAXA_EMPLOYEE }])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<gem:RedovisningsPeriod faltkod="006">202609</gem:RedovisningsPeriod>')
    expect(result.xml).not.toContain('faltkod="062"')
    expect(result.xml).not.toContain('faltkod="063"')
    expect(result.xml).not.toContain('ForstaAnstalld')
    expect(result.xml).not.toContain('VaxaStod')
    // 40 000 × 31,42 % = 12 568: the full avgift, no växa-stöd reduction.
    expect(result.xml).toContain('faltkod="487">12568<')
  })

  it('no longer refuses an eligible employee on the youth rate: there is no växa flag left to conflict with', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueSeptemberPayout(enqueueMany, [
      {
        ...REGULAR_ROW,
        monthly_salary: 20000,
        gross_salary: 20000,
        tax_withheld: 4000,
        avgifter_basis: 20000,
        avgifter_amount: 4162,
        avgifter_rate: 0.2081,
        avgifter_category: 'youth',
        employee: VAXA_EMPLOYEE,
      },
    ])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).not.toContain('faltkod="063"')
    expect(result.totals.avgifterByCategory.youth).toEqual({ basis: 20000, amount: 4162 })
  })

  it('refuses a stored row calculated at the old reduced växa-stöd sats instead of declaring 10,21 %', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueSeptemberPayout(enqueueMany, [
      {
        ...REGULAR_ROW,
        // 35 000 × 10,21 % + 5 000 × 31,42 %: the pre-2026 capped växa sats.
        avgifter_amount: 5144.5,
        avgifter_rate: 0.1021,
        avgifter_category: 'vaxa_stod',
        employee: VAXA_EMPLOYEE,
      },
    ])

    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('AGI_INCOMPLETE_DATA')
    const details = result.details as { missing_fields: string[]; message: string }
    expect(details.missing_fields).toEqual(['avgifter_category'])
    expect(details.message).toContain('Räkna om lönekörningen')
    expect(details.message).toContain('Lag 2025:1334')
  })
})

describe('generateAgiDeclaration: an employee payment for a benefit reduces the declared förmånsvärde', () => {
  // swedish-payroll skill, deductions-lonevaxling.md: a nettolöneavdrag "DOES
  // reduce the taxable förmånsvärde if the deduction constitutes payment for a
  // specific benefit". The AGI must carry the same reduced value the engine
  // taxed, or FK013 disagrees with the payslip's own underlag.
  const CAR = { item_type: 'benefit_car', amount: 6664 }
  const payment = (amount: number) => ({ item_type: 'net_deduction_benefit_payment', amount, is_net_deduction: true })
  // A row as the fixed engine stores it: benefit_values is the REDUCED value.
  const row = (lineItems: unknown[], benefitValues: number) => ({
    ...REGULAR_ROW,
    monthly_salary: 48000,
    gross_salary: 48000,
    benefit_values: benefitValues,
    avgifter_basis: 48000 + benefitValues,
    avgifter_amount: roundOre((48000 + benefitValues) * 0.3142),
    line_items: [{ item_type: 'monthly_salary', amount: 48000 }, ...lineItems],
  })

  async function generate(roster: unknown[]) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, roster)
    return generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
  }

  it('no payment: FK013 carries the whole benefit (unchanged)', async () => {
    const result = await generate([row([CAR], 6664)])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplBilformanUlagAG faltkod="013">6664</gem:SkatteplBilformanUlagAG>')
  })

  it('payment equal to the benefit: FK013 is still declared, as 0, and the salary stays on FK011', async () => {
    // Teknisk beskrivning 1.1.18.2 avsnitt 5.3: "Har den anställda betalat
    // hela förmånen genom nettolöneavdrag så att värdet blir noll (0) så ska
    // det ändå redovisas ... ska fältet för bilförmån (SkatteplBilformanUlagAG,
    // FK013) finnas med i filen med värde 0."
    const result = await generate([row([CAR, payment(-6664)], 0)])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplBilformanUlagAG faltkod="013">0</gem:SkatteplBilformanUlagAG>')
    expect(iu).toContain('<gem:KontantErsattningUlagAG faltkod="011">48000</gem:KontantErsattningUlagAG>')
    expect(iu).not.toContain('faltkod="012"')
  })

  it('a kostförmån paid in full: FK012 is declared as 0', async () => {
    const result = await generate([row([{ item_type: 'benefit_meals', amount: 2480 }, payment(-2480)], 0)])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplOvrigaFormanerUlagAG faltkod="012">0</gem:SkatteplOvrigaFormanerUlagAG>')
    expect(iu).not.toContain('faltkod="013"')
  })

  it('a bostadsförmån paid in full keeps its flag next to FK012 = 0 (kontroll S_155)', async () => {
    const result = await generate([row([{ item_type: 'benefit_housing', amount: 5000 }, payment(-5000)], 0)])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:BostadsformanEjSmahusUlagAG faltkod="043">1</gem:BostadsformanEjSmahusUlagAG>')
    expect(iu).toContain('<gem:SkatteplOvrigaFormanerUlagAG faltkod="012">0</gem:SkatteplOvrigaFormanerUlagAG>')
  })

  it('a benefit paid in full is reported even when nothing else was paid that month', async () => {
    const benefitOnly = {
      ...row([CAR, payment(-6664)], 0),
      monthly_salary: null,
      gross_salary: 0,
      tax_withheld: 0,
      avgifter_basis: 0,
      avgifter_amount: 0,
      line_items: [CAR, payment(-6664)],
    }
    const result = await generate([benefitOnly])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplBilformanUlagAG faltkod="013">0</gem:SkatteplBilformanUlagAG>')
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
  })

  it('partial payment: FK013 carries benefit minus payment', async () => {
    const result = await generate([row([CAR, payment(-2000)], 4664)])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplBilformanUlagAG faltkod="013">4664</gem:SkatteplBilformanUlagAG>')
  })

  it('refuses a payslip calculated before the reduction existed: its stored underlag still holds the whole benefit', async () => {
    // benefit_values 6664 = the pre-fix engine's unreduced value.
    const result = await generate([row([CAR, payment(-6664)], 6664)])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('AGI_INCOMPLETE_DATA')
    const message = JSON.stringify(result.details)
    expect(message).toContain('Anställd 1, 2026-06')
    expect(message).toContain('Räkna om lönekörningen')
    expect(message).toContain('Korrigera lönekörning')
    expect(message).toContain('arbetsgivardeklarationen')
  })

  it('a removed employee (FK205 tombstone) never blocks the AGI, however stale or ambiguous their rows', async () => {
    // The tombstone emits identity fields only, so nothing on it can be
    // inconsistent. Refusing here would block the correction that removes them.
    const staleRemoved = { ...row([CAR, payment(-6664)], 6664), removed_from_agi: true }
    const ambiguousRemoved = {
      ...row([CAR, { item_type: 'benefit_meals', amount: 2480 }, payment(-2480)], 9144),
      removed_from_agi: true,
    }
    for (const removed of [staleRemoved, ambiguousRemoved]) {
      const result = await generate([removed])
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const iu = iuBlockFor(result.xml, '199001011234')
      expect(iu).toContain('<gem:Borttag faltkod="205">1</gem:Borttag>')
      expect(iu).not.toContain('faltkod="013"')
    }
  })

  it('still validates the live employees next to a removed one', async () => {
    const removed = { ...row([CAR, payment(-6664)], 6664), removed_from_agi: true }
    const liveAndStale = {
      ...row([CAR, payment(-6664)], 6664),
      employee_id: '33333333-3333-4333-8333-333333333333',
      employee: { personnummer: 'emp2_encrypted', specification_number: 2, f_skatt_status: 'a_skatt' },
    }
    const result = await generate([removed, liveAndStale])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('AGI_INCOMPLETE_DATA')
    expect(JSON.stringify(result.details)).toContain('Anställd 2, 2026-06')
  })

  it('refuses a payment on a payslip with several benefit types instead of guessing a field', async () => {
    const result = await generate([row([CAR, { item_type: 'benefit_meals', amount: 2480 }, payment(-2480)], 9144)])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('AGI_INCOMPLETE_DATA')
    expect(JSON.stringify(result.details)).toContain('flera förmånstyper')
  })
})

describe('generateAgiDeclaration: text rows never reach the declaration', () => {
  // A text row (item_type 'text', lib/salary/text-rows.ts) is words on the
  // payslip: amount 0, no quantity, every flag false. The AGI reads the
  // stored totals and the benefit rows only, so a run with text rows declares
  // exactly what the same run without them declares.
  const text = (description: string) => ({
    item_type: 'text',
    description,
    amount: 0,
    quantity: null,
    unit_price: null,
    account_number: null,
    is_taxable: false,
    is_avgift_basis: false,
    is_vacation_basis: false,
    is_gross_deduction: false,
    is_net_deduction: false,
  })
  const CAR = { item_type: 'benefit_car', amount: 3000 }
  const PAYMENT = { item_type: 'net_deduction_benefit_payment', amount: -1000, is_net_deduction: true }
  const regular = (lineItems: unknown[]) => ({
    ...REGULAR_ROW,
    benefit_values: 2000,
    avgifter_basis: 42000,
    avgifter_amount: roundOre(42000 * 0.3142),
    sick_days: 1,
    line_items: lineItems,
  })
  const fSkatt = (lineItems: unknown[]) => ({ ...F_SKATT_ROW, line_items: lineItems })

  async function generate(roster: unknown[]) {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, roster)
    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('AGI refused')
    // The generation timestamp is the only part that may differ between two calls.
    const stripCreated = (xml: string) => xml.replace(/<gem:Skapad>[^<]*<\/gem:Skapad>/, '')
    const { xml, ...rest } = result
    const stored = findCall('agi_declarations', 'insert')?.[0] as Record<string, unknown>
    const storedWithoutXml = Object.fromEntries(
      Object.entries(stored).map(([k, v]) => [k, typeof v === 'string' && v.includes('<gem:') ? stripCreated(v) : v]),
    )
    return { xml: stripCreated(xml), rest, stored: storedWithoutXml }
  }

  it('declares the same IU and HU figures with and without text rows', async () => {
    const moneyRows = [{ item_type: 'monthly_salary', amount: 40000 }, CAR, PAYMENT]
    const plain = await generate([regular(moneyRows), fSkatt([])])
    const withText = await generate([
      regular([text('Grundlön enligt avtal'), ...moneyRows, text('Bilförmån Volvo XC40')]),
      fSkatt([text('Konsultarvode september')]),
    ])

    expect(withText.xml).toEqual(plain.xml)
    expect(withText.rest).toEqual(plain.rest)
    expect(withText.stored).toEqual(plain.stored)

    // Not vacuous: the declaration carries the salary, the reduced benefit,
    // the F-skatt payment and the employer totals.
    const iu = iuBlockFor(withText.xml, '199001011234')
    expect(iu).toContain('<gem:KontantErsattningUlagAG faltkod="011">40000</gem:KontantErsattningUlagAG>')
    expect(iu).toContain('<gem:SkatteplBilformanUlagAG faltkod="013">2000</gem:SkatteplBilformanUlagAG>')
    expect(withText.xml).toContain('faltkod="125">15000<')
    expect(withText.xml).not.toContain('Grundlön enligt avtal')
    expect(withText.rest.employeeCount).toBe(2)
  })

  it('a payslip whose only extra row is text keeps a benefit payment attributable', async () => {
    // resolveTaxableBenefits sees the text row (amount 0) and must not count
    // it as a second benefit type or a payment.
    const result = await generate([regular([text('Förmånsbil enligt avtal'), CAR, PAYMENT])])
    const iu = iuBlockFor(result.xml, '199001011234')
    expect(iu).toContain('<gem:SkatteplBilformanUlagAG faltkod="013">2000</gem:SkatteplBilformanUlagAG>')
  })
})

describe('generateAgiDeclaration: writeOnlyIfChanged (submit-time regeneration, issue #69)', () => {
  type OkResult = Extract<Awaited<ReturnType<typeof generateAgiDeclaration>>, { ok: true }>

  async function firstGeneration(): Promise<OkResult> {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueHappyPath(enqueueMany, [REGULAR_ROW])
    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
    if (!result.ok) throw new Error(`expected a generation, got ${result.code}`)
    return result
  }

  /** The row the first generation stored, written at another moment (its own Skapad). */
  function storedRow(first: OkResult, overrides: Record<string, unknown> = {}) {
    return {
      id: 'agi-1',
      salary_run_id: 'run-1',
      status: 'generated',
      submitted_at: null,
      xml_content: first.xml.replace(
        /<gem:Skapad>[^<]*<\/gem:Skapad>/,
        '<gem:Skapad>2026-07-01T08:00:00</gem:Skapad>',
      ),
      total_gross: RUN.total_gross,
      total_tax: first.totals.totalTax,
      total_avgifter_basis: first.totals.totalAvgifterBasis,
      total_avgifter: first.totals.totalAvgifterAmount,
      employee_count: first.employeeCount,
      ...overrides,
    }
  }

  async function regenerate(stored: unknown, writeOnlyIfChanged = true) {
    const db = createQueuedMockSupabase()
    db.enqueueMany([
      { data: RUN },
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: [REGULAR_ROW] },
      { data: [] }, // salary_absence_days
      { data: stored }, // agi_declarations for the period
      { data: [{ id: 'agi-1' }] }, // agi_declarations update
      { data: null }, // salary_runs agi_generated_at stamp
    ])
    const emitted: unknown[] = []
    const off = eventBus.on('agi.generated', async (event) => {
      emitted.push(event)
    })
    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS, writeOnlyIfChanged })
    off()
    return { result, db, emitted }
  }

  it('writes nothing when the stored declaration already says the same, its Skapad stamp aside', async () => {
    const first = await firstGeneration()
    const stored = storedRow(first)

    const { result, db, emitted } = await regenerate(stored)

    expect(result).toMatchObject({ ok: true, unchanged: true, agiDeclarationId: 'agi-1', xml: stored.xml_content })
    // Matching is not filed: the submit may still post it.
    expect(result.ok && result.filed).toBeFalsy()
    expect(db.findCall('agi_declarations', 'update')).toBeUndefined()
    expect(db.findCall('agi_declarations', 'insert')).toBeUndefined()
    // agi_generated_at keeps its stamp: an open signing draft does not turn stale.
    expect(db.findCall('salary_runs', 'update')).toBeUndefined()
    expect(emitted).toHaveLength(0)
    // The comparison needs the stored content, so it is read.
    expect(db.findCall('agi_declarations', 'select')?.[0]).toContain('xml_content')
  })

  it('replaces a stored XML a generator fix has since changed (FK001 missing, crm#1265)', async () => {
    const first = await firstGeneration()
    const stored = storedRow(first)
    stored.xml_content = (stored.xml_content as string).replace(/\s*<gem:AvdrPrelSkatt faltkod="001">[^<]*<\/gem:AvdrPrelSkatt>/, '')
    expect(stored.xml_content).not.toContain('faltkod="001"')

    const { result, db, emitted } = await regenerate(stored)

    expect(result.ok).toBe(true)
    expect(result.ok && result.unchanged).toBeFalsy()
    const update = db.findCall('agi_declarations', 'update')?.[0] as { xml_content: string }
    expect(update.xml_content).toContain('faltkod="001"')
    expect(result.ok && result.xml).toBe(update.xml_content)
    expect(db.findCall('salary_runs', 'update')?.[0]).toHaveProperty('agi_generated_at')
    expect(emitted).toHaveLength(1)
  })

  it('rewrites a row whose stored totals differ from the fresh ones even when the XML matches', async () => {
    const first = await firstGeneration()
    const stored = storedRow(first, { total_tax: first.totals.totalTax + 0.4 })

    const { result, db } = await regenerate(stored)

    expect(result.ok && result.unchanged).toBeFalsy()
    expect(db.findCall('agi_declarations', 'update')?.[0]).toMatchObject({ total_tax: first.totals.totalTax })
  })

  it('without the option writes as before, even when nothing changed', async () => {
    const first = await firstGeneration()

    const { result, db } = await regenerate(storedRow(first), false)

    expect(result.ok && result.unchanged).toBeFalsy()
    expect(db.findCall('agi_declarations', 'update')).toBeDefined()
  })
})

describe('generateAgiDeclaration: regionalt stöd (PH 208)', () => {
  const YOUTH_ROW = {
    ...REGULAR_ROW,
    employee_id: '33333333-3333-4333-8333-333333333333',
    gross_salary: 20000,
    tax_withheld: 4000,
    avgifter_basis: 20000,
    avgifter_amount: 4162,
    avgifter_rate: 0.2081,
    avgifter_category: 'youth',
    employee: { personnummer: 'emp2_encrypted', specification_number: 2, f_skatt_status: 'a_skatt' },
  }
  const SENIOR_ROW = {
    ...REGULAR_ROW,
    employee_id: '44444444-4444-4444-8444-444444444444',
    gross_salary: 30000,
    tax_withheld: 6000,
    avgifter_basis: 30000,
    avgifter_amount: 3063,
    avgifter_rate: 0.1021,
    avgifter_category: 'reduced_65plus',
    employee: { personnummer: 'emp3_encrypted', specification_number: 3, f_skatt_status: 'a_skatt' },
  }

  async function generate(calculationParams: Record<string, unknown>, roster: unknown[]) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { ...RUN, calculation_params: calculationParams } },
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: roster },
      { data: [] },
      { data: null },
      { data: { id: 'agi-1' } },
      { data: null },
    ])
    const result = await generateAgiDeclaration({ supabase: supabase as never, ...ARGS })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('generation failed')
    return result
  }

  it('declares FK471/FK476 and files FK487 after the avdrag when the run was calculated with it', async () => {
    const result = await generate(
      { avgifterTotal: 0.3142, salary_regional_support: true },
      [REGULAR_ROW, YOUTH_ROW, SENIOR_ROW],
    )
    // Underlag: 40 000 (full rate) + 20 000 (youth); the 67+ row pays only
    // ålderspensionsavgift and stays out. Avdrag 10 % = 6 000 (< 7 100).
    // Declared avgift 12 568 + 4 162 + 3 063 = 19 793, less 6 000.
    expect(result.totals.regionalSupport).toEqual({ underlag: 60000, deduction: 6000 })
    expect(result.totals.totalAvgifterAmount).toBe(19793 - 6000)
    const hu = result.xml.match(/<gem:HU>[\s\S]*?<\/gem:HU>/)![0]
    expect(hu).toContain('<gem:UlagRegionaltStod faltkod="471">60000</gem:UlagRegionaltStod>')
    expect(hu).toContain('<gem:AvdragRegionaltStod faltkod="476">6000</gem:AvdragRegionaltStod>')
    expect(hu).toContain('<gem:SummaArbAvgSlf faltkod="487">13793</gem:SummaArbAvgSlf>')
    // The IUs are unchanged: the avdrag lives in HU only.
    expect(iuBlockFor(result.xml, '199001011234')).toContain(
      '<gem:KontantErsattningUlagAG faltkod="011">40000</gem:KontantErsattningUlagAG>',
    )
  })

  it('files exactly as before when the run was calculated without it', async () => {
    const result = await generate({ avgifterTotal: 0.3142 }, [REGULAR_ROW, YOUTH_ROW, SENIOR_ROW])
    expect(result.totals.regionalSupport).toBeUndefined()
    expect(result.totals.totalAvgifterAmount).toBe(19793)
    expect(result.xml).not.toContain('faltkod="471"')
    expect(result.xml).not.toContain('faltkod="476"')
  })
})

describe('generateAgiDeclaration: a filed declaration is never rewritten (#58)', () => {
  const FILED_XML = '<?xml version="1.0" encoding="UTF-8"?><Skatteverket><gem:Skapad>2026-07-08T10:00:00</gem:Skapad>filed</Skatteverket>'
  const FILED_RUN = {
    ...RUN,
    status: 'booked',
    agi_generated_at: '2026-07-08T10:00:00Z',
    agi_submitted_at: '2026-07-09T08:30:00Z',
  }
  const FILED_ROW = {
    id: 'agi-1',
    salary_run_id: 'run-1',
    status: 'submitted',
    submitted_at: '2026-07-09T08:30:00Z',
    xml_content: FILED_XML,
    total_gross: 40000,
    total_tax: 11900,
    total_avgifter_basis: 40000,
    total_avgifter: 12568,
    employee_count: 1,
  }

  function enqueueBefore(
    enqueueMany: (results: { data?: unknown; error?: unknown }[]) => void,
    run: Record<string, unknown>,
    afterAbsence: { data?: unknown; error?: unknown }[],
  ) {
    enqueueMany([
      { data: run },
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: [REGULAR_ROW] },
      { data: [] }, // salary_absence_days
      ...afterAbsence,
    ])
  }

  async function generate(db: ReturnType<typeof createQueuedMockSupabase>, extra: Record<string, unknown> = {}) {
    const emitted: unknown[] = []
    const off = eventBus.on('agi.generated', async (event) => {
      emitted.push(event)
    })
    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS, ...extra })
    off()
    return { result, emitted }
  }

  function expectNothingWritten(db: ReturnType<typeof createQueuedMockSupabase>) {
    expect(db.findCall('agi_declarations', 'update')).toBeUndefined()
    expect(db.findCall('agi_declarations', 'insert')).toBeUndefined()
    expect(db.findCall('salary_runs', 'update')).toBeUndefined()
  }

  it('answers a filed run with its stored XML and writes, restamps and emits nothing', async () => {
    const db = createQueuedMockSupabase()
    enqueueBefore(db.enqueueMany, FILED_RUN, [{ data: FILED_ROW }])

    const { result, emitted } = await generate(db)

    expect(result).toMatchObject({ ok: true, xml: FILED_XML, agiDeclarationId: 'agi-1', unchanged: true, filed: true })
    // The figures next to the filed XML are the filed ones, not today's (12 000 withheld today).
    expect(result).toMatchObject({ employeeCount: 1, totals: { totalTax: 11900, totalAvgifterAmount: 12568 } })
    expectNothingWritten(db)
    expect(emitted).toHaveLength(0)
  })

  it('treats a receipt on its own row as filed when the run stamp is missing (the kvittens stamp failed)', async () => {
    const db = createQueuedMockSupabase()
    enqueueBefore(db.enqueueMany, { ...FILED_RUN, agi_submitted_at: null }, [{ data: FILED_ROW }])

    const { result } = await generate(db)

    expect(result).toMatchObject({ ok: true, xml: FILED_XML, unchanged: true })
    expectNothingWritten(db)
  })

  it('a filed run stays filed with writeOnlyIfChanged too: the stored XML, not a fresh one', async () => {
    const db = createQueuedMockSupabase()
    enqueueBefore(db.enqueueMany, FILED_RUN, [{ data: FILED_ROW }])

    const { result } = await generate(db, { writeOnlyIfChanged: true })

    expect(result).toMatchObject({ ok: true, xml: FILED_XML, unchanged: true })
    expectNothingWritten(db)
  })

  it('a correction run still takes over the filed row of the run it corrects, compared on what it read', async () => {
    const db = createQueuedMockSupabase()
    enqueueBefore(db.enqueueMany, { ...RUN, status: 'booked', is_correction: true, corrects_run_id: 'run-0' }, [
      { data: { ...FILED_ROW, id: 'agi-0', salary_run_id: 'run-0' } },
      { data: [{ id: 'agi-0' }] }, // agi_declarations update
      { data: null }, // salary_runs stamp
    ])

    const { result } = await generate(db)

    expect(result).toMatchObject({ ok: true, agiDeclarationId: 'agi-0' })
    expect(result.ok && result.unchanged).toBeFalsy()
    expect(db.findCall('agi_declarations', 'update')?.[0]).toMatchObject({ salary_run_id: 'run-1', status: 'generated' })
    const filters = db.findCalls('agi_declarations', 'eq')
    expect(filters).toContainEqual(['salary_run_id', 'run-0'])
    expect(filters).toContainEqual(['status', 'submitted'])
  })
})

describe('generateAgiDeclaration: unreadable state refuses instead of writing (#58)', () => {
  function enqueueUntilAbsence(
    enqueueMany: (results: { data?: unknown; error?: unknown }[]) => void,
    absence: { data?: unknown; error?: unknown },
    rest: { data?: unknown; error?: unknown }[] = [],
  ) {
    enqueueMany([
      { data: RUN },
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: [REGULAR_ROW] },
      absence,
      ...rest,
    ])
  }

  function expectNoDeclarationWrite(db: ReturnType<typeof createQueuedMockSupabase>) {
    expect(db.findCall('agi_declarations', 'update')).toBeUndefined()
    expect(db.findCall('agi_declarations', 'insert')).toBeUndefined()
    expect(db.findCall('salary_runs', 'update')).toBeUndefined()
  }

  it('refuses when the absence days cannot be read, instead of filing without frånvarouppgifter', async () => {
    const db = createQueuedMockSupabase()
    enqueueUntilAbsence(db.enqueueMany, { error: { message: 'timeout' } })

    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS })

    expect(result).toMatchObject({ ok: false, code: 'DATABASE_ERROR' })
    expectNoDeclarationWrite(db)
  })

  it("refuses when the period's declaration cannot be read, instead of inserting a second one", async () => {
    const db = createQueuedMockSupabase()
    enqueueUntilAbsence(db.enqueueMany, { data: [] }, [{ error: { message: 'timeout' } }])

    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS })

    expect(result).toMatchObject({ ok: false, code: 'DATABASE_ERROR' })
    expectNoDeclarationWrite(db)
  })

  it("refuses when the other run holding the period cannot be read, instead of taking over its declaration", async () => {
    const db = createQueuedMockSupabase()
    enqueueUntilAbsence(db.enqueueMany, { data: [] }, [
      { data: { id: 'agi-2', salary_run_id: 'run-2', status: 'submitted', submitted_at: '2026-07-09T08:30:00Z' } },
      { error: { message: 'timeout' } }, // salary_runs read of run-2
    ])

    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS })

    expect(result).toMatchObject({ ok: false, code: 'DATABASE_ERROR' })
    expectNoDeclarationWrite(db)
  })

  it('treats another run it cannot find as live: a conflict, not a takeover', async () => {
    const db = createQueuedMockSupabase()
    enqueueUntilAbsence(db.enqueueMany, { data: [] }, [
      { data: { id: 'agi-2', salary_run_id: 'run-2', status: 'submitted', submitted_at: '2026-07-09T08:30:00Z' } },
      { data: null }, // run-2 not found
    ])

    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS })

    expect(result).toMatchObject({ ok: false, code: 'AGI_PERIOD_CONFLICT', status: 409 })
    expect(result.ok ? null : result.details).toMatchObject({ other_salary_run_id: 'run-2' })
    expectNoDeclarationWrite(db)
  })
})

describe('generateAgiDeclaration: every write compares and sets (#58)', () => {
  const OWN_ROW = { id: 'agi-1', salary_run_id: 'run-1', status: 'generated', submitted_at: null }

  function enqueueThrough(
    enqueueMany: (results: { data?: unknown; error?: unknown }[]) => void,
    rest: { data?: unknown; error?: unknown }[],
  ) {
    enqueueMany([
      { data: RUN },
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: [REGULAR_ROW] },
      { data: [] }, // salary_absence_days
      ...rest,
    ])
  }

  it('updates its own row only while it is still its own and unchanged in status', async () => {
    const db = createQueuedMockSupabase()
    enqueueThrough(db.enqueueMany, [{ data: OWN_ROW }, { data: [{ id: 'agi-1' }] }, { data: null }])

    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS })

    expect(result).toMatchObject({ ok: true, agiDeclarationId: 'agi-1' })
    const filters = db.findCalls('agi_declarations', 'eq')
    expect(filters).toContainEqual(['id', 'agi-1'])
    expect(filters).toContainEqual(['salary_run_id', 'run-1'])
    expect(filters).toContainEqual(['status', 'generated'])
    expect(db.findCall('salary_runs', 'update')?.[0]).toHaveProperty('agi_generated_at')
  })

  it('an insert that races onto another live run answers AGI_PERIOD_CONFLICT and overwrites nothing', async () => {
    const db = createQueuedMockSupabase()
    enqueueThrough(db.enqueueMany, [
      { data: null }, // no declaration yet
      { error: { code: '23505', message: 'duplicate key value' } }, // insert lost the race
      { data: { id: 'agi-2', salary_run_id: 'run-2', status: 'generated', submitted_at: null } },
      { data: { id: 'run-2', status: 'booked', period_year: 2026, period_month: 6 } },
    ])

    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS })

    expect(result).toMatchObject({ ok: false, code: 'AGI_PERIOD_CONFLICT' })
    expect(db.findCall('agi_declarations', 'update')).toBeUndefined()
    expect(db.findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('an insert that races its own run updates the row that run just wrote', async () => {
    const db = createQueuedMockSupabase()
    enqueueThrough(db.enqueueMany, [
      { data: null },
      { error: { code: '23505', message: 'duplicate key value' } },
      { data: OWN_ROW },
      { data: [{ id: 'agi-1' }] },
      { data: null },
    ])

    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS })

    expect(result).toMatchObject({ ok: true, agiDeclarationId: 'agi-1', isCorrection: true })
    expect(db.findCall('agi_declarations', 'update')?.[0]).toMatchObject({ salary_run_id: 'run-1', is_correction: true })
  })

  it('a row filed while the XML was built is answered with its stored XML, not overwritten', async () => {
    const db = createQueuedMockSupabase()
    const filedXml = '<Skatteverket>filed meanwhile</Skatteverket>'
    enqueueThrough(db.enqueueMany, [
      { data: OWN_ROW },
      { data: [] }, // compare-and-set missed: the status moved on
      { data: { ...OWN_ROW, status: 'submitted', submitted_at: '2099-01-01T00:00:00Z', xml_content: filedXml } },
    ])

    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS })

    expect(result).toMatchObject({ ok: true, xml: filedXml, unchanged: true, filed: true })
    expect(db.findCalls('agi_declarations', 'update')).toHaveLength(1)
    expect(db.findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('two missed compare-and-sets answer AGI_GENERATION_CONFLICT (409) instead of writing blind', async () => {
    const db = createQueuedMockSupabase()
    enqueueThrough(db.enqueueMany, [
      { data: OWN_ROW },
      { data: [] }, // first compare-and-set missed
      { data: OWN_ROW }, // re-read
      { data: [] }, // second compare-and-set missed
    ])

    const result = await generateAgiDeclaration({ supabase: db.supabase as never, ...ARGS })

    expect(result).toMatchObject({ ok: false, code: 'AGI_GENERATION_CONFLICT', status: 409 })
    expect(db.findCalls('agi_declarations', 'update')).toHaveLength(2)
    expect(db.findCall('salary_runs', 'update')).toBeUndefined()
  })
})

describe('decideAgiWrite: the one write decision (#58)', () => {
  const run = { id: 'run-1', corrects_run_id: 'run-0', agi_generated_at: '2026-07-08T10:00:00Z', agi_submitted_at: null }
  const row = (salary_run_id: string | null, status = 'generated', submitted_at: string | null = null) => ({
    salary_run_id,
    status,
    submitted_at,
  })

  it('inserts when the period has no declaration', () => {
    expect(decideAgiWrite(null, run, null)).toBe('insert')
  })

  it("updates the run's own unfiled row, and never its filed one", () => {
    expect(decideAgiWrite(row('run-1'), run, null)).toBe('update_own')
    expect(decideAgiWrite(row('run-1', 'pending_signature'), run, null)).toBe('update_own')
    expect(decideAgiWrite(row('run-1', 'submitted', '2026-07-09T08:30:00Z'), run, null)).toBe('filed')
    expect(decideAgiWrite(row('run-1'), { ...run, agi_submitted_at: '2026-07-09T08:30:00Z' }, null)).toBe('filed')
    // A receipt older than this run's XML is the original's, kept by an old takeover: not this run's filing.
    expect(decideAgiWrite(row('run-1', 'submitted', '2026-07-01T08:30:00Z'), run, null)).toBe('update_own')
  })

  it('takes over the row of the run it corrects, of a corrected run, or of no run', () => {
    expect(decideAgiWrite(row('run-0', 'submitted', '2026-07-09T08:30:00Z'), run, null)).toBe('take_over')
    expect(decideAgiWrite(row('run-9'), run, { status: 'corrected' })).toBe('take_over')
    expect(decideAgiWrite(row(null), run, null)).toBe('take_over')
  })

  it("refuses another live run's row, and one whose run it cannot find", () => {
    expect(decideAgiWrite(row('run-9'), run, { status: 'booked' })).toBe('conflict')
    expect(decideAgiWrite(row('run-9'), run, null)).toBe('conflict')
    expect(decideAgiWrite(row('run-9'), { ...run, corrects_run_id: null }, null)).toBe('conflict')
  })
})
