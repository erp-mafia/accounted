/**
 * The payroll tools' refusals as the agent receives them: through the one
 * dispatch point (toToolError → getStructuredError), with a stable code,
 * message_sv + message_en and an explicit retryable.
 *
 * Every case below answered UNKNOWN_ERROR ("Något gick fel. Försök igen.")
 * in production for a problem the agent could fix itself: a field out of
 * range, a missing argument, an id that does not exist, a run in the wrong
 * state. "Try again" is the wrong advice for all of them; one agent repeated
 * the same set_employee_opening_balances call 241 times.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockGenerateSalaryJournal = vi.fn()
vi.mock('@/lib/reports/salary-journal', () => ({
  generateSalaryJournal: (...a: unknown[]) => mockGenerateSalaryJournal(...a),
}))

import { tools } from '../server'
import { toToolError } from '../tool-result'

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

const ACTOR = { type: 'api_key' } as const

/** Run a tool that must refuse, and return the envelope the agent receives. */
async function refusal(name: string, args: Record<string, unknown>, supabase: unknown) {
  let thrown: unknown
  try {
    await tool(name).execute(args, 'company-1', 'user-1', supabase as never, ACTOR)
  } catch (err) {
    thrown = err
  }
  expect(thrown, `${name} should have refused`).toBeDefined()
  return toToolError(thrown, { toolName: name }).error
}

const VALID_EMPLOYEE = {
  first_name: 'Anna',
  last_name: 'Andersson',
  personnummer: '190001010000',
  employment_start: '2026-01-15',
  salary_type: 'monthly',
  monthly_salary: 35000,
  tax_table_number: 33,
  tax_municipality: 'Stockholm',
}

let prevSkv: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  prevSkv = process.env.SKATTEVERKET_ENABLED
  process.env.SKATTEVERKET_ENABLED = 'true'
})
afterEach(() => {
  if (prevSkv === undefined) delete process.env.SKATTEVERKET_ENABLED
  else process.env.SKATTEVERKET_ENABLED = prevSkv
})

describe('gnubok_create_employee', () => {
  it('names vacation_days_per_year with a Swedish reason (VALIDATION_ERROR, not retryable)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_create_employee', { ...VALID_EMPLOYEE, vacation_days_per_year: 20 }, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toMatch(/^Invalid employee: vacation_days_per_year: /)
    expect(error.message_sv).toBe('vacation_days_per_year: Måste vara minst 25.')
  })

  it.each([
    ['tax_municipality', { tax_municipality: undefined }, /^tax_municipality: Folkbokföringskommun bör anges/],
    ['monthly_salary', { monthly_salary: undefined }, /^monthly_salary: Månadslön krävs/],
    ['tax_table_number', { tax_table_number: 50 }, /^tax_table_number: Får vara högst 42\./],
    ['hourly_rate', { salary_type: 'hourly', monthly_salary: undefined }, /^hourly_rate: Timlön krävs/],
  ])('names %s in both languages', async (field, patch, sv) => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_create_employee', { ...VALID_EMPLOYEE, ...patch }, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toContain(`${field}: `)
    expect(error.message_sv).toMatch(sv)
  })

  it('says a required field is missing instead of a type error', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_create_employee', { ...VALID_EMPLOYEE, employment_start: undefined }, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_sv).toBe('employment_start: Obligatoriskt fält saknas.')
  })

  it('refuses an EF owner on payroll as VALIDATION_ERROR on employment_type, like v1', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { entity_type: 'enskild_firma' } }) // entity-type preflight (company_settings)

    const error = await refusal(
      'gnubok_create_employee', { ...VALID_EMPLOYEE, employment_type: 'company_owner' }, supabase,
    )

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toMatch(/^Invalid employee: employment_type: /)
    expect(error.message_sv).toMatch(/^employment_type: En enskild firma kan inte ha sin ägare/)
  })
})

