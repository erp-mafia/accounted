/**
 * Posting port, step 3: the callers of the eight SQL posting wrappers of the
 * engine (commitBulkBooking, commitMatchBatchAllocation,
 * commitInvoiceVoucherLink, commitSupplierInvoiceVoucherLink,
 * commitExpensePayoutBatch, replaceOpeningBalanceEntry,
 * commitAssetDepreciation, commitAssetDisposal) move behind the posting port.
 * The move is pure routing, and this pins it where it matters, at the
 * database: each producer runs through its real code and its real engine
 * wrapper against a mock client, and every request the wrapper sends to its
 * SQL function (the function's name and every parameter, the port's event ids
 * named by the order the port recorded them) is compared with a committed
 * fixture (sql-posting-doors.rpc-input.json) taken before the move. The
 * producer's own answer is recorded beside it.
 *
 * Every POSTING_EVENTS mode is pinned: off, shadow, strict, and shadow and
 * strict with every business event write refused (shadow then calls the
 * function as off does, strict calls nothing). The two asset doors draft
 * through the port already (their event is linked to the draft, which is
 * mocked here: its own fixture is asset-service.engine-input.json and
 * depreciation-engine.engine-input.json), so their requests carry no event
 * ids in any mode.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_RPC_INPUT_FIXTURE=1 npx vitest run src/lib/posting/__tests__/sql-posting-doors.rpc-input.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver, type TableMockResult } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { Asset, CreateJournalEntryInput } from '@/types'

// The drafts of the two asset doors (createDraftEntry, through the port's
// draftJournalEntry): pinned by their own engine-input fixtures.
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: vi.fn(),
}))

// Side effects after the function answers, none of which reaches it.
vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: vi.fn(async () => null),
}))
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async () => new Map()),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({ propagateUnderlagForBookedTransaction: vi.fn() }))
vi.mock('@/lib/invoices/already-explained-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/already-explained-guard')>()),
  guardAlreadyExplained: vi.fn(async () => ({ status: 'clear' })),
}))
vi.mock('@/lib/invoices/batch-cash-method-guard', () => ({
  findCashMethodUnbookedAllocations: vi.fn(async () => ({ ok: true, unbooked: [] })),
}))
vi.mock('@/lib/transactions/batch-allocation-events', () => ({ emitBatchAllocationEvents: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-batch-allocations', () => ({ clearSettledBatchAllocationSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({ clearSettledInvoiceSuggestions: vi.fn() }))
vi.mock('@/lib/collections/forward-hook', () => ({ scheduleCollectionForwardDrain: vi.fn() }))
vi.mock('@/lib/invoices/paid-events', () => ({
  emitInvoicePaidIfSettled: vi.fn(),
  emitSupplierInvoicePaidIfSettled: vi.fn(),
}))
vi.mock('@/lib/core/documents/customer-invoice-underlag', () => ({ anchorCustomerInvoiceDocument: vi.fn() }))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({ anchorSupplierInvoiceDocument: vi.fn() }))
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({ autoReconcileTransactionForLinkedVoucher: vi.fn(async () => null) }))
const listed = vi.hoisted(() => ({ assets: [] as unknown[] }))
vi.mock('@/lib/bokslut/assets/asset-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/asset-service')>()),
  listAssets: vi.fn(async () => listed.assets),
}))

const { createDraftEntry } = await import('@/lib/bookkeeping/engine')
const { runWithActor } = await import('@/lib/bookkeeping/actor-context-node')
const { bulkBookTransactions } = await import('@/lib/transactions/bulk-book')
const { matchTransactionBatch } = await import('@/lib/transactions/match-batch')
const { linkInvoiceToVoucher } = await import('@/lib/invoices/voucher-matching')
const { linkSupplierInvoiceToVoucher } = await import('@/lib/invoices/supplier-voucher-matching')
const { createPayoutBatch } = await import('@/lib/expenses/expense-claims-service')
const { cascadeOpeningBalanceCorrection } = await import('@/lib/import/opening-balance/cascade')
const { commitAnnualPostings } = await import('@/lib/bokslut/assets/depreciation-engine')
const { disposeAsset } = await import('@/lib/bokslut/assets/asset-service')

const FIXTURE = path.join(__dirname, 'sql-posting-doors.rpc-input.json')

/** The SQL functions the eight wrappers call: every request to one of them is recorded. */
const SQL_POSTING_FUNCTIONS = [
  'bulk_book_transactions',
  'match_batch_allocate',
  'link_invoice_to_voucher',
  'link_supplier_invoice_to_voucher',
  'create_expense_payout_batch',
  'commit_opening_balance_replacement',
  'commit_asset_depreciation',
  'commit_asset_disposal',
] as const

