/**
 * Posting port, step 2: what bookMileagePeriod hands the engine, recorded
 * call by call and compared with a committed fixture
 * (mileage-service.engine-input.json) that was taken before the producer went
 * through the port. Every argument is recorded, an absent one as
 * '<undefined>', so an extra argument or a changed input fails here.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/mileage/__tests__/mileage-service.engine-input.test.ts
 *
 * Since the producer posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow: the engine must get the same arguments plus
 * only the event link, and a refused event write must still post. The
 * ledger adapter fills createJournalEntry's commitMethod and rubricVersion
 * positions (the pilot's six-argument call), which this producer's
 * four-argument call receives as undefined, the value its omitted optional
 * parameters had: trailing undefined arguments are dropped before the
 * comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { PayrollConfig } from '@/lib/salary/payroll-config'
import type { CreateJournalEntryInput, EntityType, MileageTrip } from '@/types'

vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAllRows: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
}))
vi.mock('@/lib/salary/payroll-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payroll-config')>()),
  loadPayrollConfig: vi.fn(),
}))
vi.mock('@/lib/core/bookkeeping/period-service', () => ({ resolvePeriodStatusForDate: vi.fn() }))
vi.mock('@/lib/company/entity-type', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/entity-type')>()),
  resolveCompanyEntityType: vi.fn(),
}))

const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
const { fetchAllRows } = await import('@/lib/supabase/fetch-all')
const { loadPayrollConfig } = await import('@/lib/salary/payroll-config')
const { resolvePeriodStatusForDate } = await import('@/lib/core/bookkeeping/period-service')
const { resolveCompanyEntityType } = await import('@/lib/company/entity-type')
const { bookMileagePeriod } = await import('../mileage-service')
const { runInOperationCommit } = await import('@/lib/pending-operations/commit-scope')
type BookParams = Parameters<typeof bookMileagePeriod>[3]

const mockedCreate = vi.mocked(createJournalEntry)

const FIXTURE = path.join(__dirname, 'mileage-service.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const EMPLOYEE = '00000000-0000-4000-8000-00000000e001'
const OPERATION = '00000000-0000-4000-8000-0000000000f1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const CONFIG = {
  milersattningEgenBil: 25,
  milersattningFormansbilFossil: 12,
  milersattningFormansbilEl: 9.5,
} as PayrollConfig

function trip(id: string, overrides: Partial<MileageTrip> = {}): MileageTrip {
  return {
    id,
    company_id: COMPANY,
    user_id: USER,
    employee_id: null,
    trip_date: '2026-05-10',
    vehicle_type: 'own_car',
    vehicle_registration: null,
    odometer_start: null,
    odometer_end: null,
    distance_km: 100,
    from_location: 'Kontoret',
    to_location: 'Kunden',
    purpose: 'Kundbesök',
    visited: null,
    is_round_trip: false,
    status: 'draft',
    journal_entry_id: null,
    salary_run_id: null,
    notes: null,
    created_via: 'manual',
    created_at: '2026-05-10T00:00:00Z',
    updated_at: '2026-05-10T00:00:00Z',
    ...overrides,
  }
}

interface Scenario {
  name: string
  entityType: EntityType
  trips: MileageTrip[]
  params: BookParams
  /** Booked inside this staged operation's approval (runInOperationCommit). */
  operationId?: string
}

