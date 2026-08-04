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
