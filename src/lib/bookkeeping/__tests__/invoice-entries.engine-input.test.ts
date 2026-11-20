/**
 * Posting port, step 2f: what the customer invoice registration and credit
 * note generators hand the engine, recorded call by call and compared with a
 * committed fixture (invoice-entries.engine-input.json) that was taken before
 * the producers went through the port. createInvoiceJournalEntry is the one
 * generator behind every registration door (the issue step of Markera som
 * skickad, the email and Peppol sends, bulk Bokför, the recurring auto-send
 * and the staged operations, the deferred Bokför step, and the received
 * självfaktura); createCreditNoteJournalEntry is the one behind every
 * kreditfaktura. Every argument of every createJournalEntry call is recorded,
 * an absent one as '<undefined>', so an extra argument or a changed input
 * fails here; trailing undefined arguments are dropped before the comparison
 * (the ledger adapter fills createJournalEntry's commitMethod and
 * rubricVersion positions, which a four-argument call receives as undefined,
 * the value its omitted optional parameters had).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bookkeeping/__tests__/invoice-entries.engine-input.test.ts
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
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, EntityType, Invoice, InvoiceItem } from '@/types'

// The engine calls the generators make are recorded; everything else in the
// engine stays real.
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
}))

const { createJournalEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { BookkeepingDatabaseError } = await import('@/lib/bookkeeping/errors')
const { createInvoiceJournalEntry, createCreditNoteJournalEntry } = await import('../invoice-entries')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)

const FIXTURE = path.join(__dirname, 'invoice-entries.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const CUSTOMER = '00000000-0000-4000-8000-00000000b001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const OPERATION = '00000000-0000-4000-8000-00000000e002'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A stable UUID per scenario: the invoice (or credit note) row's id. */
function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

type EventInvoice = Invoice & { items?: InvoiceItem[]; deduction_total?: number; is_self_billed?: boolean; external_invoice_number?: string | null }

function invoice(index: number, overrides: Partial<EventInvoice> = {}): EventInvoice {
  return {
    id: invoiceId(index),
    user_id: USER,
    company_id: COMPANY,
    customer_id: CUSTOMER,
    invoice_number: `F-${1000 + index}`,
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    delivery_date: null,
    status: 'sent',
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
    vat_rate: 25,
    moms_ruta: '05',
    your_reference: null,
    our_reference: null,
    notes: null,
    reverse_charge_text: null,
    credited_invoice_id: null,
    document_type: 'invoice',
    converted_from_id: null,
    paid_at: null,
    paid_amount: 0,
    remaining_amount: 1500,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    items: [item(index, 0, { description: 'Konsulttimmar', quantity: 12, unit: 'tim', unit_price: 100, line_total: 1200, vat_amount: 300 })],
    ...overrides,
  } as EventInvoice
}

function item(index: number, sortOrder: number, overrides: Partial<InvoiceItem>): InvoiceItem {
  return {
    id: `item-${index}-${sortOrder}`,
    invoice_id: invoiceId(index),
    sort_order: sortOrder,
    line_type: 'product',
    description: `Rad ${sortOrder + 1}`,
    quantity: 1,
    unit: 'st',
    unit_price: 0,
    line_total: 0,
    vat_rate: 25,
    vat_amount: 0,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  } as InvoiceItem
}

/** Every amount of an invoice negated, as buildCreditNoteItem and buildCreditNoteFields copy them. */
function negate(source: EventInvoice, overrides: Partial<EventInvoice>): EventInvoice {
  const neg = (n: number | null | undefined) => (n == null ? n : -Math.abs(n))
  return {
    ...source,
    subtotal: neg(source.subtotal)!,
    subtotal_sek: neg(source.subtotal_sek) ?? null,
    vat_amount: neg(source.vat_amount)!,
    vat_amount_sek: neg(source.vat_amount_sek) ?? null,
    total: neg(source.total)!,
    total_sek: neg(source.total_sek) ?? null,
    remaining_amount: 0,
    items: (source.items ?? []).map((row) => ({
      ...row,
      unit_price: -Math.abs(row.unit_price),
      line_total: -Math.abs(row.line_total),
      vat_amount: -Math.abs(row.vat_amount),
      ...(row.deduction_amount != null ? { deduction_amount: row.deduction_amount } : {}),
    })),
    ...overrides,
  } as EventInvoice
}

const RUT_ITEMS = (index: number) => [
  item(index, 0, {
    description: 'Städning',
    quantity: 10,
    unit: 'tim',
    unit_price: 400,
    line_total: 4000,
    vat_amount: 1000,
    deduction_type: 'rut',
    deduction_amount: 2500,
    labor_hours: 10,
    work_type: 'STAD',
  }),
  item(index, 1, { description: 'Material', unit_price: 800, line_total: 800, vat_amount: 200 }),
]

const CUSTOM_LINES: CreateJournalEntryLineInput[] = [
  { account_number: '1510', debit_amount: 1500, credit_amount: 0, line_description: 'Faktura F-1005' },
  { account_number: '3041', debit_amount: 0, credit_amount: 1200, line_description: 'Konsulttjänster' },
  { account_number: '2611', debit_amount: 0, credit_amount: 300, line_description: 'Utgående moms 25 %' },
]

