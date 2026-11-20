/**
 * Posting port, step 2i: what the dashboard's own voucher doors hand the
 * engine and the storno service, recorded call by call and compared with a
 * committed fixture (route.engine-input.json) that was taken before the doors
 * went through the port:
 *
 *   POST /api/bookkeeping/journal-entries            createJournalEntry, or
 *        ?as_draft=true                              createDraftEntry
 *   POST /api/bookkeeping/journal-entries/[id]/commit     commitEntry
 *   POST /api/bookkeeping/journal-entries/[id]/reverse    reverseEntry
 *   POST /api/bookkeeping/journal-entries/[id]/correct    correctEntry
 *   POST /api/bookkeeping/journal-entries/[id]/recordate  recordateEntry
 *
 * Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison (the ledger adapter
 * always passes createJournalEntry's commitMethod and rubricVersion
 * positions, see src/lib/posting/ledger-adapter.ts).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/app/api/bookkeeping/journal-entries/__tests__/route.engine-input.test.ts
 *
 * Since the doors go through the posting port, the scenarios also run with
 * POSTING_EVENTS=shadow and strict: every call must be the off call with only
 * the event link added (one event per new verifikat, the storno's and the
 * correction's for a rättelse), a refused event write must still book under
 * shadow, and under strict every door that records an event stops before the
 * engine; the commit of a draft records nothing and commits in every mode.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { callsWithoutEventLinks, eventLinksOf, roleForKind } from '@/tests/engine-input'

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
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/core/bookkeeping/storno-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/storno-service')>()),
  correctEntry: vi.fn(),
  recordateEntry: vi.fn(),
}))

const { createJournalEntry, createDraftEntry, commitEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { correctEntry, recordateEntry } = await import('@/lib/core/bookkeeping/storno-service')
const { AccountsNotInChartError, CannotReverseNonPostedError, MeaninglessCorrectionError } = await import('@/lib/bookkeeping/errors')
const { POST: createPOSTRoute } = await import('../route')
const createPOST = (request: Request) => createPOSTRoute(request, { params: Promise.resolve({}) })
const { POST: commitPOST } = await import('../[id]/commit/route')
const { POST: reversePOST } = await import('../[id]/reverse/route')
const { POST: correctPOST } = await import('../[id]/correct/route')
const { POST: recordatePOST } = await import('../[id]/recordate/route')

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const PERIOD = '00000000-0000-4000-8000-00000000f001'

const ENGINE = {
  createJournalEntry: vi.mocked(createJournalEntry),
  createDraftEntry: vi.mocked(createDraftEntry),
  commitEntry: vi.mocked(commitEntry),
  reverseEntry: vi.mocked(reverseEntry),
  correctEntry: vi.mocked(correctEntry),
  recordateEntry: vi.mocked(recordateEntry),
}

function entryId(index: number): string {
  return `00000000-0000-4000-8000-0000000e${String(index + 1).padStart(4, '0')}`
}

const LINES = [
  { account_number: '6110', debit_amount: 400, credit_amount: 0, line_description: 'Kontorsmaterial' },
  { account_number: '2641', debit_amount: 100, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 500 },
]

const VAT_SETTLEMENT_LINES = [
  { account_number: '2611', debit_amount: 2500, credit_amount: 0 },
  { account_number: '2641', debit_amount: 0, credit_amount: 900 },
  { account_number: '2650', debit_amount: 0, credit_amount: 1600 },
]

interface Scenario {
  name: string
  call: (index: number) => Promise<Response>
  /** The engine or storno service refuses. */
  refuse?: boolean
}

function body(extra: Record<string, unknown> = {}) {
  return {
    fiscal_period_id: PERIOD,
    entry_date: '2026-04-14',
    description: 'Kontorsmaterial, Clas Ohlson',
    lines: LINES,
    ...extra,
  }
}

