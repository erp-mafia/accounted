import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  employeeFieldValue,
  employeeKnownFact,
  knowsEmployeeFact,
  loadActiveEmployeeCount,
  resolveEmployeeFacts,
  type EmployeeFacts,
} from '../employee-facts'
import { buildKnownFacts, filterRedundantQuestions } from '../atom-selection'
import type { ComposerInputs } from '../inputs'

/**
 * Both call sites used to read `company_settings.employee_count` and
 * `company_settings.has_employees`. Neither column exists: `employee_count` is
 * on `agi_declarations`, `has_employees` is in no migration at all. PostgREST
 * rejects a select whole on 42703, so the agent-onboarding page and the
 * composer got `null` for the ENTIRE settings row, and "Anställda" plus every
 * other known fact silently vanished.
 *
 * tests/schema/no-phantom-columns.test.ts proves the column names are now real.
 * This file proves the replacement reads the RIGHT ones: that a live headcount
 * wins, that an attested employer registration settles the question in both
 * directions, and above all that `pays_salaries === false` (a NOT NULL DEFAULT
 * false column whose only writer is the tax settings form) is never laundered
 * into "this company has no employees".
 */

const NOTHING_KNOWN: EmployeeFacts = {
  activeEmployees: null,
  ticEmployeeRange: null,
  employerRegistered: null,
  paysSalaries: null,
}

function makeInputs(overrides: Partial<ComposerInputs> = {}): ComposerInputs {
  return {
    companyId: 'company-1',
    companyName: 'Testbolaget AB',
    entityType: 'aktiebolag',
    ticSnapshot: null,
    ticFetchedAt: null,
    companySettings: null,
    activeEmployees: null,
    sieSummary: null,
    bankingSummary: null,
    atomIndex: [],
    userIsConfirmedDirector: false,
    ...overrides,
  }
}

describe('resolveEmployeeFacts', () => {
  it('reports unknown when nothing is actually known', () => {
    expect(resolveEmployeeFacts(NOTHING_KNOWN)).toEqual({ kind: 'unknown' })
    expect(employeeFieldValue(NOTHING_KNOWN)).toBeNull()
    expect(knowsEmployeeFact(NOTHING_KNOWN)).toBe(false)
  })

  it('prefers a live headcount over every weaker signal', () => {
    expect(
      resolveEmployeeFacts({
        activeEmployees: 3,
        ticEmployeeRange: '5-9',
        employerRegistered: true,
        paysSalaries: true,
      })
    ).toEqual({ kind: 'count', count: 3 })
  })

  it('falls back to the Bolagsverket interval when no employee rows exist yet', () => {
    // Every company arriving at agent onboarding has zero employee rows, so
    // zero must fall through rather than answer the question.
    expect(
      resolveEmployeeFacts({ ...NOTHING_KNOWN, activeEmployees: 0, ticEmployeeRange: '5-9' })
    ).toEqual({ kind: 'range', range: '5-9' })
    expect(
      employeeFieldValue({ ...NOTHING_KNOWN, activeEmployees: 0, ticEmployeeRange: '5-9' })
    ).toBe('5-9')
  })

  it('treats a zero headcount as no evidence, not as "nej"', () => {
    expect(resolveEmployeeFacts({ ...NOTHING_KNOWN, activeEmployees: 0 })).toEqual({
      kind: 'unknown',
    })
  })

  it('accepts an attested employer registration in both directions', () => {
    expect(employeeFieldValue({ ...NOTHING_KNOWN, employerRegistered: true })).toBe('Ja')
    expect(employeeFieldValue({ ...NOTHING_KNOWN, employerRegistered: false })).toBe('Nej')
  })

  it('reads pays_salaries=true as evidence but pays_salaries=false as none', () => {
    // The column is NOT NULL DEFAULT false and no onboarding step sets it, so a
    // false is indistinguishable from "never answered". Answering "Nej" from it
    // would state a fact nobody entered.
    expect(employeeFieldValue({ ...NOTHING_KNOWN, paysSalaries: true })).toBe('Ja')
    expect(employeeFieldValue({ ...NOTHING_KNOWN, paysSalaries: false })).toBeNull()
    expect(knowsEmployeeFact({ ...NOTHING_KNOWN, paysSalaries: false })).toBe(false)
  })

  it('lets an attested registration override the pays_salaries default', () => {
    expect(
      employeeFieldValue({ ...NOTHING_KNOWN, employerRegistered: true, paysSalaries: false })
    ).toBe('Ja')
  })
})

