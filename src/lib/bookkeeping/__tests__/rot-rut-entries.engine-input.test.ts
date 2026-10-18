/**
 * Posting port, step 2f-2: what the ROT/RUT generators hand the engine,
 * recorded call by call and compared with a committed fixture
 * (rot-rut-entries.engine-input.json) that was taken before the producers
 * went through the port. createRotRutPayoutSetEntry is Skatteverket's payout
 * (one begäran through createRotRutPayoutEntry, or several paid in one
 * transfer), createRotRutReclaimEntry the refused share booked back onto the
 * customer, and createMigratedDeductionEntry the migrated invoice's
 * deduction moved from 1510 to 1513. Every argument of every
 * createJournalEntry call is recorded, an absent one as '<undefined>', so an
 * extra argument or a changed input fails here; trailing undefined arguments
 * are dropped before the comparison (the ledger adapter fills
 * createJournalEntry's commitMethod and rubricVersion positions, which a
 * four-argument call receives as undefined, the value its omitted optional
 * parameters had).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bookkeeping/__tests__/rot-rut-entries.engine-input.test.ts
 *
 * Since the generators post through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow and strict: the engine must get the same
 * arguments plus only the event link, a refused event write must still post
 * under shadow and stop the posting under strict, and the door's posting
 * context is read only while the port is on.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput, DeductionType } from '@/types'

// The engine calls the generators make are recorded; everything else in the
// engine stays real.
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
}))

const { createJournalEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { BookkeepingDatabaseError } = await import('@/lib/bookkeeping/errors')
const { createRotRutPayoutEntry, createRotRutPayoutSetEntry, createRotRutReclaimEntry, createMigratedDeductionEntry } = await import(
  '../rot-rut-entries'
)

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)

const FIXTURE = path.join(__dirname, 'rot-rut-entries.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const OPERATION = '00000000-0000-4000-8000-00000000e002'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a door hands down for the event (read only while the port is on). */
interface Posting {
  linkBasis: {
    link_basis: 'user_created' | 'user_confirmed' | 'agent_proposed_user_approved' | 'import_carried_over'
    link_evidence: { pending_operation_id?: string; source_system?: string } | null
  }
  bankLine?: boolean
}

const HEADLESS: Posting = { linkBasis: { link_basis: 'user_created', link_evidence: null }, bankLine: false }
const MATCHED: Posting = { linkBasis: { link_basis: 'user_confirmed', link_evidence: null }, bankLine: true }
const STAGED_MATCH: Posting = {
  linkBasis: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
  bankLine: true,
}
const CARRIED_OVER: Posting = { linkBasis: { link_basis: 'import_carried_over', link_evidence: { source_system: 'visma' } } }

/** A stable UUID: a begäran (r) or an invoice (i). */
function id(kind: 'r' | 'i', index: number): string {
  return `00000000-0000-4000-8000-${kind === 'r' ? '2' : '3'}${String(index + 1).padStart(11, '0')}`
}

interface PayoutScenario {
  name: string
  kind: 'payout'
  params: {
    requestId: string
    requestName: string
    deductionType: DeductionType
    paymentDate: string
    amount: number
    oreRounding?: number
    invoiceCount?: number
    bankAccount?: string
  }
  noPeriod?: boolean
  posting?: Posting
}

interface PayoutSetScenario {
  name: string
  kind: 'payout_set'
  params: Parameters<typeof createRotRutPayoutSetEntry>[3]
  noPeriod?: boolean
  posting?: Posting
}

interface ReclaimScenario {
  name: string
  kind: 'reclaim'
  params: Parameters<typeof createRotRutReclaimEntry>[3]
  noPeriod?: boolean
  posting?: Posting
}

interface ReclassificationScenario {
  name: string
  kind: 'reclassification'
  params: Parameters<typeof createMigratedDeductionEntry>[3]
  noPeriod?: boolean
  posting?: Posting
}

type Scenario = PayoutScenario | PayoutSetScenario | ReclaimScenario | ReclassificationScenario

