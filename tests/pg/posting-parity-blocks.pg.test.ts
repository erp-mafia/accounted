/**
 * Posting port, step 2: proof that booking output does not change when the
 * expense and mileage block and the kassa and webbshop block move onto the
 * port.
 *
 * Each producer is driven through its real door on a freshly seeded company:
 * registerExpenseClaim and deleteExpenseClaim (utlägg and their storno),
 * bookMileagePeriod (milersättning, also inside a staged operation's
 * approval), bookPosSalesDay (a kassa day) and the webbshop booking flow the
 * order routes run (assertOrderBookable, resolveOrderFx, the prefill lines,
 * bookOrderThroughEngine). Every verifikat a flow posts is dumped normalised
 * (series, number, date, description, source type, status and every line)
 * and the dump is compared with the committed fixture
 * (posting-parity-blocks.fixture.json), which was taken before these
 * producers went through the port.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every verifikat these producers posted has exactly one linked
 *      business event, of the kind, role and category the flow expects;
 *   3. a failed event or link write under shadow still posts, and under
 *      strict stops the posting before a voucher number is drawn, through
 *      both port doors (postJournalEntry: an utlägg; draftJournalEntry and
 *      commitJournalEntry: a kassa day).
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-blocks.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test), and the underlag PDFs the kassa and webbshop doors archive after the
 * commit (storage is not in pg-real; they never touch the verifikat).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PosDay } from '@accounted/connect-contract'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { deleteExpenseClaim, registerExpenseClaim } from '@/lib/expenses/expense-claims-service'
import { bookMileagePeriod } from '@/lib/mileage/mileage-service'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { bookPosSalesDay } from '@/lib/pos-sales/book-day'
import { assertOrderBookable, bookOrderThroughEngine, resolveOrderFx } from '@/lib/webshop-orders/book-order'
import { buildOrderBookingLines, orderBookingDescription } from '@/lib/webshop-orders/booking-lines'
import type { WebshopOrder } from '@/types'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

vi.mock('@/lib/supabase/service-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/service-client')>()
  const { createPgRest } = await import('./postgrest-over-pg')
  shim.rest ??= createPgRest({ role: 'service_role' })
  return {
    ...actual,
    createServiceRoleClient: (_url: string, _key: string, options?: Parameters<typeof actual.createServiceRoleClient>[2]) =>
      actual.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
        ...options,
        global: { ...options?.global, fetch: shim.rest!.fetch },
        realtime: { transport: UnusedRealtimeTransport as never },
      }),
  }
})
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const serviceClient = await import('@/lib/supabase/service-client')
  return {
    ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
    createServiceClient: () => serviceClient.createServiceRoleClient('', ''),
    createClient: async () => {
      throw new Error('pg-real: no request scope (cookie session) in this test')
    },
  }
})
// The underlag PDFs archived after the commit: storage is not in pg-real.
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  uploadDocument: vi.fn(async () => ({ id: randomUUID() })),
}))
vi.mock('@/lib/pos-sales/day-report-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pos-sales/day-report-pdf')>()),
  renderPosDayReport: vi.fn(async () => Buffer.from('%PDF-1.4')),
}))
vi.mock('@/lib/webshop-orders/order-underlag', () => ({ archiveWebshopOrderUnderlag: vi.fn(async () => ({ ok: true })) }))

afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const FIXTURE = path.join(__dirname, 'posting-parity-blocks.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

interface Seed {
  userId: string
  companyId: string
  employeeId: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow posted, in posting order, and the record it posted for. */
interface Posted {
  entryIds: string[]
  subjectId: string | null
}

/** The business event shadow mode records for one posting of a flow. */
interface ExpectedEvent {
  kind: string
  role: 'produced' | 'reversal'
  category: string | null
  subject_type: string | null
  party_type?: string | null
  currency?: string | null
  direction?: 'in' | 'out'
  link_basis?: string
  /** The rule source mapping_version names, or null for none. */
  mappingSource: string | null
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  run: (seed: Seed) => Promise<Posted>
  /** One per posting, in posting order. */
  events: ExpectedEvent[]
}