const SCENARIOS: Scenario[] = [
  {
    name: 'owner trips of an aktiebolag on the default counter account',
    entityType: 'aktiebolag',
    trips: [trip('00000000-0000-4000-8000-0000000a0001'), trip('00000000-0000-4000-8000-0000000a0002', { distance_km: 42.5 })],
    params: { from: '2026-05-01', to: '2026-05-31', entryDate: '2026-05-31' },
  },
  {
    name: 'employee trips in two vehicle types on 2820, the motpart named',
    entityType: 'aktiebolag',
    trips: [
      trip('00000000-0000-4000-8000-0000000a0003', { employee_id: EMPLOYEE }),
      trip('00000000-0000-4000-8000-0000000a0004', {
        employee_id: EMPLOYEE,
        vehicle_type: 'company_car_electric',
        vehicle_registration: 'ABC123',
        distance_km: 60,
      }),
    ],
    params: { from: '2026-06-01', to: '2026-06-30', entryDate: '2026-06-30', employeeId: EMPLOYEE, counterAccount: '2820' },
  },
  {
    name: 'enskild firma owner trips on the insättning account',
    entityType: 'enskild_firma',
    trips: [trip('00000000-0000-4000-8000-0000000a0005', { distance_km: 230 })],
    params: { from: '2026-07-01', to: '2026-07-31', entryDate: '2026-07-31' },
  },
  {
    name: 'owner trips paid from the bank, approved from a staged operation with the trip set frozen',
    entityType: 'aktiebolag',
    trips: [trip('00000000-0000-4000-8000-0000000a0006', { distance_km: 18 })],
    params: {
      from: '2026-08-01',
      to: '2026-08-31',
      entryDate: '2026-08-31',
      counterAccount: '1930',
      createdVia: 'mcp',
      expectedTripIds: ['00000000-0000-4000-8000-0000000a0006'],
    },
    operationId: OPERATION,
  },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

/** A recorded call without its trailing undefined arguments (see the header). */
function trimTrailingUndefined(call: unknown[]): unknown[] {
  const args = call.slice(1)
  while (args.length > 0 && args[args.length - 1] === '<undefined>') args.pop()
  return [args.length, ...args]
}

interface Run {
  name: string
  calls: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockClear()
    vi.mocked(resolveCompanyEntityType).mockResolvedValue(s.entityType)
    vi.mocked(fetchAllRows).mockResolvedValue(s.trips)
    vi.mocked(loadPayrollConfig).mockResolvedValue(CONFIG)
    vi.mocked(resolvePeriodStatusForDate).mockResolvedValue({ status: 'open', period_id: '00000000-0000-4000-8000-00000000f001' } as never)
    mockedCreate.mockImplementation(
      async (_sb, _c, _u, input: CreateJournalEntryInput) =>
        ({ id: `je-${index}`, voucher_number: index + 1, voucher_series: 'A', ...input }) as never,
    )
    const { supabase, findCalls } = createTableMockSupabase({
      // The claim and the stamp answer every trip; the orphan sweep awaits no rows.
      mileage_trips: (calls) =>
        calls.some((c) => c.method === 'select') ? { data: s.trips.map((t) => ({ id: t.id })) } : { data: null },
      employees: { data: { first_name: 'Sofie', last_name: 'Persson' } },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const book = () => bookMileagePeriod(supabase as never, COMPANY, USER, s.params)
    const result = await (s.operationId ? runInOperationCommit(s.operationId, book) : book())
    expect(result.ok, `${s.name}: ${JSON.stringify(result)}`).toBe(true)
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('bookMileagePeriod engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls }) => ({ name, calls: calls.map(trimTrailingUndefined) }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!.calls[0]!
      const call = run.calls[0]!
      expect(run.calls, run.name).toHaveLength(1)
      expect(call[0], run.name).toBe(7)
      expect(call.slice(1, 5), run.name).toEqual(before.slice(1, 5))
      expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
      expect(call[7], run.name).toEqual({ businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' } })
      expect(run.events, run.name).toHaveLength(1)
      expect((call[7] as { businessEvent: { id: string } }).businessEvent.id).toBe(run.events[0]!.id)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.calls)).toEqual(off.map((r) => r.calls))
    expect(refused.map((r) => r.events.length)).toEqual(refused.map(() => 1))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name === name)!.events[0]!

    expect(event('owner trips of an aktiebolag on the default counter account')).toMatchObject({
      kind: 'expense.mileage_allowance',
      category: 'expense.personnel',
      occurred_on: '2026-05-31',
      subject_type: null,
      party_type: null,
      party_id: null,
      currency: 'SEK',
      amount: 356.25,
      amount_sek: 356.25,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('owner trips of an aktiebolag on the default counter account').mapping_version).toMatch(/^se\.mileage-allowance@/)
    expect(event('employee trips in two vehicle types on 2820, the motpart named')).toMatchObject({
      party_type: 'employee',
      party_id: EMPLOYEE,
      amount: 307,
    })
    // Inside a staged operation's approval the operation is named.
    expect(event('owner trips paid from the bank, approved from a staged operation with the trip set frozen')).toMatchObject({
      pending_operation_id: OPERATION,
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
    })
  })
})
