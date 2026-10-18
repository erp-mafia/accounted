/**
 * Posting port, the SQL step: proof that booking output does not change when
 * the SQL posting functions take the port's event ids and their callers
 * move onto the port.
 *
 * Six SQL functions draft AND commit their verifikat inside one transaction,
 * so the TypeScript port cannot link an event to their drafts:
 *   bulk_book_transactions            (bulkBookTransactions: a samlingsverifikat
 *                                      of N bank lines, or a link to a posted one)
 *   match_batch_allocate              (matchTransactionBatch: one bank line
 *                                      against N customer or N supplier invoices)
 *   link_invoice_to_voucher           (linkInvoiceToVoucher: the kursdifferens
 *                                      verifikat of a foreign invoice)
 *   link_supplier_invoice_to_voucher  (linkSupplierInvoiceToVoucher: the same,
 *                                      supplier side)
 *   create_expense_payout_batch       (createPayoutBatch: N utlägg repaid in
 *                                      one transfer)
 *   commit_opening_balance_replacement (the IB cascade of correctOpeningBalances:
 *                                      a later year's IB and the storno of the old)
 *
 * Each flow is driven through its real door on a freshly seeded company, on
 * the service role with the owner as p_user_id (the v1, MCP and approval
 * doors' shape), and the IB correction on the owner's own session (the
 * dashboard door; on the service role its relink is refused). Every verifikat a flow writes is dumped normalised (series,
 * number, date, description, source type, status and every line) together
 * with each door's outcome and every request the doors send to the six
 * functions (the rpc-input record: the PostgREST body, its ids replaced by
 * their order of first appearance), and the dump is compared with the
 * committed fixture (posting-parity-sql-producers.fixture.json), which was
 * taken before the functions took event ids.
 *
 * With the functions taking event ids and their callers on the port, the
 * test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture (the same
 *      requests: no event ids) and writes no event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, its
 *      requests are the same plus only p_event_ids and p_event_mode
 *      ('shadow') where the function drafts a verifikat, and every verifikat
 *      a function wrote is linked to its events: one bank.categorized per
 *      bank line of a samlingsverifikat, one sale.payment_received or
 *      purchase.paid per batch allocation and for a voucher link's
 *      kursdifferens, one expense.paid_out per repaid claim, and the IB
 *      cascade's ledger.opening_balance (produced) and ledger.storno
 *      (reversal); a link to a posted verifikat and a voucher link in the
 *      ledger currency post nothing and record nothing;
 *   3. through every door: a refused event or link write under shadow still
 *      books (no link); under strict it books nothing and draws no voucher
 *      number; strict with nothing refused links every verifikat; and
 *      detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-sql-producers.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import { createPayoutBatch } from '@/lib/expenses/expense-claims-service'
import { correctOpeningBalances, setOpeningBalances } from '@/lib/import/opening-balance/service'
import type { OpeningBalanceLine } from '@/lib/import/opening-balance/execute-helpers'
import { linkInvoiceToVoucher } from '@/lib/invoices/voucher-matching'
import { linkSupplierInvoiceToVoucher } from '@/lib/invoices/supplier-voucher-matching'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { cascadeOpeningBalanceCorrection } from '@/lib/import/opening-balance/cascade'
import { bulkBookTransactions } from '@/lib/transactions/bulk-book'
import { matchTransactionBatch } from '@/lib/transactions/match-batch'
import { insertFiscalPeriod, seedCompany, setActiveCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

/** The six SQL posting functions whose requests the rpc-input record keeps. */
const SQL_POSTING_FUNCTIONS = [
  'bulk_book_transactions',
  'match_batch_allocate',
  'link_invoice_to_voucher',
  'link_supplier_invoice_to_voucher',
  'create_expense_payout_batch',
  'commit_opening_balance_replacement',
] as const

const shim = vi.hoisted(() => ({
  rest: null as PgRest | null,
  users: [] as PgRest[],
  /** Every request to one of the six functions, in order: the function and its JSON body. */
  calls: [] as Array<{ fn: string; body: Record<string, unknown> }>,
  /** Wraps a shim's fetch so the requests to the six functions are recorded. */
  recording: null as unknown as (inner: typeof fetch) => typeof fetch,
  createServiceRoleClient: null as unknown as (url: string, key: string, options?: Record<string, unknown>) => SupabaseClient,
}))

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
  shim.recording = (inner) => async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const fn = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.slice('/rest/v1/rpc/'.length) : null
    if (fn && (SQL_POSTING_FUNCTIONS as readonly string[]).includes(fn)) {
      const raw = typeof init?.body === 'string' ? init.body : ''
      shim.calls.push({ fn, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} })
    }
    return inner(input, init)
  }
  const recording = shim.recording(shim.rest.fetch)
  shim.createServiceRoleClient = actual.createServiceRoleClient as never
  return {
    ...actual,
    createServiceRoleClient: (_url: string, _key: string, options?: Parameters<typeof actual.createServiceRoleClient>[2]) =>
      actual.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
        ...options,
        global: { ...options?.global, fetch: recording },
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

afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = [shim.rest, ...shim.users].flatMap((rest) => rest?.unsupported.splice(0) ?? [])
  expect(unsupported).toEqual([])
})

/**
 * The dashboard door's cookie client: PostgREST as the signed-in owner. The
 * IB correction needs it: on the service role its relink is refused (the
 * compensation path, posting-parity-opening-balances.pg.test.ts).
 */
