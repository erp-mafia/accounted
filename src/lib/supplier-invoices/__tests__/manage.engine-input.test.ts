/**
 * Posting port, step 2d: what "Ångra kreditering" (uncreditSupplierInvoice)
 * hands the engine, recorded call by call and compared with a committed
 * fixture (manage.engine-input.json) that was taken before the producer went
 * through the port. The credit note's verifikat is cancelled with
 * reverseEntry; every argument is recorded, an absent one as '<undefined>',
 * so an extra argument or a changed order fails here. A verifikat an earlier
 * attempt reversed is skipped, and a credit note without a verifikat posts
 * nothing.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/supplier-invoices/__tests__/manage.engine-input.test.ts
 *
 * Since the storno goes through the posting port (reverseJournalEntry), the
 * scenarios also run with POSTING_EVENTS=shadow and strict: reverseEntry must
 * get the same call with only the event link added, a refused event write
 * must still reverse under shadow, and under strict it stops before the
 * storno.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { CannotReverseNonPostedError } from '@/lib/bookkeeping/errors'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  reverseEntry: vi.fn(),
}))

const { reverseEntry } = await import('@/lib/bookkeeping/engine')
const { uncreditSupplierInvoice } = await import('../manage')

const FIXTURE = path.join(__dirname, 'manage.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function creditNoteId(index: number): string {
  return `00000000-0000-4000-8000-0000000c${String(index + 1).padStart(4, '0')}`
}

function creditEntryId(index: number): string {
  return `00000000-0000-4000-8000-0000000e${String(index + 1).padStart(4, '0')}`
}

interface Scenario {
  name: string
  /** The credit note's verifikat: posted, already reversed by an earlier attempt, or none (kontantmetoden). */
  creditEntry: 'posted' | 'reversed' | 'none'
}

const SCENARIOS: Scenario[] = [
  { name: 'a credit note with a posted verifikat: storno of it', creditEntry: 'posted' },
  { name: 'a credit note whose verifikat an earlier attempt reversed: the storno is skipped', creditEntry: 'reversed' },
  { name: 'a credit note without a verifikat: nothing to cancel', creditEntry: 'none' },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

interface Run {
  name: string
  calls: unknown[][]
  outcome: unknown
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function supabaseFor(index: number, scenario: Scenario, opts: RunOptions) {
  const original = {
    id: invoiceId(index),
    company_id: COMPANY,
    supplier_id: '00000000-0000-4000-8000-00000000b001',
    status: 'credited',
    total: 1500,
    remaining_amount: 0,
    due_date: '2099-12-31',
    registration_journal_entry_id: '00000000-0000-4000-8000-0000000d0001',
    payments: [],
  }
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    supplier_invoices: [
      { data: original },
      {
        data: {
          id: creditNoteId(index),
          registration_journal_entry_id: scenario.creditEntry === 'none' ? null : creditEntryId(index),
        },
      },
      { data: null },
      { data: { ...original, status: 'approved', remaining_amount: 1500 } },
    ],
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, scenario] of SCENARIOS.entries()) {
    vi.mocked(reverseEntry).mockReset()
    vi.mocked(reverseEntry).mockImplementation(async (_s, _c, _u, entryId: string) => {
      if (scenario.creditEntry === 'reversed') throw new CannotReverseNonPostedError('reversed')
      return { id: `storno-${entryId}`, status: 'posted' } as never
    })
    const { supabase, findCalls } = supabaseFor(index, scenario, opts)
    const result = await uncreditSupplierInvoice({ supabase: supabase as never, companyId: COMPANY, userId: USER, log }, invoiceId(index))
    const outcome = result.ok
      ? {
          ok: true,
          reversal_entry_id: result.dryRun ? null : result.data.reversal_entry_id,
          reversed_credit_note_id: result.dryRun ? null : result.data.reversed_credit_note_id,
        }
      : { ok: false, code: result.code }
    out.push({
      name: scenario.name,
      calls: vi.mocked(reverseEntry).mock.calls.map((c) => record(c as unknown[])),
      outcome,
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('supplier invoice uncredit engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, outcome }) => ({ name, calls, outcome }))
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
      expect(run.calls, run.name).toHaveLength(before.calls.length)
      expect(run.events, run.name).toHaveLength(before.calls.length)
      for (const [j, call] of run.calls.entries()) {
        expect(before.calls[j]![0], run.name).toBe(4)
        expect(call[0], run.name).toBe(6)
        expect(call.slice(1, 5), run.name).toEqual(before.calls[j]!.slice(1, 5))
        expect(call[5], run.name).toBe('<undefined>')
        expect(call[6], run.name).toEqual({ businessEvent: { id: run.events[0]!.id, role: 'reversal', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still reverses, with exactly the off call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map(({ calls, outcome }) => ({ calls, outcome }))).toEqual(off.map(({ calls, outcome }) => ({ calls, outcome })))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the uncredit before the storno', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      if (run.name.includes('without a verifikat')) expect(run.outcome, run.name).toMatchObject({ ok: true })
      else expect(run.outcome, run.name).toEqual({ ok: false, code: 'SI_UNCREDIT_FAILED' })
    }
  })

  it('records what happened in business terms: a storno of the credit note, no party, no amount', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    expect(runs[0]!.events[0]).toMatchObject({
      kind: 'ledger.storno',
      category: null,
      subject_type: 'supplier_invoice',
      subject_id: creditNoteId(0),
      party_type: null,
      party_id: null,
      currency: null,
      amount: null,
      amount_sek: null,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      mapping_version: null,
      jurisdiction: 'SE',
      idempotency_key: null,
    })
    expect(runs[0]!.events[0]!.occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
