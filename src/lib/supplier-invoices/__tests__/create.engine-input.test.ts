/**
 * Posting port, step 2d: what the registration of a supplier invoice
 * (createSupplierInvoice under faktureringsmetoden) hands the engine,
 * recorded call by call and compared with a committed fixture
 * (create.engine-input.json) that was taken before the producer went through
 * the port. The registration verifikat is posted by
 * createSupplierInvoiceRegistrationEntry (createJournalEntry). When the
 * invoice cannot point at it, or the engine threw after the verifikat may
 * have posted, the door asks the books and takes a posted registration back
 * with reverseEntry on the invoice date (undoFailedRegistration). Every
 * argument is recorded, an absent one as '<undefined>'; trailing undefined
 * arguments of createJournalEntry are dropped before the comparison (the
 * ledger adapter fills its commitMethod and rubricVersion positions, which a
 * four-argument call receives as undefined, the value its omitted optional
 * parameters had).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/supplier-invoices/__tests__/create.engine-input.test.ts
 *
 * Since the registration and its undo storno go through the posting port,
 * the scenarios also run with POSTING_EVENTS=shadow and strict: the engine
 * must get the same calls with only the event link added
 * (purchase.registered on the registration, ledger.storno on the undo), a
 * refused event write must still post under shadow, and under strict the
 * registration stops before the engine is called and the invoice row goes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'
import type { CreateSupplierInvoiceInput } from '../create'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(async () => '00000000-0000-4000-8000-00000000f001'),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn(async () => {}) } }))

const { createJournalEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { createSupplierInvoice } = await import('../create')

const FIXTURE = path.join(__dirname, 'create.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const SUPPLIER = '00000000-0000-4000-8000-00000000b001'
const POSTED_ELSEWHERE = '00000000-0000-4000-8000-0000000e9999'
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

interface Scenario {
  name: string
  body: Partial<CreateSupplierInvoiceInput>
  /** What happens after the generator is called. */
  after: 'linked' | 'link_refused' | 'engine_threw_after_posting'
}

const SCENARIOS: Scenario[] = [
  { name: 'a domestic invoice at 25 %: the registration verifikat is posted', body: {}, after: 'linked' },
  {
    name: 'an invoice in EUR under reverse charge with invoice dimensions',
    body: {
      currency: 'EUR',
      exchange_rate: 11.5,
      reverse_charge: true,
      default_dimensions: { '6': 'P100' },
      items: [{ description: 'Hosting', amount: 150, account_number: '6540', vat_rate: 0, reverse_charge_rate: 0.25 }],
    } as Partial<CreateSupplierInvoiceInput>,
    after: 'linked',
  },
  { name: 'the invoice cannot point at its verifikat: the registration is reversed on the invoice date', body: {}, after: 'link_refused' },
  {
    name: 'the engine threw after the verifikat posted: the posted registration is found and reversed',
    body: {},
    after: 'engine_threw_after_posting',
  },
]