const SCENARIOS: Scenario[] = [
  {
    name: 'create: a manual voucher posted from the form',
    call: () => createPOST(createMockRequest('/api/bookkeeping/journal-entries', { method: 'POST', body: body({ notes: 'Kvitto i pärmen' }) })),
  },
  {
    name: 'create: a momsredovisning booked from its template (vat_settlement)',
    call: () =>
      createPOST(
        createMockRequest('/api/bookkeeping/journal-entries', {
          method: 'POST',
          body: body({ description: 'Momsredovisning mars', source_type: 'vat_settlement', lines: VAT_SETTLEMENT_LINES }),
        }),
      ),
  },
  {
    name: 'create: saved as a draft',
    call: () =>
      createPOST(
        createMockRequest('/api/bookkeeping/journal-entries', { method: 'POST', body: body({ voucher_series: 'B' }), searchParams: { as_draft: 'true' } }),
      ),
  },
  {
    name: 'create: the engine refuses the voucher',
    refuse: true,
    call: () => createPOST(createMockRequest('/api/bookkeeping/journal-entries', { method: 'POST', body: body() })),
  },
  {
    name: 'create: a draft the engine refuses',
    refuse: true,
    call: () =>
      createPOST(createMockRequest('/api/bookkeeping/journal-entries', { method: 'POST', body: body(), searchParams: { as_draft: 'true' } })),
  },
  {
    name: 'commit: a draft posted from the draft list',
    call: (i) => commitPOST(createMockRequest(`/api/bookkeeping/journal-entries/${entryId(i)}/commit`, { method: 'POST' }), createMockRouteParams({ id: entryId(i) })),
  },
  {
    name: 'reverse: a posted voucher reversed',
    call: (i) => reversePOST(createMockRequest(`/api/bookkeeping/journal-entries/${entryId(i)}/reverse`, { method: 'POST' }), createMockRouteParams({ id: entryId(i) })),
  },
  {
    name: 'reverse: deep in a correction chain, reversed anyway',
    call: (i) =>
      reversePOST(
        createMockRequest(`/api/bookkeeping/journal-entries/${entryId(i)}/reverse`, { method: 'POST', body: { allow_deep_chain: true } }),
        createMockRouteParams({ id: entryId(i) }),
      ),
  },
  {
    name: 'reverse: the engine refuses the storno',
    refuse: true,
    call: (i) => reversePOST(createMockRequest(`/api/bookkeeping/journal-entries/${entryId(i)}/reverse`, { method: 'POST' }), createMockRouteParams({ id: entryId(i) })),
  },
  {
    name: 'correct: a posted voucher corrected with new lines and its own text',
    call: (i) =>
      correctPOST(
        createMockRequest(`/api/bookkeeping/journal-entries/${entryId(i)}/correct`, {
          method: 'POST',
          body: {
            description: 'Rättelse: förbrukningsinventarier, inte kontorsmaterial',
            lines: [
              { account_number: '5410', debit_amount: 400, credit_amount: 0 },
              { account_number: '2641', debit_amount: 100, credit_amount: 0 },
              { account_number: '1930', debit_amount: 0, credit_amount: 500 },
            ],
          },
        }),
        createMockRouteParams({ id: entryId(i) }),
      ),
  },
  {
    name: 'correct: deep in a chain, corrected anyway, default text',
    call: (i) =>
      correctPOST(
        createMockRequest(`/api/bookkeeping/journal-entries/${entryId(i)}/correct`, {
          method: 'POST',
          body: {
            allow_deep_chain: true,
            lines: [
              { account_number: '6110', debit_amount: 320, credit_amount: 0 },
              { account_number: '2641', debit_amount: 80, credit_amount: 0 },
              { account_number: '1930', debit_amount: 0, credit_amount: 400 },
            ],
          },
        }),
        createMockRouteParams({ id: entryId(i) }),
      ),
  },
  {
    name: 'correct: the storno service refuses the correction',
    refuse: true,
    call: (i) =>
      correctPOST(
        createMockRequest(`/api/bookkeeping/journal-entries/${entryId(i)}/correct`, { method: 'POST', body: { lines: LINES } }),
        createMockRouteParams({ id: entryId(i) }),
      ),
  },
  {
    name: 'recordate: a posted voucher moved to the right year',
    call: (i) =>
      recordatePOST(
        createMockRequest(`/api/bookkeeping/journal-entries/${entryId(i)}/recordate`, { method: 'POST', body: { new_entry_date: '2025-04-14' } }),
        createMockRouteParams({ id: entryId(i) }),
      ),
  },
  {
    name: 'recordate: the storno service refuses the move',
    refuse: true,
    call: (i) =>
      recordatePOST(
        createMockRequest(`/api/bookkeeping/journal-entries/${entryId(i)}/recordate`, {
          method: 'POST',
          body: { new_entry_date: '2025-04-15', allow_deep_chain: true },
        }),
        createMockRouteParams({ id: entryId(i) }),
      ),
  },
]

function record(args: unknown[]): unknown[] {
  const recorded = args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))
  while (recorded.length > 0 && recorded[recorded.length - 1] === '<undefined>') recorded.pop()
  return [recorded.length, ...recorded]
}

