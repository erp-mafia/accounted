/**
 * Posting port, step 2i: what the momsdeklaration's basis fix
 * (POST /api/reports/vat-declaration/rc-basis-gaps/fix) hands the storno
 * service, recorded call by call and compared with a committed fixture
 * (fix.engine-input.json) that was taken before the door went through the
 * port. The door corrects a posted verifikat with storno and a corrected
 * verifikat that adds the basis pair the fiktiv moms lacks.
 *
 * Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/app/api/reports/vat-declaration/rc-basis-gaps/__tests__/fix.engine-input.test.ts
 *
 * Since the door goes through the posting port (correctJournalEntry), the
 * scenarios also run with POSTING_EVENTS=shadow and strict: the off call
 * plus only the two event links, a refused event write still corrects under
 * shadow, and under strict the door stops before the storno service.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase } from '@/tests/helpers'
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
vi.mock('@/lib/core/bookkeeping/storno-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/storno-service')>()),
  correctEntry: vi.fn(),
}))

const { correctEntry } = await import('@/lib/core/bookkeeping/storno-service')
const { CorrectionChainTooDeepError } = await import('@/lib/bookkeeping/errors')
const { POST } = await import('../fix/route')

const FIXTURE = path.join(__dirname, 'fix.engine-input.json')
const SUPABASE = '<supabase>'
const mockedCorrect = vi.mocked(correctEntry)

function entryId(index: number): string {
  return `00000000-0000-4000-8000-0000000e${String(index + 1).padStart(4, '0')}`
}

interface Scenario {
  name: string
  body: Record<string, unknown>
  lines: Array<Record<string, unknown>>
  refuse?: boolean
}

const EU_SERVICE = [
  { account_number: '6540', debit_amount: 10000, credit_amount: 0, line_description: 'Hosting', dimensions: { '6': 'P001' } },
  { account_number: '2440', debit_amount: 0, credit_amount: 10000, dimensions: {} },
  { account_number: '2645', debit_amount: 2500, credit_amount: 0, line_description: 'Beräknad ingående moms', dimensions: {} },
  { account_number: '2614', debit_amount: 0, credit_amount: 2500, line_description: 'Beräknad utgående moms', dimensions: {} },
]

const TWO_RATES = [
  { account_number: '4010', debit_amount: 1000, credit_amount: 0, dimensions: {} },
  { account_number: '6540', debit_amount: 2000, credit_amount: 0, dimensions: {} },
  { account_number: '2440', debit_amount: 0, credit_amount: 3000, dimensions: {} },
  { account_number: '2645', debit_amount: 620, credit_amount: 0, dimensions: {} },
  { account_number: '2624', debit_amount: 0, credit_amount: 120, dimensions: {} },
  { account_number: '2614', debit_amount: 0, credit_amount: 500, dimensions: {} },
]

const SCENARIOS: Scenario[] = [
  {
    name: 'an EU service at 25 % gets its basis pair',
    body: { supplierType: 'eu_business', supplyType: 'service' },
    lines: EU_SERVICE,
  },
  {
    name: 'EU goods at 12 % and an EU service at 25 %, classified per momssats',
    body: {
      supplierType: 'eu_business',
      supplyType: 'service',
      perOutputAccount: [{ rcOutputAccount: '2624', supplierType: 'eu_business', supplyType: 'goods' }],
    },
    lines: TWO_RATES,
  },
  {
    name: 'the storno service refuses',
    refuse: true,
    body: { supplierType: 'eu_business', supplyType: 'service' },
    lines: EU_SERVICE,
  },
]

function record(args: unknown[]): unknown[] {
  const recorded = args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))
  while (recorded.length > 0 && recorded[recorded.length - 1] === '<undefined>') recorded.pop()
  return [recorded.length, ...recorded]
}

interface Run {
  name: string
  corrections: unknown[][]
  outcome: { status: number; body: unknown }
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    const id = entryId(index)
    mockedCorrect.mockReset()
    mockedCorrect.mockImplementation(async () => {
      if (s.refuse) throw new CorrectionChainTooDeepError(3, 'A-1')
      return { reversal: { id: `storno-${id}` }, corrected: { id: `correction-${id}` } } as never
    })
    const mock = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      company_members: { data: { company_id: '00000000-0000-4000-8000-00000000c001', role: 'owner' } },
      journal_entries: { data: { id, status: 'posted', lines: s.lines } },
      chart_of_accounts: { data: [] },
    })
    state.client = mock.supabase
    const response = await POST(
      createMockRequest('/api/reports/vat-declaration/rc-basis-gaps/fix', { method: 'POST', body: { entryId: id, ...s.body } }),
      { params: Promise.resolve({}) },
    )
    const body = (await response.json()) as { data?: unknown; error?: { code?: string } }
    out.push({
      name: s.name,
      corrections: mockedCorrect.mock.calls.map((c) => record(c as unknown[])),
      outcome: { status: response.status, body: body.data ?? { error: body.error?.code ?? null } },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('rc basis fix engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the storno service exactly what it got before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, corrections, outcome }) => ({ name, corrections, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })
  it('with POSTING_EVENTS=shadow corrects with the same call, plus only the storno\'s and the correction\'s links', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      expect(run.outcome, run.name).toEqual(off[i]!.outcome)
      expect(run.corrections.map(withoutEventLinks), run.name).toEqual(off[i]!.corrections)
      const links = run.corrections.flatMap(eventLinksOf)
      expect(links, run.name).toEqual([
        { id: run.events[0]!.id, role: 'reversal', onFailure: 'log' },
        { id: run.events[1]!.id, role: 'correction', onFailure: 'log' },
      ])
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still corrects, with exactly the off call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ name, corrections, outcome }) => ({ name, corrections, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the door before the storno service', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.corrections, run.name).toEqual([])
      expect(run.outcome.status, run.name).toBeGreaterThanOrEqual(400)
    }
  })

  it('records the storno and the correction of the verifikat, the correction naming the basis rule', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const [run] = await runScenarios()
    const common = { subject_type: 'journal_entry', subject_id: entryId(0), category: null, amount: null, jurisdiction: 'SE', evidence: { link_basis: 'user_created' } }
    expect(run!.events).toEqual([
      expect.objectContaining({ ...common, kind: 'ledger.storno', mapping_version: null }),
      expect.objectContaining({ ...common, kind: 'ledger.correction' }),
    ])
    expect(String(run!.events[1]!.mapping_version)).toMatch(/^se\.vat-rc-basis-fix@/)
  })
})