interface Scenario {
  name: string
  kind: 'registration' | 'credit_note'
  invoice: EventInvoice
  entityType: EntityType
  customerName?: string
  /** createInvoiceJournalEntry's options. */
  options?: { customLines?: CreateJournalEntryLineInput[]; descriptionPrefix?: string; numberOverride?: string | null }
  /** createCreditNoteJournalEntry's originalVoucherRef. */
  originalVoucherRef?: string
  /** No open fiscal period covers the date: the generator answers null and posts nothing. */
  noPeriod?: boolean
  /** What the door hands down for the event (read only while the port is on). */
  posting?: { linkBasis: { link_basis: 'user_created' | 'agent_proposed_user_approved'; link_evidence: { pending_operation_id: string } | null } }
}

const USER_CREATED = { linkBasis: { link_basis: 'user_created', link_evidence: null } } as const
const STAGED = { linkBasis: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } } } as const

const EUR_INVOICE = invoice(2, {
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
  vat_rate: 0,
  moms_ruta: '39',
  reverse_charge_text: 'Omvänd betalningsskyldighet',
  items: [item(2, 0, { description: 'Hosting', unit_price: 200, line_total: 200, vat_rate: 0, vat_amount: 0 })],
})

const RUT_INVOICE = invoice(4, {
  subtotal: 4800,
  subtotal_sek: 4800,
  vat_amount: 1200,
  vat_amount_sek: 1200,
  total: 6000,
  total_sek: 6000,
  remaining_amount: 3500,
  deduction_total: 2500,
  items: RUT_ITEMS(4),
})