interface Run {
  name: string
  calls: Record<string, unknown[][]>
  outcome: { status: number; error: unknown }
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function posted(id: string, extra: Record<string, unknown> = {}) {
  return { id, status: 'posted', voucher_series: 'A', voucher_number: 7, ...extra }
}

function arm(index: number, refuse: boolean): void {
  for (const fn of Object.values(ENGINE)) fn.mockReset()
  const id = entryId(index)
  ENGINE.createJournalEntry.mockImplementation(async () => {
    if (refuse) throw new AccountsNotInChartError(['6110'])
    return posted(id) as never
  })
  ENGINE.createDraftEntry.mockImplementation(async () => {
    if (refuse) throw new AccountsNotInChartError(['6110'])
    return { id, status: 'draft', voucher_series: 'B', voucher_number: 0 } as never
  })
  ENGINE.commitEntry.mockImplementation(async () => posted(id) as never)
  ENGINE.reverseEntry.mockImplementation(async () => {
    if (refuse) throw new CannotReverseNonPostedError('reversed')
    return posted(`storno-${id}`, { reverses_id: id }) as never
  })
  ENGINE.correctEntry.mockImplementation(async () => {
    if (refuse) throw new MeaninglessCorrectionError('identical_to_original')
    return { reversal: posted(`storno-${id}`), corrected: posted(`correction-${id}`) } as never
  })
  ENGINE.recordateEntry.mockImplementation(async () => {
    if (refuse) throw new MeaninglessCorrectionError('no_date_change')
    return { reversal: posted(`storno-${id}`), corrected: posted(`correction-${id}`, { entry_date: '2025-04-14' }) } as never
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    arm(index, s.refuse === true)
    const mock = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      company_members: { data: { company_id: '00000000-0000-4000-8000-00000000c001', role: 'owner' } },
    })
    state.client = mock.supabase
    const response = await s.call(index)
    const text = await response.text()
    let error: unknown = null
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      error = typeof parsed.error === 'string' ? parsed.error : ((parsed.error as { code?: string } | undefined)?.code ?? null)
    } catch {
      error = text
    }
    const calls: Record<string, unknown[][]> = {}
    for (const [name, fn] of Object.entries(ENGINE)) {
      if (fn.mock.calls.length > 0) calls[name] = fn.mock.calls.map((c) => record(c as unknown[]))
    }
    out.push({
      name: s.name,
      calls,
      outcome: { status: response.status, error },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('dashboard voucher doors engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine and the storno service exactly what they got before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, outcome }) => ({ name, calls, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })
  it('with POSTING_EVENTS=shadow calls the engine the same, plus only one event link per new verifikat', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(callsWithoutEventLinks(run.calls), run.name).toEqual(before.calls)
      const links = Object.values(run.calls).flat().flatMap(eventLinksOf)
      expect(links.map((l) => l.id), run.name).toEqual(run.events.map((e) => e.id))
      for (const [j, link] of links.entries()) {
        expect(link, run.name).toEqual({ id: run.events[j]!.id, role: roleForKind(run.events[j]!.kind), onFailure: 'log' })
      }
    }
    const count = (name: string) => shadow.find((r) => r.name === name)!.events.length
    expect(count('commit: a draft posted from the draft list')).toBe(0)
    expect(count('create: saved as a draft')).toBe(1)
    expect(count('reverse: a posted voucher reversed')).toBe(1)
    expect(count('correct: a posted voucher corrected with new lines and its own text')).toBe(2)
    expect(count('recordate: a posted voucher moved to the right year')).toBe(2)
  })

  it('with POSTING_EVENTS=shadow a refused event write still books, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ name, calls, outcome }) => ({ name, calls, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops every door that records one before the engine', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const [i, run] of refused.entries()) {
      if (run.name.startsWith('commit:')) {
        // A draft's commit records nothing, so nothing can be refused.
        expect({ calls: run.calls, outcome: run.outcome }, run.name).toEqual({ calls: off[i]!.calls, outcome: off[i]!.outcome })
        continue
      }
      expect(run.calls, run.name).toEqual({})
      expect(run.outcome.status, run.name).toBeGreaterThanOrEqual(400)
    }
  })

  it('records what happened in business terms: the person\'s own voucher, storno and correction', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const events = (name: string) => runs.find((r) => r.name === name)!.events
    const today = /^\d{4}-\d{2}-\d{2}$/
    const common = { category: null, party_type: null, party_id: null, amount: null, currency: null, mapping_version: null, jurisdiction: 'SE', actor_type: 'user' }
    expect(events('create: a manual voucher posted from the form')).toEqual([
      expect.objectContaining({ ...common, kind: 'ledger.manual', occurred_on: '2026-04-14', subject_type: null, subject_id: null, evidence: { link_basis: 'user_created' } }),
    ])
    expect(events('create: a momsredovisning booked from its template (vat_settlement)')).toEqual([
      expect.objectContaining({ ...common, kind: 'vat.settled', occurred_on: '2026-04-14' }),
    ])
    expect(events('create: saved as a draft')).toEqual([expect.objectContaining({ ...common, kind: 'ledger.manual' })])
    const reversed = events('reverse: a posted voucher reversed')
    expect(reversed).toEqual([
      expect.objectContaining({ ...common, kind: 'ledger.storno', subject_type: 'journal_entry', subject_id: entryId(6), evidence: { link_basis: 'user_created' } }),
    ])
    expect(reversed[0]!.occurred_on).toMatch(today)
    const corrected = events('correct: a posted voucher corrected with new lines and its own text')
    expect(corrected).toEqual([
      expect.objectContaining({ ...common, kind: 'ledger.storno', subject_type: 'journal_entry', subject_id: entryId(9) }),
      expect.objectContaining({ ...common, kind: 'ledger.correction', subject_type: 'journal_entry', subject_id: entryId(9) }),
    ])
    expect(events('recordate: a posted voucher moved to the right year').map((e) => e.kind)).toEqual(['ledger.storno', 'ledger.correction'])
  })
})
