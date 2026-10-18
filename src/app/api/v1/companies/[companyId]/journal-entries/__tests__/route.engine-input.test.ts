/**
 * Posting port, step 2i: what the v1 voucher doors hand the engine and the
 * storno service on an API key, recorded call by call and compared with a
 * committed fixture (route.engine-input.json) that was taken before the doors
 * went through the port:
 *
 *   POST /api/v1/companies/{companyId}/journal-entries              createDraftEntry
 *   POST .../journal-entries/batch-create                            createDraftEntry per item
 *   POST .../journal-entries/{id}/commit                             commitEntry
 *   POST .../journal-entries/{id}/reverse                            reverseEntry
 *   POST .../journal-entries/{id}/correct                            correctEntry
 *   POST .../journal-entries/{id}/redate (operation journal-entries.redate)  recordateEntry
 *
 * Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run 'src/app/api/v1/companies/[companyId]/journal-entries/__tests__/route.engine-input.test.ts'
 *
 * Since the doors go through the posting port, the scenarios also run with
 * POSTING_EVENTS=shadow and strict, as the dashboard doors' twin test does;
 * on a key every event records client_asserted and the api_key actor.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { callsWithoutEventLinks, eventLinksOf, roleForKind } from '@/tests/engine-input'

const state = vi.hoisted(() => ({ client: null as unknown }))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn(() => state.client) }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/api/v1/owns-fiscal-period', () => ({ ownsFiscalPeriod: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }) }))
vi.mock('@/lib/core/bookkeeping/storno-target', () => ({
  assertStornoTarget: vi.fn(async (_sb: unknown, _c: unknown, original: { entry_date: string }, date?: string) => date ?? original.entry_date),
}))
vi.mock('@/lib/core/bookkeeping/correction-chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/correction-chain')>()),
  correctionChainDepth: vi.fn().mockResolvedValue({ depth: 0, rootVoucher: null }),
}))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/core/bookkeeping/storno-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/storno-service')>()),
  correctEntry: vi.fn(),
  recordateEntry: vi.fn(),
}))

const { validateApiKey } = await import('@/lib/auth/api-keys')
const { createDraftEntry, commitEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { correctEntry, recordateEntry } = await import('@/lib/core/bookkeeping/storno-service')
const { AccountsNotInChartError, CannotReverseNonPostedError, MeaninglessCorrectionError } = await import('@/lib/bookkeeping/errors')
const { POST: createPOST } = await import('../route')
const { POST: batchPOST } = await import('../batch-create/route')
const { POST: commitPOST } = await import('../[id]/commit/route')
const { POST: reversePOST } = await import('../[id]/reverse/route')
const { POST: correctPOST } = await import('../[id]/correct/route')
const { POST: redatePOST } = await import('../[id]/redate/route')

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'

const ENGINE = {
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
  { account_number: '6570', debit_amount: 50, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 50 },
]

function entry(extra: Record<string, unknown> = {}) {
  return { fiscal_period_id: PERIOD, entry_date: '2026-05-12', description: 'Bankavgift maj 2026', lines: LINES, ...extra }
}

let idempotency = 0

function v1(pathname: string, body?: unknown): Request {
  return new Request(`https://x.test/api/v1/companies/${COMPANY}/journal-entries${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': `engine-input-v1-vouchers-${++idempotency}-${Date.now()}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function params(id?: string) {
  return { params: Promise.resolve(id ? { companyId: COMPANY, id } : { companyId: COMPANY }) } as never
}

interface Scenario {
  name: string
  call: (index: number) => Promise<Response>
  /** What journal_entries answers the door's pre-flight read with. */
  existing?: 'draft' | 'posted'
  /** The engine or storno service refuses. */
  refuse?: boolean
}