const CLAIM = { kind: 'expense.claimed', role: 'produced', category: null, subject_type: 'expense_claim', mappingSource: 'se.expense-claim' } as const
const MILEAGE = {
  kind: 'expense.mileage_allowance',
  role: 'produced',
  category: 'expense.personnel',
  subject_type: null,
  currency: 'SEK',
  mappingSource: 'se.mileage-allowance',
} as const
const KASSA = {
  kind: 'sale.pos_daily_takings',
  role: 'produced',
  category: 'income.sales',
  subject_type: null,
  direction: 'in',
  mappingSource: 'se.pos-daily-takings',
} as const
const WEBBSHOP = {
  kind: 'sale.webshop_order',
  role: 'produced',
  category: 'income.sales',
  subject_type: null,
  mappingSource: 'se.webshop-order-lines',
} as const

async function insertEmployee(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Sofie', 'Persson', $4, '0000', '2026-01-01')`,
    [id, companyId, userId, `enc-${id}`],
  )
  return id
}

async function insertTrip(
  seed: Seed,
  trip: { date: string; km: number; vehicle?: string; registration?: string | null; employeeId?: string | null },
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.mileage_trips
       (company_id, user_id, employee_id, trip_date, vehicle_type, vehicle_registration, distance_km,
        from_location, to_location, purpose, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Kontoret', 'Kunden', 'Kundbesök', 'draft')
     RETURNING id`,
    [seed.companyId, seed.userId, trip.employeeId ?? null, trip.date, trip.vehicle ?? 'own_car', trip.registration ?? null, trip.km],
  )
  return rows[0]!.id
}

function posDay(overrides: Partial<PosDay> = {}): PosDay {
  return {
    businessDate: '2026-09-30',
    currency: 'SEK',
    sales: { net: 100, vat: 12, gross: 112 },
    vatGroups: [{ ratePercent: 12, net: 100, vat: 12, gross: 112 }],
    tenders: [{ kind: 'card', method: 'card', amount: 112, tips: 0, receiptCount: 1 }],
    tips: 0,
    discounts: 0,
    refunds: { count: 0, gross: 0 },
    receiptCount: 1,
    firstReceiptNumber: '1001',
    lastReceiptNumber: '1001',
    firstPaidAt: null,
    lastPaidAt: null,
    categories: [],
    receipts: [],
    issues: [],
    ...overrides,
  }
}

async function insertPosDay(seed: Seed, day: PosDay): Promise<{ dayId: string; sha: string }> {
  const venueRef = randomUUID().slice(0, 16)
  const { rows: conn } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pos_connections
       (company_id, provider, provider_name, venue_ref, venue_name, connection_handle, status, sync_from)
     VALUES ($1, 'heynow', 'Heynow', $2, 'Restaurang Test', $3, 'active', '2026-09-01')
     RETURNING id`,
    [seed.companyId, venueRef, `pos_${randomUUID().replace(/-/g, '')}`],
  )
  const sha = 'b'.repeat(64)
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pos_sales_days
       (company_id, connection_id, business_date, status, gross, net, vat, tips, receipt_count, day,
        raw_body, raw_content_type, raw_sha256, fetched_at)
     VALUES ($1, $2, $3::date, 'ready', $4, $5, $6, $7, $8, $9::jsonb,
             '{"receipts":[]}', 'application/json', $10, now())
     RETURNING id`,
    [
      seed.companyId,
      conn[0]!.id,
      day.businessDate,
      day.sales.gross,
      day.sales.net,
      day.sales.vat,
      day.tips,
      day.receiptCount,
      JSON.stringify(day),
      sha,
    ],
  )
  return { dayId: rows[0]!.id, sha }
}

interface OrderRow {
  rowType?: 'order' | 'refund'
  parentOrderId?: string | null
  orderNumber: string
  orderDate: string
  paidDate: string | null
  currency?: string
  total: number
  totalTax: number
  totalSek: number | null
  exchangeRate: number | null
  vatBreakdown: Array<{ rate: number; net: number; tax: number }>
  paymentMethod?: string
}

async function insertOrder(seed: Seed, row: OrderRow): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.webshop_orders
       (company_id, user_id, platform, store_scope, row_type, parent_order_id, external_id,
        platform_order_id, order_number, status, is_paid, order_date, paid_date,
        currency, total, total_tax, total_sek, exchange_rate, vat_breakdown,
        payment_method, payment_method_title)
     VALUES ($1, $2, 'woocommerce', 'butik.example.se', $3, $4, $5,
             $6, $6, 'processing', true, $7, $8,
             $9, $10, $11, $12, $13, $14::jsonb, $15, $15)
     RETURNING id`,
    [
      seed.companyId,
      seed.userId,
      row.rowType ?? 'order',
      row.parentOrderId ?? null,
      `woo_butik.example.se_${row.rowType ?? 'order'}_${row.orderNumber}_${randomUUID()}`,
      row.orderNumber,
      row.orderDate,
      row.paidDate,
      row.currency ?? 'SEK',
      row.total,
      row.totalTax,
      row.totalSek,
      row.exchangeRate,
      JSON.stringify(row.vatBreakdown),
      row.paymentMethod ?? 'swish',
    ],
  )
  return rows[0]!.id
}