function body(index: number, overrides: Partial<CreateSupplierInvoiceInput>): CreateSupplierInvoiceInput {
  return {
    supplier_id: SUPPLIER,
    supplier_invoice_number: `F-${4000 + index}`,
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    items: [
      { description: 'Skärmar', amount: 1000, account_number: '5410', vat_rate: 0.25 },
      { description: 'Pärmar', amount: 200, account_number: '6110', vat_rate: 0.25 },
    ],
    ...overrides,
  } as CreateSupplierInvoiceInput
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

type ChainCalls = Array<{ method: string; args: unknown[] }>

function supabaseFor(index: number, scenario: Scenario, opts: RunOptions) {
  const supplierType = scenario.body.reverse_charge ? 'eu_business' : 'swedish_business'
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    suppliers: { data: { id: SUPPLIER, company_id: COMPANY, name: 'Leverantören AB', supplier_type: supplierType, archived_at: null } },
    company_settings: { data: { accounting_method: 'accrual', vat_registered: true, bookkeeping_locked_through: null } },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    'rpc:get_next_arrival_number': { data: 70 + index },
    chart_of_accounts: { data: [] },
    supplier_invoices: (calls: ChainCalls) => {
      const insert = calls.find((c) => c.method === 'insert')
      if (insert) return { data: { id: invoiceId(index), ...(insert.args[0] as Record<string, unknown>) } }
      const update = calls.find((c) => c.method === 'update')?.args[0] as Record<string, unknown> | undefined
      if (update && 'registration_journal_entry_id' in update && scenario.after === 'link_refused') {
        return { error: { message: 'link refused', code: 'P0001' } }
      }
      return { data: null }
    },
    supplier_invoice_items: (calls: ChainCalls) => {
      const rows = (calls.find((c) => c.method === 'insert')?.args[0] ?? []) as Array<{ sort_order: number }>
      return { data: rows.map((r) => ({ id: `item-${r.sort_order}`, sort_order: r.sort_order })) }
    },
    // undoFailedRegistration asks the books for a posted registration.
    journal_entries: { data: scenario.after === 'engine_threw_after_posting' ? { id: POSTED_ELSEWHERE } : null },
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, scenario] of SCENARIOS.entries()) {
    vi.mocked(createJournalEntry).mockReset()
    vi.mocked(reverseEntry).mockReset()
    vi.mocked(createJournalEntry).mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => {
      if (scenario.after === 'engine_threw_after_posting') throw new Error('connection reset after commit')
      return { id: `je-reg-${index}`, ...input } as never
    })
    vi.mocked(reverseEntry).mockImplementation(async (_s, _c, _u, entryId: string) => ({ id: `storno-${entryId}`, status: 'posted' }) as never)
    const { supabase, findCalls } = supabaseFor(index, scenario, opts)
    const result = await createSupplierInvoice({ supabase: supabase as never, companyId: COMPANY, userId: USER, log }, body(index, scenario.body))
    const outcome = result.ok
      ? { ok: true, registrationJournalEntryId: result.dryRun ? null : result.registrationJournalEntryId }
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

describe('supplier invoice registration engine input (posting port parity)', () => {
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
      expect(run.events, run.name).toHaveLength(before.createCalls.length + before.reverseCalls.length)
      const [registered, storno] = run.events
      const create = run.createCalls[0]!
      expect(create[0], run.name).toBe(7)
      expect(create.slice(1, 5), run.name).toEqual(before.createCalls[0]!.slice(1, 5))
      expect(create[7], run.name).toEqual({ businessEvent: { id: registered!.id, role: 'produced', onFailure: 'log' } })
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

  it('with POSTING_EVENTS=strict a refused event write stops the registration before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.createCalls, run.name).toEqual([])
      expect(run.outcome, run.name).toMatchObject({ ok: false, code: 'SI_CREATE_FAILED' })
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    expect(runs[0]!.events[0]).toMatchObject({
      kind: 'purchase.registered',
      category: null,
      occurred_on: '2026-09-01',
      subject_type: 'supplier_invoice',
      subject_id: invoiceId(0),
      party_type: 'supplier',
      party_id: SUPPLIER,
      currency: 'SEK',
      amount: 1500,
      amount_sek: 1500,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
      evidence: { link_basis: 'user_created' },
      jurisdiction: 'SE',
      idempotency_key: `purchase.registered:supplier_invoice:${invoiceId(0)}`,
    })
    expect(runs[1]!.events[0]).toMatchObject({ currency: 'EUR', amount: 150, amount_sek: 1725, tax_amounts: [] })
    // The undo storno: no one chose it.
    for (const run of runs.slice(2)) {
      expect(run.events[1], run.name).toMatchObject({
        kind: 'ledger.storno',
        subject_type: 'supplier_invoice',
        subject_id: run.events[0]!.subject_id,
        party_type: null,
        amount: null,
        evidence: { link_basis: 'system_derived' },
      })
    }
  })
})
