/**
 * Posting port, step 2b: what createSkattekontoTransferDraft hands the
 * engine, recorded call by call and compared with a committed fixture
 * (skattekonto-account-service.engine-input.json) that was taken before the
 * producer went through the port. The transfer is only ever a draft
 * (createDraftEntry); every argument is recorded, an absent one as
 * '<undefined>', so an extra argument or a changed input fails here.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/skatteverket/__tests__/skattekonto-account-service.engine-input.test.ts
 *
 * Since the producer drafts through the posting port (draftJournalEntry),
 * the scenarios also run with POSTING_EVENTS=shadow: the draft must get the
 * same four arguments plus only the event link, and a refused event write
 * must still draft.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/chart-of-accounts-service', () => ({
  activateAccounts: vi.fn(async () => ({ ok: true, data: { accounts: [], activated: 0, reactivated: 0, skipped: 1, unknown: [] } })),
  createAccount: vi.fn(async () => ({ ok: true, data: {} })),
}))
const balances = vi.hoisted(() => new Map<string, number>())
vi.mock('@/lib/reconciliation/gl-balance', () => ({
  findOpeningBalanceFloor: vi.fn(async () => null),
  sumAccountBalance: vi.fn(async (_s: unknown, _c: unknown, account: string) => balances.get(account) ?? 0),
}))
const accounts = vi.hoisted(() => ({ resolved: '2012' as string }))
vi.mock('../skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => accounts.resolved),
  deriveSkattekontoAccountFromBooks: vi.fn(async () => null),
}))

const { createDraftEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { createSkattekontoTransferDraft } = await import('../skattekonto-account-service')

const mockedDraft = vi.mocked(createDraftEntry)

const FIXTURE = path.join(__dirname, 'skattekonto-account-service.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const FISCAL_PERIOD = '00000000-0000-4000-8000-00000000f001'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

interface Scenario {
  name: string
  /** The account the company runs now; the other choice holds `balance`. */
  now: '1630' | '2012'
  balances: Record<string, number>
  entryDate: string
}

const SCENARIOS: Scenario[] = [
  { name: 'an överskott left on 1630 moves to 2012', now: '2012', balances: { '1630': 800 }, entryDate: '2026-09-01' },
  { name: 'a debt left on 2012 moves back to 1630', now: '1630', balances: { '2012': -1234.5 }, entryDate: '2026-10-14' },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Run {
  name: string
  createDraftEntry: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedDraft.mockReset()
    balances.clear()
    for (const [account, balance] of Object.entries(s.balances)) balances.set(account, balance)
    accounts.resolved = s.now
    vi.mocked(findFiscalPeriod).mockResolvedValue(FISCAL_PERIOD)
    mockedDraft.mockImplementation(async (_sb, _c, _u, input) => ({ id: `je-${index}`, status: 'draft', ...input }) as never)
    const { supabase, payloads } = createTableMockSupabase({
      company_settings: { data: { entity_type: 'enskild_firma', skattekonto_account: s.now } },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const outcome = await createSkattekontoTransferDraft(
      { supabase: supabase as never, companyId: COMPANY, userId: USER, log },
      { entry_date: s.entryDate },
    )
    expect(outcome.ok, `${s.name}: ${JSON.stringify(outcome)}`).toBe(true)
    out.push({
      name: s.name,
      createDraftEntry: mockedDraft.mock.calls.map((c) => record(c as unknown[])),
      events: payloads('business_events', 'insert') as Array<Record<string, unknown>>,
    })
  }
  return out
}

describe('createSkattekontoTransferDraft engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, createDraftEntry: calls }) => ({ name, createDraftEntry: calls }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow drafts with the same four arguments plus only the link', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!.createDraftEntry[0]!
      const call = run.createDraftEntry[0]!
      expect(run.createDraftEntry, run.name).toHaveLength(1)
      expect(before[0]).toBe(4)
      expect(call[0], run.name).toBe(5)
      expect(call.slice(1, 5), run.name).toEqual(before.slice(1, 5))
      expect(call[5], run.name).toEqual({ businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' } })
      expect(run.events, run.name).toHaveLength(1)
      expect((call[5] as { businessEvent: { id: string } }).businessEvent.id).toBe(run.events[0]!.id)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still drafts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.createDraftEntry)).toEqual(off.map((r) => r.createDraftEntry))
    expect(refused.map((r) => r.events.length)).toEqual(refused.map(() => 1))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    expect(runs[0]!.events[0]).toMatchObject({
      kind: 'ledger.manual',
      category: 'se.tax.settlement',
      occurred_on: '2026-09-01',
      subject_type: null,
      party_type: null,
      currency: 'SEK',
      amount: 800,
      amount_sek: 800,
      evidence: {},
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(runs[0]!.events[0]!.mapping_version).toMatch(/^se\.skattekonto-account-transfer@/)
    expect(runs[1]!.events[0]).toMatchObject({ occurred_on: '2026-10-14', amount: 1234.5 })
  })
})