async function register(seed: Seed, input: Parameters<typeof registerExpenseClaim>[3]): Promise<Posted> {
  const result = await registerExpenseClaim(seed.supabase, seed.companyId, seed.userId, input)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return { entryIds: [result.claim.journal_entry_id!], subjectId: result.claim.id }
}

async function bookMileage(seed: Seed, params: Parameters<typeof bookMileagePeriod>[3]): Promise<Posted> {
  const result = await bookMileagePeriod(seed.supabase, seed.companyId, seed.userId, params)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return { entryIds: [result.journalEntryId], subjectId: null }
}

async function bookDay(seed: Seed, day: PosDay): Promise<Posted> {
  const { dayId, sha } = await insertPosDay(seed, day)
  const outcome = await bookPosSalesDay(
    { supabase: seed.supabase, companyId: seed.companyId, userId: seed.userId, log },
    { day_id: dayId, expected_raw_sha256: sha },
  )
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  if (!outcome.ok || outcome.dryRun) throw new Error('unreachable')
  return { entryIds: [outcome.data.journal_entry_id], subjectId: dayId }
}

/** The webbshop door as both order routes run it, per order. */
async function bookOrder(seed: Seed, orderId: string): Promise<Posted> {
  const { data: order, error } = await seed.supabase
    .from('webshop_orders')
    .select('*')
    .eq('id', orderId)
    .eq('company_id', seed.companyId)
    .single<WebshopOrder>()
  expect(error).toBeNull()
  expect(await assertOrderBookable(seed.supabase, seed.companyId, order!)).toBeNull()
  const resolved = await resolveOrderFx(seed.supabase, seed.companyId, order!, log)
  expect(resolved).not.toBeNull()
  const entryDate = resolved!.paid_date ?? resolved!.order_date
  const fiscalPeriodId = await findFiscalPeriod(seed.supabase, seed.companyId, entryDate)
  expect(fiscalPeriodId).not.toBeNull()
  const outcome = await bookOrderThroughEngine(
    seed.supabase,
    seed.companyId,
    seed.userId,
    resolved!,
    {
      fiscal_period_id: fiscalPeriodId!,
      entry_date: entryDate,
      description: orderBookingDescription(resolved!),
      lines: buildOrderBookingLines({ order: resolved! }),
    },
    log,
  )
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  if (!outcome.ok) throw new Error('unreachable')
  return { entryIds: [outcome.journalEntryId], subjectId: orderId }
}