const SCENARIOS: Scenario[] = [
  {
    name: 'payout: one RUT begäran paid in full to 1930',
    kind: 'payout',
    params: { requestId: id('r', 0), requestName: 'RUT 2026-01', deductionType: 'rut', paymentDate: '2026-09-10', amount: 2500 },
    posting: HEADLESS,
  },
  {
    name: 'payout: one ROT begäran to 1940, the öre its invoices carried on 1513 to 3740',
    kind: 'payout',
    params: {
      requestId: id('r', 1),
      requestName: 'ROT 2026-02',
      deductionType: 'rot',
      paymentDate: '2026-09-11',
      amount: 6750,
      oreRounding: 0.75,
      invoiceCount: 2,
      bankAccount: '1940',
    },
    posting: MATCHED,
  },
  {
    name: 'payout: a grön teknik begäran',
    kind: 'payout',
    params: { requestId: id('r', 2), requestName: 'GT 2026-01', deductionType: 'gron_teknik', paymentDate: '2026-09-12', amount: 9700 },
  },
  {
    name: 'payout set: a ROT and a RUT begäran paid in one transfer',
    kind: 'payout_set',
    params: {
      paymentDate: '2026-09-14',
      legs: [
        { requestId: id('r', 3), requestName: 'ROT 2026-03', deductionType: 'rot', amount: 4000, oreRounding: 0.5, invoiceCount: 1 },
        { requestId: id('r', 4), requestName: 'RUT 2026-04', deductionType: 'rut', amount: 1500.25 },
      ],
    },
    posting: STAGED_MATCH,
  },
  {
    name: 'payout set: two RUT begäran on 1940',
    kind: 'payout_set',
    params: {
      paymentDate: '2026-09-15',
      bankAccount: '1940',
      legs: [
        { requestId: id('r', 5), requestName: 'RUT 2026-05', deductionType: 'rut', amount: 3000 },
        { requestId: id('r', 6), requestName: 'RUT 2026-06', deductionType: 'rut', amount: 2000 },
      ],
    },
    posting: MATCHED,
  },
  {
    name: 'payout set: no begäran refused before anything is read',
    kind: 'payout_set',
    params: { paymentDate: '2026-09-15', legs: [] },
  },
  {
    name: 'payout set: öre rounding beyond what the invoices could leave refused',
    kind: 'payout_set',
    params: {
      paymentDate: '2026-09-15',
      legs: [{ requestId: id('r', 7), requestName: 'RUT 2026-07', deductionType: 'rut', amount: 100, oreRounding: 1.5, invoiceCount: 1 }],
    },
  },
  {
    name: 'payout: no open fiscal period, refused',
    kind: 'payout',
    params: { requestId: id('r', 8), requestName: 'RUT 2026-08', deductionType: 'rut', paymentDate: '2026-09-16', amount: 1000 },
    noPeriod: true,
  },
  {
    name: 'reclaim: a RUT begäran refused for two invoices',
    kind: 'reclaim',
    params: {
      requestId: id('r', 9),
      requestName: 'RUT 2026-09',
      deductionType: 'rut',
      bookingDate: '2026-09-20',
      legs: [
        { invoiceId: id('i', 0), invoiceNumber: '1001', amount: 2500 },
        { invoiceId: id('i', 1), invoiceNumber: null, amount: 1250.5 },
      ],
    },
    posting: HEADLESS,
  },
  {
    name: 'reclaim: a ROT share, legs of zero dropped',
    kind: 'reclaim',
    params: {
      requestId: id('r', 10),
      requestName: 'ROT 2026-10',
      deductionType: 'rot',
      bookingDate: '2026-09-21',
      legs: [
        { invoiceId: id('i', 2), invoiceNumber: '1003', amount: 0 },
        { invoiceId: id('i', 3), invoiceNumber: '1004', amount: 3000 },
      ],
    },
  },
  {
    name: 'reclaim: nothing refused, refused',
    kind: 'reclaim',
    params: { requestId: id('r', 11), requestName: 'RUT 2026-11', deductionType: 'rut', bookingDate: '2026-09-22', legs: [] },
  },
  {
    name: 'reclaim: no open fiscal period, refused',
    kind: 'reclaim',
    params: {
      requestId: id('r', 12),
      requestName: 'RUT 2026-12',
      deductionType: 'rut',
      bookingDate: '2026-09-23',
      legs: [{ invoiceId: id('i', 4), invoiceNumber: '1005', amount: 500 }],
    },
    noPeriod: true,
  },
  {
    name: 'reclassification: a migrated invoice\'s RUT deduction to 1513',
    kind: 'reclassification',
    params: { invoiceId: id('i', 5), invoiceNumber: 'V-1042', deductionType: 'rut', amount: 3750, bookingDate: '2026-09-24' },
    posting: CARRIED_OVER,
  },
  {
    name: 'reclassification: a ROT deduction on an invoice without a number',
    kind: 'reclassification',
    params: { invoiceId: id('i', 6), invoiceNumber: null, deductionType: 'rot', amount: 1234.56, bookingDate: '2026-09-25' },
  },
  {
    name: 'reclassification: a zero deduction, refused',
    kind: 'reclassification',
    params: { invoiceId: id('i', 7), invoiceNumber: 'V-1044', deductionType: 'rut', amount: 0, bookingDate: '2026-09-26' },
  },
  {
    name: 'reclassification: no open fiscal period, refused',
    kind: 'reclassification',
    params: { invoiceId: id('i', 8), invoiceNumber: 'V-1045', deductionType: 'rut', amount: 100, bookingDate: '2026-09-27' },
    noPeriod: true,
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

interface Run {
  name: string
  calls: unknown[][]
  outcome: unknown
  events: Array<Record<string, unknown>>
  /** How often the door's posting context was read. */
  postingReads: number
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedFindPeriod.mockReset()
    mockedFindPeriod.mockResolvedValue(s.noPeriod ? null : PERIOD)
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${index}`, ...input }) as never)
    const { supabase, findCalls } = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      chart_of_accounts: { data: [] },
    })
    let postingReads = 0
    const posting = s.posting
      ? () => {
          postingReads++
          return s.posting!
        }
      : undefined
    let outcome: unknown
    try {
      const sb = supabase as never
      const entry =
        s.kind === 'payout'
          ? await createRotRutPayoutEntry(sb, COMPANY, USER, s.params, posting)
          : s.kind === 'payout_set'
            ? await createRotRutPayoutSetEntry(sb, COMPANY, USER, s.params, posting)
            : s.kind === 'reclaim'
              ? await createRotRutReclaimEntry(sb, COMPANY, USER, s.params, posting)
              : await createMigratedDeductionEntry(sb, COMPANY, USER, s.params, posting)
      outcome = { posted: entry.id }
    } catch (err) {
      outcome = { threw: err instanceof BookkeepingDatabaseError ? 'BookkeepingDatabaseError' : err instanceof Error ? err.message : String(err) }
    }
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      outcome,
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
      postingReads,
    })
  }
  return out
}

describe('ROT/RUT generators engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, outcome }) => ({ name, calls: calls.map(trimTrailingUndefined), outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
    // Off, the door's context is never even read.
    expect(runs.map((r) => r.postingReads)).toEqual(runs.map(() => 0))
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()

    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.calls, run.name).toHaveLength(before.calls.length)
      // A refusal before the engine: nothing posted and nothing recorded.
      expect(run.events, run.name).toHaveLength(before.calls.length)
      for (const [j, call] of run.calls.entries()) {
        // Off, the adapter's six-argument call: the producer's four plus two undefined positions.
        expect(trimTrailingUndefined(before.calls[j]!)[0], run.name).toBe(4)
        expect(call[0], run.name).toBe(7)
        expect(call.slice(1, 5), run.name).toEqual(before.calls[j]!.slice(1, 5))
        expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
        expect(call[7], run.name).toEqual({ businessEvent: { id: run.events[0]!.id, role: 'produced', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map(({ calls, outcome }) => ({ calls, outcome }))).toEqual(off.map(({ calls, outcome }) => ({ calls, outcome })))
    expect(refused.map((r) => r.events.length)).toEqual(off.map((r) => r.calls.length))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the posting before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const [i, run] of refused.entries()) {
      expect(run.calls, run.name).toEqual([])
      // A generator's own refusal comes first, as before; a posting stops on the event.
      if (off[i]!.calls.length === 0) expect(run.outcome, run.name).toEqual(off[i]!.outcome)
      else expect(run.outcome, run.name).toEqual({ threw: 'BookkeepingDatabaseError' })
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name.startsWith(name))!.events[0]!

    // Skatteverket's payout: no subject (a begäran has no handle), no party, no moms.
    expect(event('payout: one RUT begäran')).toMatchObject({
      kind: 'se.rot_rut.payout_received',
      category: null,
      occurred_on: '2026-09-10',
      subject_type: null,
      subject_id: null,
      party_type: null,
      party_id: null,
      currency: 'SEK',
      amount: 2500,
      amount_sek: 2500,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
      idempotency_key: null,
    })
    expect(event('payout: one RUT begäran').mapping_version).toMatch(/^se\.rot-rut-lines@/)
    // The kronor that reached the bank: the öre cleared on 3740 is not money in.
    expect(event('payout: one ROT begäran to 1940')).toMatchObject({ amount: 6750, amount_sek: 6750, evidence: { direction: 'in', link_basis: 'user_confirmed' } })
    // Without a context from the door: no link basis, never a guess.
    expect(event('payout: a grön teknik begäran')).toMatchObject({ amount: 9700, evidence: {} })
    // One event for the whole transfer.
    expect(event('payout set: a ROT and a RUT')).toMatchObject({
      amount: 5500.25,
      amount_sek: 5500.25,
      evidence: { direction: 'in', link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
      pending_operation_id: OPERATION,
    })
    expect(event('payout set: two RUT begäran on 1940')).toMatchObject({ amount: 5000 })
    // The refused share, every invoice's together; zero legs dropped as in the lines.
    expect(event('reclaim: a RUT begäran refused')).toMatchObject({
      kind: 'se.rot_rut.reclaimed',
      occurred_on: '2026-09-20',
      subject_type: null,
      party_type: null,
      currency: 'SEK',
      amount: 3750.5,
      amount_sek: 3750.5,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
    })
    expect(event('reclaim: a ROT share')).toMatchObject({ amount: 3000 })
    // The migrated invoice is the subject; the deduction came over from the provider.
    expect(event("reclassification: a migrated invoice's RUT")).toMatchObject({
      kind: 'se.rot_rut.reclassified',
      occurred_on: '2026-09-24',
      subject_type: 'invoice',
      subject_id: id('i', 5),
      party_type: null,
      currency: 'SEK',
      amount: 3750,
      amount_sek: 3750,
      tax_amounts: [],
      evidence: { link_basis: 'import_carried_over', link_evidence: { source_system: 'visma' } },
    })
    expect(event('reclassification: a ROT deduction')).toMatchObject({ amount: 1234.56, subject_id: id('i', 6) })
    for (const run of runs) {
      for (const e of run.events) expect(e.id, run.name).toMatch(UUID)
    }
  })
})