async function ownerClient(userId: string): Promise<SupabaseClient> {
  const { createPgRest } = await import('./postgrest-over-pg')
  const rest = createPgRest({ role: 'authenticated', userId })
  shim.users.push(rest)
  return shim.createServiceRoleClient('http://pg-real.invalid', 'pg-real-anon', {
    global: { fetch: shim.recording(rest.fetch) },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

const FIXTURE = path.join(__dirname, 'posting-parity-sql-producers.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const OWNER: CommitActor = { type: 'user' }
const asOwner = <T>(fn: () => Promise<T>) => runWithActor(OWNER, fn)

/** An aktiebolag on faktureringsmetoden with two open years, the chart the SQL functions check, a customer and a supplier. */
interface Seed {
  userId: string
  companyId: string
  periods: { '2026': string; '2027': string }
  customerId: string
  supplierId: string
  templateId: string
  /** The v1, MCP and approval doors (service role, the owner as p_user_id). */
  supabase: SupabaseClient
  /** The dashboard doors (authenticated as the owner). */
  owner: SupabaseClient
}

/** What a flow wrote, in writing order, and what its doors answered and sent. */
interface Posted {
  entryIds: string[]
  outcomes: unknown[]
  rpc: Array<{ fn: string; body: Record<string, unknown> }>
  /** The flow's own records by name (bank lines, invoices, claims), for the events' subjects. */
  refs: Record<string, string>
}

/**
 * One business event shadow mode records for a flow, and the verifikat it is
 * linked to. Subject and party name a record: a flow ref, or one of the
 * seed's (customer, supplier, period2026, period2027).
 */
interface ExpectedEvent {
  kind: string
  role: 'produced' | 'reversal'
  /** Indices into the flow's entryIds: every verifikat linked to the event. */
  entries: readonly number[]
  subject: readonly [type: string, ref: string]
  party: readonly [type: string, ref: string] | null
  currency: string | null
  amount: string | null
  amount_sek: string | null
  /** The act's date, or 'today' for a storno (dated the day it is made). */
  occurred_on: string
  link_basis: string
  direction: 'in' | 'out' | null
  /** The evidence names the seed's booking template. */
  template: boolean
  /** The mapping version's source, without the version. */
  mapping: string | null
  /**
   * Written by the port itself (step 2h, the base IB correction), not by a
   * SQL function: its ids travel in no RPC.
   */
  port?: true
}

interface Flow {
  name: string
  run: (seed: Seed) => Promise<Posted>
  /** Every event linked to the flow's verifikat under shadow. */
  events: ExpectedEvent[]
}

const ctxOf = (seed: Seed): OperationContext => ({ supabase: seed.supabase, companyId: seed.companyId, userId: seed.userId, log })
const ownerCtx = (seed: Seed): OperationContext => ({ supabase: seed.owner, companyId: seed.companyId, userId: seed.userId, log })

async function companyEntryIds(companyId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1`, [companyId])
  return new Set(rows.map((r) => r.id))
}

/** The verifikat the company got while `fn` ran (number, then creation order) and the requests to the six functions. */
async function written(seed: Seed, fn: () => Promise<unknown[]>, refs: Record<string, string> = {}): Promise<Posted> {
  const before = await companyEntryIds(seed.companyId)
  shim.calls.splice(0)
  const outcomes = await fn()
  const rpc = shim.calls.splice(0)
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1 ORDER BY created_at, voucher_number`,
    [seed.companyId],
  )
  return { entryIds: rows.map((r) => r.id).filter((id) => !before.has(id)), outcomes, rpc, refs }
}

/** An outcome without ids. */
function outcomeOf(outcome: OperationOutcome<Record<string, unknown>> | { ok: boolean; [k: string]: unknown }): unknown {
  if (!outcome.ok) return { ok: false, code: (outcome as { code?: string }).code }
  const data = ((outcome as { data?: Record<string, unknown> }).data ?? (outcome as { result?: Record<string, unknown> }).result ?? outcome) as Record<
    string,
    unknown
  >
  const keep = [
    'mode',
    'voucher_series',
    'voucher_number',
    'linked_tx_count',
    'tx_sum',
    'docs_linked',
    'total_allocated',
    'leftover',
    'invoiceStatus',
    'paidAmount',
    'remainingAmount',
    'paymentAmount',
    'voucherRemaining',
    'total_sek',
    'claim_count',
    'lines_created',
    'total_debit',
    'total_credit',
  ]
  const kept: Record<string, unknown> = { ok: true }
  for (const key of keep) if (key in data) kept[key] = data[key]
  if (Array.isArray(data.allocations)) {
    // The RPC settles in invoice id order (random ids): compared as a set.
    kept.allocations = (data.allocations as Array<Record<string, unknown>>)
      .map((a) => ({
        kind: a.kind,
        status: a.status,
        amount: a.amount,
        paid_amount: a.paid_amount,
        remaining_amount: a.remaining_amount,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  const cascade = data.cascade as { corrected: Array<{ period_name: string | null }>; skipped: unknown[] } | undefined
  if (cascade) kept.cascade = { corrected: cascade.corrected.map((c) => c.period_name), skipped: cascade.skipped.length }
  return kept
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A request body with every id replaced by its order of first appearance in the flow. */
function normaliseIds(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string' && UUID.test(value)) {
    if (!ids.has(value)) ids.set(value, `<id:${ids.size + 1}>`)
    return ids.get(value)
  }
  if (Array.isArray(value)) return value.map((v) => normaliseIds(v, ids))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normaliseIds(v, ids)]),
    )
  }
  return value
}

/**
 * The rpc-input record of a flow: function and normalised body, the seed's
 * ids named. The IB cascade's p_lines are the old IB's lines as the cascade
 * reads them back, an unordered read that no run fixes: they are compared
 * as a set (sorted, sort_order left out, each account_id named by its
 * account), as posting-parity-opening-balances compares storno lines.
 */
function rpcRecord(seed: Seed, calls: Posted['rpc']): unknown[] {
  const ids = new Map<string, string>([
    [seed.companyId, '<company>'],
    [seed.userId, '<user>'],
  ])
  return calls.map((c) => {
    const body = { ...c.body }
    if (c.fn === 'commit_opening_balance_replacement' && Array.isArray(body.p_lines)) {
      body.p_lines = (body.p_lines as Array<Record<string, unknown>>)
        .map((line) => ({ ...line, account_id: `<account:${String(line.account_number)}>`, sort_order: null }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }
    return { fn: c.fn, body: normaliseIds(body, ids) }
  })
}

// ---------------------------------------------------------------------------
// Setup rows (not part of a flow's dump)
// ---------------------------------------------------------------------------

async function insertTx(seed: Seed, row: { date: string; description: string; amount: number }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions (id, company_id, user_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, $4, $5, $6, 'SEK', 'uncategorized')`,
    [id, seed.companyId, seed.userId, row.date, row.description, row.amount],
  )
  return id
}

/** A posted verifikat written as the engine does (draft, lines, commit_journal_entry): the voucher a link names. */
async function postedVoucher(seed: Seed, p: { date: string; description: string; debit: string; credit: string; amount: number }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', $5, $6, 'manual', 'draft')`,
    [id, seed.userId, seed.companyId, seed.periods['2026'], p.date, p.description],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
     VALUES ($1, $2, $4, 0, 'SEK', 0), ($1, $3, 0, $4, 'SEK', 1)`,
    [id, p.debit, p.credit, p.amount],
  )
  await getPool().query('SELECT * FROM public.commit_journal_entry($1, $2)', [seed.companyId, id])
  return id
}

async function customerInvoice(
  seed: Seed,
  p: { number: string; currency: string; rate: number | null; total: number; totalSek: number | null },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, exchange_rate, subtotal, vat_amount, total, total_sek,
        vat_treatment, vat_rate, status, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-02-01', '2026-03-01', $6, $7, $8, 0, $8, $9, 'standard_25', 25, 'sent', 0, $8)`,
    [id, seed.userId, seed.companyId, seed.customerId, p.number, p.currency, p.rate, p.total, p.totalSek],
  )
  return id
}

async function supplierInvoice(seed: Seed, p: { number: string; currency: string; rate: number | null; total: number }): Promise<string> {
  const id = randomUUID()
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(max(arrival_number), 0)::int + 1 AS n FROM public.supplier_invoices WHERE company_id = $1`,
    [seed.companyId],
  )
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-02-01', '2026-03-01', '2026-02-01', 'approved', $7, $8,
             $9, 0, $9, 0, $9, 'standard_25', false, false)`,
    [id, seed.userId, seed.companyId, seed.supplierId, rows[0]!.n, p.number, p.currency, p.rate, p.total],
  )
  return id
}

async function expenseClaim(seed: Seed, p: { description: string; date: string; amount: number }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.expense_claims
       (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account, liability_account, status)
     VALUES ($1, $2, $3, 'Ägaren', $4, $5, $6, 0, '5410', '2893', 'registered')`,
    [id, seed.companyId, seed.userId, p.description, p.date, p.amount],
  )
  return id
}

type Line = [account: string, debit: number, credit: number]
const ibLines = (rows: Line[]): OpeningBalanceLine[] =>
  rows.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount }))

const IB_2026: Line[] = [
  ['1930', 100000, 0],
  ['2081', 0, 25000],
  ['2091', 0, 75000],
]
/** 2 000 kronor less in the bank: an owner withdrawal booked in the wrong year. */
const IB_2026_CORRECTED: Line[] = [
  ['1930', 98000, 0],
  ['2081', 0, 25000],
  ['2091', 0, 73000],
]
const IB_2027: Line[] = [
  ['1930', 120000, 0],
  ['2081', 0, 25000],
  ['2091', 0, 95000],
]

// ---------------------------------------------------------------------------
// The flows
// ---------------------------------------------------------------------------

/** A bank line booked into a samlingsverifikat: bank.categorized, the person's own rows. */
const BANK_LINE = {
  kind: 'bank.categorized',
  role: 'produced',
  entries: [0],
  party: null,
  currency: 'SEK',
  link_basis: 'user_created',
  direction: 'out',
  template: false,
  mapping: null,
} as const
const CUSTOMER_PAYMENT = {
  kind: 'sale.payment_received',
  role: 'produced',
  entries: [0],
  party: ['customer', 'customer'],
  link_basis: 'user_confirmed',
  template: false,
  mapping: 'se.customer-payment-lines',
} as const
const SUPPLIER_PAYMENT = {
  kind: 'purchase.paid',
  role: 'produced',
  entries: [0],
  party: ['supplier', 'supplier'],
  link_basis: 'user_confirmed',
  template: false,
  mapping: 'se.supplier-payment-lines',
} as const
const PAYOUT = {
  kind: 'expense.paid_out',
  role: 'produced',
  entries: [0],
  party: null,
  currency: null,
  amount: null,
  occurred_on: '2026-03-20',
  link_basis: 'user_created',
  direction: null,
  template: false,
  mapping: 'se.expense-claim',
} as const
const IB = {
  kind: 'ledger.opening_balance',
  role: 'produced',
  party: null,
  currency: null,
  amount: null,
  amount_sek: null,
  link_basis: 'user_created',
  direction: null,
  template: false,
  mapping: null,
} as const
const IB_STORNO = { ...IB, kind: 'ledger.storno', role: 'reversal', occurred_on: 'today' } as const

const FLOWS: Flow[] = [
  {
    name: 'bulk book: a samlingsverifikat of two bank fees, own lines',
    run: async (seed) => {
      const a = await insertTx(seed, { date: '2026-03-10', description: 'Avgift kort', amount: -50 })
      const b = await insertTx(seed, { date: '2026-03-10', description: 'Avgift konto', amount: -75 })
      return written(
        seed,
        async () => [
          outcomeOf(
            await asOwner(() =>
              bulkBookTransactions(ctxOf(seed), {
                tx_ids: [a, b],
                entry_description: 'Bankavgifter mars',
                manual_lines: [
                  { account_number: '6570', debit_amount: 125, credit_amount: 0, currency: 'SEK', line_description: 'Bankavgifter' },
                  { account_number: '1930', debit_amount: 0, credit_amount: 125, currency: 'SEK' },
                ],
              }),
            ),
          ),
        ],
        { a, b },
      )
    },
    events: [
      { ...BANK_LINE, subject: ['transaction', 'a'], amount: '50.00', amount_sek: '50.00', occurred_on: '2026-03-10' },
      { ...BANK_LINE, subject: ['transaction', 'b'], amount: '75.00', amount_sek: '75.00', occurred_on: '2026-03-10' },
    ],
  },
  {
    name: 'bulk book: three bank fees through a company template, one line per row',
    run: async (seed) => {
      const a = await insertTx(seed, { date: '2026-03-11', description: 'Avgift A', amount: -20 })
      const b = await insertTx(seed, { date: '2026-03-11', description: 'Avgift B', amount: -30 })
      const c = await insertTx(seed, { date: '2026-03-11', description: 'Avgift C', amount: -45 })
      return written(
        seed,
        async () => [
          outcomeOf(
            await asOwner(() =>
              bulkBookTransactions(ctxOf(seed), {
                tx_ids: [a, b, c],
                template_id: seed.templateId,
                mode: 'one_line_per_tx',
                entry_description: 'Bankavgifter, mall',
              }),
            ),
          ),
        ],
        { a, b, c },
      )
    },
    events: (
      [
        ['a', '20.00'],
        ['b', '30.00'],
        ['c', '45.00'],
      ] as const
    ).map(([ref, amount]) => ({
      ...BANK_LINE,
      subject: ['transaction', ref],
      amount,
      amount_sek: amount,
      occurred_on: '2026-03-11',
      template: true,
      mapping: 'se.booking-template',
    })),
  },
  {
    name: 'bulk book: two rows linked to a posted verifikat (no new verifikat)',
    run: async (seed) => {
      await postedVoucher(seed, { date: '2026-03-12', description: 'Avgiftsfaktura banken', debit: '6570', credit: '1930', amount: 100 })
      const voucher = (
        await getPool().query<{ id: string }>(
          `SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1 AND description = 'Avgiftsfaktura banken'`,
          [seed.companyId],
        )
      ).rows[0]!.id
      const a = await insertTx(seed, { date: '2026-03-12', description: 'Avgift del 1', amount: -40 })
      const b = await insertTx(seed, { date: '2026-03-13', description: 'Avgift del 2', amount: -60 })
      return written(
        seed,
        async () => [outcomeOf(await asOwner(() => bulkBookTransactions(ctxOf(seed), { tx_ids: [a, b], existing_journal_entry_id: voucher })))],
        { a, b },
      )
    },
    events: [],
  },
  {
    name: 'match batch: one deposit against two customer invoices',
    run: async (seed) => {
      const first = await customerInvoice(seed, { number: 'F-1001', currency: 'SEK', rate: null, total: 1250, totalSek: 1250 })
      // 0.40 kr under the remaining: öresavrundning settles it in full.
      const second = await customerInvoice(seed, { number: 'F-1002', currency: 'SEK', rate: null, total: 1750.4, totalSek: 1750.4 })
      const tx = await insertTx(seed, { date: '2026-03-14', description: 'Inbetalning kund', amount: 3000 })
      return written(
        seed,
        async () => [
          outcomeOf(
            await asOwner(() =>
              matchTransactionBatch(ctxOf(seed), tx, {
                allocations: [
                  { kind: 'customer_invoice', invoice_id: first, amount: 1250 },
                  { kind: 'customer_invoice', invoice_id: second, amount: 1750 },
                ],
              }),
            ),
          ),
        ],
        { first, second },
      )
    },
    events: [
      { ...CUSTOMER_PAYMENT, subject: ['invoice', 'first'], currency: 'SEK', amount: '1250.00', amount_sek: '1250.00', occurred_on: '2026-03-14', direction: 'in' },
      // The debt settled in full (öresavrundning), the kronor that arrived for it.
      { ...CUSTOMER_PAYMENT, subject: ['invoice', 'second'], currency: 'SEK', amount: '1750.40', amount_sek: '1750.00', occurred_on: '2026-03-14', direction: 'in' },
    ],
  },
  {
    name: 'match batch: one deposit against a EUR invoice (kursdifferens inside)',
    run: async (seed) => {
      // 100 EUR booked at 11.40: 1 140 kr on 1510; 1 120 kr arrives.
      const invoice = await customerInvoice(seed, { number: 'F-1003', currency: 'EUR', rate: 11.4, total: 100, totalSek: 1140 })
      const tx = await insertTx(seed, { date: '2026-03-15', description: 'Inbetalning EUR-kund', amount: 1120 })
      return written(
        seed,
        async () => [
          outcomeOf(
            await asOwner(() =>
              matchTransactionBatch(ctxOf(seed), tx, { allocations: [{ kind: 'customer_invoice', invoice_id: invoice, amount: 1120 }] }),
            ),
          ),
        ],
        { invoice },
      )
    },
    events: [
      { ...CUSTOMER_PAYMENT, subject: ['invoice', 'invoice'], currency: 'EUR', amount: '100.00', amount_sek: '1120.00', occurred_on: '2026-03-15', direction: 'in' },
    ],
  },
  {
    name: 'match batch: one payment against two supplier invoices',
    run: async (seed) => {
      const first = await supplierInvoice(seed, { number: 'LF-2001', currency: 'SEK', rate: null, total: 800 })
      const second = await supplierInvoice(seed, { number: 'LF-2002', currency: 'SEK', rate: null, total: 1200 })
      const tx = await insertTx(seed, { date: '2026-03-16', description: 'Betalning leverantörer', amount: -2000 })
      return written(
        seed,
        async () => [
          outcomeOf(
            await asOwner(() =>
              matchTransactionBatch(ctxOf(seed), tx, {
                allocations: [
                  { kind: 'supplier_invoice', supplier_invoice_id: first, amount: 800 },
                  { kind: 'supplier_invoice', supplier_invoice_id: second, amount: 1200 },
                ],
              }),
            ),
          ),
        ],
        { first, second },
      )
    },
    events: [
      { ...SUPPLIER_PAYMENT, subject: ['supplier_invoice', 'first'], currency: 'SEK', amount: '800.00', amount_sek: '800.00', occurred_on: '2026-03-16', direction: 'out' },
      { ...SUPPLIER_PAYMENT, subject: ['supplier_invoice', 'second'], currency: 'SEK', amount: '1200.00', amount_sek: '1200.00', occurred_on: '2026-03-16', direction: 'out' },
    ],
  },
  {
    name: 'voucher link: a EUR customer invoice settled by a SEK voucher (kursdifferens verifikat)',
    run: async (seed) => {
      // 1 000 EUR booked at 11.50 (11 500 kr); the voucher settles 11 200 kr: 300 kr to 7960.
      const invoice = await customerInvoice(seed, { number: 'F-1004', currency: 'EUR', rate: 11.5, total: 1000, totalSek: 11500 })
      const voucher = await postedVoucher(seed, { date: '2026-03-17', description: 'Inbetalning F-1004', debit: '1930', credit: '1510', amount: 11200 })
      return written(
        seed,
        async () => [
          outcomeOf(await asOwner(() => linkInvoiceToVoucher(seed.supabase, seed.userId, seed.companyId, { invoiceId: invoice, journalEntryId: voucher }))),
        ],
        { invoice },
      )
    },
    events: [
      { ...CUSTOMER_PAYMENT, subject: ['invoice', 'invoice'], currency: 'EUR', amount: '1000.00', amount_sek: null, occurred_on: '2026-03-17', direction: null },
    ],
  },
  {
    name: 'voucher link: a SEK customer invoice (no verifikat of its own)',
    run: async (seed) => {
      const invoice = await customerInvoice(seed, { number: 'F-1005', currency: 'SEK', rate: null, total: 900, totalSek: 900 })
      const voucher = await postedVoucher(seed, { date: '2026-03-18', description: 'Inbetalning F-1005', debit: '1930', credit: '1510', amount: 900 })
      return written(
        seed,
        async () => [
          outcomeOf(await asOwner(() => linkInvoiceToVoucher(seed.supabase, seed.userId, seed.companyId, { invoiceId: invoice, journalEntryId: voucher }))),
        ],
        { invoice },
      )
    },
    events: [],
  },
  {
    name: 'voucher link: a EUR supplier invoice paid by a SEK voucher (kursdifferens verifikat)',
    run: async (seed) => {
      // 1 000 EUR booked at 11.50 (11 500 kr); paid 11 200 kr: 300 kr to 3960.
      const invoice = await supplierInvoice(seed, { number: 'LF-2003', currency: 'EUR', rate: 11.5, total: 1000 })
      const voucher = await postedVoucher(seed, { date: '2026-03-19', description: 'Betalning LF-2003', debit: '2440', credit: '1930', amount: 11200 })
      return written(
        seed,
        async () => [
          outcomeOf(
            await asOwner(() =>
              linkSupplierInvoiceToVoucher(seed.supabase, seed.userId, seed.companyId, { supplierInvoiceId: invoice, journalEntryId: voucher }),
            ),
          ),
        ],
        { invoice },
      )
    },
    events: [
      { ...SUPPLIER_PAYMENT, subject: ['supplier_invoice', 'invoice'], currency: 'EUR', amount: '1000.00', amount_sek: null, occurred_on: '2026-03-19', direction: null },
    ],
  },
  {
    name: 'utlägg payout: two claims repaid in one transfer',
    run: async (seed) => {
      const first = await expenseClaim(seed, { description: 'Kontorsstol', date: '2026-03-02', amount: 500 })
      const second = await expenseClaim(seed, { description: 'Skrivarpapper', date: '2026-03-03', amount: 300 })
      return written(
        seed,
        async () => [
          outcomeOf(
            await asOwner(() =>
              createPayoutBatch(seed.supabase, seed.companyId, seed.userId, {
                claim_ids: [first, second],
                payout_date: '2026-03-20',
                cash_account: '1930',
              }),
            ),
          ),
        ],
        { first, second },
      )
    },
    events: [
      { ...PAYOUT, subject: ['expense_claim', 'first'], amount_sek: '500.00' },
      { ...PAYOUT, subject: ['expense_claim', 'second'], amount_sek: '300.00' },
    ],
  },
  {
    name: 'utlägg payout matched to its bank transfer',
    run: async (seed) => {
      const claim = await expenseClaim(seed, { description: 'Tågbiljett', date: '2026-03-04', amount: 265 })
      const tx = await insertTx(seed, { date: '2026-03-21', description: 'Utlägg Ägaren', amount: -265 })
      return written(
        seed,
        async () => [
          outcomeOf(
            await asOwner(() =>
              createPayoutBatch(seed.supabase, seed.companyId, seed.userId, {
                claim_ids: [claim],
                payout_date: '2026-03-21',
                cash_account: '1930',
                transaction_id: tx,
              }),
            ),
          ),
        ],
        { claim },
      )
    },
    events: [{ ...PAYOUT, subject: ['expense_claim', 'claim'], amount_sek: '265.00', occurred_on: '2026-03-21', direction: 'out' }],
  },
  {
    name: 'IB correction with cascade: the next year IB replaced in SQL',
    run: async (seed) => {
      const set = async (period: string, rows: Line[]) => {
        const outcome = await asOwner(() => setOpeningBalances(ownerCtx(seed), { fiscal_period_id: period, lines: ibLines(rows) }))
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true })
      }
      await set(seed.periods['2026'], IB_2026)
      await set(seed.periods['2027'], IB_2027)
      return written(seed, async () => [
        outcomeOf(
          (await asOwner(() =>
            correctOpeningBalances(ownerCtx(seed), { fiscal_period_id: seed.periods['2026'], lines: ibLines(IB_2026_CORRECTED), cascade: true }),
          )) as OperationOutcome<Record<string, unknown>>,
        ),
      ])
    },
    // The corrected 2026 IB and the storno of the old one are the port's
    // (step 2h); the 2027 replacement and its storno are the SQL cascade's.
    events: [
      { ...IB, entries: [0], subject: ['fiscal_period', 'period2026'], occurred_on: '2026-01-01', port: true },
      { ...IB_STORNO, entries: [1], subject: ['fiscal_period', 'period2026'], port: true },
      { ...IB, entries: [2], subject: ['fiscal_period', 'period2027'], occurred_on: '2027-01-01' },
      { ...IB_STORNO, entries: [3], subject: ['fiscal_period', 'period2027'] },
    ],
  },
]

// ---------------------------------------------------------------------------
// The dump
// ---------------------------------------------------------------------------

interface DumpEntry {
  voucher_series: string
  voucher_number: number
  entry_date: string
  description: string
  source_type: string
  status: string
  reverses_voucher: number | null
  lines: unknown[]
}

interface FlowDump {
  flow: string
  outcomes: unknown[]
  entries: DumpEntry[]
  rpc: unknown[]
}

/** The verifikat a flow wrote, normalised: no ids, no timestamps, lines as a set. */
async function dumpEntries(companyId: string, entryIds: string[]): Promise<DumpEntry[]> {
  const { rows } = await getPool().query<DumpEntry>(
    `SELECT je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status, r.voucher_number AS reverses_voucher,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'account_number', l.account_number,
                       'debit_amount', l.debit_amount::text,
                       'credit_amount', l.credit_amount::text,
                       'currency', l.currency,
                       'amount_in_currency', l.amount_in_currency::text,
                       'line_description', l.line_description,
                       'dimensions', l.dimensions)
                     ORDER BY l.account_number, l.debit_amount, l.credit_amount, l.line_description)
                FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = je.id
            ), '[]'::jsonb) AS lines
       FROM public.journal_entries je
       LEFT JOIN public.journal_entries r ON r.id = je.reverses_id
      WHERE je.company_id = $1 AND je.id = ANY($2::uuid[])
      ORDER BY je.voucher_series, je.voucher_number, je.created_at`,
    [companyId, entryIds],
  )
  return rows
}

async function seedAll(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await setActiveCompany(userId, companyId)
  const pool = getPool()
  await pool.query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true)`,
    [userId, companyId],
  )
  const period2027 = await insertFiscalPeriod({ userId, companyId, name: '2027', periodStart: '2027-01-01', periodEnd: '2027-12-31' })
  await pool.query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     VALUES ($1, $2, '1930', 'Företagskonto', 1, 'asset', 'debit', true),
            ($1, $2, '1510', 'Kundfordringar', 1, 'asset', 'debit', true),
            ($1, $2, '2440', 'Leverantörsskulder', 2, 'liability', 'credit', true),
            ($1, $2, '2893', 'Skuld till aktieägare', 2, 'liability', 'credit', true),
            ($1, $2, '6570', 'Bankkostnader', 6, 'expense', 'debit', true)`,
    [userId, companyId],
  )
  const customer = await pool.query<{ id: string }>(
    `INSERT INTO public.customers (user_id, company_id, name, customer_type) VALUES ($1, $2, 'Kund AB', 'swedish_business') RETURNING id::text AS id`,
    [userId, companyId],
  )
  const supplier = await pool.query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name, supplier_type, default_currency)
     VALUES ($1, $2, 'Leverantör AB', 'swedish_business', 'SEK') RETURNING id::text AS id`,
    [userId, companyId],
  )
  const template = await pool.query<{ id: string }>(
    `INSERT INTO public.booking_template_library (company_id, created_by, name, category, lines)
     VALUES ($1, $2, 'Bankavgift', 'other', $3::jsonb) RETURNING id::text AS id`,
    [
      companyId,
      userId,
      JSON.stringify([
        { account: '6570', label: 'Bankavgift', side: 'debit', type: 'business' },
        { account: '1930', label: 'Bank', side: 'credit', type: 'settlement' },
      ]),
    ],
  )
  return {
    userId,
    companyId,
    periods: { '2026': fiscalPeriodId, '2027': period2027 },
    customerId: customer.rows[0]!.id,
    supplierId: supplier.rows[0]!.id,
    templateId: template.rows[0]!.id,
    supabase: createServiceClientNoCookies(),
    owner: await ownerClient(userId),
  }
}