describe('gnubok_update_employee', () => {
  it('names vacation_days_per_year in the update schema refusal', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_update_employee', { employee_id: 'emp-1', vacation_days_per_year: 12 }, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toMatch(/^Invalid employee update: vacation_days_per_year: /)
    expect(error.message_sv).toBe('vacation_days_per_year: Måste vara minst 25.')
  })

  it('names the field a merged-row rule refuses', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'emp-1', first_name: 'Anna', last_name: 'A', salary_type: 'monthly', monthly_salary: 35000 } })

    const error = await refusal('gnubok_update_employee', { employee_id: 'emp-1', monthly_salary: null }, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_sv).toMatch(/^monthly_salary: Månadslön krävs/)
  })

  it('answers EMPLOYEE_NOT_FOUND for an employee of another company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const error = await refusal('gnubok_update_employee', { employee_id: 'emp-x', monthly_salary: 38000 }, supabase)

    expect(error.code).toBe('EMPLOYEE_NOT_FOUND')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toContain('emp-x')
  })
})

describe('gnubok_set_employee_opening_balances', () => {
  it.each([
    ['a JSON string', '[{"employee_id":"e","cutover_date":"2026-07-01"}]', /got a string: send the array itself/],
    ['nothing', undefined, /got nothing/],
    ['an empty array', [], /got an empty array/],
  ])('refuses %s as items with VALIDATION_ERROR before any read', async (_label, items, got) => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_set_employee_opening_balances', { items }, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toMatch(/^Invalid opening balances: items: must be a non-empty array/)
    expect(error.message_en).toMatch(got)
    expect(error.message_sv).toMatch(/^items: Ska vara en lista/)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('gnubok_get_salary_run', () => {
  it('answers SALARY_RUN_NOT_FOUND for an unknown id, with a way to find the run', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const error = await refusal('gnubok_get_salary_run', { salary_run_id: 'run-x' }, supabase)

    expect(error.code).toBe('SALARY_RUN_NOT_FOUND')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toBe('Lönekörningen kunde inte hittas.')
    expect(error.message_en).toContain('run-x')
    expect(error.remediation?.tool).toBe('gnubok_get_salary_run')
  })

  it('treats a malformed id (22P02) as not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid: "run-x"' } })

    const error = await refusal('gnubok_get_salary_run', { salary_run_id: 'run-x' }, supabase)

    expect(error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('keeps a statement timeout transient', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    const error = await refusal('gnubok_get_salary_run', { salary_run_id: 'run-1' }, supabase)

    expect(error.code).toBe('TRANSIENT_ERROR')
    expect(error.retryable).toBe(true)
  })

  it('points at creating the run when a month has none', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const error = await refusal('gnubok_get_salary_run', { period_year: 2026, period_month: 2 }, supabase)

    expect(error.code).toBe('SALARY_RUN_NOT_FOUND')
    expect(error.message_en).toContain('2026-02')
    expect(error.remediation).toMatchObject({
      tool: 'gnubok_create_salary_run',
      args: { period_year: 2026, period_month: 2 },
    })
  })

  it('answers VALIDATION_ERROR for a missing selector', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_get_salary_run', {}, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toMatch(/^salary_run_id: Ange antingen salary_run_id eller period_year/)
  })
})

describe('gnubok_get_vacation_balance', () => {
  it('answers VACATION_BALANCE_NOT_FOUND with the way forward before the ledger has seeded', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vacation_rule: 'procentregeln', vacation_days_per_year: 25 } }) // the employee exists
    enqueue({ data: null }) // no open ledger row yet

    const error = await refusal('gnubok_get_vacation_balance', { employee_id: 'emp-1' }, supabase)

    expect(error.code).toBe('VACATION_BALANCE_NOT_FOUND')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toBe('Inget semestersaldo finns för den anställda ännu.')
    expect(error.message_en).toMatch(/seeded when their first salary run is booked/)
    expect(error.remediation?.tool).toBe('gnubok_get_employee')
  })
})

