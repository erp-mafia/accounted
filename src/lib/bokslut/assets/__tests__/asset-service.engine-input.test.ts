/**
 * Posting port, step 2b: what disposeAsset hands the engine, recorded call by
 * call and compared with a committed fixture (asset-service.engine-input.json)
 * that was taken before the producer went through the port. The disposal is
 * drafted (createDraftEntry) and committed together with the register update
 * by commit_asset_disposal (commitAssetDisposal); both engine calls are
 * recorded with every argument, an absent one as '<undefined>', so an extra
 * argument or a changed input fails here.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bokslut/assets/__tests__/asset-service.engine-input.test.ts
 *
 * Since the producer drafts through the posting port (draftJournalEntry),
 * the scenarios also run with POSTING_EVENTS=shadow: the draft must get the
 * same four arguments plus only the event link, commitAssetDisposal exactly
 * the same arguments, and a refused event write must still post. A disposal
 * that books nothing drafts nothing and records no event.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Asset } from '@/types'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: vi.fn(),
  commitAssetDisposal: vi.fn(),
}))

const { createDraftEntry, commitAssetDisposal } = await import('@/lib/bookkeeping/engine')
const { disposeAsset } = await import('../asset-service')
const { runInOperationCommit } = await import('@/lib/pending-operations/commit-scope')
type DisposeInput = Parameters<typeof disposeAsset>[4]

const mockedDraft = vi.mocked(createDraftEntry)
const mockedCommit = vi.mocked(commitAssetDisposal)

const FIXTURE = path.join(__dirname, 'asset-service.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const FISCAL_PERIOD = '00000000-0000-4000-8000-00000000f001'

function asset(index: number, overrides: Partial<Asset>): Asset {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    user_id: USER,
    company_id: COMPANY,
    name: 'Lastbil',
    category: 'equipment',
    acquisition_date: '2026-01-01',
    acquisition_cost: 60000,
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
  asset: Asset
  input: Omit<DisposeInput, 'fiscal_period_id'>
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a sale with 25 % moms, depreciated to the disposal day',
    asset: asset(0, {}),
    input: { disposal_type: 'sale', disposed_at: '2026-06-30', disposed_proceeds: 50000, vat_treatment: 'standard_25' },
  },
  {
    name: 'scrapped (utrangering)',
    asset: asset(1, { name: 'Kopiator', acquisition_date: '2026-02-01', acquisition_cost: 30000, useful_life_months: 36 }),
    input: { disposal_type: 'scrap', disposed_at: '2026-09-30', disposed_proceeds: 0 },
  },
  {
    name: 'a sale of a K3 asset with components, to another proceeds account, at a gain',
    asset: asset(2, {
      name: 'Produktionslinje',
      category: 'machinery',
      acquisition_cost: 120000,
      useful_life_months: 120,
      bas_asset_account: '1210',
      bas_accumulated_account: '1219',
      bas_expense_account: '7831',
      k3_components: [
        { name: 'Stomme', cost: 80000, useful_life_months: 180 },
        { name: 'Styrsystem', cost: 40000, useful_life_months: 60 },
      ],
    } as Partial<Asset>),
    input: { disposal_type: 'sale', disposed_at: '2026-03-31', disposed_proceeds: 150000, proceeds_account: '1940', vat_treatment: 'standard_25' },
  },
  {
    name: 'a moms-free sale of an investeringsvara inside its adjustment period (jämkning)',
    asset: asset(3, { name: 'Lager-maskin', acquisition_date: '2025-01-15', acquisition_cost: 250000, useful_life_months: 60 }),
    input: {
      disposal_type: 'sale',
      disposed_at: '2026-05-31',
      disposed_proceeds: 180000,
      vat_treatment: 'exempt',
      jamkning_original_input_vat: 62500,
      jamkning_original_deduction_percent: 100,
    },
  },
  {
    name: 'a fully written-off asset scrapped for nothing: no verifikat',
    asset: asset(4, { name: 'Gammal skärm', acquisition_cost: 0, useful_life_months: 36 }),
    input: { disposal_type: 'scrap', disposed_at: '2026-04-30', disposed_proceeds: 0 },
  },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Run {
  name: string
  createDraftEntry: unknown[][]
  commitAssetDisposal: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean; operationId?: string } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedDraft.mockReset()
    mockedCommit.mockReset()
    mockedDraft.mockImplementation(async (_sb, _c, _u, input) => ({ id: `je-${index}`, status: 'draft', ...input }) as never)
    mockedCommit.mockImplementation(async (_sb, _c, _u, entryId) => (entryId ? { id: entryId, status: 'posted' } : null) as never)
    const { supabase, payloads } = createTableMockSupabase({
      assets: { data: s.asset },
      fiscal_periods: { data: [{ id: FISCAL_PERIOD, period_start: '2026-01-01', period_end: '2026-12-31' }] },
      depreciation_schedules: { data: [] },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const dispose = () => disposeAsset(supabase as never, COMPANY, USER, s.asset.id, { ...s.input, fiscal_period_id: FISCAL_PERIOD })
    if (opts.operationId) await runInOperationCommit(opts.operationId, dispose)
    else await dispose()
    out.push({
      name: s.name,
      createDraftEntry: mockedDraft.mock.calls.map((c) => record(c as unknown[])),
      commitAssetDisposal: mockedCommit.mock.calls.map((c) => record(c as unknown[])),
      events: payloads('business_events', 'insert') as Array<Record<string, unknown>>,
    })
  }
  return out
}

describe('disposeAsset engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, createDraftEntry: draft, commitAssetDisposal: commit }) => ({
      name,
      createDraftEntry: draft,
      commitAssetDisposal: commit,
    }))
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
        expect(before.createDraftEntry[j]![0]).toBe(4)
        expect(call[0], run.name).toBe(5)
        expect(call.slice(1, 5), run.name).toEqual(before.createDraftEntry[j]!.slice(1, 5))
        expect(call[5], run.name).toEqual({ businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' } })
        expect((call[5] as { businessEvent: { id: string } }).businessEvent.id).toBe(run.events[j]!.id)
      }
      expect(run.commitAssetDisposal, run.name).toEqual(before.commitAssetDisposal)
      // One event per verifikat: none for the disposal that books nothing.
      expect(run.events, run.name).toHaveLength(run.createDraftEntry.length)
    }
    expect(shadow.at(-1)!.events).toEqual([])
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off calls', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => [r.createDraftEntry, r.commitAssetDisposal])).toEqual(
      off.map((r) => [r.createDraftEntry, r.commitAssetDisposal]),
    )
    expect(refused.map((r) => r.events.length)).toEqual(refused.map((r) => r.createDraftEntry.length))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name === name)!.events[0]!
    expect(event('a sale with 25 % moms, depreciated to the disposal day')).toMatchObject({
      kind: 'asset.disposed',
      category: null,
      occurred_on: '2026-06-30',
      subject_type: 'asset',
      subject_id: '00000000-0000-4000-8000-000000000001',
      party_type: null,
      currency: 'SEK',
      amount: 50000,
      amount_sek: 50000,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 10000 }],
      evidence: { direction: 'in', link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('a sale with 25 % moms, depreciated to the disposal day').mapping_version).toMatch(/^se\.asset-disposal@/)
    // A scrapping brings no money in: amount 0, no direction, no moms.
    expect(event('scrapped (utrangering)')).toMatchObject({ kind: 'asset.disposed', amount: 0, tax_amounts: [], evidence: { link_basis: 'user_created' } })
    expect(event('scrapped (utrangering)').evidence).not.toHaveProperty('direction')
    expect(event('a moms-free sale of an investeringsvara inside its adjustment period (jämkning)')).toMatchObject({
      amount: 180000,
      tax_amounts: [],
      evidence: { direction: 'in' },
    })
  })

  it('names the staged operation inside its approval', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const operationId = '00000000-0000-4000-8000-0000000a0b02'
    const runs = await runScenarios({ operationId })
    for (const event of runs.flatMap((r) => r.events)) {
      expect(event).toMatchObject({
        pending_operation_id: operationId,
        evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: operationId } },
      })
    }
  })
})
