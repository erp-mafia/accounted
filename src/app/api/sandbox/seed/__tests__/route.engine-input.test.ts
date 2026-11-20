/**
 * Posting port, step 2i: what the sandbox seed (POST /api/sandbox/seed) hands
 * the engine, recorded call by call and compared with a committed fixture
 * (route.engine-input.json) that was taken before the seed went through the
 * port: the year-to-date ledger history, the demo invoice and its payment,
 * and the booked salary run's verifikat of an anonymous visitor's sandbox
 * company, on a fixed clock.
 *
 * Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/app/api/sandbox/seed/__tests__/route.engine-input.test.ts
 *
 * Since the seed posts through the posting port, the scenarios also run with
 * POSTING_EVENTS=shadow and strict: the off calls plus only one event link per
 * verifikat (ledger.system, system_derived), a refused event write still
 * seeds under shadow, and under strict the seed stops before its first
 * verifikat and fails as any other seed failure does.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'
import { eventLinksOf, withoutEventLinks } from '@/tests/engine-input'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkRateLimit: vi.fn(),
  ensureSandboxAgentProfile: vi.fn(),
  markEntriesNoDocRequired: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: mocks.requireAuth }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: mocks.checkRateLimit }))
vi.mock('@/lib/sandbox/ensure-agent', () => ({ ensureSandboxAgentProfile: mocks.ensureSandboxAgentProfile }))
vi.mock('@/lib/bookkeeping/no-doc-required', () => ({ markEntriesNoDocRequired: mocks.markEntriesNoDocRequired }))
vi.mock('@/lib/bookkeeping/bas-reference', () => ({
  getBASReference: (accountNumber: string) => ({
    account_name: `Account ${accountNumber}`,
    account_class: Number(accountNumber[0]),
    account_group: accountNumber.slice(0, 2),
    account_type: 'asset',
    normal_balance: 'debit',
    sru_code: null,
    k2_excluded: false,
  }),
}))
vi.mock('@/lib/salary/personnummer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/personnummer')>()),
  encryptPersonnummer: (value: string) => `encrypted:${value}`,
  decryptPersonnummer: (value: string) => value.replace(/^encrypted:/, ''),
}))
vi.mock('@/lib/salary/payroll-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payroll-config')>()),
  loadPayrollConfig: async (_db: unknown, year: number) => ({
    configYear: year,
    avgifterTotal: 0.3142,
    avgifterReduced65plus: 0.1021,
    avgifterYouthRate: 0.2081,
    avgifterYouthSalaryCap: 25000,
    avgifterVaxaStodRate: 0.1021,
    avgifterVaxaStodCap: 35000,
    reducedAvgiftAge: 67,
    slpRate: 0.2426,
    sjuklonRate: 0.8,
    karensavdragFactor: 0.2,
  }),
}))
vi.mock('@/lib/salary/tax-tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/tax-tables')>()),
  fetchTaxTableRates: async (year: number, tableNumber: number, column: number) => ({
    rates: [{ tableYear: year, tableNumber, columnNumber: column, incomeFrom: 0, incomeTo: 9999999, kind: 'amount', taxAmount: 5000 }],
    source: 'fallback',
  }),
}))

const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
const { POST } = await import('../route')

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const mockedCreate = vi.mocked(createJournalEntry)

/**
 * A client that answers every read with nothing and every insert with its
 * own rows (ids counted per run), the sandbox claim as a fresh attempt, and
 * refuses the journal tables: the seed must post through the engine.
 */
function makeClient(opts: { refuseEvent?: boolean } = {}) {
  let rowId = 0
  const inserts: Array<{ table: string; payload: unknown }> = []
  const from = vi.fn((table: string) => {
    if (table === 'journal_entries' || table === 'journal_entry_lines') throw new Error('Seed must use the engine')
    let insertPayload: unknown = undefined
    const chain: Record<string, unknown> = {}
    const insertedRows = () => {
      if (insertPayload === undefined) return []
      const rows = Array.isArray(insertPayload) ? insertPayload : [insertPayload]
      // The posting port's own rows take no id from the seed's counter, so
      // the seed's rows are numbered alike in every mode.
      if (table.startsWith('business_event')) return rows
      return rows.map((row) => ({ ...(row as Record<string, unknown>), id: `${table}-${++rowId}` }))
    }
    const refused = () => opts.refuseEvent === true && table === 'business_events'
    chain.insert = (payload: unknown) => {
      insertPayload = payload
      inserts.push({ table, payload })
      return chain
    }
    chain.update = () => chain
    chain.select = () => chain
    for (const method of ['eq', 'in', 'is', 'order', 'limit', 'gte', 'lte', 'not', 'or']) chain[method] = () => chain
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.single = async () => ({ data: insertedRows()[0] ?? { id: `${table}-${++rowId}` }, error: null })
    chain.then = (resolve: (value: unknown) => void) =>
      resolve(refused() ? { data: null, error: { message: 'business_events refused', code: '42501' } } : { data: insertedRows(), error: null })
    return chain
  })
  const supabase = {
    from,
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'claim_sandbox_seed') return { data: { status: 'new', company_id: 'sandbox-company-1', attempt_id: 'attempt-1' }, error: null }
      if (fn === 'finish_sandbox_seed') return { data: true, error: null }
      return { data: null, error: null }
    }),
  }
  return Object.assign(supabase, { inserts })
}