const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const NEXT_PERIOD = '00000000-0000-4000-8000-00000000f002'
const TX_1 = '00000000-0000-4000-8000-0000000b0001'
const TX_2 = '00000000-0000-4000-8000-0000000b0002'
const INVOICE_1 = '00000000-0000-4000-8000-0000000d0001'
const INVOICE_2 = '00000000-0000-4000-8000-0000000d0002'
const CUSTOMER = '00000000-0000-4000-8000-0000000e0001'
const SUPPLIER_INVOICE = '00000000-0000-4000-8000-0000000d0101'
const SUPPLIER = '00000000-0000-4000-8000-0000000e0101'
const VOUCHER = '00000000-0000-4000-8000-000000009001'
const OLD_IB = '00000000-0000-4000-8000-000000009101'
const CLAIM_1 = '00000000-0000-4000-8000-0000000c1001'
const CLAIM_2 = '00000000-0000-4000-8000-0000000c1002'
const EMPLOYEE = '00000000-0000-4000-8000-0000000e0201'

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
} as unknown as Logger
const ctx = (supabase: unknown) => ({ supabase: supabase as never, companyId: COMPANY, userId: USER, log: silentLog })

type Tables = Record<string, TableMockResult | TableMockResult[] | TableMockResolver>
type Chain = Array<{ method: string; args: unknown[] }>

const POSTED = { id: 'je-posted', company_id: COMPANY, status: 'posted', voucher_series: 'A', voucher_number: 41, lines: [] }

function asset(index: number, overrides: Partial<Asset> = {}): Asset {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    user_id: USER,
    company_id: COMPANY,
    name: 'Fräsmaskin',
    category: 'equipment',
    acquisition_date: '2026-01-01',
    acquisition_cost: 60000,
    salvage_value: 0,
    useful_life_months: 60,
    depreciation_method: 'linear',
    bas_asset_account: '1220',
    bas_accumulated_account: '1229',
    bas_expense_account: '7832',
    restvarde_target: null,
    disposed_at: null,
    disposed_proceeds: null,
    disposal_type: null,
    disposal_journal_entry_id: null,
    disposed_proceeds_vat: 0,
    disposed_vat_treatment: null,
    jamkning_amount: 0,
    jamkning_remaining_months: null,
    jamkning_total_months: null,
    jamkning_original_input_vat: null,
    k3_components: null,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Asset
}

interface Scenario {
  name: string
  /** What each table (and 'rpc:<name>') answers. */
  tables: Tables
  run: (supabase: unknown) => Promise<unknown>
  /** The assets listAssets answers (the depreciation door). */
  assets?: Asset[]
}

const BANK_ROW = (id: string, amount: number, description: string) => ({
  id,
  amount,
  currency: 'SEK',
  description,
  merchant_name: null,
  date: '2026-03-31',
  amount_sek: amount,
  exchange_rate: null,
  cash_account_id: null,
  journal_entry_id: null,
  external_id: null,
  import_source: null,
  bank_connection_id: null,
})