describe('gnubok_get_salary_journal', () => {
  it('requires the year, as the v1 report does, instead of querying with "undefined"', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_get_salary_journal', {}, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toBe('Invalid arguments: year: is required, an integer 2020-2100')
    expect(error.message_sv).toBe('year: Ange år som ett heltal 2020-2100.')
    expect(mockGenerateSalaryJournal).not.toHaveBeenCalled()
  })

  it('refuses a year outside 2020-2100', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_get_salary_journal', { year: 2019 }, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(mockGenerateSalaryJournal).not.toHaveBeenCalled()
  })

  it('passes an integer year to the report, accepting a numeric string', async () => {
    mockGenerateSalaryJournal.mockResolvedValue({ rows: [], totals: {}, period: { year: 2026 } })
    const { supabase } = createQueuedMockSupabase()

    await tool('gnubok_get_salary_journal').execute({ year: '2026' }, 'company-1', 'user-1', supabase as never, ACTOR)

    expect(mockGenerateSalaryJournal).toHaveBeenCalledWith(supabase, 'company-1', 2026)
  })
})

describe('gnubok_agi_status', () => {
  it('answers VALIDATION_ERROR for a missing salary_run_id', async () => {
    const { supabase } = createQueuedMockSupabase()
    const error = await refusal('gnubok_agi_status', {}, supabase)

    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toBe('Invalid arguments: salary_run_id: is required')
    expect(error.message_sv).toMatch(/^salary_run_id: Obligatoriskt fält saknas/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('answers SALARY_RUN_NOT_FOUND for an unknown run', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const error = await refusal('gnubok_agi_status', { salary_run_id: 'run-x' }, supabase)

    expect(error.code).toBe('SALARY_RUN_NOT_FOUND')
  })
})

describe('gnubok_generate_agi', () => {
  it('answers AGI_GENERATE_NOT_BOOKABLE for a draft run, pointing at booking it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'draft', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } })

    const error = await refusal('gnubok_generate_agi', { salary_run_id: 'run-1' }, supabase)

    expect(error.code).toBe('AGI_GENERATE_NOT_BOOKABLE')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toMatch(/^AGI kan endast genereras/)
    expect(error.message_en).toMatch(/must be past draft/)
    expect(error.remediation).toMatchObject({ tool: 'gnubok_book_salary_run', args: { salary_run_id: 'run-1' } })
  })
})

describe('gnubok_update_payslip_line', () => {
  it('lets SALARY_RUN_LINE_NOT_DRAFT itself reach the agent, with the run status', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'booked' } }) // service draft gate

    const error = await refusal(
      'gnubok_update_payslip_line', { salary_run_id: 'run-1', salary_line_item_id: 'line-1', amount: 5500 }, supabase,
    )

    expect(error.code).toBe('SALARY_RUN_LINE_NOT_DRAFT')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toBe('Lönebeskedets rader kan bara redigeras medan lönekörningen är ett utkast.')
    expect(error.message_en).toContain('Current status: booked.')
    expect(error.remediation?.tool).toBe('gnubok_revert_salary_run')
  })
})

describe('gnubok_agi_submit', () => {
  it('answers AGI_SUBMIT_NOT_GENERATED when no underlag exists, pointing at generate_agi', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'booked', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } })
    enqueue({ data: null }) // no agi_declarations row

    const error = await refusal('gnubok_agi_submit', { salary_run_id: 'run-1' }, supabase)

    expect(error.code).toBe('AGI_SUBMIT_NOT_GENERATED')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toBe('AGI-underlaget saknas för lönekörningen. Generera AGI först och lämna sedan in.')
    expect(error.message_en).toMatch(/^No AGI underlag has been generated for salary run run-1/)
    expect(error.remediation).toMatchObject({ tool: 'gnubok_generate_agi', args: { salary_run_id: 'run-1' } })
  })
})

describe('gnubok_book_salary_run', () => {
  it('answers SALARY_RUN_NOT_FOUND for an unknown id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const error = await refusal('gnubok_book_salary_run', { salary_run_id: 'run-x' }, supabase)

    expect(error.code).toBe('SALARY_RUN_NOT_FOUND')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toContain('run-x')
  })

  it('answers SALARY_RUN_ALREADY_BOOKED for a booked run instead of "Något gick fel"', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'booked', period_year: 2026, period_month: 8, payment_date: '2026-08-25' } })

    const error = await refusal('gnubok_book_salary_run', { salary_run_id: 'run-1' }, supabase)

    expect(error.code).toBe('SALARY_RUN_ALREADY_BOOKED')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toBe('Lönekörningen är redan bokförd.')
  })
})
