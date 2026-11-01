/**
 * Posting port, step 2g: what POST bokslutsdispositioner hands the engine,
 * recorded call by call and compared with a committed fixture
 * (route.engine-input.json) that was taken before the route went through the
 * port. Every argument of createJournalEntry is recorded, an absent one as
 * '<undefined>', so an extra argument, a changed input or a changed order of
 * the dispositions fails here. The calculators are mocked with fixed
 * proposals: the route's input to the engine is what is pinned, not the
 * calculators (they have their own tests), and the auth wrapper hands the
 * handler a signed-in owner's context.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run "src/app/api/bookkeeping/fiscal-periods/[id]/bokslutsdispositioner/__tests__/route.engine-input.test.ts" *
 * Since the route posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow: the engine must get the same arguments plus
 * only the event link, one event per verifikat, and a refused event write
 * must still post. Trailing undefined arguments (the ledger adapter's
 * commitMethod and rubricVersion positions) are dropped before the
 * comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { createTableMockSupabase } from '@/tests/helpers'
import type { ProposedDisposition } from '@/lib/bokslut/types'

const route = vi.hoisted(() => ({ ctx: null as Record<string, unknown> | null }))

vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext:
    (_operation: string, handler: (request: Request, ctx: unknown, params: unknown) => Promise<Response>) =>
    (request: Request, params: unknown) =>
      handler(request, route.ctx, params),
}))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
}))
vi.mock('@/lib/bokslut/dispositions-proposal-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/dispositions-proposal-builder')>()),
  loadDispositionState: vi.fn(),
  ateforingDispositions: vi.fn(),
  avsattningDisposition: vi.fn(),
  bolagsskattDisposition: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/sarskild-loneskatt-calculator', () => ({ calculateSarskildLoneskatt: vi.fn() }))
vi.mock('@/lib/bokslut/reserves/overavskrivningar-calculator', () => ({ calculateOveravskrivningar: vi.fn() }))

const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
const builder = await import('@/lib/bokslut/dispositions-proposal-builder')
const { calculateSarskildLoneskatt } = await import('@/lib/bokslut/tax-provision/sarskild-loneskatt-calculator')
const { calculateOveravskrivningar } = await import('@/lib/bokslut/reserves/overavskrivningar-calculator')
const { POST } = await import('../route')

const mockedCreate = vi.mocked(createJournalEntry)

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'

const proposal = (kind: ProposedDisposition['kind'], label: string, amount: number, debit: string, credit: string): ProposedDisposition => ({
  kind,
  label,
  description: label,
  amount,
  lines: [
    { account_number: debit, debit_amount: amount, credit_amount: 0, line_description: label },
    { account_number: credit, debit_amount: 0, credit_amount: amount, line_description: label },
  ],
  warnings: [],
})

const BOLAGSSKATT = proposal('bolagsskatt', 'Bolagsskatt 20,6 %', 12515, '8910', '2512')
const AVSATTNING = proposal('periodiseringsfond_avsattning', 'Avsättning till periodiseringsfond 2025', 20250, '8811', '2125')
const ATERFORING_2019 = proposal('periodiseringsfond_ateforing', 'Återföring periodiseringsfond 2019', 8000, '2129', '8819')
const ATERFORING_2020 = proposal('periodiseringsfond_ateforing', 'Återföring periodiseringsfond 2020', 4500, '2120', '8819')
const SLP = proposal('sarskild_loneskatt', 'Särskild löneskatt på pensionskostnader', 2426, '7533', '2514')

interface Scenario {
  name: string
  items: Array<Record<string, unknown>>
}

const SCENARIOS: Scenario[] = [
  {
    name: 'bolagsskatt and an avsättning sent in that order: booked avsättning first, bolagsskatt last',
    items: [{ kind: 'bolagsskatt' }, { kind: 'periodiseringsfond_avsattning', desiredAmount: 20250 }],
  },
  {
    name: 'two fonder returned in one verifikat, an överavskrivning and the särskild löneskatt',
    items: [
      { kind: 'sarskild_loneskatt' },
      { kind: 'overavskrivningar', additionalAmount: 8000 },
      { kind: 'periodiseringsfond_ateforing', returns: { '2019': 8000, '2020': 4500 } },
    ],
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A shadow call without its event link, trimmed as the off call is, and the link it carried. */
function splitLink(call: unknown[]): { call: unknown[]; link: unknown } {
  const args = call.slice(1)
  const last = args[args.length - 1]
  if (last && typeof last === 'object' && 'businessEvent' in last) {
    const { businessEvent, ...rest } = last as Record<string, unknown>
    args[args.length - 1] = Object.keys(rest).length > 0 ? rest : '<undefined>'
    return { call: trimTrailingUndefined([args.length, ...args]), link: businessEvent }
  }
  return { call: trimTrailingUndefined(call), link: undefined }
}