interface FlowRun {
  seed: Seed
  dumps: FlowDump[]
  posted: Posted[]
}

async function runFlows(): Promise<FlowRun> {
  const seed = await seedAll()
  const dumps: FlowDump[] = []
  const posted: Posted[] = []
  for (const flow of FLOWS) {
    const result = await flow.run(seed)
    const entries = await dumpEntries(seed.companyId, result.entryIds)
    expect(entries, `${flow.name}: one dump row per verifikat`).toHaveLength(result.entryIds.length)
    posted.push(result)
    dumps.push({ flow: flow.name, outcomes: result.outcomes, entries, rpc: rpcRecord(seed, result.rpc) })
  }
  return { seed, dumps, posted }
}

/** Every flow books on a fresh company: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 300_000

describe('posting port parity, the SQL posting functions (pg)', () => {
  it('books the flows exactly as before the move, with POSTING_EVENTS off', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { dumps } = await runFlows()

    const recorded = { dumps }
    if (process.env.UPDATE_POSTING_PARITY_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
  })

  it('off writes no business event', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { seed, posted } = await runFlows()
    expect(await eventLinks(seed.companyId)).toEqual([])
    for (const p of posted) for (const call of p.rpc) expect(Object.keys(call.body)).not.toContain('p_event_ids')
  })

  it(
    'books the same with POSTING_EVENTS=shadow, sends only the event ids on top and links every SQL verifikat to its events',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'off')
      const off = await runFlows()
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const shadow = await runFlows()

      // Verifikat and outcomes: as off, as the fixture.
      const booked = (run: FlowRun | { dumps: FlowDump[] }) => run.dumps.map(({ flow, outcomes, entries }) => ({ flow, outcomes, entries }))
      expect(booked(shadow)).toEqual(booked(off))
      expect(booked(shadow)).toEqual(booked(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { dumps: FlowDump[] }))

      // Requests: the same, plus only the two event parameters.
      for (const [i, flow] of FLOWS.entries()) {
        expect(rpcRecord(shadow.seed, withoutEventParams(shadow.posted[i]!.rpc)), flow.name).toEqual(off.dumps[i]!.rpc)
      }

      const { seed } = shadow
      const links = await eventLinks(seed.companyId)
      // Every event the doors recorded is linked: none stands alone.
      expect(links.filter((l) => l.journal_entry_id === null)).toEqual([])
      const today = (await getPool().query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS d`)).rows[0]!.d
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        const names = new Map<string, string>([
          [seed.customerId, 'customer'],
          [seed.supplierId, 'supplier'],
          [seed.periods['2026'], 'period2026'],
          [seed.periods['2027'], 'period2027'],
          ...Object.entries(posted.refs).map(([name, id]) => [id, name] as [string, string]),
        ])
        const inFlow = links.filter((l) => posted.entryIds.includes(l.journal_entry_id!))
        const byEvent = new Map<string, EventLinkRow[]>()
        for (const l of inFlow) byEvent.set(l.id, [...(byEvent.get(l.id) ?? []), l])
        const actual = [...byEvent.values()].map((rows) => {
          const e = rows[0]!
          expect(new Set(rows.map((r) => r.role)).size, flow.name).toBe(1)
          expect(e, flow.name).toMatchObject({ category: null, tax_amounts: [], jurisdiction: 'SE', actor_type: 'user', idempotency_key: null })
          return {
            kind: e.kind,
            role: e.role,
            entries: rows.map((r) => posted.entryIds.indexOf(r.journal_entry_id!)).sort(),
            subject: [e.subject_type, names.get(e.subject_id!) ?? e.subject_id],
            party: e.party_type ? [e.party_type, names.get(e.party_id!) ?? e.party_id] : null,
            currency: e.currency,
            amount: e.amount,
            amount_sek: e.amount_sek,
            occurred_on: e.occurred_on === today ? 'today' : e.occurred_on,
            link_basis: e.evidence.link_basis ?? null,
            direction: e.evidence.direction ?? null,
            template: e.evidence.template_id === seed.templateId,
            mapping: e.mapping_version ? e.mapping_version.split('@')[0] : null,
          }
        })
        const expected = flow.events.map(({ port: _port, ...e }) => e)
        const sorted = (list: unknown[]) => list.map(canonical).sort()
        expect(sorted(actual), flow.name).toEqual(sorted(expected))

        // The functions got exactly their events' ids, in the doors' order,
        // and the mode; a function that drafted nothing got none.
        const sqlEvents = flow.events.filter((e) => !e.port)
        if (sqlEvents.length === 0) {
          for (const call of posted.rpc) expect(Object.keys(call.body), flow.name).not.toContain('p_event_ids')
          continue
        }
        expect(posted.rpc.map((c) => c.body.p_event_mode), flow.name).toEqual(posted.rpc.map(() => 'shadow'))
        const sent = posted.rpc.flatMap((c) => (c.body.p_event_ids ?? []) as string[])
        const linkedToSql = new Set(
          inFlow.filter((l) => sqlEvents.some((e) => e.entries.includes(posted.entryIds.indexOf(l.journal_entry_id!)))).map((l) => l.id),
        )
        expect(new Set(sent), flow.name).toEqual(linkedToSql)
        expect(sent, flow.name).toHaveLength(sqlEvents.length)
      }

      // The cascade's ids by position: 1 the new IB, 2 the storno.
      const cascade = shadow.posted[FLOWS.length - 1]!
      const ids = cascade.rpc[0]!.body.p_event_ids as string[]
      expect(links.find((l) => l.id === ids[0])).toMatchObject({ journal_entry_id: cascade.entryIds[2], role: 'produced', kind: 'ledger.opening_balance' })
      expect(links.find((l) => l.id === ids[1])).toMatchObject({ journal_entry_id: cascade.entryIds[3], role: 'reversal', kind: 'ledger.storno' })
    },
  )

  it(
    'through every door: shadow books past a refused event or link, strict books nothing and draws no number',
    { timeout: FLOW_TIMEOUT },
    async () => {
      const seed = await seedAll()
      const { companyId } = seed
      // The cascade door needs a 2027 IB to replace (set as the dashboard does).
      vi.stubEnv('POSTING_EVENTS', 'off')
      const ib = await asOwner(() => setOpeningBalances(ownerCtx(seed), { fiscal_period_id: seed.periods['2027'], lines: ibLines(IB_2027) }))
      expect(ib, JSON.stringify(ib)).toMatchObject({ ok: true })

      const phases: Array<{ mode: 'shadow' | 'strict'; refuse: 'business_events' | 'business_event_entries' | null; books: boolean }> = [
        { mode: 'shadow', refuse: 'business_event_entries', books: true },
        { mode: 'shadow', refuse: 'business_events', books: true },
        { mode: 'strict', refuse: 'business_event_entries', books: false },
        { mode: 'strict', refuse: 'business_events', books: false },
        { mode: 'strict', refuse: null, books: true },
      ]
      for (const [n, phase] of phases.entries()) {
        const label = `${phase.mode}, ${phase.refuse ?? 'nothing'} refused`
        vi.stubEnv('POSTING_EVENTS', 'off')
        const doors = await prepareDoors(seed, n)
        vi.stubEnv('POSTING_EVENTS', phase.mode)
        const restore = phase.refuse ? await failInserts(phase.refuse) : async () => {}
        const before = await companyEntryIds(companyId)
        const drawn = await lastVoucherNumber(companyId)
        let outcomes: Array<[string, boolean]>
        try {
          outcomes = []
          for (const [name, door] of doors) outcomes.push([name, await door()])
        } finally {
          await restore()
        }
        expect(outcomes, label).toEqual(doors.map(([name]) => [name, phase.books]))
        const fresh = [...(await companyEntryIds(companyId))].filter((id) => !before.has(id))
        if (!phase.books) {
          // Nothing booked, no number drawn: every door stopped before commit_journal_entry.
          expect(fresh, label).toEqual([])
          expect(await lastVoucherNumber(companyId), label).toBe(drawn)
          continue
        }
        // One verifikat per door, numbered in sequence.
        expect(fresh, label).toHaveLength(doors.length + 1)
        expect(await lastVoucherNumber(companyId), label).toBe(drawn + doors.length + 1)
        const counts = await linkCounts(fresh)
        if (phase.refuse) expect(counts.filter((c) => c.links > 0), label).toEqual([])
        else expect(counts.filter((c) => c.links === 0), label).toEqual([])
      }

      const { rows: series } = await getPool().query<{ fiscal_period_id: string; voucher_series: string }>(
        `SELECT DISTINCT fiscal_period_id::text, voucher_series FROM public.voucher_sequences WHERE company_id = $1`,
        [companyId],
      )
      expect(series.length).toBeGreaterThan(1)
      for (const { fiscal_period_id, voucher_series } of series) {
        const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, $3)`, [companyId, fiscal_period_id, voucher_series])
        expect(gaps.rows, `${voucher_series} ${fiscal_period_id}`).toEqual([])
      }
    },
  )
})

// ---------------------------------------------------------------------------
// Shadow and failure-path helpers
// ---------------------------------------------------------------------------

/** JSON with every object's keys sorted, for comparing as sets. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )
}

function withoutEventParams(calls: Posted['rpc']): Posted['rpc'] {
  return calls.map((c) => ({
    fn: c.fn,
    body: Object.fromEntries(Object.entries(c.body).filter(([key]) => key !== 'p_event_ids' && key !== 'p_event_mode')),
  }))
}

interface EventLinkRow {
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
  tax_amounts: unknown[]
  evidence: Record<string, unknown>
  actor_type: string | null
  mapping_version: string | null
  jurisdiction: string
  idempotency_key: string | null
  role: string | null
  journal_entry_id: string | null
}

/** Every event of the company, once per link. */
async function eventLinks(companyId: string): Promise<EventLinkRow[]> {
  const { rows } = await getPool().query<EventLinkRow>(
    `SELECT e.id::text AS id, e.kind, e.category, e.occurred_on::text AS occurred_on,
            e.subject_type, e.subject_id::text AS subject_id, e.party_type, e.party_id::text AS party_id,
            e.currency, e.amount::text AS amount, e.amount_sek::text AS amount_sek, e.tax_amounts, e.evidence,
            e.actor_type, e.mapping_version, e.jurisdiction, e.idempotency_key,
            l.role, l.journal_entry_id::text AS journal_entry_id
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
      WHERE e.company_id = $1
      ORDER BY e.created_at`,
    [companyId],
  )
  return rows
}

