/**
 * Posting port, step 2i: what the owner's reopen of a closed year
 * (POST /api/bookkeeping/fiscal-periods/[id]/reopen, reopenClosedFiscalYear)
 * hands the engine, recorded call by call and compared with a committed
 * fixture (route.engine-input.json) that was taken before the door went
 * through the port. After the database's half, the engine reverses the next
 * year's omföring and IB, the closing entry and the year-end's currency
 * revaluation by storno, one verifikat at a time.
 *
 * Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run 'src/app/api/bookkeeping/fiscal-periods/[id]/reopen/__tests__/route.engine-input.test.ts'
 *
 * Since the stornos go through the posting port, the scenarios also run with
 * POSTING_EVENTS=shadow and strict: the off calls plus only one event link
 * per storno (ledger.storno of the year, the owner's own act), a refused
 * event write still reverses under shadow, and under strict the reopen stops
 * before its first storno and answers the resumable INCOMPLETE.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { eventLinksOf, withoutEventLinks } from '@/tests/engine-input'

const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: '00000000-0000-4000-8000-00000000a001' }, supabase: state.client, error: null })),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('00000000-0000-4000-8000-00000000c001'),
  getActiveCompanyId: vi.fn().mockResolvedValue('00000000-0000-4000-8000-00000000c001'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/agent/composer/tic-fetch', () => ({ ensureTicSnapshot: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  reverseEntry: vi.fn(),
}))

const { reverseEntry } = await import('@/lib/bookkeeping/engine')
const { BookkeepingDatabaseError, EntryAlreadyReversedError } = await import('@/lib/bookkeeping/errors')
const { POST } = await import('../route')

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const CLOSED = '00000000-0000-4000-8000-00000000f025'
const NEXT = '00000000-0000-4000-8000-00000000f026'
const mockedReverse = vi.mocked(reverseEntry)

type Kind = 'result_appropriation' | 'opening_balance' | 'closing_entry' | 'currency_revaluation'

function entry(kind: Kind, n: number) {
  const next = kind === 'result_appropriation' || kind === 'opening_balance'
  return {
    id: `00000000-0000-4000-8000-0000000e00${String(n).padStart(2, '0')}`,
    kind,
    voucher_series: 'A',
    voucher_number: n,
    entry_date: next ? '2026-01-01' : '2025-12-31',
    fiscal_period_id: next ? NEXT : CLOSED,
  }
}

interface Scenario {
  name: string
  entries: ReturnType<typeof entry>[]
  /** How the engine answers the storno of each entry, by index. */
  answer?: (index: number) => 'posted' | 'already' | 'refused'
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a closed year reopened: omföring, IB, closing entry and revaluation reversed',
    entries: [entry('result_appropriation', 2), entry('opening_balance', 1), entry('closing_entry', 41), entry('currency_revaluation', 40)],
  },
  {
    name: 'a resumed reopen: the IB was reversed by the run that stopped',
    entries: [entry('opening_balance', 1), entry('closing_entry', 41)],
    answer: (i) => (i === 0 ? 'already' : 'posted'),
  },
  {
    name: 'the engine refuses the closing entry storno: the reopen stops, resumable',
    entries: [entry('result_appropriation', 2), entry('closing_entry', 41), entry('currency_revaluation', 40)],
    answer: (i) => (i === 1 ? 'refused' : 'posted'),
  },
]

function record(args: unknown[]): unknown[] {
  const recorded = args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))
  while (recorded.length > 0 && recorded[recorded.length - 1] === '<undefined>') recorded.pop()
  return [recorded.length, ...recorded]
}

interface Run {
  name: string
  reversals: unknown[][]
  outcome: { status: number; body: unknown }
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const s of SCENARIOS) {
    let call = 0
    mockedReverse.mockReset()
    mockedReverse.mockImplementation(async (_sb, _c, _u, id: string) => {
      const answer = s.answer?.(call++) ?? 'posted'
      if (answer === 'already') throw new EntryAlreadyReversedError()
      if (answer === 'refused') throw new BookkeepingDatabaseError('post_reversal_entry', 'refused')
      return { id: `storno-${id}`, status: 'posted' } as never
    })
    const mock = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      company_members: { data: { company_id: '00000000-0000-4000-8000-00000000c001', role: 'owner' } },
      companies: { data: { entity_type: 'aktiebolag' } },
      'rpc:get_fiscal_year_reopen_eligibility': { data: { ok: true, eligible: true, blockers: [] } },
      'rpc:reopen_closed_fiscal_year': {
        data: { ok: true, period_name: '2025', resumed: s.answer !== undefined, entries: s.entries, closing_entry_id: s.entries.find((e) => e.kind === 'closing_entry')?.id ?? null, superseded_version_ids: [] },
      },
      fiscal_periods: [{ data: null }, { data: { id: CLOSED, name: '2025', is_closed: false, closing_entry_id: null } }],
    })
    state.client = mock.supabase
    const response = await POST(
      createMockRequest(`/api/bookkeeping/fiscal-periods/${CLOSED}/reopen`, {
        method: 'POST',
        body: { confirm_name: '2025', confirm_annual_report_not_adopted: true },
      }),
      createMockRouteParams({ id: CLOSED }),
    )
    const body = (await response.json()) as { data?: unknown; error?: { code?: string } }
    out.push({
      name: s.name,
      reversals: mockedReverse.mock.calls.map((c) => record(c as unknown[])),
      outcome: { status: response.status, body: body.data ?? { error: body.error?.code ?? null } },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('fiscal year reopen engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine exactly what it got before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, reversals, outcome }) => ({ name, reversals, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })
  it('with POSTING_EVENTS=shadow reverses with the same calls, plus only one event link per storno', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      expect(run.outcome, run.name).toEqual(off[i]!.outcome)
      expect(run.reversals.map(withoutEventLinks), run.name).toEqual(off[i]!.reversals)
      expect(run.reversals.flatMap(eventLinksOf), run.name).toEqual(run.events.map((e) => ({ id: e.id, role: 'reversal', onFailure: 'log' })))
      expect(run.events, run.name).toHaveLength(run.reversals.length)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still reverses, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ name, reversals, outcome }) => ({ name, reversals, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the reopen before its first storno, resumable', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.reversals, run.name).toEqual([])
      expect(run.outcome, run.name).toEqual({ status: 500, body: { error: 'FISCAL_YEAR_REOPEN_INCOMPLETE' } })
    }
  })

  it('records each storno as ledger.storno of the year reopened, the owner\'s own act', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const [run] = await runScenarios()
    expect(run!.events).toHaveLength(4)
    for (const event of run!.events) {
      expect(event).toMatchObject({
        kind: 'ledger.storno',
        subject_type: 'fiscal_period',
        subject_id: CLOSED,
        category: null,
        amount: null,
        mapping_version: null,
        evidence: { link_basis: 'user_created' },
        actor_type: 'user',
      })
      expect(String(event.occurred_on)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
