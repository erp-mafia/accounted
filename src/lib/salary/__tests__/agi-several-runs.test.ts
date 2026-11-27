/**
 * Several salary runs in one month (SALARY_EXTRA_RUNS_COMPANY_IDS): the AGI
 * of a payout month sums every live run paid out in it, one individuppgift
 * per person, and the month's figures are Skatteverket's computation on the
 * summed underlag (öre dropped once per sats, not once per run).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decideMonthAgiWrite, generateAgiDeclaration } from '../agi/generate-declaration'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'

vi.mock('../personnummer', () => ({
  decryptPersonnummer: (encrypted: string) => {
    if (encrypted === 'emp1_encrypted') return '199001011234'
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

const COMPANY_ID = 'company-1'

// Hourly staff for October paid early in November, monthly staff paid on the 26th.
const RUN_A = {
  id: 'run-a',
  company_id: COMPANY_ID,
  status: 'approved',
  period_year: 2026,
  period_month: 10,
  run_number: 2,
  payment_date: '2026-11-05',
  total_gross: 30002,
  total_tax: 9000.6,
  calculation_params: {},
  corrects_run_id: null,
}
const RUN_B = {
  id: 'run-b',
  company_id: COMPANY_ID,
  status: 'approved',
  period_year: 2026,
  period_month: 11,
  run_number: 1,
  payment_date: '2026-11-26',
  total_gross: 25002,
  total_tax: 7500.9,
  calculation_params: {},
  corrects_run_id: null,
}

const ROW_A = {
  employee_id: '11111111-1111-4111-8111-111111111111',
  monthly_salary: null,
  gross_salary: 30002,
  tax_withheld: 9000.6,
  avgifter_basis: 30002,
  avgifter_amount: 9426.63,
  avgifter_rate: 0.3142,
  avgifter_category: 'standard',
  employee: { personnummer: 'emp1_encrypted', specification_number: 1, f_skatt_status: 'a_skatt' },
  line_items: [],
}
const ROW_B = {
  employee_id: '33333333-3333-4333-8333-333333333333',
  monthly_salary: 25002,
  gross_salary: 25002,
  tax_withheld: 7500.9,
  avgifter_basis: 25002,
  avgifter_amount: 7855.63,
  avgifter_rate: 0.3142,
  avgifter_category: 'standard',
  employee: { personnummer: 'emp3_encrypted', specification_number: 3, f_skatt_status: 'a_skatt' },
  line_items: [],
}

const COMPANY = { name: 'Test AB', org_number: '556123-4567', entity_type: 'aktiebolag' }
const SETTINGS = { company_name: 'Test AB', org_number: '556123-4567', phone: '0701234567', email: 'agi@test.se' }
const PROFILE = { full_name: 'Anna Admin', email: 'anna@test.se' }

const ARGS = {
  companyId: COMPANY_ID,
  userId: 'user-1',
  userEmail: 'anna@test.se',
  salaryRunId: 'run-a',
  log,
  requestId: 'req-1',
}

const field = (xml: string, code: string) =>
  [...xml.matchAll(new RegExp(`faltkod="${code}">([^<]*)<`, 'g'))].map((match) => Number(match[1]))

/** Run A generates; run B is the month's other live run. */
function enqueueMonth(
  enqueueMany: (results: { data?: unknown; error?: unknown }[]) => void,
  opts: { rosterB?: unknown[]; stored?: unknown; holder?: unknown } = {},
) {
  enqueueMany([
    { data: RUN_A }, // salary_runs: the run
    { data: COMPANY },
    { data: SETTINGS },
    { data: PROFILE },
    { data: [ROW_A] }, // run A's roster
    { data: [] }, // run A: absence in its window
    { data: [] }, // run A: late days carried to it
    { data: [{ ...RUN_B }] }, // the month's other live runs
    { data: [] }, // no correction of a month's run waiting in draft
    { data: [RUN_B] }, // the other runs in full
    { data: opts.rosterB ?? [ROW_B] }, // run B's roster
    { data: [] }, // run B: absence in its window
    { data: [] }, // run B: late days carried to it
    { data: opts.stored ?? null }, // the period's declaration
    ...(opts.holder !== undefined ? [{ data: opts.holder }] : []),
  ])
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = COMPANY_ID
})

afterEach(() => {
  delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
})

