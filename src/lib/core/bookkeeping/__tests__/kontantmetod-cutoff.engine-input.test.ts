/**
 * Posting port, step 2g: what postKontantmetodCutoff hands the engine,
 * recorded call by call and compared with a committed fixture
 * (kontantmetod-cutoff.engine-input.json) that was taken before the producer
 * went through the port: the cut-off verifikat and their vändningar, and the
 * stornos it makes when a vändning, or the marker that records one, fails.
 * Every argument of createJournalEntry and reverseEntry is recorded, an
 * absent one as '<undefined>', so an extra argument or a changed input fails
 * here, and so does a changed order of the calls.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/core/bookkeeping/__tests__/kontantmetod-cutoff.engine-input.test.ts
 *
 * Since the producer posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow, with the link basis its only door (the staged
 * operation's executor) hands down: the engine must get the same arguments
 * plus only the event link, one event per verifikat and per storno, and a
 * refused event write must still post. Trailing undefined arguments (the
 * ledger adapter's commitMethod and rubricVersion positions) are dropped
 * before the comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'
import type { CutoffPayable, CutoffReceivable } from '../kontantmetod-cutoff'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))

const { createJournalEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { postKontantmetodCutoff, KontantmetodCutoffPartialError } = await import('../kontantmetod-cutoff')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedReverse = vi.mocked(reverseEntry)

const FIXTURE = path.join(__dirname, 'kontantmetod-cutoff.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const NEXT_PERIOD = '00000000-0000-4000-8000-00000000f002'
const OPERATION = '00000000-0000-4000-8000-0000000c0001'
/** What the staged executor hands down: the approval being committed. */
const STAGED = { link_basis: 'agent_proposed_user_approved' as const, link_evidence: { pending_operation_id: OPERATION } }

type Chain = Array<{ method: string; args: unknown[] }>

const RECEIVABLES: CutoffReceivable[] = [
  { id: 'inv-1', reference: 'F-10', vatTreatment: 'standard_25', outstanding: 10000, vat: 2000 },
  { id: 'inv-2', reference: 'F-11', vatTreatment: 'reduced_12', outstanding: 1120, vat: 120 },
  { id: 'inv-3', reference: 'F-12', vatTreatment: 'export', outstanding: 5000, vat: 0 },
]

const PAYABLES: CutoffPayable[] = [
  { id: 'si-1', reference: 'L-1', outstanding: 2500, vat: 500, netByAccount: [{ account: '4010', amount: 2000 }] },
  {
    id: 'si-2',
    reference: 'L-2',
    outstanding: 1000,
    vat: 0,
    reverseCharge: true,
    reverseChargeGroups: [{ rate: 0.25, base: 1000, nonBasisBase: 0, supplierType: 'eu_business' }],
    netByAccount: [{ account: '6540', amount: 1000 }],
  },
]

