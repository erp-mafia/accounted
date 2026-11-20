/**
 * Posting port, step 2i: what the compensation of a verifikat a door could
 * not keep (reverseOrphanedJournalEntry, src/lib/bookkeeping/cancel-orphaned-entry.ts)
 * hands the engine, recorded call by call and compared with a committed
 * fixture (cancel-orphaned-entry.engine-input.json) that was taken before
 * its last direct engine call went through the port. A caller without its
 * own storno event (the bank-line categorization of lib/transactions,
 * create_voucher's lost inbox claim) reversed the verifikat with the engine
 * directly; one with an event (step 2e) already went through the port.
 *
 * Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bookkeeping/__tests__/cancel-orphaned-entry.engine-input.test.ts
 *
 * Since every compensation storno goes through the posting port, the
 * scenarios also run with POSTING_EVENTS=shadow and strict: the off call plus
 * only the event link (the door's event, or ledger.storno of the verifikat
 * reversed, system_derived), a refused event write still reverses under
 * shadow, and under strict the compensation stops before the engine (and
 * documents no gap: no number was drawn).
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { eventLinksOf, withoutEventLinks } from '@/tests/engine-input'
import type { BusinessEventDraft } from '@/lib/posting/types'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  reverseEntry: vi.fn(),
}))

const { reverseEntry } = await import('@/lib/bookkeeping/engine')
const { CannotReverseNonPostedError } = await import('@/lib/bookkeeping/errors')
const { reverseOrphanedJournalEntry } = await import('../cancel-orphaned-entry')

const FIXTURE = path.join(__dirname, 'cancel-orphaned-entry.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const mockedReverse = vi.mocked(reverseEntry)

function entryId(index: number): string {
  return `00000000-0000-4000-8000-0000000e${String(index + 1).padStart(4, '0')}`
}

const DOOR_EVENT = (): BusinessEventDraft => ({
  kind: 'ledger.storno',
  occurredOn: '2026-03-20',
  subject: { type: 'transaction', id: '00000000-0000-4000-8000-00000000b001' },
  evidence: { link_basis: 'system_derived' },
  jurisdiction: 'SE',
})

interface Scenario {
  name: string
  withEvent: boolean
  refuse?: boolean
}

const SCENARIOS: Scenario[] = [
  { name: 'a caller without its own storno event', withEvent: false },
  { name: 'a caller that hands down its storno event', withEvent: true },
  { name: 'the engine refuses the storno of a caller without an event', withEvent: false, refuse: true },
]

function record(args: unknown[]): unknown[] {
  const recorded = args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))
  while (recorded.length > 0 && recorded[recorded.length - 1] === '<undefined>') recorded.pop()
  return [recorded.length, ...recorded]
}

interface Run {
  name: string
  reversals: unknown[][]
  gapExplanations: unknown[]
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedReverse.mockReset()
    mockedReverse.mockImplementation(async (_sb, _c, _u, id: string) => {
      if (s.refuse) throw new CannotReverseNonPostedError('reversed')
      return { id: `storno-${id}`, status: 'posted' } as never
    })
    const mock = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    await reverseOrphanedJournalEntry(
      mock.supabase as never,
      COMPANY,
      USER,
      entryId(index),
      'Verifikation som inte kunde kopplas; automatisk storno.',
      ...(s.withEvent ? [DOOR_EVENT] : []),
    )
    out.push({
      name: s.name,
      reversals: mockedReverse.mock.calls.map((c) => record(c as unknown[])),
      gapExplanations: mock.payloads('voucher_gap_explanations', 'insert'),
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('orphaned verifikat compensation engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine exactly what it got before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, reversals, gapExplanations }) => ({ name, reversals, gapExplanations }))
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
      expect(run.gapExplanations, run.name).toEqual(off[i]!.gapExplanations)
      expect(run.reversals.map(withoutEventLinks), run.name).toEqual(off[i]!.reversals)
      expect(run.reversals.flatMap(eventLinksOf), run.name).toEqual(run.events.map((e) => ({ id: e.id, role: 'reversal', onFailure: 'log' })))
      expect(run.events, run.name).toHaveLength(1)
    }
    // Without a door's event: ledger.storno of the verifikat reversed, nobody chose it.
    expect(shadow[0]!.events[0]).toMatchObject({
      kind: 'ledger.storno',
      subject_type: 'journal_entry',
      subject_id: entryId(0),
      evidence: { link_basis: 'system_derived' },
    })
    expect(shadow[1]!.events[0]).toMatchObject({ kind: 'ledger.storno', subject_type: 'transaction' })
  })

  it('with POSTING_EVENTS=shadow a refused event write still reverses, with exactly the off call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ name, reversals, gapExplanations }) => ({ name, reversals, gapExplanations }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the compensation before the engine, no gap documented', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.reversals, run.name).toEqual([])
      expect(run.gapExplanations, run.name).toEqual([])
    }
  })
})