const FLOWS: Flow[] = [
  {
    name: 'expenses: owner claim in SEK with ingående moms',
    events: [{ ...CLAIM, party_type: null, currency: 'SEK', link_basis: 'user_created' }],
    run: (seed) =>
      register(seed, {
        description: 'USB-hubb',
        expense_date: '2026-03-02',
        amount: 500,
        vat_amount: 100,
        currency: 'SEK',
        expense_account: '5410',
        claimant_name: 'Joakim Hansson',
      }),
  },
  {
    name: 'expenses: employee claim with a project tag',
    events: [{ ...CLAIM, party_type: 'employee' }],
    run: (seed) =>
      register(seed, {
        description: 'Tågbiljett',
        expense_date: '2026-03-03',
        amount: 265,
        vat_amount: 15,
        currency: 'SEK',
        expense_account: '5810',
        employee_id: seed.employeeId,
        dimensions: { '6': 'P100' },
      }),
  },
  {
    name: 'expenses: claim in euro at an explicit rate',
    events: [{ ...CLAIM, currency: 'EUR' }],
    run: (seed) =>
      register(seed, {
        description: 'Konferensavgift',
        expense_date: '2026-03-04',
        amount: 100,
        vat_amount: 0,
        currency: 'EUR',
        exchange_rate: 11.25,
        expense_account: '6990',
        claimant_name: 'Joakim Hansson',
      }),
  },
  {
    name: 'expenses: service bought abroad under reverse charge',
    events: [CLAIM],
    run: (seed) =>
      register(seed, {
        description: 'Molntjänst',
        expense_date: '2026-03-05',
        amount: 800,
        vat_amount: 0,
        currency: 'SEK',
        expense_account: '6540',
        claimant_name: 'Joakim Hansson',
        reverse_charge: 'eu_services',
      }),
  },
  {
    name: 'expenses: custom lines from the advanced booking step',
    events: [{ ...CLAIM, mappingSource: null }],
    run: (seed) =>
      register(seed, {
        description: 'Lunch med kund',
        expense_date: '2026-03-06',
        amount: 560,
        vat_amount: 0,
        currency: 'SEK',
        expense_account: '6071',
        claimant_name: 'Joakim Hansson',
        lines: [
          { account_number: '6071', debit_amount: 500, credit_amount: 0, line_description: 'Representation' },
          { account_number: '2641', debit_amount: 60, credit_amount: 0, line_description: 'Moms' },
          { account_number: '2893', debit_amount: 0, credit_amount: 560 },
        ],
      }),
  },
  {
    name: 'expenses: a registered claim removed again (storno)',
    events: [CLAIM, { kind: 'ledger.storno', role: 'reversal', category: null, subject_type: 'expense_claim', mappingSource: null }],
    run: async (seed) => {
      const posted = await register(seed, {
        description: 'Felregistrerat utlägg',
        expense_date: '2026-03-09',
        amount: 300,
        vat_amount: 60,
        currency: 'SEK',
        expense_account: '5460',
        claimant_name: 'Joakim Hansson',
      })
      const removed = await deleteExpenseClaim(seed.supabase, seed.companyId, seed.userId, posted.subjectId!)
      expect(removed.ok, JSON.stringify(removed)).toBe(true)
      if (!removed.ok) throw new Error('unreachable')
      return { entryIds: [...posted.entryIds, removed.reversal_entry_id!], subjectId: posted.subjectId }
    },
  },
  {
    name: 'mileage: owner trips of an aktiebolag on the default counter account',
    events: [{ ...MILEAGE, party_type: null, link_basis: 'user_created' }],
    run: async (seed) => {
      await insertTrip(seed, { date: '2026-04-07', km: 100 })
      await insertTrip(seed, { date: '2026-04-14', km: 42.5 })
      return bookMileage(seed, { from: '2026-04-01', to: '2026-04-30', entryDate: '2026-04-30' })
    },
  },
  {
    name: 'mileage: employee trips in two vehicle types on 2820',
    events: [{ ...MILEAGE, party_type: 'employee' }],
    run: async (seed) => {
      await insertTrip(seed, { date: '2026-05-05', km: 120, employeeId: seed.employeeId })
      await insertTrip(seed, {
        date: '2026-05-06',
        km: 60,
        vehicle: 'company_car_electric',
        registration: 'ABC123',
        employeeId: seed.employeeId,
      })
      return bookMileage(seed, {
        from: '2026-05-01',
        to: '2026-05-31',
        entryDate: '2026-05-31',
        employeeId: seed.employeeId,
        counterAccount: '2820',
      })
    },
  },
  {
    name: 'mileage: approved from a staged operation, the trip set frozen',
    events: [{ ...MILEAGE, link_basis: 'agent_proposed_user_approved' }],
    run: async (seed) => {
      const tripId = await insertTrip(seed, { date: '2026-06-10', km: 18 })
      return runInOperationCommit(randomUUID(), () =>
        bookMileage(seed, {
          from: '2026-06-01',
          to: '2026-06-30',
          entryDate: '2026-06-30',
          counterAccount: '1930',
          createdVia: 'mcp',
          expectedTripIds: [tripId],
        }),
      )
    },
  },
  {
    name: 'kassa: card day at 12 % moms',
    events: [{ ...KASSA, currency: 'SEK', link_basis: 'user_created' }],
    run: (seed) => bookDay(seed, posDay()),
  },
  {
    name: 'kassa: mixed tenders, two rates, tips and öresutjämning',
    events: [KASSA],
    run: (seed) =>
      bookDay(
        seed,
        posDay({
          businessDate: '2026-10-01',
          sales: { net: 900, vat: 127.5, gross: 1027.5 },
          vatGroups: [
            { ratePercent: 12, net: 750, vat: 90, gross: 840 },
            { ratePercent: 25, net: 150, vat: 37.5, gross: 187.5 },
          ],
          tenders: [
            { kind: 'card', method: 'card', amount: 900, tips: 40, receiptCount: 9 },
            { kind: 'cash', method: 'cash', amount: 167.75, tips: 0, receiptCount: 3 },
          ],
          tips: 40,
          receiptCount: 12,
          firstReceiptNumber: '2001',
          lastReceiptNumber: '2012',
        }),
      ),
  },
  {
    name: 'webbshop: paid order in SEK at 25 % moms',
    events: [{ ...WEBBSHOP, currency: 'SEK', direction: 'in' }],
    run: async (seed) =>
      bookOrder(
        seed,
        await insertOrder(seed, {
          orderNumber: '1001',
          orderDate: '2026-08-01',
          paidDate: '2026-08-01',
          total: 500,
          totalTax: 100,
          totalSek: 500,
          exchangeRate: 1,
          vatBreakdown: [{ rate: 25, net: 400, tax: 100 }],
        }),
      ),
  },
  {
    name: 'webbshop: refund row of an order',
    events: [{ ...WEBBSHOP, direction: 'out' }],
    run: async (seed) =>
      bookOrder(
        seed,
        await insertOrder(seed, {
          rowType: 'refund',
          orderNumber: '1001',
          orderDate: '2026-08-05',
          paidDate: null,
          total: -125,
          totalTax: -25,
          totalSek: -125,
          exchangeRate: 1,
          vatBreakdown: [{ rate: 25, net: 100, tax: 25 }],
        }),
      ),
  },
  {
    name: 'webbshop: order in euro with a resolved SEK total, two rates',
    events: [{ ...WEBBSHOP, currency: 'EUR', direction: 'in' }],
    run: async (seed) =>
      bookOrder(
        seed,
        await insertOrder(seed, {
          orderNumber: '1003',
          orderDate: '2026-08-10',
          paidDate: '2026-08-11',
          currency: 'EUR',
          total: 61.2,
          totalTax: 11.2,
          totalSek: 688.5,
          exchangeRate: 11.25,
          vatBreakdown: [
            { rate: 25, net: 40, tax: 10 },
            { rate: 12, net: 10, tax: 1.2 },
          ],
        }),
      ),
  },
]

