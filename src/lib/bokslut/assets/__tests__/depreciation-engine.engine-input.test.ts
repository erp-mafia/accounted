/**
 * Posting port, step 2b: what commitAnnualPostings hands the engine, recorded
 * call by call and compared with a committed fixture
 * (depreciation-engine.engine-input.json) that was taken before the producer
 * went through the port. Each asset's planenlig avskrivning is one call of
 * createAssetDepreciationEntry: the voucher input (drafted) and the register
 * link (committed with it by commit_asset_depreciation). Every argument is
 * recorded, an absent one as '<undefined>', so an extra argument or a changed
 * input fails here.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bokslut/assets/__tests__/depreciation-engine.engine-input.test.ts
 *
 * Since the move the producer makes the two calls createAssetDepreciationEntry
 * made inside the engine itself: the draft through the posting port
 * (draftJournalEntry, createDraftEntry with the same four arguments) and the
 * commit through commitAssetDepreciation (the same RPC with the same link).
 * Each posting's two calls are put back together into the fixture's one call
 * (asFixtureCall): the four leading arguments and the input from the draft,
 * the link from the commit, which must name the draft the engine answered.
 * The scenarios also run with POSTING_EVENTS=shadow: the draft must get the
 * same four arguments plus only the event link, the commit exactly the same
 * arguments, and a refused event write must still post.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Asset } from '@/types'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createAssetDepreciationEntry: vi.fn(),
  createDraftEntry: vi.fn(),
  commitAssetDepreciation: vi.fn(),
}))
const listed = vi.hoisted(() => ({ assets: [] as unknown[] }))
vi.mock('../asset-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../asset-service')>()),
  listAssets: vi.fn(async () => listed.assets),
}))

const { createAssetDepreciationEntry, createDraftEntry, commitAssetDepreciation } = await import('@/lib/bookkeeping/engine')
const { commitAnnualPostings } = await import('../depreciation-engine')

const mockedComposite = vi.mocked(createAssetDepreciationEntry)
const mockedDraft = vi.mocked(createDraftEntry)
const mockedCommit = vi.mocked(commitAssetDepreciation)

const FIXTURE = path.join(__dirname, 'depreciation-engine.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const FISCAL_PERIOD = '00000000-0000-4000-8000-00000000f001'

function asset(id: number, overrides: Partial<Asset>): Asset {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    user_id: USER,
    company_id: COMPANY,
    name: 'Fräsmaskin',
    category: 'equipment',
    acquisition_date: '2026-01-01',
    acquisition_cost: 100000,
    salvage_value: 0,
    useful_life_months: 60,
    depreciation_method: 'linear',
    bas_asset_account: '1220',
    bas_accumulated_account: '1229',
    bas_expense_account: '7832',
    restvarde_target: null,
    disposed_at: null,
    disposed_proceeds: null,
    disposal_type: null,
    disposal_journal_entry_id: null,
    disposed_proceeds_vat: 0,
    disposed_vat_treatment: null,
    jamkning_amount: 0,
    jamkning_remaining_months: null,
    jamkning_total_months: null,
    jamkning_original_input_vat: null,
    k3_components: null,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Asset
}

interface Scenario {
  name: string
  assets: Asset[]
  /** Schedule rows of the period already posted, by asset id. */
  postedInPeriod?: string[]
  assetIds?: string[]
}

