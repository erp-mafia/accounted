/**
 * Posting port, step 2d: what the credit of a supplier invoice
 * (creditSupplierInvoice) hands the engine, recorded call by call and
 * compared with a committed fixture (credit.engine-input.json) that was taken
 * before the producer went through the port. The credit note's verifikat is
 * posted by createSupplierCreditNoteEntry (createJournalEntry); when the
 * credit note cannot point at it, or a concurrent credit won the race, the
 * door takes it back with reverseEntry on the credit date. Every argument is
 * recorded, an absent one as '<undefined>'; trailing undefined arguments of
 * createJournalEntry are dropped before the comparison (the ledger adapter
 * fills its commitMethod and rubricVersion positions, which a four-argument
 * call receives as undefined, the value its omitted optional parameters had).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/supplier-invoices/__tests__/credit.engine-input.test.ts
 *
 * Since the credit posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow and strict: the engine must get the same calls
 * with only the event link added (purchase.credited on the credit verifikat,
 * ledger.storno on a storno the door makes of it), a refused event write must
 * still post under shadow, and under strict the credit stops before the
 * engine is called.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(async () => '00000000-0000-4000-8000-00000000f001'),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  cancelSchedulesForSource: vi.fn(async () => ({ cancelledSchedules: 0, reversedEntries: 0, failedReversals: 0 })),
}))

const { createJournalEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { creditSupplierInvoice } = await import('../credit')

const FIXTURE = path.join(__dirname, 'credit.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const SUPPLIER = '00000000-0000-4000-8000-00000000b001'
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const emit = async () => {}

function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function creditNoteId(index: number): string {
  return `00000000-0000-4000-8000-0000000c${String(index + 1).padStart(4, '0')}`
}

interface Scenario {
  name: string
  /** What the door meets after the credit verifikat is posted. */
  after: 'linked' | 'link_refused' | 'race_lost'
}

const SCENARIOS: Scenario[] = [
  { name: 'a credit on the credit note\'s date: the reversing verifikat is posted', after: 'linked' },
  { name: 'the credit note cannot point at its verifikat: the verifikat is reversed on the credit date', after: 'link_refused' },
  { name: 'a concurrent credit won the race: the losing verifikat is reversed on the credit date', after: 'race_lost' },
]