interface DumpLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  currency: string | null
  amount_in_currency: string | null
  exchange_rate: string | null
  line_description: string | null
  tax_code: string | null
  dimensions: unknown
  sort_order: number | null
}

interface DumpEntry {
  voucher_series: string
  voucher_number: number
  entry_date: string
  description: string
  source_type: string
  status: string
  lines: DumpLine[]
}

interface FlowDump {
  flow: string
  entries: DumpEntry[]
}

/**
 * The verifikat a flow posted, normalised: no ids, no timestamps. A storno's
 * line order follows the order reverseEntry reads its original's lines back
 * in (an unordered embed), so a storno's lines are compared as a set: in
 * account and amount order, without sort_order.
 */
async function dumpEntries(companyId: string, entryIds: string[]): Promise<DumpEntry[]> {
  const { rows } = await getPool().query<DumpEntry>(
    `SELECT je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'account_number', l.account_number,
                       'debit_amount', l.debit_amount::text,
                       'credit_amount', l.credit_amount::text,
                       'currency', l.currency,
                       'amount_in_currency', l.amount_in_currency::text,
                       'exchange_rate', l.exchange_rate::text,
                       'line_description', l.line_description,
                       'tax_code', l.tax_code,
                       'dimensions', l.dimensions,
                       'sort_order', CASE WHEN je.source_type = 'storno' THEN NULL ELSE l.sort_order END)
                     ORDER BY CASE WHEN je.source_type = 'storno' THEN NULL ELSE l.sort_order END,
                              l.account_number, l.debit_amount, l.credit_amount)
                FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = je.id
            ), '[]'::jsonb) AS lines
       FROM public.journal_entries je
      WHERE je.company_id = $1 AND je.id = ANY($2::uuid[])
      ORDER BY je.voucher_series, je.voucher_number, je.created_at`,
    [companyId, entryIds],
  )
  return rows
}

