/**
 * Posting port, step 2f-2: what settleInvoicePayment (the write path of the
 * dashboard and v1 mark-paid routes, the staged mark_invoice_paid and the
 * kontantfaktura at issue) hands the engine, recorded call by call and
 * compared with a committed fixture (settle-invoice-payment.engine-input.json)
 * that was taken before the payments went through the port. Its three
 * shapes: the person's own rows (booked by the door itself), the generated
 * kontantmetoden entry (createInvoiceCashEntry, also for a kontantfaktura)
 * and the generated 1510 clearing (createInvoicePaymentJournalEntry). The
 * generators run for real; only the engine's createJournalEntry and
 * findFiscalPeriod are recorded. Every argument of every call is recorded,
 * an absent one as '<undefined>'; trailing undefined arguments are dropped
 * before the comparison (the ledger adapter fills createJournalEntry's
 * commitMethod and rubricVersion positions, which a four-argument call
 * receives as undefined, the value its omitted optional parameters had).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/invoices/__tests__/settle-invoice-payment.engine-input.test.ts
 *
 * Since the payments post through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow and strict: the engine must get the same
 * arguments plus only the event link (one sale.payment_received per payment,
 * with the payment row's link basis and the debt it settles), a refused event
 * write must still post under shadow, and under strict stop the posting
 * before the engine is called, leaving no payment row and the invoice as it
 * was.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Whether a credit note is active: mocked so it takes no slot in the Supabase
// mock; the read is pinned by lib/invoices/__tests__/active-credit-note.test.ts.
const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput, Invoice, InvoiceItem } from '@/types'
import type { SettleInvoicePaymentParams } from '../settle-invoice-payment'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
}))
// The settlement's own side effects after the posting: not what this records.
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({ clearSettledInvoiceSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/paid-events', () => ({ emitInvoicePaidIfSettled: vi.fn() }))

const { createJournalEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { settleInvoicePayment } = await import('../settle-invoice-payment')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)

const FIXTURE = path.join(__dirname, 'settle-invoice-payment.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const CUSTOMER = '00000000-0000-4000-8000-00000000b001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

type SettledInvoice = Omit<Invoice, 'customer'> & { items?: InvoiceItem[]; customer?: { name: string } | null; journal_entry_id?: string | null }

function invoice(index: number, overrides: Partial<SettledInvoice> = {}): SettledInvoice {
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
    journal_entry_id: `00000000-0000-4000-8000-9${String(index + 1).padStart(11, '0')}`,
    customer: { name: 'Kund AB' },
    items: [
      {
        id: `item-${index}`,
        invoice_id: invoiceId(index),
        sort_order: 0,
        line_type: 'product',
        description: 'Konsulttimmar',
        quantity: 12,
        unit: 'tim',
        unit_price: 100,
        line_total: 1200,
        vat_rate: 25,
        vat_amount: 300,
        created_at: '2026-09-01T00:00:00Z',
      } as InvoiceItem,
    ],
    ...overrides,
  } as SettledInvoice
}

type Params = Omit<SettleInvoicePaymentParams, 'invoice' | 'entityType'> & { entityType?: SettleInvoicePaymentParams['entityType'] }

interface Scenario {
  name: string
  invoice: SettledInvoice
  params: Params
  noPeriod?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'clearing: an issued invoice paid in full (mark-paid without lines)',
    invoice: invoice(0),
    params: { settlementAccountNumber: '1930', paymentAmountInInvoiceCurrency: 1500, paymentDate: '2026-09-15', accountingMethod: 'accrual', paymentSource: 'manual' },
  },
  {
    name: 'clearing: an EUR invoice with a kursvinst, to the account the invoice asked for',
    invoice: invoice(1, {
      currency: 'EUR',
      exchange_rate: 11.5,
      subtotal: 200,
      subtotal_sek: 2300,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 200,
      total_sek: 2300,
      remaining_amount: 200,
      vat_treatment: 'reverse_charge',
    }),
    params: {
      paymentAmountInInvoiceCurrency: 200,
      paymentDate: '2026-09-16',
      accountingMethod: 'accrual',
      exchangeRateDifference: 40,
      settlementAccountNumber: '1931',
      paymentSource: 'manual',
    },
  },
  {
    name: 'clearing: a Stripe payment into the PSP balance on 1686',
    invoice: invoice(2),
    params: {
      paymentAmountInInvoiceCurrency: 1500,
      paymentDate: '2026-09-17',
      accountingMethod: 'accrual',
      settlementAccountNumber: '1686',
      paymentSource: 'stripe',
      externalRef: 'pi_123',
    },
  },
  {
    name: 'cash: kontantmetoden books a never-booked invoice with its moms',
    invoice: invoice(3, { journal_entry_id: null }),
    params: { settlementAccountNumber: '1930', paymentAmountInInvoiceCurrency: 1500, paymentDate: '2026-09-18', accountingMethod: 'cash', paymentSource: 'manual' },
  },
  {
    name: 'cash: a kontantfaktura paid at issue under faktureringsmetoden',
    invoice: invoice(4, { journal_entry_id: null }),
    params: {
      paymentAmountInInvoiceCurrency: 1500,
      paymentDate: '2026-09-01',
      accountingMethod: 'accrual',
      settlementAccountNumber: '1930',
      paymentSource: 'manual',
      recognizeSaleAtPayment: true,
    },
  },
  {
    name: "own rows: a partial payment on the person's rows",
    invoice: invoice(5),
    params: {
      settlementAccountNumber: '1930', paymentAmountInInvoiceCurrency: 600,
      paymentDate: '2026-09-19',
      accountingMethod: 'accrual',
      paymentSource: 'manual',
      customLines: [
        { account_number: '1930', debit_amount: 600, credit_amount: 0, line_description: 'Delbetalning' },
        { account_number: '1510', debit_amount: 0, credit_amount: 600 },
      ],
    },
  },
  {
    name: "own rows: kontantmetoden on the person's rows books as a cash payment",
    invoice: invoice(6, { journal_entry_id: null, customer: null }),
    params: {
      settlementAccountNumber: '1930', paymentAmountInInvoiceCurrency: 1500,
      paymentDate: '2026-09-20',
      accountingMethod: 'cash',
      paymentSource: 'manual',
      customLines: [
        { account_number: '1930', debit_amount: 1500, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1200 },
        { account_number: '2611', debit_amount: 0, credit_amount: 300 },
      ],
    },
  },
  {
    name: "own rows: no open fiscal period, refused before the engine",
    invoice: invoice(7),
    params: {
      settlementAccountNumber: '1930', paymentAmountInInvoiceCurrency: 1500,
      paymentDate: '2026-09-21',
      accountingMethod: 'accrual',
      paymentSource: 'manual',
      customLines: [
        { account_number: '1930', debit_amount: 1500, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1500 },
      ],
    },
    noPeriod: true,
  },
  {
    name: 'clearing: no open fiscal period, refused',
    invoice: invoice(8),
    params: { settlementAccountNumber: '1930', paymentAmountInInvoiceCurrency: 1500, paymentDate: '2026-09-22', accountingMethod: 'accrual', paymentSource: 'manual' },
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
  /** The writes after the posting: the payment row and the invoice's status. */
  writes: { paymentRows: number; invoiceUpdates: number }
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
      invoice_payments: { data: { id: `ip-${index}` } },
      invoices: { data: [{ id: s.invoice.id }] },
    })
    const result = await settleInvoicePayment(supabase as never, COMPANY, USER, {
      entityType: 'aktiebolag',
      ...s.params,
      invoice: s.invoice,
    })
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      outcome: result.ok ? { ok: true, status: result.newStatus, journalEntryId: result.journalEntryId } : { ok: false, code: result.code },
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
      writes: { paymentRows: findCalls('invoice_payments', 'insert').length, invoiceUpdates: findCalls('invoices', 'update').length },
    })
  }
  return out
}