const SCENARIOS: Scenario[] = [
  {
    name: 'two assets, one acquired mid-year',
    assets: [asset(1, {}), asset(2, { name: 'Server', acquisition_date: '2026-04-01', acquisition_cost: 36000, useful_life_months: 36 })],
  },
  {
    name: 'an asset that arrived partly depreciated from the previous system',
    assets: [
      asset(3, {
        name: 'Truck',
        acquisition_date: '2024-01-01',
        acquisition_cost: 240000,
        useful_life_months: 96,
        opening_accumulated_depreciation: 60000,
        opening_depreciation_date: '2025-12-31',
      } as Partial<Asset>),
    ],
  },
  {
    name: 'an asset already posted in the period is skipped, the other posted',
    assets: [asset(4, { name: 'Svetsaggregat' }), asset(5, { name: 'Kompressor', acquisition_cost: 48000, useful_life_months: 48 })],
    postedInPeriod: ['00000000-0000-4000-8000-000000000004'],
  },
  {
    name: 'only the assets the caller names',
    assets: [asset(6, { name: 'Bärbar dator', acquisition_date: '2026-07-01', acquisition_cost: 24000, useful_life_months: 48 }), asset(7, { name: 'Skrivare' })],
    assetIds: ['00000000-0000-4000-8000-000000000006'],
  },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

/** The fixture's createAssetDepreciationEntry call, from one posting's draft and commit calls (see the header). */
function asFixtureCall(draft: unknown[], commit: unknown[], draftId: string): unknown[] {
  expect(commit[0]).toBe(5)
  expect(commit.slice(1, 4)).toEqual(draft.slice(1, 4))
  expect((commit[4] as { id: string }).id).toBe(draftId)
  return [5, ...draft.slice(1, 5), commit[5]]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Run {
  name: string
  createDraftEntry: unknown[][]
  commitAssetDepreciation: unknown[][]
  /** The draft id the engine answered, per posting. */
  draftIds: string[]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedComposite.mockReset()
    mockedDraft.mockReset()
    mockedCommit.mockReset()
    listed.assets = s.assets
    const draftIds: string[] = []
    mockedDraft.mockImplementation(async (_sb, _c, _u, input) => {
      const id = `je-${index}-${draftIds.length + 1}`
      draftIds.push(id)
      return { id, status: 'draft', fiscal_period_id: input.fiscal_period_id } as never
    })
    mockedCommit.mockImplementation(async (_sb, _c, _u, draft) => ({
      entry: { id: draft.id, status: 'posted' },
      scheduleId: `sched-${draft.id}`,
    }) as never)
    const current = (s.postedInPeriod ?? []).map((assetId, n) => ({ id: `sched-old-${n}`, asset_id: assetId, journal_entry_id: `je-old-${n}` }))
    const { supabase, payloads } = createTableMockSupabase({
      fiscal_periods: { data: { id: FISCAL_PERIOD, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' } },
      // The current period's rows, then the prior periods' posted rows (none).
      depreciation_schedules: (chain) => ({ data: chain.some((c) => c.method === 'neq') ? [] : current }),
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const result = await commitAnnualPostings(supabase as never, COMPANY, USER, FISCAL_PERIOD, s.assetIds ? { assetIds: s.assetIds } : {})
    expect(result.posted.length, s.name).toBeGreaterThan(0)
    expect(result.posted.map((p) => p.entry.id), s.name).toEqual(draftIds)
    // The producer no longer asks the engine to draft and commit in one call.
    expect(mockedComposite, s.name).not.toHaveBeenCalled()
    out.push({
      name: s.name,
      createDraftEntry: mockedDraft.mock.calls.map((c) => record(c as unknown[])),
      commitAssetDepreciation: mockedCommit.mock.calls.map((c) => record(c as unknown[])),
      draftIds,
      events: payloads('business_events', 'insert') as Array<Record<string, unknown>>,
    })
  }
  return out
}

function fixtureCalls(run: Run): unknown[][] {
  expect(run.commitAssetDepreciation, run.name).toHaveLength(run.createDraftEntry.length)
  return run.createDraftEntry.map((draft, i) => {
    expect(draft[0], run.name).toBe(4)
    return asFixtureCall(draft, run.commitAssetDepreciation[i]!, run.draftIds[i]!)
  })
}

describe('commitAnnualPostings engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map((run) => ({ name: run.name, createAssetDepreciationEntry: fixtureCalls(run) }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow drafts with the same four arguments plus only the link, and commits exactly as before', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.createDraftEntry, run.name).toHaveLength(before.createDraftEntry.length)
      for (const [j, call] of run.createDraftEntry.entries()) {
        expect(call[0], run.name).toBe(5)
        expect(call.slice(1, 5), run.name).toEqual(before.createDraftEntry[j]!.slice(1, 5))
        expect(call[5], run.name).toEqual({ businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' } })
        expect((call[5] as { businessEvent: { id: string } }).businessEvent.id).toBe(run.events[j]!.id)
      }
      expect(run.commitAssetDepreciation, run.name).toEqual(before.commitAssetDepreciation)
      expect(run.events, run.name).toHaveLength(run.createDraftEntry.length)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off calls', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => [r.createDraftEntry, r.commitAssetDepreciation])).toEqual(
      off.map((r) => [r.createDraftEntry, r.commitAssetDepreciation]),
    )
    expect(refused.map((r) => r.events.length)).toEqual(refused.map((r) => r.createDraftEntry.length))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    expect(runs[0]!.events).toMatchObject([
      { subject_id: '00000000-0000-4000-8000-000000000001', amount: 20000 },
      { subject_id: '00000000-0000-4000-8000-000000000002', amount: 9041 },
    ])
    for (const event of runs.flatMap((r) => r.events)) {
      expect(event).toMatchObject({
        kind: 'asset.depreciated',
        category: null,
        occurred_on: '2026-12-31',
        subject_type: 'asset',
        party_type: null,
        currency: 'SEK',
        tax_amounts: [],
        evidence: { link_basis: 'user_created' },
        pending_operation_id: null,
        jurisdiction: 'SE',
      })
      expect(event.amount_sek).toBe(event.amount)
      expect(event.mapping_version).toMatch(/^se\.asset-depreciation@/)
    }
  })
})