interface FlowRun {
  companyId: string
  fiscalPeriodId: string
  dumps: FlowDump[]
  posted: Posted[]
}

async function runFlows(): Promise<FlowRun> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const employeeId = await insertEmployee(companyId, userId)
  const seed: Seed = { userId, companyId, employeeId, supabase: createServiceClientNoCookies() }
  const dumps: FlowDump[] = []
  const posted: Posted[] = []
  for (const flow of FLOWS) {
    const result = await runWithActor({ type: 'user' }, () => flow.run(seed))
    const entries = await dumpEntries(companyId, result.entryIds)
    expect(entries, `${flow.name}: one verifikat per posting`).toHaveLength(result.entryIds.length)
    posted.push(result)
    dumps.push({ flow: flow.name, entries })
  }
  return { companyId, fiscalPeriodId, dumps, posted }
}

interface EventRow {
  id: string
  kind: string
  category: string | null
  occurred_on: string
  subject_type: string | null
  subject_id: string | null
  party_type: string | null
  party_id: string | null
  currency: string | null
  amount: string | null
  amount_sek: string | null
  evidence: Record<string, unknown>
  pending_operation_id: string | null
  actor_type: string | null
  mapping_version: string | null
  jurisdiction: string
  role: string | null
  journal_entry_id: string | null
  entry_status: string | null
}

/** Every event of the company with its links and the verifikat each points at. */
async function eventsOf(companyId: string): Promise<EventRow[]> {
  const { rows } = await getPool().query<EventRow>(
    `SELECT e.id, e.kind, e.category, e.occurred_on::text AS occurred_on, e.subject_type, e.subject_id::text AS subject_id,
            e.party_type, e.party_id::text AS party_id, e.currency, e.amount::text AS amount, e.amount_sek::text AS amount_sek,
            e.evidence, e.pending_operation_id::text AS pending_operation_id, e.actor_type, e.mapping_version, e.jurisdiction,
            l.role, l.journal_entry_id::text AS journal_entry_id, je.status AS entry_status
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
       LEFT JOIN public.journal_entries je ON je.id = l.journal_entry_id
      WHERE e.company_id = $1
      ORDER BY e.created_at`,
    [companyId],
  )
  return rows
}

