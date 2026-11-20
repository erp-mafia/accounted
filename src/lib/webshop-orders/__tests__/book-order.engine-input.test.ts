/**
 * Posting port, step 2: what bookOrderThroughEngine hands the engine,
 * recorded call by call and compared with a committed fixture
 * (book-order.engine-input.json) that was taken before the producer went
 * through the port. The order is booked draft -> claim -> commit, so both
 * engine calls are recorded: every argument, an absent one as '<undefined>',
 * so an extra argument or a changed input fails here.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/webshop-orders/__tests__/book-order.engine-input.test.ts
 *
 * Since the producer drafts and commits through the posting port, the
 * scenarios also run with POSTING_EVENTS=shadow: the draft must get the same
 * four arguments plus only the event link, the commit exactly the same
 * arguments, and a refused event write must still post.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput, WebshopOrder } from '@/types'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
}))
vi.mock('@/lib/webshop-orders/ensure-accounts', () => ({ ensureWebshopPrefillAccounts: vi.fn(async () => undefined) }))
vi.mock('@/lib/webshop-orders/order-underlag', () => ({ archiveWebshopOrderUnderlag: vi.fn(async () => ({ ok: true })) }))

const { createDraftEntry, commitEntry } = await import('@/lib/bookkeeping/engine')
const { bookOrderThroughEngine } = await import('../book-order')
const { buildOrderBookingLines, orderBookingDescription } = await import('../booking-lines')
type EngineInput = Parameters<typeof bookOrderThroughEngine>[4]

const mockedDraft = vi.mocked(createDraftEntry)
const mockedCommit = vi.mocked(commitEntry)

const FIXTURE = path.join(__dirname, 'book-order.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

function order(index: number, overrides: Partial<WebshopOrder>): WebshopOrder {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    company_id: COMPANY,
    user_id: USER,
    platform: 'woocommerce',
    store_scope: 'butik.example.se',
    store_label: null,
    connection_id: null,
    row_type: 'order',
    parent_order_id: null,
    external_id: `woo_butik.example.se_order_${1001 + index}`,
    platform_order_id: String(1001 + index),
    order_number: String(1001 + index),
    status: 'processing',
    is_paid: true,
    order_date: '2026-08-01',
    paid_date: '2026-08-01',
    currency: 'SEK',
    total: 500,
    total_tax: 100,
    total_sek: 500,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
    line_items: [],
    customer_name: null,
    customer_company: null,
    customer_email: null,
    customer_orgnr: null,
    customer_country: 'SE',
    payment_method: 'swish',
    payment_method_title: 'Swish',
    gateway_reference: null,
    refunded_total: 0,
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    remote_changed_after_freeze: false,
    manually_booked_at: null,
    manually_booked_by: null,
    manually_booked_journal_entry_id: null,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
    ...overrides,
  } as WebshopOrder
}

interface Scenario {
  name: string
  order: WebshopOrder
  extra?: Partial<EngineInput>
}

const SCENARIOS: Scenario[] = [
  { name: 'paid order in SEK at 25 % moms', order: order(0, {}) },
  {
    name: 'refund row of an order',
    order: order(1, {
      row_type: 'refund',
      parent_order_id: '00000000-0000-4000-8000-000000000001',
      external_id: 'woo_butik.example.se_refund_9001',
      order_date: '2026-08-05',
      paid_date: null,
      total: -125,
      total_tax: -25,
      total_sek: -125,
      vat_breakdown: [{ rate: 25, net: 100, tax: 25 }],
    }),
  },
  {
    name: 'order in euro with a resolved SEK total, two rates',
    order: order(2, {
      currency: 'EUR',
      order_date: '2026-08-10',
      paid_date: '2026-08-11',
      total: 61.2,
      total_tax: 9,
      total_sek: 688.5,
      exchange_rate: 11.25,
      vat_breakdown: [
        { rate: 25, net: 40, tax: 10 },
        { rate: 12, net: 10, tax: 1.2 },
      ],
      customer_country: 'DE',
    }),
  },
  {
    name: 'order with its own verifikationsserie and a note',
    order: order(3, { order_date: '2026-08-12', paid_date: '2026-08-12', payment_method: 'stripe', payment_method_title: 'Kort' }),
    extra: { voucher_series: 'W', notes: 'Underlag: orderunderlag från butiken.' },
  },
]

function engineInput(s: Scenario): EngineInput {
  return {
    fiscal_period_id: PERIOD,
    entry_date: s.order.paid_date ?? s.order.order_date,
    description: orderBookingDescription(s.order),
    lines: buildOrderBookingLines({ order: s.order }),
    ...s.extra,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

interface Run {
  name: string
  createDraftEntry: unknown[][]
  commitEntry: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedDraft.mockReset()
    mockedCommit.mockReset()
    const entryId = `je-${index}`
    mockedDraft.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: entryId, ...input }) as never)
    mockedCommit.mockImplementation(async () => ({ id: entryId, voucher_series: 'A', voucher_number: index + 1 }) as never)
    const { supabase, findCalls } = createTableMockSupabase({
      webshop_orders: { data: [{ id: s.order.id }] },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const outcome = await bookOrderThroughEngine(supabase as never, COMPANY, USER, s.order, engineInput(s), log)
    expect(outcome.ok, `${s.name}: ${JSON.stringify(outcome)}`).toBe(true)
    out.push({
      name: s.name,
      createDraftEntry: mockedDraft.mock.calls.map((c) => record(c as unknown[])),
      commitEntry: mockedCommit.mock.calls.map((c) => record(c as unknown[])),
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('bookOrderThroughEngine engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, createDraftEntry: draft, commitEntry: commit }) => ({
      name,
      createDraftEntry: draft,
      commitEntry: commit,
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
      expect(run.createDraftEntry, run.name).toHaveLength(1)
      expect(before.createDraftEntry[0]![0]).toBe(4)
      expect(run.createDraftEntry[0]![0], run.name).toBe(5)
      expect(run.createDraftEntry[0]!.slice(1, 5), run.name).toEqual(before.createDraftEntry[0]!.slice(1, 5))
      expect(run.createDraftEntry[0]![5], run.name).toEqual({
        businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' },
      })
      expect(run.commitEntry, run.name).toEqual(before.commitEntry)
      expect(run.events, run.name).toHaveLength(1)
      expect((run.createDraftEntry[0]![5] as { businessEvent: { id: string } }).businessEvent.id).toBe(run.events[0]!.id)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off calls', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => [r.createDraftEntry, r.commitEntry])).toEqual(off.map((r) => [r.createDraftEntry, r.commitEntry]))
    expect(refused.map((r) => r.events.length)).toEqual(refused.map(() => 1))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name === name)!.events[0]!
    expect(event('paid order in SEK at 25 % moms')).toMatchObject({
      kind: 'sale.webshop_order',
      category: 'income.sales',
      occurred_on: '2026-08-01',
      subject_type: null,
      party_type: null,
      currency: 'SEK',
      amount: 500,
      amount_sek: 500,
      tax_amounts: [{ tax: 'vat', treatment: null, amount_sek: 100 }],
      evidence: { direction: 'in', link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('paid order in SEK at 25 % moms').mapping_version).toMatch(/^se\.webshop-order-lines@/)
    // A refund is the same kind, money going out: magnitudes, the direction says which way.
    expect(event('refund row of an order')).toMatchObject({
      occurred_on: '2026-08-05',
      amount: 125,
      amount_sek: 125,
      tax_amounts: [{ tax: 'vat', amount_sek: 25 }],
      evidence: { direction: 'out' },
    })
    expect(event('order in euro with a resolved SEK total, two rates')).toMatchObject({
      occurred_on: '2026-08-11',
      currency: 'EUR',
      amount: 61.2,
      amount_sek: 688.5,
      tax_amounts: [{ tax: 'vat', amount_sek: 101.25 }],
    })
  })
})