const SCENARIOS: Scenario[] = [
  {
    name: 'bulk_book_transactions: a new samlingsverifikat of two bank lines, manual lines',
    tables: {
      transactions: { data: [BANK_ROW(TX_1, -300, 'Bankavgift mars'), BANK_ROW(TX_2, -200, 'Bankavgift kort')] },
      chart_of_accounts: { data: [{ account_number: '6570' }, { account_number: '1930' }] },
      account_dimension_rules: { data: [] },
      'rpc:bulk_book_transactions': {
        data: { ok: true, mode: 'create_new', journal_entry_id: 'je-bulk', voucher_series: 'A', voucher_number: 7, linked_tx_count: 2, tx_sum: -500, docs_linked: 0 },
      },
      journal_entries: { data: POSTED },
    },
    run: (supabase) =>
      bulkBookTransactions(ctx(supabase), {
        tx_ids: [TX_1, TX_2],
        entry_description: 'Bankavgifter mars',
        manual_lines: [
          { account_number: '6570', debit_amount: 500, credit_amount: 0, currency: 'SEK', line_description: 'Bankavgifter' },
          { account_number: '1930', debit_amount: 0, credit_amount: 500, currency: 'SEK' },
        ],
      } as never),
  },
  {
    name: 'bulk_book_transactions: two bank lines linked to a posted verifikat (no event)',
    tables: {
      transactions: { data: [BANK_ROW(TX_1, -300, 'Stripe'), BANK_ROW(TX_2, -200, 'Stripe')] },
      'rpc:bulk_book_transactions': {
        data: { ok: true, mode: 'link_existing', journal_entry_id: VOUCHER, voucher_series: 'A', voucher_number: 3, linked_tx_count: 2, tx_sum: -500, docs_linked: 0 },
      },
    },
    run: (supabase) => bulkBookTransactions(ctx(supabase), { tx_ids: [TX_1, TX_2], existing_journal_entry_id: VOUCHER } as never),
  },
  {
    name: 'match_batch_allocate: one bank line against two customer invoices',
    tables: {
      invoices: {
        data: [
          { id: INVOICE_1, document_type: 'invoice', customer_id: CUSTOMER, currency: 'SEK', remaining_amount: 1250, total: 1250 },
          { id: INVOICE_2, document_type: 'invoice', customer_id: CUSTOMER, currency: 'SEK', remaining_amount: 500, total: 500 },
        ],
      },
      transactions: { data: { date: '2026-04-02', currency: 'SEK' } },
      'rpc:match_batch_allocate': {
        data: { ok: true, tx_id: TX_1, journal_entry_id: 'je-batch', voucher_series: 'A', voucher_number: 12, allocations: [], total_allocated: 1750, leftover: 0 },
      },
      journal_entries: { data: POSTED },
    },
    run: (supabase) =>
      matchTransactionBatch(ctx(supabase), TX_1, {
        allocations: [
          { kind: 'customer_invoice', invoice_id: INVOICE_1, amount: 1250 },
          { kind: 'customer_invoice', invoice_id: INVOICE_2, amount: 500 },
        ],
      } as never),
  },
  {
    name: 'link_invoice_to_voucher: a EUR invoice settled by a kronor verifikat (kursdifferens event)',
    tables: {
      invoices: { data: { id: INVOICE_1, customer_id: CUSTOMER, currency: 'EUR', total: 100, paid_amount: 0, remaining_amount: 100 } },
      journal_entries: (chain: Chain) => ({ data: chain.some((c) => c.method === 'single') ? POSTED : { entry_date: '2026-05-04' } }),
      'rpc:link_invoice_to_voucher': {
        data: {
          ok: true, payment_id: 'pay-1', invoice_status: 'paid', paid_amount: 100, remaining_amount: 0, payment_amount: 100,
          journal_entry_id: VOUCHER, currency: 'EUR', payment_date: '2026-05-04', fx_journal_entry_id: 'je-fx',
        },
      },
    },
    run: (supabase) => linkInvoiceToVoucher(supabase as never, USER, COMPANY, { invoiceId: INVOICE_1, journalEntryId: VOUCHER, notes: 'Länkad' }),
  },
  {
    name: 'link_invoice_to_voucher: a kronor invoice (no event)',
    tables: {
      invoices: { data: { id: INVOICE_1, customer_id: CUSTOMER, currency: 'SEK', total: 1250, paid_amount: 0, remaining_amount: 1250 } },
      'rpc:link_invoice_to_voucher': {
        data: {
          ok: true, payment_id: 'pay-1', invoice_status: 'partially_paid', paid_amount: 1000, remaining_amount: 250, payment_amount: 1000,
          journal_entry_id: VOUCHER, currency: 'SEK', payment_date: '2026-05-04', fx_journal_entry_id: null,
        },
      },
    },
    run: (supabase) => linkInvoiceToVoucher(supabase as never, USER, COMPANY, { invoiceId: INVOICE_1, journalEntryId: VOUCHER }),
  },
  {
    name: 'link_supplier_invoice_to_voucher: a EUR invoice settled by a kronor verifikat (kursdifferens event)',
    tables: {
      supplier_invoices: { data: { id: SUPPLIER_INVOICE, supplier_id: SUPPLIER, currency: 'EUR', total: 80, paid_amount: 0, remaining_amount: 80 } },
      journal_entries: (chain: Chain) => ({ data: chain.some((c) => c.method === 'single') ? POSTED : { entry_date: '2026-05-06' } }),
      'rpc:link_supplier_invoice_to_voucher': {
        data: {
          ok: true, payment_id: 'spay-1', invoice_status: 'paid', paid_amount: 80, remaining_amount: 0, payment_amount: 80,
          journal_entry_id: VOUCHER, fx_journal_entry_id: 'je-fx', voucher_remaining: 0,
        },
      },
    },
    run: (supabase) =>
      linkSupplierInvoiceToVoucher(supabase as never, USER, COMPANY, { supplierInvoiceId: SUPPLIER_INVOICE, journalEntryId: VOUCHER, notes: 'Auto-länkad' }),
  },
  {
    name: 'link_supplier_invoice_to_voucher: a stated share of a verifikat that pays several (no event, p_amount)',
    tables: {
      supplier_invoices: { data: { id: SUPPLIER_INVOICE, supplier_id: SUPPLIER, currency: 'EUR', total: 80, paid_amount: 0, remaining_amount: 80 } },
      'rpc:link_supplier_invoice_to_voucher': {
        data: {
          ok: true, payment_id: 'spay-1', invoice_status: 'partially_paid', paid_amount: 40, remaining_amount: 40, payment_amount: 40,
          journal_entry_id: VOUCHER, fx_journal_entry_id: null, voucher_remaining: 60,
        },
      },
    },
    run: (supabase) =>
      linkSupplierInvoiceToVoucher(supabase as never, USER, COMPANY, { supplierInvoiceId: SUPPLIER_INVOICE, journalEntryId: VOUCHER, amount: 40 }),
  },
  {
    name: 'create_expense_payout_batch: two utlägg repaid in one transfer',
    tables: {
      expense_claims: {
        data: [
          { id: CLAIM_1, employee_id: EMPLOYEE, amount_sek: 450, document_id: null },
          { id: CLAIM_2, employee_id: EMPLOYEE, amount_sek: 120.5, document_id: null },
        ],
      },
      'rpc:create_expense_payout_batch': {
        data: { ok: true, batch_id: 'batch-1', journal_entry_id: 'je-payout', voucher_number: 19, total_sek: 570.5, claim_count: 2 },
      },
      journal_entries: { data: POSTED },
    },
    run: (supabase) =>
      createPayoutBatch(supabase as never, COMPANY, USER, {
        claim_ids: [CLAIM_1, CLAIM_2, CLAIM_1],
        payout_date: '2026-06-10',
        cash_account: '1930',
        notes: 'Utlägg maj',
        transaction_id: TX_1,
      } as never),
  },
  {
    name: 'commit_opening_balance_replacement: the IB cascade replaces a later year\'s IB',
    tables: {
      fiscal_periods: {
        data: [
          {
            id: NEXT_PERIOD, name: '2027', period_start: '2027-01-01', is_closed: false, locked_at: null,
            opening_balance_entry_id: OLD_IB, opening_balance_entry: { voucher_series: 'IB', voucher_number: 1 },
          },
        ],
      },
      journal_entries: (chain: Chain) => {
        // The year-end check (a head count), the old IB's header, then the reload of the three verifikat.
        if (chain.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head)) return { data: null, count: 0 }
        if (chain.some((c) => c.method === 'range')) return { data: [{ id: OLD_IB }] }
        return { data: [] }
      },
      journal_entry_lines: {
        data: [
          { id: 'l1', journal_entry_id: OLD_IB, account_number: '1930', debit_amount: 10000, credit_amount: 0, line_description: 'Bank', dimensions: null },
          { id: 'l2', journal_entry_id: OLD_IB, account_number: '2091', debit_amount: 0, credit_amount: 10000, line_description: null, dimensions: null },
        ],
      },
      chart_of_accounts: { data: [{ id: 'acc-1930', account_number: '1930' }, { id: 'acc-2091', account_number: '2091' }, { id: 'acc-1510', account_number: '1510' }] },
      'rpc:commit_opening_balance_replacement': {
        data: [{ new_entry_id: 'je-ib-new', storno_entry_id: 'je-ib-storno', new_voucher_number: 2, storno_voucher_number: 3 }],
      },
    },
    run: (supabase) =>
      cascadeOpeningBalanceCorrection(supabase as never, COMPANY, USER, {
        basePeriodStart: '2026-01-01',
        deltas: new Map([['1510', 400], ['2091', -400]]),
        lockDate: null,
        log: silentLog,
      }),
  },
  {
    name: 'commit_asset_depreciation: the planenlig avskrivning of two assets',
    assets: [asset(1), asset(2, { name: 'Server', acquisition_date: '2026-04-01', acquisition_cost: 36000, useful_life_months: 36 })],
    tables: {
      fiscal_periods: { data: { id: PERIOD, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' } },
      depreciation_schedules: { data: [] },
      'rpc:commit_asset_depreciation': { data: [{ voucher_number: 5, schedule_id: 'sched-1' }] },
      journal_entries: { data: POSTED },
    },
    run: (supabase) => commitAnnualPostings(supabase as never, COMPANY, USER, PERIOD),
  },
  {
    name: 'commit_asset_disposal: a sale with 25 % moms',
    tables: {
      assets: { data: asset(3, { name: 'Lastbil' }) },
      fiscal_periods: { data: [{ id: PERIOD, period_start: '2026-01-01', period_end: '2026-12-31' }] },
      depreciation_schedules: { data: [] },
      'rpc:commit_asset_disposal': { data: null },
      journal_entries: { data: POSTED },
    },
    run: (supabase) =>
      disposeAsset(supabase as never, COMPANY, USER, asset(3).id, {
        disposal_type: 'sale',
        disposed_at: '2026-06-30',
        disposed_proceeds: 50000,
        vat_treatment: 'standard_25',
        fiscal_period_id: PERIOD,
      }),
  },
  {
    name: 'commit_asset_disposal: a fully written-off asset scrapped for nothing (no verifikat)',
    tables: {
      assets: { data: asset(4, { name: 'Gammal skärm', acquisition_cost: 0, useful_life_months: 36 }) },
      fiscal_periods: { data: [{ id: PERIOD, period_start: '2026-01-01', period_end: '2026-12-31' }] },
      depreciation_schedules: { data: [] },
      'rpc:commit_asset_disposal': { data: null },
    },
    run: (supabase) =>
      disposeAsset(supabase as never, COMPANY, USER, asset(4).id, {
        disposal_type: 'scrap',
        disposed_at: '2026-04-30',
        disposed_proceeds: 0,
        fiscal_period_id: PERIOD,
      }),
  },
]

interface Mode {
  label: string
  env: string
  refuseEvents: boolean
}

const MODES: Mode[] = [
  { label: 'off', env: '', refuseEvents: false },
  { label: 'shadow', env: 'shadow', refuseEvents: false },
  { label: 'strict', env: 'strict', refuseEvents: false },
  { label: 'shadow, every event write refused', env: 'shadow', refuseEvents: true },
  { label: 'strict, every event write refused', env: 'strict', refuseEvents: true },
]

/** A request's event ids named by the order the port recorded the events: '<event 0>', ... */
function nameEvents(params: unknown, eventIds: string[]): unknown {
  if (!params || typeof params !== 'object' || !('p_event_ids' in params)) return params
  const ids = (params as { p_event_ids: Array<string | null> }).p_event_ids
  return {
    ...params,
    p_event_ids: ids.map((id) => (id === null ? null : eventIds.includes(id) ? `<event ${eventIds.indexOf(id)}>` : '<unrecorded id>')),
  }
}

/** What a JSON fixture can hold of an answer: Error objects and Maps reduced to their JSON. */
function asJson(value: unknown): unknown {
  return value === undefined ? '<undefined>' : JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Map ? [...v] : v)))
}