describe('employeeKnownFact (composer KÄNDA FAKTA line)', () => {
  it('states a headcount when employee rows back it', () => {
    expect(employeeKnownFact({ ...NOTHING_KNOWN, activeEmployees: 2 })).toBe('Anställda: 2')
  })

  it('does not repeat the TIC interval, which has its own line', () => {
    expect(employeeKnownFact({ ...NOTHING_KNOWN, ticEmployeeRange: '5-9' })).toBeNull()
  })

  it('says nothing when nothing is known', () => {
    expect(employeeKnownFact(NOTHING_KNOWN)).toBeNull()
    expect(employeeKnownFact({ ...NOTHING_KNOWN, paysSalaries: false })).toBeNull()
  })
})

describe('buildKnownFacts', () => {
  it('surfaces the real settings columns that the phantom select was discarding', () => {
    const facts = buildKnownFacts(
      makeInputs({
        activeEmployees: 2,
        companySettings: {
          city: 'Göteborg',
          moms_period: 'quarterly',
          fiscal_year_start_month: 1,
          f_skatt: true,
          vat_registered: true,
          employer_registered: true,
          pays_salaries: true,
          accounting_method: 'accrual',
        },
      })
    )
    expect(facts).toContain('Anställda: 2')
    expect(facts).toContain('Arbetsgivarregistrerad: ja')
    expect(facts).toContain('Betalar ut lön: ja')
    expect(facts).toContain('Momsperiod: kvartalsvis')
    expect(facts).toContain('Säte: Göteborg')
  })

  it('states a headcount even when the company has no company_settings row', () => {
    expect(buildKnownFacts(makeInputs({ activeEmployees: 4 }))).toContain('Anställda: 4')
  })

  it('claims no employee fact when there is none to claim', () => {
    const facts = buildKnownFacts(makeInputs())
    expect(facts.some((f) => f.startsWith('Anställda'))).toBe(false)
  })
})

describe('filterRedundantQuestions: the employee question', () => {
  // fallbackAtomSelection generates exactly this question for an aktiebolag.
  const QUESTION = 'Har bolaget anställda förutom dig?'

  it('keeps the question when the employee fact is genuinely unknown', () => {
    expect(filterRedundantQuestions([QUESTION], makeInputs())).toEqual([QUESTION])
  })

  it('keeps the question when pays_salaries is merely at its column default', () => {
    const inputs = makeInputs({
      activeEmployees: 0,
      companySettings: {
        city: null,
        moms_period: null,
        fiscal_year_start_month: null,
        f_skatt: null,
        vat_registered: null,
        employer_registered: null,
        pays_salaries: false,
        accounting_method: null,
      },
    })
    expect(filterRedundantQuestions([QUESTION], inputs)).toEqual([QUESTION])
  })

  it('drops the question once employee rows exist', () => {
    expect(filterRedundantQuestions([QUESTION], makeInputs({ activeEmployees: 1 }))).toEqual([])
  })

  it('drops the question when the TIC snapshot carries an employee interval', () => {
    const inputs = makeInputs({ ticSnapshot: { employeeRange: '1-4' } })
    expect(filterRedundantQuestions([QUESTION], inputs)).toEqual([])
  })

  it('drops the question when employer registration was attested either way', () => {
    for (const employer_registered of [true, false]) {
      const inputs = makeInputs({
        companySettings: {
          city: null,
          moms_period: null,
          fiscal_year_start_month: null,
          f_skatt: null,
          vat_registered: null,
          employer_registered,
          pays_salaries: false,
          accounting_method: null,
        },
      })
      expect(filterRedundantQuestions([QUESTION], inputs)).toEqual([])
    }
  })
})

describe('loadActiveEmployeeCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockClient(result: { count: number | null; error: unknown }) {
    const eq = vi.fn()
    const chain = {
      select: vi.fn(() => chain),
      eq,
    }
    eq.mockReturnValueOnce(chain).mockReturnValueOnce(Promise.resolve(result))
    const from = vi.fn(() => chain)
    return { client: { from } as unknown as SupabaseClient, from, chain }
  }

  it('counts only active employees for the company', async () => {
    const { client, from, chain } = mockClient({ count: 3, error: null })
    await expect(loadActiveEmployeeCount(client, 'company-1')).resolves.toBe(3)
    expect(from).toHaveBeenCalledWith('employees')
    expect(chain.select).toHaveBeenCalledWith('id', { count: 'exact', head: true })
    expect(chain.eq).toHaveBeenNthCalledWith(1, 'company_id', 'company-1')
    expect(chain.eq).toHaveBeenNthCalledWith(2, 'is_active', true)
  })

  it('returns null (not 0) when the count cannot be read', async () => {
    const { client } = mockClient({ count: null, error: { message: 'boom' } })
    await expect(loadActiveEmployeeCount(client, 'company-1')).resolves.toBeNull()
  })
})
