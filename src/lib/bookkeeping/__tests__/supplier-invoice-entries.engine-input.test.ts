/**
 * Posting port, step 2d: what the supplier invoice registration and credit
 * note generators hand the engine, recorded call by call and compared with a
 * committed fixture (supplier-invoice-entries.engine-input.json) that was
 * taken before the producers went through the port.
 * createSupplierInvoiceRegistrationEntry is the one generator behind every
 * registration door (createSupplierInvoice, the deferred Bokför step, the
 * inbox conversion and its staged approval); createSupplierCreditNoteEntry is
 * the one behind every credit. Every argument of every createJournalEntry
 * call is recorded, an absent one as '<undefined>', so an extra argument or a
 * changed input fails here; trailing undefined arguments are dropped before
 * the comparison (the ledger adapter fills createJournalEntry's commitMethod
 * and rubricVersion positions, which a four-argument call receives as
 * undefined, the value its omitted optional parameters had).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bookkeeping/__tests__/supplier-invoice-entries.engine-input.test.ts
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
import type { CreateJournalEntryInput, SupplierInvoice, SupplierInvoiceItem } from '@/types'

// The engine calls the generators make are recorded; everything else in the
// engine stays real.
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
}))

const { createJournalEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { BookkeepingDatabaseError } = await import('@/lib/bookkeeping/errors')
const { createSupplierInvoiceRegistrationEntry, createSupplierCreditNoteEntry } = await import('../supplier-invoice-entries')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)

const FIXTURE = path.join(__dirname, 'supplier-invoice-entries.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const SUPPLIER = '00000000-0000-4000-8000-00000000b001'
const DOCUMENT = '00000000-0000-4000-8000-00000000d001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const INBOX_ITEM = '00000000-0000-4000-8000-00000000e001'
const OPERATION = '00000000-0000-4000-8000-00000000e002'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A stable UUID per scenario: the supplier invoice (or credit note) row's id. */
function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function invoice(index: number, overrides: Partial<SupplierInvoice> = {}): SupplierInvoice {
  return {
    id: invoiceId(index),
    user_id: USER,
    company_id: COMPANY,
    supplier_id: SUPPLIER,
    arrival_number: 40 + index,
    supplier_invoice_number: `F-${2000 + index}`,
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    received_date: '2026-09-02',
    delivery_date: null,
    status: 'registered',
    approved_at: null,
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 1200,
    subtotal_sek: 1200,
    vat_amount: 300,
    vat_amount_sek: 300,
    total: 1500,
    total_sek: 1500,
    ore_rounding: null,
    vat_treatment: 'standard_25',
    reverse_charge: false,
    payment_reference: null,
    paid_at: null,
    paid_amount: 0,
    remaining_amount: 1500,
    is_credit_note: false,
    credited_invoice_id: null,
    registration_journal_entry_id: null,
    payment_journal_entry_id: null,
    transaction_id: null,
    document_id: null,
    paid_with_private_funds: false,
    bank_entered_at: null,
    notes: null,
    created_at: '2026-09-02T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
    ...overrides,
  } as SupplierInvoice
}

function item(sortOrder: number, overrides: Partial<SupplierInvoiceItem>): SupplierInvoiceItem {
  return {
    id: `item-${sortOrder}`,
    supplier_invoice_id: 'unused',
    sort_order: sortOrder,
    description: `Rad ${sortOrder + 1}`,
    quantity: 1,
    unit: 'st',
    unit_price: 0,
    line_total: 0,
    account_number: '6110',
    vat_code: null,
    vat_rate: 0.25,
    vat_amount: 0,
    reverse_charge_rate: null,
    accrual_period_start: null,
    accrual_period_end: null,
    accrual_balance_account: null,
    dimensions: {},
    apply_slp: false,
    created_at: '2026-09-02T00:00:00Z',
    ...overrides,
  } as SupplierInvoiceItem
}

const DOMESTIC_ITEMS = [
  item(0, { description: 'Skärmar', unit_price: 1000, line_total: 1000, account_number: '5410', vat_amount: 250 }),
  item(1, { description: 'Pärmar', unit_price: 200, line_total: 200, account_number: '6110', vat_amount: 50 }),
]

const REVERSE_CHARGE_ITEMS = [
  item(0, { description: 'Hosting', unit_price: 150, line_total: 150, account_number: '6540', vat_rate: 0, reverse_charge_rate: 0.25 }),
  item(1, { description: 'Support', unit_price: 50, line_total: 50, account_number: '6550', vat_rate: 0 }),
]