describe('settleInvoicePayment engine input (posting port parity)', () => {
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
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()

    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.writes, run.name).toEqual(before.writes)
      expect(run.calls, run.name).toHaveLength(before.calls.length)
      expect(run.events, run.name).toHaveLength(before.calls.length)
      for (const [j, call] of run.calls.entries()) {
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
    expect(refused.map(({ calls, outcome, writes }) => ({ calls, outcome, writes }))).toEqual(
      off.map(({ calls, outcome, writes }) => ({ calls, outcome, writes })),
    )
  })

  it('with POSTING_EVENTS=strict a refused event write stops the payment before the engine, with nothing written', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const [i, run] of refused.entries()) {
      expect(run.calls, run.name).toEqual([])
      if (off[i]!.calls.length === 0) {
        expect(run.outcome, run.name).toEqual(off[i]!.outcome)
      } else {
        expect(run.outcome, run.name).toEqual({ ok: false, code: 'BOOKKEEPING_ERROR' })
        expect(run.writes, run.name).toEqual({ paymentRows: 0, invoiceUpdates: 0 })
      }
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name.startsWith(name))!.events[0]!

    expect(event('clearing: an issued invoice paid in full')).toMatchObject({
      kind: 'sale.payment_received',
      category: null,
      occurred_on: '2026-09-15',
      subject_type: 'invoice',
      subject_id: invoiceId(0),
      party_type: 'customer',
      party_id: CUSTOMER,
      currency: 'SEK',
      amount: 1500,
      amount_sek: 1500,
      tax_amounts: [],
      // The payment row's basis: the person said the invoice is paid.
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('clearing: an issued invoice paid in full').mapping_version).toMatch(/^se\.customer-payment-lines@/)
    expect(event('clearing: an EUR invoice')).toMatchObject({ currency: 'EUR', amount: 200, amount_sek: 2340, tax_amounts: [] })
    // A payment sync: nobody chose the pair; its reference rides along.
    expect(event('clearing: a Stripe payment')).toMatchObject({
      amount_sek: 1500,
      evidence: { link_basis: 'system_derived', link_evidence: { source_system: 'stripe', reference: 'pi_123' } },
    })
    // The sale is booked at payment: its moms rides along.
    for (const name of ['cash: kontantmetoden books', 'cash: a kontantfaktura']) {
      expect(event(name), name).toMatchObject({ amount: 1500, amount_sek: 1500, tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }] })
      expect(event(name).mapping_version, name).toMatch(/^se\.customer-payment-lines@/)
    }
    // The person's own rows: the debt settled, but no rule and no payment account.
    expect(event("own rows: a partial payment")).toMatchObject({ amount: 600, amount_sek: null, mapping_version: null, tax_amounts: [] })
    expect(event("own rows: kontantmetoden")).toMatchObject({ amount: 1500, amount_sek: null, mapping_version: null, tax_amounts: [{ amount_sek: 300 }] })
    for (const run of runs) {
      for (const e of run.events) expect(e.id, run.name).toMatch(UUID)
    }
  })
})