describe('generateAgiDeclaration: two runs paid out in one month', () => {
  it('sums both runs into one declaration, per person and in total', async () => {
    const { supabase, enqueueMany, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueueMonth(enqueueMany)
    enqueue({ data: { id: 'agi-1' } }) // agi_declarations insert
    enqueue({ data: null }) // salary_runs: agi_generated_at stamp

    const result = await generateAgiDeclaration({ ...ARGS, supabase: supabase as never })
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`)

    // Skatteverket drops öre once per sats on the month's summed underlag:
    // trunc(55 004 × 31,42 %) = 17 282, a krona more than the two runs alone
    // (9 426 + 7 855).
    expect(result.totals.totalAvgifterAmount).toBe(17282)
    expect(result.totals.totalAvgifterBasis).toBe(55004)
    // FK001 is whole kronor per IU: 9 000 + 7 500.
    expect(result.totals.totalTax).toBe(16500)
    expect(result.employeeCount).toBe(2)
    expect(result.periodYear).toBe(2026)
    expect(result.periodMonth).toBe(11)

    expect(field(result.xml, '487')).toEqual([17282])
    expect(field(result.xml, '497')).toEqual([16500])
    expect(field(result.xml, '011').sort((a, b) => a - b)).toEqual([25002, 30002])
    expect(field(result.xml, '001').sort((a, b) => a - b)).toEqual([7500, 9000])

    const insert = findCall('agi_declarations', 'insert')?.[0] as Record<string, unknown>
    expect(insert).toMatchObject({
      salary_run_id: 'run-a',
      salary_run_ids: ['run-a', 'run-b'],
      period_year: 2026,
      period_month: 11,
      total_gross: 55004,
      total_tax: 16500,
      total_avgifter: 17282,
      employee_count: 2,
    })
    // Both runs show the month's declaration.
    expect(findCalls('salary_runs', 'in')).toContainEqual(['id', ['run-a', 'run-b']])
  })

  it('refuses the same person on both runs: one run per payout month and person', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMonth(enqueueMany, { rosterB: [{ ...ROW_B, employee_id: ROW_A.employee_id }] })

    const result = await generateAgiDeclaration({ ...ARGS, supabase: supabase as never })

    expect(result).toMatchObject({
      ok: false,
      code: 'AGI_MONTH_RUNS_NOT_COMBINED',
      details: { reason: 'same_employee', period: '2026-11', salary_run_ids: ['run-a', 'run-b'] },
    })
    expect(findCall('agi_declarations', 'insert')).toBeUndefined()
  })

  it('answers a filed declaration that covers both runs with the stored XML', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    const stored = {
      id: 'agi-1',
      salary_run_id: 'run-b',
      salary_run_ids: ['run-a', 'run-b'],
      status: 'submitted',
      submitted_at: '2026-12-02T10:00:00Z',
      xml_content: '<stored/>',
      total_gross: 55004,
      total_tax: 16500,
      total_avgifter_basis: 55004,
      total_avgifter: 17282,
      employee_count: 2,
    }
    enqueueMonth(enqueueMany, { stored, holder: { id: 'run-b', status: 'approved', period_year: 2026, period_month: 11 } })

    const result = await generateAgiDeclaration({ ...ARGS, supabase: supabase as never })

    expect(result).toMatchObject({ ok: true, xml: '<stored/>', unchanged: true, filed: true })
    expect(findCall('agi_declarations', 'update')).toBeUndefined()
    expect(findCall('agi_declarations', 'insert')).toBeUndefined()
  })

  it('makes a filed declaration of one run a rättelse of the month once a second run is paid in it', async () => {
    const { supabase, enqueueMany, enqueue, findCall } = createQueuedMockSupabase()
    const stored = {
      id: 'agi-1',
      salary_run_id: 'run-b',
      salary_run_ids: null,
      status: 'submitted',
      submitted_at: '2026-11-27T10:00:00Z',
      xml_content: '<only-b/>',
      total_gross: 25002,
      total_tax: 7500,
      total_avgifter_basis: 25002,
      total_avgifter: 7855,
      employee_count: 1,
    }
    enqueueMonth(enqueueMany, { stored, holder: { id: 'run-b', status: 'approved', period_year: 2026, period_month: 11 } })
    enqueue({ data: [{ id: 'agi-1' }] }) // agi_declarations update (takeover)
    enqueue({ data: null }) // stamp

    const result = await generateAgiDeclaration({ ...ARGS, supabase: supabase as never })
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`)

    const update = findCall('agi_declarations', 'update')?.[0] as Record<string, unknown>
    expect(update).toMatchObject({
      salary_run_id: 'run-a',
      salary_run_ids: ['run-a', 'run-b'],
      status: 'generated',
      kvittensnummer: null,
      total_avgifter: 17282,
    })
  })

  it('keeps a company outside the list on one run per declaration', async () => {
    delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: RUN_A },
      { data: COMPANY },
      { data: SETTINGS },
      { data: PROFILE },
      { data: [ROW_A] },
      { data: [] },
      { data: [] },
      { data: null }, // agi_declarations maybeSingle
      { data: [RUN_B] }, // another live run paid out in the month
    ])

    const result = await generateAgiDeclaration({ ...ARGS, supabase: supabase as never })

    expect(result).toMatchObject({ ok: false, code: 'AGI_PERIOD_CONFLICT' })
    expect(findCall('agi_declarations', 'insert')).toBeUndefined()
  })
})

describe('decideMonthAgiWrite', () => {
  const both = ['run-a', 'run-b']

  it('inserts the month\'s first declaration', () => {
    expect(decideMonthAgiWrite(null, both)).toBe('insert')
  })

  it('answers a filed declaration of exactly these runs as filed', () => {
    expect(decideMonthAgiWrite({ salary_run_id: 'run-b', salary_run_ids: ['run-b', 'run-a'], status: 'accepted' }, both)).toBe('filed')
    // A declaration of one run, filed before the month had another.
    expect(decideMonthAgiWrite({ salary_run_id: 'run-a', salary_run_ids: null, status: 'submitted' }, ['run-a'])).toBe('filed')
  })

  it('takes a filed declaration of other runs over as the month\'s rättelse', () => {
    expect(decideMonthAgiWrite({ salary_run_id: 'run-b', salary_run_ids: null, status: 'submitted' }, both)).toBe('take_over')
  })

  it('refuses while Skatteverket holds a declaration of other runs for signing', () => {
    expect(decideMonthAgiWrite({ salary_run_id: 'run-b', salary_run_ids: null, status: 'pending_signature' }, both)).toBe(
      'awaiting_signature',
    )
    expect(decideMonthAgiWrite({ salary_run_id: 'run-b', salary_run_ids: both, status: 'pending_signature' }, both)).toBe(
      'update_own',
    )
  })

  it('rewrites an unfiled declaration in place, whichever run holds it', () => {
    expect(decideMonthAgiWrite({ salary_run_id: 'run-b', salary_run_ids: null, status: 'generated' }, both)).toBe('update_own')
  })
})