interface Scenario {
  name: string
  kind: 'registration' | 'credit_note'
  invoice: SupplierInvoice
  items: SupplierInvoiceItem[]
  supplierType: string
  supplierName?: string
  /** No open fiscal period covers the date: the generator answers null and posts nothing. */
  noPeriod?: boolean
  /** createSupplierCreditNoteEntry's invoicePayableSek. */
  payableSek?: number | null
  /** What the door hands down for the event (read only while the port is on). */
  posting?: { linkBasis: { link_basis: 'user_created' | 'agent_proposed_user_approved'; link_evidence: { pending_operation_id: string } | null }; inboxItemId?: string }
}

const SCENARIOS: Scenario[] = [
  {
    name: 'registration: domestic at 25 % with an underlag and invoice dimensions',
    kind: 'registration',
    invoice: invoice(0, { document_id: DOCUMENT, default_dimensions: { '6': 'P100' } } as Partial<SupplierInvoice>),
    items: DOMESTIC_ITEMS,
    supplierType: 'swedish_business',
    supplierName: 'Kontorsbolaget AB',
    posting: { linkBasis: { link_basis: 'user_created', link_evidence: null }, inboxItemId: INBOX_ITEM },
  },
  {
    name: 'registration: mixed rates 25 % and 12 %',
    kind: 'registration',
    invoice: invoice(1, { subtotal: 1500, vat_amount: 286, vat_amount_sek: 286, total: 1786, total_sek: 1786, remaining_amount: 1786 }),
    items: [
      item(0, { description: 'Konferens', unit_price: 1000, line_total: 1000, account_number: '5810', vat_amount: 250 }),
      item(1, { description: 'Lunch', unit_price: 300, line_total: 300, account_number: '5831', vat_rate: 0.12, vat_amount: 36 }),
      item(2, { description: 'Material', unit_price: 200, line_total: 200, account_number: '6110', vat_rate: 0, vat_amount: 0 }),
    ],
    supplierType: 'swedish_business',
    supplierName: 'Konferensgården AB',
  },
  {
    name: 'registration: EU supplier in EUR under reverse charge',
    kind: 'registration',
    invoice: invoice(2, {
      currency: 'EUR',
      exchange_rate: 11.5,
      exchange_rate_date: '2026-09-01',
      subtotal: 200,
      subtotal_sek: 2300,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 200,
      total_sek: 2300,
      remaining_amount: 200,
      vat_treatment: 'reverse_charge',
      reverse_charge: true,
    }),
    items: REVERSE_CHARGE_ITEMS,
    supplierType: 'eu_business',
    supplierName: 'Hosting GmbH',
    posting: { linkBasis: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } } },
  },
  {
    name: 'registration: särskild löneskatt on a pension premium',
    kind: 'registration',
    invoice: invoice(3, { subtotal: 5000, vat_amount: 0, vat_amount_sek: 0, total: 5000, total_sek: 5000, remaining_amount: 5000, vat_treatment: 'exempt' }),
    items: [item(0, { description: 'Tjänstepension', unit_price: 5000, line_total: 5000, account_number: '7412', vat_rate: 0, apply_slp: true })],
    supplierType: 'swedish_business',
    supplierName: 'Pensionsbolaget AB',
  },
  {
    name: 'registration: a förutbetald kostnad on 1790 for a periodisering',
    kind: 'registration',
    invoice: invoice(4, { subtotal: 12000, vat_amount: 3000, vat_amount_sek: 3000, total: 15000, total_sek: 15000, remaining_amount: 15000 }),
    items: [
      item(0, {
        description: 'Licens 12 månader',
        unit_price: 12000,
        line_total: 12000,
        account_number: '5420',
        vat_amount: 3000,
        accrual_period_start: '2026-09-01',
        accrual_period_end: '2027-08-31',
        accrual_balance_account: '1790',
      }),
    ],
    supplierType: 'swedish_business',
  },
  {
    name: 'registration: no open fiscal period, nothing posted',
    kind: 'registration',
    invoice: invoice(5),
    items: DOMESTIC_ITEMS,
    supplierType: 'swedish_business',
    noPeriod: true,
  },
  {
    name: 'credit note: domestic, held to the original payable',
    kind: 'credit_note',
    invoice: invoice(6, {
      supplier_invoice_number: 'KF-2006',
      invoice_date: '2026-09-20',
      status: 'credited',
      is_credit_note: true,
      credited_invoice_id: invoiceId(0),
      remaining_amount: 0,
      document_id: DOCUMENT,
    }),
    items: DOMESTIC_ITEMS,
    supplierType: 'swedish_business',
    supplierName: 'Kontorsbolaget AB',
    payableSek: 1500,
    posting: { linkBasis: { link_basis: 'user_created', link_evidence: null } },
  },
  {
    name: 'credit note: EU supplier in EUR under reverse charge',
    kind: 'credit_note',
    invoice: invoice(7, {
      supplier_invoice_number: 'KF-EU-7',
      invoice_date: '2026-09-22',
      status: 'credited',
      is_credit_note: true,
      credited_invoice_id: invoiceId(2),
      currency: 'EUR',
      exchange_rate: 11.5,
      subtotal: 200,
      subtotal_sek: 2300,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 200,
      total_sek: 2300,
      remaining_amount: 0,
      vat_treatment: 'reverse_charge',
      reverse_charge: true,
    }),
    items: REVERSE_CHARGE_ITEMS,
    supplierType: 'eu_business',
    supplierName: 'Hosting GmbH',
    payableSek: 2300,
  },
  {
    name: 'credit note: no open fiscal period, nothing posted',
    kind: 'credit_note',
    invoice: invoice(8, { is_credit_note: true, status: 'credited', credited_invoice_id: invoiceId(1) }),
    items: DOMESTIC_ITEMS,
    supplierType: 'swedish_business',
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

function supabaseFor(opts: RunOptions) {
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    chart_of_accounts: { data: [] },
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedFindPeriod.mockReset()
    mockedFindPeriod.mockResolvedValue(s.noPeriod ? null : PERIOD)
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${index}`, ...input }) as never)
    const { supabase, findCalls } = supabaseFor(opts)
    let postingReads = 0
    const posting = s.posting
      ? () => {
          postingReads++
          return s.posting!
        }
      : undefined
    let outcome: unknown
    try {
      const entry =
        s.kind === 'registration'
          ? await createSupplierInvoiceRegistrationEntry(supabase as never, COMPANY, USER, s.invoice, s.items, s.supplierType, s.supplierName, posting)
          : await createSupplierCreditNoteEntry(supabase as never, COMPANY, USER, s.invoice, s.items, s.supplierType, s.supplierName, s.payableSek, posting)
      outcome = entry ? { posted: entry.id } : null
    } catch (err) {
      outcome = { threw: err instanceof BookkeepingDatabaseError ? 'BookkeepingDatabaseError' : String(err) }
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

describe('supplier invoice generators engine input (posting port parity)', () => {
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
      // No period: nothing posted and nothing recorded.
      expect(run.events, run.name).toHaveLength(before.calls.length)
      for (const [j, call] of run.calls.entries()) {
        // Off, the adapter's six-argument call: the producer's four plus two undefined positions.
        expect(trimTrailingUndefined(before.calls[j]!)[0], run.name).toBe(4)
        expect(call[0], run.name).toBe(7)
        expect(call.slice(1, 5), run.name).toEqual(before.calls[j]!.slice(1, 5))
        // The adapter's commitMethod and rubricVersion positions, undefined as before.
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
    // The write was tried once per posting, and refused.
    expect(refused.map((r) => r.events.length)).toEqual(off.map((r) => r.calls.length))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the posting before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      if (run.name.includes('no open fiscal period')) expect(run.outcome, run.name).toBeNull()
      else expect(run.outcome, run.name).toEqual({ threw: 'BookkeepingDatabaseError' })
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name.startsWith(name))!.events[0]!

    expect(event('registration: domestic at 25 %')).toMatchObject({
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
      evidence: { document_id: DOCUMENT, inbox_item_id: INBOX_ITEM, link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
      idempotency_key: `purchase.registered:supplier_invoice:${invoiceId(0)}`,
    })
    expect(event('registration: domestic at 25 %').mapping_version).toMatch(/^se\.supplier-invoice-lines@/)
    expect(event('registration: mixed rates')).toMatchObject({ amount: 1786, tax_amounts: [{ tax: 'vat', amount_sek: 286 }] })
    // Omvänd skattskyldighet: the invoice states no moms; the staged approval names its operation.
    expect(event('registration: EU supplier')).toMatchObject({
      currency: 'EUR',
      amount: 200,
      amount_sek: 2300,
      tax_amounts: [],
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
      pending_operation_id: OPERATION,
    })
    expect(event('credit note: domestic')).toMatchObject({
      kind: 'purchase.credited',
      occurred_on: '2026-09-20',
      subject_type: 'supplier_invoice',
      subject_id: invoiceId(6),
      party_id: SUPPLIER,
      amount: 1500,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
      evidence: { document_id: DOCUMENT, link_basis: 'user_created' },
      idempotency_key: null,
    })
    expect(event('credit note: EU supplier')).toMatchObject({ kind: 'purchase.credited', currency: 'EUR', amount_sek: 2300, tax_amounts: [] })
    // Without a context from the door the evidence has no link basis, never a guess.
    expect(event('registration: särskild löneskatt').evidence).toEqual({})
    for (const run of runs) {
      for (const e of run.events) expect(e.id, run.name).toMatch(UUID)
    }
  })
})