interface Recorded {
  name: string
  requests: Array<[string, unknown]>
  answer: unknown
}

async function runMode(mode: Mode): Promise<Recorded[]> {
  vi.stubEnv('POSTING_EVENTS', mode.env)
  const out: Recorded[] = []
  for (const scenario of SCENARIOS) {
    listed.assets = scenario.assets ?? []
    let drafts = 0
    vi.mocked(createDraftEntry).mockReset()
    vi.mocked(createDraftEntry).mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => {
      drafts++
      return { id: `je-draft-${drafts}`, status: 'draft', fiscal_period_id: input.fiscal_period_id, entry_date: input.entry_date } as never
    })
    const { supabase, calls, payloads } = createTableMockSupabase({
      ...scenario.tables,
      business_events: mode.refuseEvents ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    let answer: unknown
    try {
      answer = await runWithActor({ type: 'user' }, () => scenario.run(supabase))
    } catch (err) {
      answer = { threw: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
    }
    const eventIds = (payloads('business_events', 'insert') as Array<{ id: string }>).map((row) => row.id)
    const requests = calls
      .filter((c) => c.method === 'rpc' && (SQL_POSTING_FUNCTIONS as readonly string[]).includes(c.table.slice('rpc:'.length)))
      .map((c): [string, unknown] => [c.table.slice('rpc:'.length), nameEvents(c.args[0], eventIds)])
    out.push({ name: scenario.name, requests, answer: asJson(answer) })
  }
  return out
}

describe('the SQL posting doors through the posting port: what each SQL function is sent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('sends every SQL posting function exactly the requests it got before the move, in every POSTING_EVENTS mode', async () => {
    const recorded: Record<string, Recorded[]> = {}
    for (const mode of MODES) recorded[mode.label] = await runMode(mode)
    if (process.env.UPDATE_RPC_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
  })

  it('covers each of the eight functions, with event ids in shadow and strict where it drafts a verifikat', async () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, Recorded[]>
    const fns = (label: string) => new Set(fixture[label]!.flatMap((r) => r.requests.map(([fn]) => fn)))
    for (const label of ['off', 'shadow', 'strict', 'shadow, every event write refused']) {
      expect([...fns(label)].sort(), label).toEqual([...SQL_POSTING_FUNCTIONS].sort())
    }
    const withIds = (label: string) =>
      fixture[label]!.flatMap((r) => r.requests.filter(([, params]) => params && typeof params === 'object' && 'p_event_ids' in params))
    expect(withIds('off')).toEqual([])
    expect(withIds('shadow, every event write refused')).toEqual([])
    expect(new Set(withIds('shadow').map(([fn]) => fn))).toEqual(
      new Set(['bulk_book_transactions', 'match_batch_allocate', 'link_invoice_to_voucher', 'link_supplier_invoice_to_voucher', 'create_expense_payout_batch', 'commit_opening_balance_replacement']),
    )
    // Strict with every event write refused sends a function nothing whenever
    // an event was to be recorded; what records none goes through: a link to
    // a posted verifikat, a voucher link in kronor or with a stated share, and
    // a disposal that books no verifikat (the register update alone).
    expect(fns('strict, every event write refused')).toEqual(
      new Set(['bulk_book_transactions', 'link_invoice_to_voucher', 'link_supplier_invoice_to_voucher', 'commit_asset_disposal']),
    )
    expect(
      fixture['strict, every event write refused']!.filter((r) => r.requests.length > 0).map((r) => r.name),
    ).toEqual([
      'bulk_book_transactions: two bank lines linked to a posted verifikat (no event)',
      'link_invoice_to_voucher: a kronor invoice (no event)',
      'link_supplier_invoice_to_voucher: a stated share of a verifikat that pays several (no event, p_amount)',
      'commit_asset_disposal: a fully written-off asset scrapped for nothing (no verifikat)',
    ])
  })
})