interface Scenario {
  name: string
  receivables: CutoffReceivable[]
  payables: CutoffPayable[]
  entityType: 'enskild_firma' | 'aktiebolag'
  /** A verifikat description whose posting the engine refuses. */
  refusePosting?: string
  /** A marker kind whose insert the database refuses. */
  refuseMarker?: string
  /** The scenario ends in KontantmetodCutoffPartialError. */
  partial?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'fordringar and skulder, each cut off at the year end and reversed on the first day of the next',
    receivables: RECEIVABLES,
    payables: PAYABLES,
    entityType: 'enskild_firma',
  },
  {
    name: 'fordringar only, for an aktiebolag on kontantmetoden',
    receivables: RECEIVABLES.slice(0, 1),
    payables: [],
    entityType: 'aktiebolag',
  },
  {
    name: 'the vändning of the skulder refused: their cut-off stornoed on the year end, the fordringar pair stands',
    receivables: RECEIVABLES.slice(0, 1),
    payables: PAYABLES.slice(0, 1),
    entityType: 'enskild_firma',
    refusePosting: 'Vändning leverantörsskulder bokslut (kontantmetoden)',
    partial: true,
  },
  {
    name: 'the vändning of the fordringar not marked: the vändning stornoed on its own date, then the cut-off',
    receivables: RECEIVABLES.slice(0, 1),
    payables: [],
    entityType: 'enskild_firma',
    refuseMarker: 'receivable_reversal',
    partial: true,
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
  /** Every engine call in order: ['createJournalEntry', ...args] or ['reverseEntry', ...args]. */
  calls: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const s of SCENARIOS) {
    mockedCreate.mockReset()
    mockedReverse.mockReset()
    const calls: unknown[][] = []
    let n = 0
    mockedCreate.mockImplementation(async (...args: unknown[]) => {
      calls.push(['createJournalEntry', ...record(args)])
      const input = args[3] as CreateJournalEntryInput
      if (input.description === s.refusePosting) throw new Error('pg: posting refused')
      n++
      return { id: `je-${n}`, voucher_series: 'I', voucher_number: n, entry_date: input.entry_date } as never
    })
    mockedReverse.mockImplementation(async (...args: unknown[]) => {
      calls.push(['reverseEntry', ...record(args)])
      n++
      return { id: `je-${n}`, voucher_series: 'I', voucher_number: n } as never
    })
    const { supabase, payloads } = createTableMockSupabase({
      fiscal_periods: {
        data: { id: NEXT_PERIOD, period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null },
      },
      kontantmetod_cutoff_entries: (chain: Chain) => {
        const insert = chain.find((c) => c.method === 'insert')
        if (!insert) return { data: [] }
        const row = insert.args[0] as { kind: string }
        return row.kind === s.refuseMarker ? { error: { message: 'marker refused' } } : { data: null }
      },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const posting = postKontantmetodCutoff(supabase as never, COMPANY, USER, {
      fiscalPeriodId: PERIOD,
      nextFiscalPeriodId: NEXT_PERIOD,
      periodEnd: '2025-12-31',
      receivables: s.receivables,
      payables: s.payables,
      entityType: s.entityType,
      posting: () => ({ linkBasis: STAGED }),
    })
    if (s.partial) {
      await expect(posting, s.name).rejects.toBeInstanceOf(KontantmetodCutoffPartialError)
    } else {
      const result = await posting
      expect(Object.values(result).every((entry) => entry !== null) || s.payables.length === 0, s.name).toBe(true)
    }
    out.push({ name: s.name, calls, events: payloads('business_events', 'insert') as Array<Record<string, unknown>> })
  }
  return out
}

describe('postKontantmetodCutoff engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls }) => ({
      name,
      calls: calls.map(([fn, ...call]) => [fn, ...trimTrailingUndefined(call)]),
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
      expect(run.calls.map(([fn]) => fn), run.name).toEqual(off[i]!.calls.map(([fn]) => fn))
      const links = run.calls.map(([fn, ...call], j) => {
        const { call: bare, link } = splitLink(call)
        const [, ...offCall] = off[i]!.calls[j]!
        expect(bare, `${run.name} #${j}`).toEqual(trimTrailingUndefined(offCall))
        expect(link, `${run.name} #${j}`).toEqual({
          id: expect.stringMatching(UUID),
          role: fn === 'reverseEntry' ? 'reversal' : 'produced',
          onFailure: 'log',
        })
        return (link as { id: string }).id
      })
      // One event per verifikat and per storno, each recorded before its call.
      expect(new Set(links).size, run.name).toBe(links.length)
      expect(run.events.map((e) => e.id), run.name).toEqual(links)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.calls)).toEqual(off.map((r) => r.calls))
    expect(refused.map((r) => r.events.length)).toEqual(off.map((r) => r.calls.length))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const staged = {
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
      pending_operation_id: OPERATION,
    }
    const [receivable, receivableReversal, payable, payableReversal] = runs[0]!.events
    // The fordringar with their moms per treatment: 10 000 + 1 120 + 5 000 outstanding.
    expect(receivable).toMatchObject({
      kind: 'year_end.closing',
      category: null,
      occurred_on: '2025-12-31',
      subject_type: 'fiscal_period',
      subject_id: PERIOD,
      party_type: null,
      currency: 'SEK',
      amount: 16120,
      amount_sek: 16120,
      tax_amounts: [
        { tax: 'vat', treatment: 'standard_25', amount_sek: 2000 },
        { tax: 'vat', treatment: 'reduced_12', amount_sek: 120 },
      ],
      jurisdiction: 'SE',
      ...staged,
    })
    expect(receivable!.mapping_version).toMatch(/^se\.kontantmetod-cutoff@/)
    // The vändning: the next year's first day, the same amount, no moms (kept out of the declaration).
    expect(receivableReversal).toMatchObject({ kind: 'year_end.closing', occurred_on: '2026-01-01', amount: 16120, tax_amounts: [], ...staged })
    // The skulder: one vilande account for every rate, so no treatment; the reverse-charge payable states none.
    expect(payable).toMatchObject({ occurred_on: '2025-12-31', amount: 3500, tax_amounts: [{ tax: 'vat', treatment: null, amount_sek: 500 }] })
    expect(payableReversal).toMatchObject({ occurred_on: '2026-01-01', amount: 3500, tax_amounts: [] })

    // A storno the writer makes of its own verifikat: system_derived, naming the approval, dated the day.
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
    const stornos = runs.slice(2).flatMap((r) => r.events.filter((e) => e.kind === 'ledger.storno'))
    expect(stornos).toHaveLength(3)
    for (const storno of stornos) {
      expect(storno).toMatchObject({
        occurred_on: today,
        subject_type: 'fiscal_period',
        subject_id: PERIOD,
        amount: null,
        currency: null,
        mapping_version: null,
        evidence: { link_basis: 'system_derived', link_evidence: { pending_operation_id: OPERATION } },
        pending_operation_id: OPERATION,
      })
    }
  })
})