/** The company's live verifikat (draft-free) with how many event links each has. */
async function linkCounts(companyId: string): Promise<Array<{ id: string; source_type: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; source_type: string; links: number }>(
    `SELECT je.id, je.source_type,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.journal_entry_id = je.id) AS links
       FROM public.journal_entries je
      WHERE je.company_id = $1 AND je.status IN ('posted', 'reversed')
      ORDER BY je.voucher_series, je.voucher_number`,
    [companyId],
  )
  return rows
}

async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(max(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** A trigger that refuses every insert into `table`, for the failure paths. */
async function failInserts(table: 'business_events' | 'business_event_entries'): Promise<() => Promise<void>> {
  const fn = `pg_test_blocks_fail_${table}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'pg-test: % refused', TG_TABLE_NAME; END; $$;
    CREATE TRIGGER ${fn} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.${table}; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

describe('posting port parity, expenses, mileage, kassa and webbshop (pg)', () => {
  it('books the flows exactly as before the move, with POSTING_EVENTS off', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { dumps } = await runFlows()

    if (process.env.UPDATE_POSTING_PARITY_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(dumps, null, 2)}\n`)
    }
    expect(dumps).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
  })

  it('off writes no business event', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { companyId } = await runFlows()
    expect(await eventsOf(companyId)).toEqual([])
    expect((await linkCounts(companyId)).filter((e) => e.links > 0)).toEqual([])
  })

  it('books the same verifikat with POSTING_EVENTS=shadow and links exactly one event to every posting', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runFlows()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runFlows()

    expect(shadow.dumps).toEqual(off.dumps)
    expect(shadow.dumps).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

    // Every verifikat the moved producers posted has its event: exactly one link each.
    const counts = await linkCounts(shadow.companyId)
    expect(counts).toHaveLength(FLOWS.reduce((n, f) => n + f.events.length, 0))
    expect(counts.filter((e) => e.links !== 1)).toEqual([])

    const events = await eventsOf(shadow.companyId)
    expect(events).toHaveLength(counts.length)
    for (const [i, flow] of FLOWS.entries()) {
      const posted = shadow.posted[i]!
      expect(posted.entryIds, flow.name).toHaveLength(flow.events.length)
      for (const [j, expected] of flow.events.entries()) {
        const entryId = posted.entryIds[j]!
        const linked = events.filter((e) => e.journal_entry_id === entryId)
        expect(linked, `${flow.name} #${j}`).toHaveLength(1)
        const event = linked[0]!
        expect(event, `${flow.name} #${j}`).toMatchObject({
          kind: expected.kind,
          role: expected.role,
          category: expected.category,
          subject_type: expected.subject_type,
          subject_id: expected.subject_type ? posted.subjectId : null,
          jurisdiction: 'SE',
          actor_type: 'user',
          ...(expected.party_type !== undefined ? { party_type: expected.party_type } : {}),
          ...(expected.currency !== undefined ? { currency: expected.currency } : {}),
        })
        if (expected.party_type === 'employee') {
          const { rows } = await getPool().query<{ id: string }>(`SELECT id FROM public.employees WHERE company_id = $1`, [shadow.companyId])
          expect(event.party_id, flow.name).toBe(rows[0]!.id)
        }
        if (expected.direction) expect(event.evidence.direction, flow.name).toBe(expected.direction)
        if (expected.link_basis) expect(event.evidence.link_basis, flow.name).toBe(expected.link_basis)
        if (expected.mappingSource === null) expect(event.mapping_version, flow.name).toBeNull()
        else expect(event.mapping_version?.startsWith(`${expected.mappingSource}@`), `${flow.name}: ${event.mapping_version}`).toBe(true)
        expect(event.occurred_on, flow.name).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        if (expected.role === 'produced') {
          // The magnitude of the business act, never negative.
          expect(Number(event.amount), flow.name).toBeGreaterThan(0)
        }
      }
    }
    // Inside the staged operation's approval the event names the operation.
    const staged = events.find(
      (e) => e.journal_entry_id === shadow.posted[FLOWS.findIndex((f) => f.name.startsWith('mileage: approved'))]!.entryIds[0],
    )!
    expect(staged.pending_operation_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(staged.evidence.link_evidence).toEqual({ pending_operation_id: staged.pending_operation_id })
  })

  it('shadow posts through a failed event or link write; strict stops before a voucher number is drawn', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const seed: Seed = { userId, companyId, employeeId: await insertEmployee(companyId, userId), supabase: createServiceClientNoCookies() }
    const claim = (n: number, label: string) =>
      runWithActor({ type: 'user' }, () =>
        registerExpenseClaim(seed.supabase, companyId, userId, {
          description: `Kontorsmaterial ${label}`,
          expense_date: `2026-07-${String(n).padStart(2, '0')}`,
          amount: 100 + n,
          vat_amount: 20,
          currency: 'SEK',
          expense_account: '6110',
          claimant_name: 'Joakim Hansson',
        }),
      )
    const day = async (n: number) => {
      const { dayId, sha } = await insertPosDay(seed, posDay({ businessDate: `2026-09-${String(n).padStart(2, '0')}` }))
      const outcome = await runWithActor({ type: 'user' }, () =>
        bookPosSalesDay({ supabase: seed.supabase, companyId, userId, log }, { day_id: dayId, expected_raw_sha256: sha }),
      )
      const { rows } = await getPool().query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.pos_sales_days WHERE id = $1`,
        [dayId],
      )
      return { outcome, linkedEntry: rows[0]!.journal_entry_id }
    }
    const linksOf = async (entryId: string) =>
      (await getPool().query(`SELECT 1 FROM public.business_event_entries WHERE journal_entry_id = $1`, [entryId])).rowCount

    for (const [n, table] of (['business_events', 'business_event_entries'] as const).entries()) {
      const restore = await failInserts(table)
      try {
        // Shadow: both doors post, without their event (or its link).
        vi.stubEnv('POSTING_EVENTS', 'shadow')
        const before = await lastVoucherNumber(companyId)
        const registered = await claim(1 + n, `shadow ${table}`)
        expect(registered.ok, JSON.stringify(registered)).toBe(true)
        if (!registered.ok) throw new Error('unreachable')
        expect(await linksOf(registered.claim.journal_entry_id!)).toBe(0)
        const shadowDay = await day(1 + n)
        expect(shadowDay.outcome.ok, JSON.stringify(shadowDay.outcome)).toBe(true)
        expect(await linksOf(shadowDay.linkedEntry!)).toBe(0)
        expect(await lastVoucherNumber(companyId)).toBe(before + 2)

        // Strict: both doors refuse before a voucher number is drawn.
        vi.stubEnv('POSTING_EVENTS', 'strict')
        const drawn = await lastVoucherNumber(companyId)
        await expect(claim(11 + n, `strict ${table}`)).rejects.toThrow()
        const strictDay = await day(11 + n)
        expect(strictDay.outcome).toMatchObject({ ok: false, code: 'POS_DAY_BOOKING_FAILED' })
        expect(strictDay.linkedEntry).toBeNull()
        expect(await lastVoucherNumber(companyId)).toBe(drawn)
        const { rows: claims } = await getPool().query(
          `SELECT 1 FROM public.expense_claims WHERE company_id = $1 AND description = $2`,
          [companyId, `Kontorsmaterial strict ${table}`],
        )
        // The refused claim's row is removed again, as for any refused booking.
        expect(claims).toEqual([])
      } finally {
        await restore()
      }
    }

    // With nothing refused, strict posts with the event, the next number in
    // the series: the refusals above left no gap.
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const before = await lastVoucherNumber(companyId)
    const ok = await claim(20, 'strict ok')
    expect(ok.ok).toBe(true)
    if (!ok.ok) throw new Error('unreachable')
    const okDay = await day(20)
    expect(okDay.outcome.ok).toBe(true)
    expect(await lastVoucherNumber(companyId)).toBe(before + 2)
    expect(await linksOf(ok.claim.journal_entry_id!)).toBe(1)
    expect(await linksOf(okDay.linkedEntry!)).toBe(1)
    const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, 'A')`, [companyId, fiscalPeriodId])
    expect(gaps.rows).toEqual([])
  })
})