interface Run {
  name: string
  createJournalEntry: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const s of SCENARIOS) {
    mockedCreate.mockReset()
    let n = 0
    mockedCreate.mockImplementation(async (_sb, _c, _u, input) => {
      n++
      return { id: `je-${n}`, voucher_series: 'A', voucher_number: n, entry_date: input.entry_date } as never
    })
    vi.mocked(builder.loadDispositionState).mockResolvedValue({ bookedTax: 0 } as never)
    vi.mocked(builder.ateforingDispositions).mockReturnValue({ proposals: [ATERFORING_2019, ATERFORING_2020], schablonintaktAmount: 0 } as never)
    vi.mocked(builder.avsattningDisposition).mockReturnValue(AVSATTNING)
    vi.mocked(builder.bolagsskattDisposition).mockReturnValue(BOLAGSSKATT)
    vi.mocked(calculateSarskildLoneskatt).mockResolvedValue(SLP)
    vi.mocked(calculateOveravskrivningar).mockResolvedValue({
      status: 'ready',
      proposal: { ...proposal('overavskrivningar', 'Överavskrivningar', 10000, '8853', '2153'), signedAmount: 10000, computation: { method: '30-rule' } },
      warning: null,
      currentReserve: 0,
      currentPeriodChange: 0,
      targetReserve: 10000,
      maximumSignedChange: 10000,
    } as never)
    const { supabase, payloads } = createTableMockSupabase({
      companies: { data: { entity_type: 'aktiebolag' } },
      fiscal_periods: {
        data: {
          id: PERIOD,
          name: '2025',
          period_start: '2025-01-01',
          period_end: '2025-12-31',
          opening_balance_entry_id: null,
          is_closed: false,
          locked_at: null,
          closing_entry_id: null,
        },
      },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
    route.ctx = { user: { id: USER }, userId: USER, supabase, companyId: COMPANY, log, requestId: 'req-1' }
    const response = await POST(
      new Request('http://localhost/api', { method: 'POST', body: JSON.stringify({ items: s.items }) }),
      { params: Promise.resolve({ id: PERIOD }) },
    )
    expect(response.status, `${s.name}: ${await response.clone().text()}`).toBe(200)
    out.push({
      name: s.name,
      createJournalEntry: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      events: payloads('business_events', 'insert') as Array<Record<string, unknown>>,
    })
  }
  return out
}

describe('POST bokslutsdispositioner engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, createJournalEntry: calls }) => ({
      name,
      createJournalEntry: calls.map(trimTrailingUndefined),
    }))
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
      expect(run.createJournalEntry, run.name).toHaveLength(off[i]!.createJournalEntry.length)
      const links = run.createJournalEntry.map((c, j) => {
        const { call, link } = splitLink(c)
        expect(call, `${run.name} #${j}`).toEqual(trimTrailingUndefined(off[i]!.createJournalEntry[j]!))
        expect(link, `${run.name} #${j}`).toEqual({ id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' })
        return (link as { id: string }).id
      })
      expect(run.events.map((e) => e.id), run.name).toEqual(links)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.createJournalEntry)).toEqual(off.map((r) => r.createJournalEntry))
    expect(refused.map((r) => r.events.length)).toEqual(off.map((r) => r.createJournalEntry.length))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const [avsattning, bolagsskatt] = runs[0]!.events
    expect(avsattning).toMatchObject({
      kind: 'year_end.closing',
      category: 'se.closing.appropriations',
      occurred_on: '2025-12-31',
      subject_type: 'fiscal_period',
      subject_id: PERIOD,
      party_type: null,
      currency: 'SEK',
      amount: 20250,
      amount_sek: 20250,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(avsattning!.mapping_version).toMatch(/^se\.year-end-dispositions@/)
    expect(bolagsskatt).toMatchObject({ category: 'se.closing.appropriations', amount: 12515 })
    // Two fonder returned in one verifikat, the överavskrivning, then the särskild löneskatt (a personnel cost).
    expect(runs[1]!.events.map((e) => [e.category, e.amount])).toEqual([
      ['se.closing.appropriations', 12500],
      ['se.closing.appropriations', 8000],
      ['expense.personnel', 2426],
    ])
    // Inside an approval the event names the operation.
    const operation = '00000000-0000-4000-8000-0000000c0001'
    const staged = await runInOperationCommit(operation, () => runScenarios())
    expect(staged[0]!.events[0]).toMatchObject({
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: operation } },
      pending_operation_id: operation,
    })
  })
})
