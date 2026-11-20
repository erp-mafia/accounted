/**
 * Posting port, step 2e: what the two uncategorize doors hand the engine
 * (POST /api/transactions/[id]/uncategorize and its v1 twin
 * POST /api/v1/companies/{companyId}/transactions/{id}/uncategorize),
 * recorded call by call and compared with a committed fixture
 * (route.engine-input.json) that was taken before the doors went through the
 * port. Each reverses the bank line's posted verifikat with a storno; every
 * argument of reverseEntry is recorded, an absent one as '<undefined>'.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run 'src/app/api/transactions/[id]/uncategorize/__tests__/route.engine-input.test.ts'
 *
 * Since the storno goes through the posting port (reverseJournalEntry), the
 * scenarios also run with POSTING_EVENTS=shadow and strict: reverseEntry
 * must get the same call with only the event link added, a refused event
 * write must still reverse under shadow, and under strict the doors stop
 * before the storno.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const state = vi.hoisted(() => ({ client: null as unknown }))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

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
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn(() => state.client) }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  reverseEntry: vi.fn(),
}))

const { validateApiKey } = await import('@/lib/auth/api-keys')
const { reverseEntry } = await import('@/lib/bookkeeping/engine')
const { CannotReverseNonPostedError } = await import('@/lib/bookkeeping/errors')
const { POST: sessionPOST } = await import('../route')
const { POST: v1POST } = await import('@/app/api/v1/companies/[companyId]/transactions/[id]/uncategorize/route')

const mockedReverse = vi.mocked(reverseEntry)

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'

function transactionId(index: number): string {
  return `00000000-0000-4000-8000-0000000a${String(index + 1).padStart(4, '0')}`
}

function entryId(index: number): string {
  return `00000000-0000-4000-8000-0000000e${String(index + 1).padStart(4, '0')}`
}

interface Scenario {
  name: string
  door: 'session' | 'v1'
  /** The bank line's verifikat: posted, not posted, or one the engine refuses to reverse. */
  entry: 'posted' | 'draft' | 'refused'
}

const SCENARIOS: Scenario[] = [
  { name: 'session: a categorized row has its posted verifikat reversed', door: 'session', entry: 'posted' },
  { name: 'session: a verifikat that is not posted is refused before the engine', door: 'session', entry: 'draft' },
  { name: 'session: the engine refuses the storno', door: 'session', entry: 'refused' },
  { name: 'v1: a categorized row has its posted verifikat reversed', door: 'v1', entry: 'posted' },
  { name: 'v1: a verifikat that is not posted is refused before the engine', door: 'v1', entry: 'draft' },
  { name: 'v1: the engine refuses the storno', door: 'v1', entry: 'refused' },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

interface Run {
  name: string
  reversals: unknown[][]
  resets: unknown[]
  outcome: unknown
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

let idempotency = 0

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedReverse.mockReset()
    mockedReverse.mockImplementation(async (_sb, _c, _u, id: string) => {
      if (s.entry === 'refused') throw new CannotReverseNonPostedError('reversed')
      return { id: `storno-${id}`, status: 'posted' } as never
    })
    const mock = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      company_members: { data: { company_id: COMPANY, role: 'owner' } },
      transactions: [{ data: { id: transactionId(index), journal_entry_id: entryId(index) } }, { data: null }],
      journal_entries: { data: { id: entryId(index), status: s.entry === 'draft' ? 'draft' : 'posted' } },
    })
    state.client = mock.supabase
    const response =
      s.door === 'session'
        ? await sessionPOST(
            createMockRequest(`/api/transactions/${transactionId(index)}/uncategorize`, { method: 'POST' }),
            createMockRouteParams({ id: transactionId(index) }),
          )
        : await v1POST(
            new Request(`https://x.test/api/v1/companies/${COMPANY}/transactions/${transactionId(index)}/uncategorize`, {
              method: 'POST',
              headers: {
                Authorization: 'Bearer test-fixture-not-a-real-key',
                'Idempotency-Key': `engine-input-uncategorize-${++idempotency}-${Date.now()}`,
              },
            }),
            { params: Promise.resolve({ companyId: COMPANY, id: transactionId(index) }) },
          )
    const body = (await response.json()) as { error?: unknown }
    out.push({
      name: s.name,
      reversals: mockedReverse.mock.calls.map((c) => record(c as unknown[])),
      resets: mock.payloads('transactions', 'update'),
      outcome: {
        status: response.status,
        error: typeof body.error === 'string' ? body.error : ((body.error as { code?: string } | undefined)?.code ?? null),
      },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('uncategorize engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
    vi.mocked(validateApiKey).mockResolvedValue({
      userId: USER,
      companyId: COMPANY,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['transactions:write'],
      mode: 'live',
    } as never)
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, reversals, resets, outcome }) => ({ name, reversals, resets, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow reverses with the same call, plus only the event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.resets, run.name).toEqual(before.resets)
      expect(run.reversals, run.name).toHaveLength(before.reversals.length)
      expect(run.events, run.name).toHaveLength(before.reversals.length)
      for (const [j, reversal] of run.reversals.entries()) {
        expect(before.reversals[j]![0], run.name).toBe(4)
        expect(reversal[0], run.name).toBe(6)
        expect(reversal.slice(1, 5), run.name).toEqual(before.reversals[j]!.slice(1, 5))
        expect(reversal[5], run.name).toBe('<undefined>')
        expect(reversal[6], run.name).toEqual({ businessEvent: { id: run.events[0]!.id, role: 'reversal', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still reverses, with exactly the off call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ reversals, resets, outcome }) => ({ reversals, resets, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the uncategorize before the storno', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.reversals, run.name).toEqual([])
      expect(run.resets, run.name).toEqual([])
      expect((run.outcome as { status: number }).status, run.name).toBeGreaterThanOrEqual(400)
    }
  })

  it('records what happened in business terms: a storno of the bank line, asked for by the caller', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name === name)!.events[0]!
    const storno = {
      kind: 'ledger.storno',
      category: null,
      subject_type: 'transaction',
      party_type: null,
      party_id: null,
      currency: null,
      amount: null,
      amount_sek: null,
      tax_amounts: [],
      mapping_version: null,
      jurisdiction: 'SE',
      idempotency_key: null,
    }
    expect(event('session: a categorized row has its posted verifikat reversed')).toMatchObject({
      ...storno,
      subject_id: transactionId(0),
      evidence: { link_basis: 'user_created' },
    })
    // On an API key the caller's request is client_asserted.
    expect(event('v1: a categorized row has its posted verifikat reversed')).toMatchObject({
      ...storno,
      subject_id: transactionId(3),
      evidence: { link_basis: 'client_asserted' },
    })
    expect(event('session: a categorized row has its posted verifikat reversed').occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