const SCENARIOS: Scenario[] = [
  {
    name: 'registration: domestic at 25 % for an aktiebolag, with invoice dimensions',
    kind: 'registration',
    invoice: invoice(0, { default_dimensions: { '6': 'P100' } } as Partial<EventInvoice>),
    entityType: 'aktiebolag',
    customerName: 'Kund AB',
    posting: USER_CREATED,
  },
  {
    name: 'registration: mixed rates 25 %, 12 % and 6 % for an enskild firma',
    kind: 'registration',
    invoice: invoice(1, {
      subtotal: 1600,
      subtotal_sek: 1600,
      vat_amount: 192,
      vat_amount_sek: 192,
      total: 1792,
      total_sek: 1792,
      remaining_amount: 1792,
      items: [
        item(1, 0, { description: 'Arbete', unit_price: 600, line_total: 600, vat_amount: 150 }),
        item(1, 1, { description: 'Mat', unit_price: 200, line_total: 200, vat_rate: 12, vat_amount: 24 }),
        item(1, 2, { description: 'Böcker', unit_price: 300, line_total: 300, vat_rate: 6, vat_amount: 18 }),
        item(1, 3, { description: 'Tryck', unit_price: 500, line_total: 500, vat_rate: 0, vat_amount: 0, revenue_account: '3004' }),
        item(1, 4, { description: 'Tack för uppdraget', line_type: 'text', unit_price: 0, line_total: 0, vat_rate: 0, vat_amount: 0 }),
      ],
    }),
    entityType: 'enskild_firma',
    customerName: 'Kund AB',
  },
  {
    name: 'registration: EU business customer in EUR under reverse charge',
    kind: 'registration',
    invoice: EUR_INVOICE,
    entityType: 'aktiebolag',
    customerName: 'Kunde GmbH',
    posting: STAGED,
  },
  {
    name: 'registration: a periodisering defers the revenue to 2970',
    kind: 'registration',
    invoice: invoice(3, {
      subtotal: 12000,
      subtotal_sek: 12000,
      vat_amount: 3000,
      vat_amount_sek: 3000,
      total: 15000,
      total_sek: 15000,
      remaining_amount: 15000,
      items: [
        item(3, 0, {
          description: 'Support 12 månader',
          unit_price: 12000,
          line_total: 12000,
          vat_amount: 3000,
          accrual_period_start: '2026-09-01',
          accrual_period_end: '2027-08-31',
          accrual_balance_account: '2970',
        }),
      ],
    }),
    entityType: 'aktiebolag',
  },
  {
    name: 'registration: a RUT invoice splits the receivable over 1510 and 1513',
    kind: 'registration',
    invoice: RUT_INVOICE,
    entityType: 'aktiebolag',
    customerName: 'Privatkund',
    posting: USER_CREATED,
  },
  {
    name: 'registration: the send dialog\'s user-edited lines are booked verbatim',
    kind: 'registration',
    invoice: invoice(5),
    entityType: 'aktiebolag',
    customerName: 'Kund AB',
    options: { customLines: CUSTOM_LINES },
    posting: USER_CREATED,
  },
  {
    name: 'registration: a received självfaktura books under the counterparty\'s number',
    kind: 'registration',
    invoice: invoice(6, { invoice_number: null, is_self_billed: true, external_invoice_number: 'SF-77' }),
    entityType: 'aktiebolag',
    customerName: 'Uppdragsgivaren AB',
    options: { descriptionPrefix: 'Självfaktura', numberOverride: 'SF-77' },
    posting: USER_CREATED,
  },
  {
    name: 'registration: no open fiscal period, nothing posted',
    kind: 'registration',
    invoice: invoice(7),
    entityType: 'aktiebolag',
    noPeriod: true,
  },
  {
    name: 'credit note: domestic, pointing back at the original verifikat',
    kind: 'credit_note',
    invoice: negate(invoice(8), {
      invoice_number: 'KR-F-1000',
      invoice_date: '2026-09-20',
      credited_invoice_id: invoiceId(0),
    }),
    entityType: 'aktiebolag',
    customerName: 'Kund AB',
    originalVoucherRef: 'B-12',
    posting: STAGED,
  },
  {
    name: 'credit note: a RUT invoice credited back over 1510 and 1513',
    kind: 'credit_note',
    invoice: negate(RUT_INVOICE, {
      id: invoiceId(9),
      invoice_number: 'KR-F-1004',
      invoice_date: '2026-09-21',
      credited_invoice_id: invoiceId(4),
    }),
    entityType: 'aktiebolag',
    customerName: 'Privatkund',
    originalVoucherRef: 'B-14',
    posting: USER_CREATED,
  },
  {
    name: 'credit note: EU business customer in EUR under reverse charge',
    kind: 'credit_note',
    invoice: negate(EUR_INVOICE, {
      id: invoiceId(10),
      invoice_number: 'KR-F-1002',
      invoice_date: '2026-09-22',
      credited_invoice_id: invoiceId(2),
    }),
    entityType: 'aktiebolag',
    customerName: 'Kunde GmbH',
  },
  {
    name: 'credit note: no open fiscal period, nothing posted',
    kind: 'credit_note',
    invoice: negate(invoice(11), { invoice_number: 'KR-F-1011', credited_invoice_id: invoiceId(7) }),
    entityType: 'aktiebolag',
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
          ? await createInvoiceJournalEntry(supabase as never, COMPANY, USER, s.invoice, s.entityType, s.customerName, { ...s.options, posting })
          : await createCreditNoteJournalEntry(supabase as never, COMPANY, USER, s.invoice, s.entityType, s.customerName, s.originalVoucherRef, posting)
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

describe('customer invoice generators engine input (posting port parity)', () => {
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
      kind: 'sale.invoiced',
      category: null,
      occurred_on: '2026-09-01',
      subject_type: 'invoice',
      subject_id: invoiceId(0),
      party_type: 'customer',
      party_id: CUSTOMER,
      currency: 'SEK',
      amount: 1500,
      amount_sek: 1500,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
      idempotency_key: `sale.invoiced:invoice:${invoiceId(0)}`,
    })
    expect(event('registration: domestic at 25 %').mapping_version).toMatch(/^se\.customer-invoice-lines@/)
    expect(event('registration: mixed rates')).toMatchObject({ amount: 1792, tax_amounts: [{ tax: 'vat', amount_sek: 192 }] })
    // Omvänd betalningsskyldighet: the invoice states no moms; the staged approval names its operation.
    expect(event('registration: EU business customer')).toMatchObject({
      currency: 'EUR',
      amount: 200,
      amount_sek: 2300,
      tax_amounts: [],
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
      pending_operation_id: OPERATION,
    })
    // The whole sale, the 1513 share included: who pays which part stays in the lines.
    expect(event('registration: a RUT invoice')).toMatchObject({ amount: 6000, amount_sek: 6000, tax_amounts: [{ amount_sek: 1200 }] })
    // User-edited lines were written by a person: no rule version.
    expect(event('registration: the send dialog')).toMatchObject({ kind: 'sale.invoiced', mapping_version: null })
    // A SEK invoice without its *_sek twins (a received självfaktura) is its own SEK figure.
    expect(event('registration: a received självfaktura')).toMatchObject({ amount_sek: 1500, tax_amounts: [{ amount_sek: 300 }] })
    expect(event('credit note: domestic')).toMatchObject({
      kind: 'sale.credited',
      occurred_on: '2026-09-20',
      subject_type: 'invoice',
      subject_id: invoiceId(8),
      party_id: CUSTOMER,
      amount: 1500,
      amount_sek: 1500,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
      evidence: { link_basis: 'agent_proposed_user_approved' },
      pending_operation_id: OPERATION,
      idempotency_key: `sale.credited:invoice:${invoiceId(8)}`,
    })
    expect(event('credit note: domestic').mapping_version).toMatch(/^se\.customer-invoice-lines@/)
    expect(event('credit note: a RUT invoice')).toMatchObject({ kind: 'sale.credited', amount: 6000, tax_amounts: [{ amount_sek: 1200 }] })
    expect(event('credit note: EU business customer')).toMatchObject({ kind: 'sale.credited', currency: 'EUR', amount: 200, amount_sek: 2300, tax_amounts: [] })
    // Without a context from the door the evidence has no link basis, never a guess.
    expect(event('registration: a periodisering').evidence).toEqual({})
    for (const run of runs) {
      for (const e of run.events) expect(e.id, run.name).toMatch(UUID)
    }
  })
})