const SCENARIOS: Scenario[] = [
  { name: 'create: a manual draft', call: () => createPOST(v1('', entry({ notes: 'Från bankens avgiftsavi' })), params()) },
  {
    name: 'create: a draft an integration labels as its own (webshop_order)',
    call: () => createPOST(v1('', entry({ description: 'Order 1001', source_type: 'webshop_order', source_id: 'shop-1001' })), params()),
  },
  { name: 'create: the engine refuses the draft', refuse: true, call: () => createPOST(v1('', entry()), params()) },
  {
    name: 'batch-create: two drafts, history replayed and a manual one',
    call: () =>
      batchPOST(
        v1('/batch-create', {
          journal_entries: [
            entry({ description: 'Historik 2025-12', entry_date: '2026-01-02', source_type: 'import' }),
            entry({ description: 'Bankavgift juni', entry_date: '2026-06-01', voucher_series: 'B' }),
          ],
        }),
        params(),
      ),
  },
  {
    name: 'batch-create: the engine refuses one draft of two',
    refuse: true,
    call: () => batchPOST(v1('/batch-create', { journal_entries: [entry(), entry({ description: 'Andra' })] }), params()),
  },
  { name: 'commit: a draft posted', existing: 'draft', call: (i) => commitPOST(v1(`/${entryId(i)}/commit`), params(entryId(i))) },
  { name: 'reverse: a posted voucher reversed on its own date', existing: 'posted', call: (i) => reversePOST(v1(`/${entryId(i)}/reverse`), params(entryId(i))) },
  {
    name: 'reverse: on a date inside the year, deep in a chain',
    existing: 'posted',
    call: (i) => reversePOST(v1(`/${entryId(i)}/reverse`, { reversal_date: '2026-05-31', allow_deep_chain: true }), params(entryId(i))),
  },
  {
    name: 'reverse: the engine refuses the storno',
    existing: 'posted',
    refuse: true,
    call: (i) => reversePOST(v1(`/${entryId(i)}/reverse`), params(entryId(i))),
  },
  {
    name: 'correct: new lines and text',
    existing: 'posted',
    call: (i) =>
      correctPOST(
        v1(`/${entryId(i)}/correct`, {
          description: 'Rättelse: kortavgift',
          lines: [
            { account_number: '6064', debit_amount: 50, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 50 },
          ],
        }),
        params(entryId(i)),
      ),
  },
  {
    name: 'correct: the storno service refuses',
    existing: 'posted',
    refuse: true,
    call: (i) => correctPOST(v1(`/${entryId(i)}/correct`, { lines: LINES, allow_deep_chain: true }), params(entryId(i))),
  },
  {
    name: 'redate: moved to another date',
    call: (i) => redatePOST(v1(`/${entryId(i)}/redate`, { new_entry_date: '2026-04-30' }), params(entryId(i))),
  },
  {
    name: 'redate: the storno service refuses',
    refuse: true,
    call: (i) => redatePOST(v1(`/${entryId(i)}/redate`, { new_entry_date: '2026-04-29', allow_deep_chain: true }), params(entryId(i))),
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
  outcome: { status: number; body: unknown }
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function posted(id: string, extra: Record<string, unknown> = {}) {
  return { id, status: 'posted', voucher_series: 'A', voucher_number: 7, entry_date: '2026-05-12', fiscal_period_id: PERIOD, ...extra }
}

function arm(index: number, refuse: boolean): void {
  for (const fn of Object.values(ENGINE)) fn.mockReset()
  const id = entryId(index)
  let draft = 0
  ENGINE.createDraftEntry.mockImplementation(async () => {
    draft++
    if (refuse && draft === 1) throw new AccountsNotInChartError(['6570'])
    return { id: `${id}-${draft}`, status: 'draft', voucher_series: 'A', voucher_number: 0 } as never
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
    return { reversal: posted(`storno-${id}`), corrected: posted(`correction-${id}`, { entry_date: '2026-04-30' }) } as never
  })
}

/** The response body without what changes per run (request ids, timestamps). */
function stable(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const { meta: _meta, ...rest } = body as Record<string, unknown>
  const error = rest.error as Record<string, unknown> | undefined
  if (error && typeof error === 'object') return { error: { code: error.code } }
  return rest
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    arm(index, s.refuse === true)
    const existing = s.existing
      ? {
          id: entryId(index),
          status: s.existing,
          entry_date: '2026-05-12',
          fiscal_period_id: PERIOD,
          voucher_series: 'A',
          voucher_number: s.existing === 'posted' ? 7 : 0,
          reversed_by_id: null,
          correction_of_id: null,
          reverses_id: null,
        }
      : null
    const mock = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      company_members: { data: { company_id: COMPANY, role: 'owner' } },
      journal_entries: { data: existing },
    })
    state.client = mock.supabase
    const response = await s.call(index)
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // not JSON
    }
    const calls: Record<string, unknown[][]> = {}
    for (const [name, fn] of Object.entries(ENGINE)) {
      if (fn.mock.calls.length > 0) calls[name] = fn.mock.calls.map((c) => record(c as unknown[]))
    }
    out.push({
      name: s.name,
      calls,
      outcome: { status: response.status, body: stable(body) },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('v1 voucher doors engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
    vi.mocked(validateApiKey).mockResolvedValue({
      userId: USER,
      companyId: COMPANY,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['bookkeeping:read', 'bookkeeping:write'],
      mode: 'live',
    } as never)
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
    expect(count('commit: a draft posted')).toBe(0)
    expect(count('batch-create: two drafts, history replayed and a manual one')).toBe(2)
    expect(count('correct: new lines and text')).toBe(2)
    expect(count('redate: moved to another date')).toBe(2)
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
        expect({ calls: run.calls, outcome: run.outcome }, run.name).toEqual({ calls: off[i]!.calls, outcome: off[i]!.outcome })
        continue
      }
      expect(run.calls, run.name).toEqual({})
      // batch-create answers per item: every item failed, none drafted.
      if (run.name.startsWith('batch-create:')) {
        const body = run.outcome.body as { data: { summary: { succeeded: number } } }
        expect(body.data.summary.succeeded, run.name).toBe(0)
      } else {
        expect(run.outcome.status, run.name).toBeGreaterThanOrEqual(400)
      }
    }
  })

  it('records what happened in business terms: the caller\'s own voucher, storno and correction, asserted on a key', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const events = (name: string) => runs.find((r) => r.name === name)!.events
    const common = { category: null, party_type: null, amount: null, mapping_version: null, jurisdiction: 'SE', actor_type: 'api_key', evidence: { link_basis: 'client_asserted' } }
    expect(events('create: a manual draft')).toEqual([
      expect.objectContaining({ ...common, kind: 'ledger.manual', occurred_on: '2026-05-12', subject_type: null }),
    ])
    // An integration's own label names its kind, as the projection reads the verifikat.
    expect(events('create: a draft an integration labels as its own (webshop_order)')).toEqual([
      expect.objectContaining({ ...common, kind: 'sale.webshop_order' }),
    ])
    expect(events('batch-create: two drafts, history replayed and a manual one').map((e) => [e.kind, e.occurred_on])).toEqual([
      ['ledger.history_import', '2026-01-02'],
      ['ledger.manual', '2026-06-01'],
    ])
    expect(events('reverse: a posted voucher reversed on its own date')).toEqual([
      expect.objectContaining({ ...common, kind: 'ledger.storno', subject_type: 'journal_entry', subject_id: entryId(6) }),
    ])
    expect(events('correct: new lines and text')).toEqual([
      expect.objectContaining({ ...common, kind: 'ledger.storno', subject_id: entryId(9) }),
      expect.objectContaining({ ...common, kind: 'ledger.correction', subject_id: entryId(9) }),
    ])
    expect(events('redate: moved to another date')).toEqual([
      expect.objectContaining({ ...common, kind: 'ledger.storno', subject_id: entryId(11) }),
      expect.objectContaining({ ...common, kind: 'ledger.correction', subject_id: entryId(11) }),
    ])
  })
})