function original(index: number) {
  return {
    id: invoiceId(index),
    supplier_id: SUPPLIER,
    supplier_invoice_number: `F-${3000 + index}`,
    invoice_date: '2026-09-01',
    status: 'approved',
    currency: 'SEK',
    exchange_rate: null,
    subtotal: 1200,
    subtotal_sek: 1200,
    vat_amount: 300,
    vat_amount_sek: 300,
    total: 1500,
    total_sek: 1500,
    vat_treatment: 'standard_25',
    reverse_charge: false,
    remaining_amount: 1500,
    registration_journal_entry_id: '00000000-0000-4000-8000-0000000d0001',
    payment_journal_entry_id: null,
    paid_at: null,
    paid_amount: 0,
    is_credit_note: false,
    credited_invoice_id: null,
    arrival_number: 50 + index,
    default_dimensions: {},
    supplier: { id: SUPPLIER, name: 'Kontorsbolaget AB', supplier_type: 'swedish_business' },
    items: [
      { id: 'i-0', sort_order: 0, description: 'Skärmar', quantity: 1, unit: 'st', unit_price: 1000, line_total: 1000, account_number: '5410', vat_code: null, vat_rate: 0.25, vat_amount: 250, reverse_charge_rate: null, accrual_period_start: null, accrual_period_end: null, accrual_balance_account: null, dimensions: {}, apply_slp: false },
      { id: 'i-1', sort_order: 1, description: 'Pärmar', quantity: 1, unit: 'st', unit_price: 200, line_total: 200, account_number: '6110', vat_code: null, vat_rate: 0.25, vat_amount: 50, reverse_charge_rate: null, accrual_period_start: null, accrual_period_end: null, accrual_balance_account: null, dimensions: {}, apply_slp: false },
    ],
  }
}

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
  createCalls: unknown[][]
  reverseCalls: unknown[][]
  outcome: unknown
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function supabaseFor(index: number, scenario: Scenario, opts: RunOptions) {
  const source = original(index)
  const creditNote = {
    ...source,
    id: creditNoteId(index),
    supplier_invoice_number: `KF-${3000 + index}`,
    invoice_date: '2026-09-20',
    due_date: '2026-09-20',
    status: 'credited',
    remaining_amount: 0,
    is_credit_note: true,
    credited_invoice_id: source.id,
    arrival_number: 60 + index,
    document_id: null,
  }
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    company_settings: { data: { accounting_method: 'accrual', bookkeeping_locked_through: null } },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    'rpc:get_next_arrival_number': { data: 60 + index },
    supplier_invoice_items: { data: null },
    chart_of_accounts: { data: [] },
    supplier_invoices: [
      { data: source },
      { data: creditNote },
      // The credit note pointed at its verifikat.
      scenario.after === 'link_refused' ? { error: { message: 'link refused', code: 'P0001' } } : { data: null },
      // The original flipped to credited (or another credit got there first).
      scenario.after === 'race_lost' ? { data: null } : { data: { id: source.id } },
      { data: null },
    ],
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, scenario] of SCENARIOS.entries()) {
    vi.mocked(createJournalEntry).mockReset()
    vi.mocked(reverseEntry).mockReset()
    vi.mocked(createJournalEntry).mockImplementation(
      async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-credit-${index}`, ...input }) as never,
    )
    vi.mocked(reverseEntry).mockImplementation(async (_s, _c, _u, entryId: string) => ({ id: `storno-${entryId}`, status: 'posted' }) as never)
    const { supabase, findCalls } = supabaseFor(index, scenario, opts)
    const result = await creditSupplierInvoice(
      { supabase: supabase as never, companyId: COMPANY, userId: USER, log },
      invoiceId(index),
      { credit_date: '2026-09-20', supplier_credit_note_number: `KF-${3000 + index}` },
      { emit },
    )
    const outcome = result.ok
      ? { ok: true, journal_entry_id: result.dryRun ? null : result.data.journal_entry_id }
      : { ok: false, code: result.code, details: 'details' in result ? result.details : null }
    out.push({
      name: scenario.name,
      createCalls: vi.mocked(createJournalEntry).mock.calls.map((c) => record(c as unknown[])),
      reverseCalls: vi.mocked(reverseEntry).mock.calls.map((c) => record(c as unknown[])),
      outcome,
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('supplier invoice credit engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, createCalls, reverseCalls, outcome }) => ({
      name,
      createJournalEntry: createCalls.map(trimTrailingUndefined),
      reverseEntry: reverseCalls,
      outcome,
    }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
    for (const r of runs) expect(r.createCalls, r.name).toHaveLength(1)
  })

  it('with POSTING_EVENTS=shadow hands the engine the same calls, plus only the event links', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      // One event per posting: the credit, and the storno when the door made one.
      expect(run.events, run.name).toHaveLength(before.createCalls.length + before.reverseCalls.length)
      const [credited, storno] = run.events
      const create = run.createCalls[0]!
      expect(create[0], run.name).toBe(7)
      expect(create.slice(1, 5), run.name).toEqual(before.createCalls[0]!.slice(1, 5))
      expect(create[7], run.name).toEqual({ businessEvent: { id: credited!.id, role: 'produced', onFailure: 'log' } })
      expect(run.reverseCalls, run.name).toHaveLength(before.reverseCalls.length)
      for (const [j, call] of run.reverseCalls.entries()) {
        expect(before.reverseCalls[j]![0], run.name).toBe(5)
        expect(call[0], run.name).toBe(6)
        expect(call.slice(1, 6), run.name).toEqual(before.reverseCalls[j]!.slice(1, 6))
        expect(call[6], run.name).toEqual({ businessEvent: { id: storno!.id, role: 'reversal', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const shape = (runs: Run[]) => runs.map(({ createCalls, reverseCalls, outcome }) => ({ createCalls, reverseCalls, outcome }))
    expect(shape(refused)).toEqual(shape(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the credit before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.createCalls, run.name).toEqual([])
      expect(run.reverseCalls, run.name).toEqual([])
      expect(run.outcome, run.name).toMatchObject({ ok: false, code: 'SI_CREDIT_FAILED' })
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    for (const [index, run] of runs.entries()) {
      expect(run.events[0], run.name).toMatchObject({
        kind: 'purchase.credited',
        category: null,
        occurred_on: '2026-09-20',
        subject_type: 'supplier_invoice',
        subject_id: creditNoteId(index),
        party_type: 'supplier',
        party_id: SUPPLIER,
        currency: 'SEK',
        amount: 1500,
        amount_sek: 1500,
        tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
        evidence: { link_basis: 'user_created' },
        jurisdiction: 'SE',
      })
      expect(run.events[0]!.mapping_version, run.name).toMatch(/^se\.supplier-invoice-lines@/)
    }
    // The storno the door makes of its own verifikat: no one chose it.
    for (const run of runs.slice(1)) {
      expect(run.events[1], run.name).toMatchObject({
        kind: 'ledger.storno',
        subject_type: 'supplier_invoice',
        subject_id: run.events[0]!.subject_id,
        party_type: null,
        amount: null,
        evidence: { link_basis: 'system_derived' },
        mapping_version: null,
      })
    }
  })
})