function record(args: unknown[]): unknown[] {
  const recorded = args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))
  while (recorded.length > 0 && recorded[recorded.length - 1] === '<undefined>') recorded.pop()
  return [recorded.length, ...recorded]
}

interface Run {
  name: string
  postings: unknown[][]
  outcome: { status: number; body: unknown }
  events: Array<Record<string, unknown>>
}

interface Scenario {
  name: string
  /** The clock the seed runs on: the history runs January through last month. */
  now: Date
  /** The engine refuses this posting, by index. */
  refuseAt?: number
}

const SCENARIOS: Scenario[] = [
  { name: 'a sandbox seeded in May', now: new Date(2026, 4, 15, 12, 0, 0) },
  { name: 'a sandbox seeded in early January', now: new Date(2026, 0, 3, 12, 0, 0) },
  { name: 'the engine refuses the fifth history voucher: the seed fails', now: new Date(2026, 4, 15, 12, 0, 0), refuseAt: 4 },
]

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const s of SCENARIOS) {
    vi.setSystemTime(s.now)
    mockedCreate.mockReset()
    mockedCreate.mockImplementation(async (_db, companyId, _user, input) => {
      if (s.refuseAt !== undefined && mockedCreate.mock.calls.length === s.refuseAt + 1) throw new Error('posting failed')
      return { id: `entry-${mockedCreate.mock.calls.length}`, company_id: companyId, status: 'posted', ...input } as never
    })
    const db = makeClient(opts)
    mocks.requireAuth.mockResolvedValue({ error: null, user: { id: 'sandbox-user-1', is_anonymous: true }, supabase: db })
    const response = await POST(
      new Request('http://localhost:3000/api/sandbox/seed', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.15' } }),
    )
    const body = (await response.json()) as Record<string, unknown>
    out.push({
      name: s.name,
      postings: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      outcome: { status: response.status, body: response.status === 200 ? body : { error: 'failed' } },
      events: db.inserts.filter((i) => i.table === 'business_events').map((i) => i.payload as Record<string, unknown>),
    })
  }
  return out
}

describe('sandbox seed engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
    vi.useFakeTimers()
    mocks.checkRateLimit.mockResolvedValue({ ok: true })
    mocks.ensureSandboxAgentProfile.mockResolvedValue(undefined)
    mocks.markEntriesNoDocRequired.mockResolvedValue(undefined)
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('hands the engine exactly what it got before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, postings, outcome }) => ({ name, postings, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })
  it('with POSTING_EVENTS=shadow posts with the same calls, plus only one ledger.system link per verifikat', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      expect(run.outcome, run.name).toEqual(off[i]!.outcome)
      expect(run.postings.map(withoutEventLinks), run.name).toEqual(off[i]!.postings)
      expect(run.postings.flatMap(eventLinksOf), run.name).toEqual(run.events.map((e) => ({ id: e.id, role: 'produced', onFailure: 'log' })))
      for (const [j, event] of run.events.entries()) {
        const input = run.postings[j]![4] as { entry_date: string }
        expect(event, run.name).toMatchObject({
          kind: 'ledger.system',
          occurred_on: input.entry_date,
          subject_type: null,
          category: null,
          amount: null,
          mapping_version: null,
          evidence: { link_basis: 'system_derived' },
        })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still seeds, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ name, postings, outcome }) => ({ name, postings, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the seed before its first verifikat', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.postings, run.name).toEqual([])
      expect(run.outcome, run.name).toEqual({ status: 500, body: { error: 'failed' } })
    }
  })
})