async function linkCounts(entryIds: string[]): Promise<Array<{ id: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; links: number }>(
    `SELECT je.id::text AS id, (SELECT count(*)::int FROM public.business_event_entries l WHERE l.journal_entry_id = je.id) AS links
       FROM public.journal_entries je WHERE je.id = ANY($1::uuid[])`,
    [entryIds],
  )
  return rows
}

/** How many voucher numbers the company has drawn, over every year and series. */
async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(sum(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** A trigger that refuses every insert into `table`. */
async function failInserts(table: 'business_events' | 'business_event_entries'): Promise<() => Promise<void>> {
  const fn = `pg_test_sqlp_fail_${table}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'pg-test: % refused', TG_TABLE_NAME;
    END; $$;
    CREATE TRIGGER ${fn} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.${table}; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

/**
 * One fresh booking per door, answering whether it booked: a bulk booking,
 * a batch allocation, both voucher links (EUR invoices settled at another
 * rate: a kursdifferens verifikat each), an utlägg payout and the IB
 * cascade (cascadeOpeningBalanceCorrection in its storno mode, as
 * correctOpeningBalances runs it after the base correction; it replaces the
 * 2027 IB: two verifikat). Records are made with the port off; `n` keeps
 * each round's numbers apart.
 */
async function prepareDoors(seed: Seed, n: number): Promise<Array<[string, () => Promise<boolean>]>> {
  const day = `2026-04-${String(10 + n).padStart(2, '0')}`
  // Amounts of their own per round: the booking-time duplicate guard
  // refuses a row like one booked days before.
  const feeA = 10 + 3 * n
  const feeB = 15 + 5 * n
  const a = await insertTx(seed, { date: day, description: `Avgift ${n}a`, amount: -feeA })
  const b = await insertTx(seed, { date: day, description: `Avgift ${n}b`, amount: -feeB })
  const due = 400 + 7 * n
  const invoice = await customerInvoice(seed, { number: `F-9${n}01`, currency: 'SEK', rate: null, total: due, totalSek: due })
  const deposit = await insertTx(seed, { date: day, description: `Inbetalning ${n}`, amount: due })
  const eurInvoice = await customerInvoice(seed, { number: `F-9${n}02`, currency: 'EUR', rate: 11.5, total: 100, totalSek: 1150 })
  const eurVoucher = await postedVoucher(seed, { date: day, description: `Inbetalning F-9${n}02`, debit: '1930', credit: '1510', amount: 1120 })
  const eurSupplierInvoice = await supplierInvoice(seed, { number: `LF-9${n}03`, currency: 'EUR', rate: 11.5, total: 100 })
  const eurPayment = await postedVoucher(seed, { date: day, description: `Betalning LF-9${n}03`, debit: '2440', credit: '1930', amount: 1120 })
  const claim = await expenseClaim(seed, { description: `Utlägg ${n}`, date: day, amount: 120 })
  return [
    [
      'bulk_book_transactions',
      async () =>
        (
          await asOwner(() =>
            bulkBookTransactions(ctxOf(seed), {
              tx_ids: [a, b],
              entry_description: `Bankavgifter ${n}`,
              manual_lines: [
                { account_number: '6570', debit_amount: feeA + feeB, credit_amount: 0, currency: 'SEK' },
                { account_number: '1930', debit_amount: 0, credit_amount: feeA + feeB, currency: 'SEK' },
              ],
            }),
          )
        ).ok,
    ],
    [
      'match_batch_allocate',
      async () =>
        (await asOwner(() => matchTransactionBatch(ctxOf(seed), deposit, { allocations: [{ kind: 'customer_invoice', invoice_id: invoice, amount: due }] })))
          .ok,
    ],
    [
      'link_invoice_to_voucher',
      async () =>
        (await asOwner(() => linkInvoiceToVoucher(seed.supabase, seed.userId, seed.companyId, { invoiceId: eurInvoice, journalEntryId: eurVoucher }))).ok,
    ],
    [
      'link_supplier_invoice_to_voucher',
      async () =>
        (
          await asOwner(() =>
            linkSupplierInvoiceToVoucher(seed.supabase, seed.userId, seed.companyId, { supplierInvoiceId: eurSupplierInvoice, journalEntryId: eurPayment }),
          )
        ).ok,
    ],
    [
      'create_expense_payout_batch',
      async () =>
        (await asOwner(() => createPayoutBatch(seed.supabase, seed.companyId, seed.userId, { claim_ids: [claim], payout_date: day, cash_account: '1930' }))).ok,
    ],
    [
      'commit_opening_balance_replacement',
      async () => {
        const result = await asOwner(() =>
          cascadeOpeningBalanceCorrection(seed.owner, seed.companyId, seed.userId, {
            basePeriodStart: '2026-01-01',
            deltas: new Map([
              ['1930', -100],
              ['2091', 100],
            ]),
            lockDate: null,
            log,
          }),
        )
        return result.corrected.length === 1
      },
    ],
  ]
}
