/**
 * Posting port, step 2f-2: proof that booking output does not change when the
 * customer invoice payments and the bank matches against customer invoices
 * move onto the port.
 *
 * Each producer is driven through its real door on a freshly seeded
 * aktiebolag: the dashboard mark-paid route (an issued invoice paid in full,
 * a partial payment on the person's own rows, an EUR invoice with a
 * kursvinst, a kontantmetoden payment), the v1 mark-paid route on an API key,
 * the staged mark_invoice_paid approval, the kontantfaktura paid at issue,
 * the dashboard bank match route (in full, in part, an overpayment booked on
 * 2420, an EUR row with its kursdifferens, a row categorized first and undone
 * before the match, a kontantmetoden match, the person's own rows), the v1
 * bank match (in full, a categorized row undone first, kontantmetoden, the
 * person's own rows) and the staged match_transaction_invoice approval (in
 * full, a categorized row undone first, kontantmetoden). Three flows storno a
 * payment a moved door posted, so the engine's payment sync (the reversal
 * hook) runs on it. Every
 * verifikat a door writes is dumped normalised (series, number, date,
 * description, source type, status and every line) together with the
 * invoices, their payment rows and the bank lines the doors write beside
 * them, and the dump is compared with the committed fixture
 * (posting-parity-invoice-payments.fixture.json), which was taken before
 * these producers went through the port. A flow's setup (the invoice it
 * pays, the row it books) is not part of its dump.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every verifikat a moved door wrote has exactly ONE event linked: a
 *      payment sale.payment_received (the invoice as subject, the customer as
 *      party, the debt settled and the kronor that arrived, kontantmetoden's
 *      moms), the undo of the row's earlier booking ledger.storno (role
 *      reversal) of the bank line, with the door's link basis as evidence (the
 *      staged ones naming their pending operation);
 *      the stornos the reversal-hook flows make directly through the engine
 *      carry none, and the payment sync puts each reversed payment's invoice
 *      back to unpaid exactly as with the port off;
 *   3. a failed event or link write under shadow still posts; under strict
 *      every door stops before a voucher number is drawn, with no invoice
 *      paid and no bank line moved; and detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-invoice-payments.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test); the session doors' cookie auth, replaced by the signed-in user on
 * the service-role client (requireAuth and the active company are mocked,
 * the write-role check passes); the v1 doors run on a real API key; and the
 * invoice PDF the issue archives as underlag (rendering and the storage
 * upload, which pg-real does not have, are stubbed: the archive is not a
 * posting, and a failed archive is a partial failure the doors already answer
 * with).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies, generateApiKey } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { issueAndBookInvoice, type IssuableInvoice } from '@/lib/invoices/issue-and-book-invoice'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { categorizeTransaction } from '@/lib/transactions/categorize-core'
import type { CompanySettings, PendingOperation } from '@/types'
import { POST as markPaidRoute } from '@/app/api/invoices/[id]/mark-paid/route'
import { POST as matchInvoiceRoute } from '@/app/api/transactions/[id]/match-invoice/route'
import { POST as uncategorizeRoute } from '@/app/api/transactions/[id]/uncategorize/route'
import { POST as v1MarkPaidRoute } from '@/app/api/v1/companies/[companyId]/invoices/[id]/mark-paid/route'
import { POST as v1MatchInvoiceRoute } from '@/app/api/v1/companies/[companyId]/transactions/[id]/match-invoice/route'
import { POST as v1UncategorizeRoute } from '@/app/api/v1/companies/[companyId]/transactions/[id]/uncategorize/route'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))
/** Who the session doors run as: the seeded owner of the seeded company. */
const session = vi.hoisted(() => ({ userId: '', companyId: '' }))

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
// The session doors: the signed-in owner on the service-role client.
vi.mock('@/lib/auth/require-auth', async () => {
  const { createServiceClientNoCookies: client } = await import('@/lib/auth/api-keys')
  return {
    requireAuth: async () => ({ user: { id: session.userId }, supabase: client(), error: null }),
  }
})
vi.mock('@/lib/company/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/context')>()),
  getActiveCompanyId: async () => session.companyId,
  requireCompanyId: async () => session.companyId,
}))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: async () => ({ ok: true }),
}))
vi.mock('@/lib/invoices/render-invoice-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/render-invoice-pdf')>()),
  renderInvoicePdfBuffer: async () => ({ buffer: Buffer.from('%PDF-1.4 pg-real') }),
}))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  uploadDocument: async () => {
    throw new Error('pg-real: no storage')
  },
}))

afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const FIXTURE = path.join(__dirname, 'posting-parity-invoice-payments.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const V1_SCOPES = ['invoices:read', 'invoices:write', 'transactions:read', 'transactions:write']

/** An aktiebolag under faktureringsmetoden, VAT-registered, with a Swedish and an EU customer and an API key. */
interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  /** A Swedish business. */
  domestic: string
  /** A German business with a validated VAT number: reverse charge, EUR. */
  eu: string
  apiKey: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow's setup made: the records its door acts on. */
interface Prepared {
  invoiceIds?: string[]
  transactionIds?: string[]
  /** Undone after the door ran (a switched accounting method). */
  restore?: () => Promise<void>
}

type EntryRole = 'invoice_paid' | 'invoice_cash_payment' | 'storno'
type CustomerKey = 'domestic' | 'eu'

/** One business event shadow mode records for a flow, and the verifikat it is linked to. */
interface ExpectedEvent {
  kind: 'sale.payment_received' | 'ledger.storno'
  role: 'produced' | 'reversal'
  /** The act's date; 'today' for a storno, dated the day it is made. */
  occurred_on: string
  subject: { type: 'invoice' | 'transaction'; index: number }
  party: CustomerKey | null
  currency: string | null
  amount: number | null
  amount_sek: number | null
  /** The moms the payment books, in SEK, under this treatment; null for none. */
  vat: { treatment: string; amount_sek: number } | null
  link_basis: string
  direction: 'in' | 'out' | null
  /** The rule source mapping_version names; null for none. */
  mappingSource: string | null
  /** The verifikat the door wrote that are linked to the event, by source type. */
  entries: readonly EntryRole[]
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  setup: (seed: Seed) => Promise<Prepared>
  run: (seed: Seed, prepared: Prepared) => Promise<void>
  events: ExpectedEvent[]
  /** The verifikat the flow writes outside the moved doors (a storno made directly through the engine): no event. */
  unmoved?: readonly EntryRole[]
}

async function stageOperation(seed: Seed, operationType: string, params: Record<string, unknown>): Promise<PendingOperation> {
  const { rows } = await getPool().query(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [seed.userId, seed.companyId, operationType, operationType, JSON.stringify(params)],
  )
  return rows[0] as PendingOperation
}

async function approve(seed: Seed, op: PendingOperation): Promise<Record<string, unknown>> {
  const result = await runWithActor({ type: 'user' }, () =>
    commitPendingOperation(seed.supabase, seed.userId, seed.companyId, op, {
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    }),
  )
  expect(result.status, JSON.stringify(result)).toBe('committed')
  return (result as { data?: Record<string, unknown> }).data ?? {}
}

/**
 * A draft invoice through the staged create_invoice door. Consulting hours at
 * 100 kr and 25 %: `hours` sets the total (hours x 125 kr), so no two flows
 * pay the same amount and no door reads another flow's payment as its
 * duplicate.
 */
async function draft(seed: Seed, date: string, hours: number): Promise<string> {
  const data = await approve(
    seed,
    await stageOperation(seed, 'create_invoice', {
      customer_id: seed.domestic,
      invoice_date: date,
      due_date: '2026-12-31',
      currency: 'SEK',
      items: [{ description: 'Konsulttimmar', quantity: hours, unit: 'tim', unit_price: 100, vat_rate: 25 }],
    }),
  )
  return data.invoice_id as string
}

/** An EU business customer's EUR invoice under reverse charge (no moms). */
async function draftEur(seed: Seed, date: string, euros: number): Promise<string> {
  const data = await approve(
    seed,
    await stageOperation(seed, 'create_invoice', {
      customer_id: seed.eu,
      invoice_date: date,
      due_date: '2026-12-31',
      currency: 'EUR',
      items: [{ description: 'Hosting', quantity: 1, unit: 'st', unit_price: euros, vat_rate: 0 }],
    }),
  )
  return data.invoice_id as string
}

async function issuable(seed: Seed, invoiceId: string): Promise<{ invoice: IssuableInvoice; settings: CompanySettings }> {
  const { data: invoice, error } = await seed.supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .single()
  expect(error).toBeNull()
  const { data: settings } = await seed.supabase.from('company_settings').select('*').eq('company_id', seed.companyId).single()
  return { invoice: invoice as IssuableInvoice, settings: settings as CompanySettings }
}

/** Markera som skickad: the issue step, which books the registration under faktureringsmetoden. */
async function issue(seed: Seed, invoiceId: string, paidAtIssue?: { settlementAccountNumber: string }): Promise<void> {
  const { invoice, settings } = await issuable(seed, invoiceId)
  const result = await runWithActor({ type: 'user' }, () =>
    issueAndBookInvoice({
      supabase: seed.supabase,
      companyId: seed.companyId,
      userId: seed.userId,
      invoice,
      settings,
      log,
      ...(paidAtIssue ? { paidAtIssue } : {}),
    }),
  )
  expect(result.ok, JSON.stringify(result)).toBe(true)
}

/** A drafted and issued domestic invoice. */
async function issued(seed: Seed, date: string, hours: number): Promise<string> {
  const id = await draft(seed, date, hours)
  await issue(seed, id)
  return id
}

async function setMethod(seed: Seed, method: 'accrual' | 'cash'): Promise<void> {
  await getPool().query(`UPDATE public.company_settings SET accounting_method = $2 WHERE company_id = $1`, [seed.companyId, method])
}

/** A drafted domestic invoice issued under kontantmetoden: no verifikat until it is paid. */
async function issuedUnderCash(seed: Seed, date: string, hours: number): Promise<Prepared> {
  await setMethod(seed, 'cash')
  return { invoiceIds: [await issued(seed, date, hours)], restore: () => setMethod(seed, 'accrual') }
}

/** A bank line as the feed leaves it: uncategorized, not linked. */
async function insertRow(
  seed: Seed,
  row: { date: string; description: string; amount: number; currency?: string; amount_sek?: number; exchange_rate?: number },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, date, description, amount, currency, amount_sek, exchange_rate, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'uncategorized')`,
    [id, seed.companyId, seed.userId, row.date, row.description, row.amount, row.currency ?? 'SEK', row.amount_sek ?? null, row.exchange_rate ?? null],
  )
  return id
}

/** A bank line categorized as income before the match: it carries a bank_transaction verifikat. */
async function categorizedRow(seed: Seed, row: { date: string; description: string; amount: number }): Promise<string> {
  const id = await insertRow(seed, row)
  const categorized = await runWithActor({ type: 'user' }, () =>
    categorizeTransaction(seed.supabase, seed.userId, seed.companyId, id, { is_business: true, category: 'income_services' }, {
      onBooked: 'refuse',
      invoiceMatchIntercept: false,
    }),
  )
  expect(categorized.ok, JSON.stringify(categorized)).toBe(true)
  return id
}

function sessionRequest(pathname: string, body: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

let idempotency = 0

function v1Request(seed: Seed, pathname: string, body?: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${seed.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `pg-parity-invoice-payments-${Date.now()}-${++idempotency}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function expectStatus(response: Response, status: number, code?: string): Promise<void> {
  const text = await response.text()
  expect(response.status, text).toBe(status)
  if (code) expect(text).toContain(code)
}

function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) }
}

async function markPaid(invoiceId: string, body: unknown): Promise<void> {
  await expectStatus(await markPaidRoute(sessionRequest(`/api/invoices/${invoiceId}/mark-paid`, body), params({ id: invoiceId })), 200)
}

async function match(transactionId: string, body: Record<string, unknown>): Promise<void> {
  await expectStatus(
    await matchInvoiceRoute(sessionRequest(`/api/transactions/${transactionId}/match-invoice`, body), params({ id: transactionId })),
    200,
  )
}

async function v1Match(seed: Seed, transactionId: string, body: Record<string, unknown>): Promise<void> {
  await expectStatus(
    await v1MatchInvoiceRoute(
      v1Request(seed, `/api/v1/companies/${seed.companyId}/transactions/${transactionId}/match-invoice`, body),
      params({ companyId: seed.companyId, id: transactionId }),
    ),
    200,
  )
}

/** The way out a match of a booked row names: the row's own booking is undone first. */
async function uncategorize(transactionId: string): Promise<void> {
  await expectStatus(
    await uncategorizeRoute(sessionRequest(`/api/transactions/${transactionId}/uncategorize`, {}), params({ id: transactionId })),
    200,
  )
}

async function v1Uncategorize(seed: Seed, transactionId: string): Promise<void> {
  await expectStatus(
    await v1UncategorizeRoute(
      v1Request(seed, `/api/v1/companies/${seed.companyId}/transactions/${transactionId}/uncategorize`, {}),
      params({ companyId: seed.companyId, id: transactionId }),
    ),
    200,
  )
}

/** The live payment verifikat of an invoice. */
async function paymentEntryOf(invoiceId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id::text AS id FROM public.journal_entries
      WHERE source_id = $1 AND source_type IN ('invoice_paid', 'invoice_cash_payment') AND status = 'posted'`,
    [invoiceId],
  )
  expect(rows).toHaveLength(1)
  return rows[0]!.id
}

const STAGED = 'agent_proposed_user_approved'
const LINES = 'se.customer-payment-lines'
/** A payment of an issued domestic invoice (faktureringsmetoden: the 1510 clearing, no moms). */
const PAID = {
  kind: 'sale.payment_received',
  role: 'produced',
  party: 'domestic',
  currency: 'SEK',
  vat: null,
  direction: null,
  mappingSource: LINES,
  entries: ['invoice_paid'],
} as const
/** A bank match of an issued domestic invoice: money in on the row. */
const MATCHED = { ...PAID, direction: 'in', link_basis: 'user_confirmed' } as const
/** Kontantmetoden: the sale and its moms are booked at payment. */
const CASH = { ...PAID, entries: ['invoice_cash_payment'] } as const
const STORNO = {
  kind: 'ledger.storno',
  role: 'reversal',
  occurred_on: 'today',
  party: null,
  currency: null,
  amount: null,
  amount_sek: null,
  vat: null,
  direction: null,
  mappingSource: null,
  entries: ['storno'],
} as const
const invoice0 = { type: 'invoice', index: 0 } as const
const row0 = { type: 'transaction', index: 0 } as const
/** 25 % moms of a domestic invoice of `hours` consulting hours. */
const vat = (hours: number) => ({ treatment: 'standard_25', amount_sek: hours * 25 })

const FLOWS: Flow[] = [
  {
    name: 'mark-paid (dashboard): an issued invoice paid in full to the default account',
    setup: async (seed) => ({ invoiceIds: [await issued(seed, '2026-02-02', 10)] }),
    run: async (_seed, { invoiceIds }) => markPaid(invoiceIds![0]!, { payment_date: '2026-02-20' }),
    events: [{ ...PAID, occurred_on: '2026-02-20', subject: invoice0, amount: 1250, amount_sek: 1250, link_basis: 'user_created' }],
  },
  {
    name: "mark-paid (dashboard): a partial payment on the person's own rows",
    setup: async (seed) => ({ invoiceIds: [await issued(seed, '2026-02-03', 11)] }),
    run: async (_seed, { invoiceIds }) =>
      markPaid(invoiceIds![0]!, {
        payment_date: '2026-02-21',
        lines: [
          { account_number: '1930', debit_amount: 600, credit_amount: 0, line_description: 'Delbetalning' },
          { account_number: '1510', debit_amount: 0, credit_amount: 600 },
        ],
      }),
    // The person's own rows: no rule made them, and the door names no payment account.
    events: [{ ...PAID, occurred_on: '2026-02-21', subject: invoice0, amount: 600, amount_sek: null, link_basis: 'user_created', mappingSource: null }],
  },
  {
    name: 'mark-paid (dashboard): an EUR invoice paid with a kursvinst',
    setup: async (seed) => {
      const id = await draftEur(seed, '2026-03-10', 200)
      await issue(seed, id)
      return { invoiceIds: [id] }
    },
    run: async (_seed, { invoiceIds }) => markPaid(invoiceIds![0]!, { payment_date: '2026-03-31', exchange_rate_difference: 40 }),
    events: [
      { ...PAID, occurred_on: '2026-03-31', subject: invoice0, party: 'eu', currency: 'EUR', amount: 200, amount_sek: 2340, link_basis: 'user_created' },
    ],
  },
  {
    name: 'mark-paid (dashboard): kontantmetoden books a never-booked invoice with its moms at payment',
    setup: (seed) => issuedUnderCash(seed, '2026-02-04', 12),
    run: async (_seed, { invoiceIds }) => markPaid(invoiceIds![0]!, { payment_date: '2026-02-22' }),
    events: [{ ...CASH, occurred_on: '2026-02-22', subject: invoice0, amount: 1500, amount_sek: 1500, vat: vat(12), link_basis: 'user_created' }],
  },
  {
    name: 'mark-paid (v1): an issued invoice paid on an API key',
    setup: async (seed) => ({ invoiceIds: [await issued(seed, '2026-02-05', 13)] }),
    run: async (seed, { invoiceIds }) => {
      const id = invoiceIds![0]!
      await expectStatus(
        await v1MarkPaidRoute(
          v1Request(seed, `/api/v1/companies/${seed.companyId}/invoices/${id}/mark-paid`, { payment_date: '2026-02-23' }),
          params({ companyId: seed.companyId, id }),
        ),
        200,
      )
    },
    events: [{ ...PAID, occurred_on: '2026-02-23', subject: invoice0, amount: 1625, amount_sek: 1625, link_basis: 'client_asserted' }],
  },
  {
    name: 'mark-paid (staged): a mark_invoice_paid approved',
    setup: async (seed) => ({ invoiceIds: [await issued(seed, '2026-02-06', 14)] }),
    run: async (seed, { invoiceIds }) => {
      await approve(seed, await stageOperation(seed, 'mark_invoice_paid', { invoice_id: invoiceIds![0], payment_date: '2026-02-24' }))
    },
    events: [{ ...PAID, occurred_on: '2026-02-24', subject: invoice0, amount: 1750, amount_sek: 1750, link_basis: STAGED }],
  },
  {
    name: 'kontantfaktura: an invoice paid at issue books the sale and the payment as one verifikat',
    setup: async (seed) => ({ invoiceIds: [await draft(seed, '2026-02-09', 15)] }),
    run: async (seed, { invoiceIds }) => issue(seed, invoiceIds![0]!, { settlementAccountNumber: '1930' }),
    events: [{ ...CASH, occurred_on: '2026-02-09', subject: invoice0, amount: 1875, amount_sek: 1875, vat: vat(15), link_basis: 'user_created' }],
  },
  {
    name: 'bank match (dashboard): a SEK row paying an issued invoice in full',
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-04-01', 16)],
      transactionIds: [await insertRow(seed, { date: '2026-04-14', description: 'Kund AB faktura', amount: 2000 })],
    }),
    run: async (_seed, { invoiceIds, transactionIds }) => match(transactionIds![0]!, { invoice_id: invoiceIds![0] }),
    events: [{ ...MATCHED, occurred_on: '2026-04-14', subject: invoice0, amount: 2000, amount_sek: 2000 }],
  },
  {
    name: 'bank match (dashboard): a SEK row paying part of an issued invoice',
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-04-02', 17)],
      transactionIds: [await insertRow(seed, { date: '2026-04-15', description: 'Kund AB delbetalning', amount: 1000 })],
    }),
    run: async (_seed, { invoiceIds, transactionIds }) => match(transactionIds![0]!, { invoice_id: invoiceIds![0] }),
    events: [{ ...MATCHED, occurred_on: '2026-04-15', subject: invoice0, amount: 1000, amount_sek: 1000 }],
  },
  {
    name: 'bank match (dashboard): an overpayment, the excess booked on 2420',
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-04-03', 18)],
      transactionIds: [await insertRow(seed, { date: '2026-04-16', description: 'Kund AB med förskott', amount: 2450 })],
    }),
    run: async (_seed, { invoiceIds, transactionIds }) =>
      match(transactionIds![0]!, { invoice_id: invoiceIds![0], overpayment_account: '2420', overpayment_amount: 200 }),
    // The debt settled is the invoice; the kronor in include the advance.
    events: [{ ...MATCHED, occurred_on: '2026-04-16', subject: invoice0, amount: 2250, amount_sek: 2450 }],
  },
  {
    name: 'bank match (dashboard): an EUR row on an EUR invoice, the kursdifferens on 3960',
    setup: async (seed) => {
      const id = await draftEur(seed, '2026-03-10', 300)
      await issue(seed, id)
      return {
        invoiceIds: [id],
        transactionIds: [
          await insertRow(seed, { date: '2026-04-17', description: 'Kunde GmbH', amount: 300, currency: 'EUR', amount_sek: 3510, exchange_rate: 11.7 }),
        ],
      }
    },
    run: async (_seed, { invoiceIds, transactionIds }) => match(transactionIds![0]!, { invoice_id: invoiceIds![0] }),
    events: [{ ...MATCHED, occurred_on: '2026-04-17', subject: invoice0, party: 'eu', currency: 'EUR', amount: 300, amount_sek: 3510 }],
  },
  {
    name: 'bank match (dashboard): a row categorized first has that verifikat reversed, then the payment is booked',
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-04-06', 19)],
      transactionIds: [await categorizedRow(seed, { date: '2026-04-20', description: 'Kund AB kategoriserad', amount: 2375 })],
    }),
    run: async (_seed, { invoiceIds, transactionIds }) => {
      await uncategorize(transactionIds![0]!)
      await match(transactionIds![0]!, { invoice_id: invoiceIds![0] })
    },
    events: [
      { ...STORNO, subject: row0, link_basis: 'user_created' },
      { ...MATCHED, occurred_on: '2026-04-20', subject: invoice0, amount: 2375, amount_sek: 2375 },
    ],
  },
  {
    name: 'bank match (dashboard): kontantmetoden settles a never-booked invoice from the row',
    setup: async (seed) => {
      const prepared = await issuedUnderCash(seed, '2026-04-07', 20)
      return { ...prepared, transactionIds: [await insertRow(seed, { date: '2026-04-21', description: 'Kund AB kontant', amount: 2500 })] }
    },
    run: async (_seed, { invoiceIds, transactionIds }) => match(transactionIds![0]!, { invoice_id: invoiceIds![0] }),
    events: [
      { ...CASH, occurred_on: '2026-04-21', subject: invoice0, amount: 2500, amount_sek: 2500, vat: vat(20), direction: 'in', link_basis: 'user_confirmed' },
    ],
  },
  {
    name: "bank match (dashboard): the person's own rows",
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-04-08', 21)],
      transactionIds: [await insertRow(seed, { date: '2026-04-22', description: 'Kund AB egna rader', amount: 2625 })],
    }),
    run: async (_seed, { invoiceIds, transactionIds }) =>
      match(transactionIds![0]!, {
        invoice_id: invoiceIds![0],
        lines: [
          { account_number: '1930', debit_amount: 2625, credit_amount: 0, line_description: 'Inbetalning' },
          { account_number: '1510', debit_amount: 0, credit_amount: 2625, line_description: 'Kundfordran' },
        ],
      }),
    events: [{ ...MATCHED, occurred_on: '2026-04-22', subject: invoice0, amount: 2625, amount_sek: null, mappingSource: null }],
  },
  {
    name: 'bank match (v1): a SEK row paying an issued invoice in full',
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-05-04', 22)],
      transactionIds: [await insertRow(seed, { date: '2026-05-18', description: 'Kund AB v1', amount: 2750 })],
    }),
    run: async (seed, { invoiceIds, transactionIds }) => v1Match(seed, transactionIds![0]!, { invoice_id: invoiceIds![0] }),
    events: [{ ...MATCHED, occurred_on: '2026-05-18', subject: invoice0, amount: 2750, amount_sek: 2750, link_basis: 'client_asserted' }],
  },
  {
    name: 'bank match (v1): a row categorized first has that verifikat reversed, then the payment is booked',
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-05-05', 23)],
      transactionIds: [await categorizedRow(seed, { date: '2026-05-19', description: 'Kund AB v1 kategoriserad', amount: 2875 })],
    }),
    run: async (seed, { invoiceIds, transactionIds }) => {
      await v1Uncategorize(seed, transactionIds![0]!)
      await v1Match(seed, transactionIds![0]!, { invoice_id: invoiceIds![0] })
    },
    events: [
      { ...STORNO, subject: row0, link_basis: 'client_asserted' },
      { ...MATCHED, occurred_on: '2026-05-19', subject: invoice0, amount: 2875, amount_sek: 2875, link_basis: 'client_asserted' },
    ],
  },
  {
    name: 'bank match (v1): kontantmetoden settles a never-booked invoice from the row',
    setup: async (seed) => {
      const prepared = await issuedUnderCash(seed, '2026-05-06', 24)
      return { ...prepared, transactionIds: [await insertRow(seed, { date: '2026-05-20', description: 'Kund AB v1 kontant', amount: 3000 })] }
    },
    run: async (seed, { invoiceIds, transactionIds }) => v1Match(seed, transactionIds![0]!, { invoice_id: invoiceIds![0] }),
    events: [
      { ...CASH, occurred_on: '2026-05-20', subject: invoice0, amount: 3000, amount_sek: 3000, vat: vat(24), direction: 'in', link_basis: 'client_asserted' },
    ],
  },
  {
    name: "bank match (v1): the person's own rows",
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-05-07', 25)],
      transactionIds: [await insertRow(seed, { date: '2026-05-21', description: 'Kund AB v1 egna rader', amount: 3125 })],
    }),
    run: async (seed, { invoiceIds, transactionIds }) =>
      v1Match(seed, transactionIds![0]!, {
        invoice_id: invoiceIds![0],
        lines: [
          { account_number: '1930', debit_amount: 3125, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 3125 },
        ],
      }),
    events: [{ ...MATCHED, occurred_on: '2026-05-21', subject: invoice0, amount: 3125, amount_sek: null, link_basis: 'client_asserted', mappingSource: null }],
  },
  {
    name: 'bank match (staged): a match_transaction_invoice approved',
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-06-01', 26)],
      transactionIds: [await insertRow(seed, { date: '2026-06-15', description: 'Kund AB agent', amount: 3250 })],
    }),
    run: async (seed, { invoiceIds, transactionIds }) => {
      await approve(seed, await stageOperation(seed, 'match_transaction_invoice', { transaction_id: transactionIds![0], invoice_id: invoiceIds![0] }))
    },
    events: [{ ...MATCHED, occurred_on: '2026-06-15', subject: invoice0, amount: 3250, amount_sek: 3250, link_basis: STAGED }],
  },
  {
    name: 'bank match (staged): a row categorized first has that verifikat reversed, then the payment is booked',
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-06-02', 27)],
      transactionIds: [await categorizedRow(seed, { date: '2026-06-16', description: 'Kund AB agent kategoriserad', amount: 3375 })],
    }),
    run: async (seed, { invoiceIds, transactionIds }) => {
      const { rows } = await getPool().query<{ journal_entry_id: string }>(
        `SELECT journal_entry_id::text AS journal_entry_id FROM public.transactions WHERE id = $1`,
        [transactionIds![0]],
      )
      await approve(seed, await stageOperation(seed, 'uncategorize_transaction', { transaction_id: transactionIds![0], journal_entry_id: rows[0]!.journal_entry_id }))
      await approve(seed, await stageOperation(seed, 'match_transaction_invoice', { transaction_id: transactionIds![0], invoice_id: invoiceIds![0] }))
    },
    events: [
      { ...STORNO, subject: row0, link_basis: STAGED },
      { ...MATCHED, occurred_on: '2026-06-16', subject: invoice0, amount: 3375, amount_sek: 3375, link_basis: STAGED },
    ],
  },
  {
    name: 'bank match (staged): kontantmetoden settles a never-booked invoice from the row',
    setup: async (seed) => {
      const prepared = await issuedUnderCash(seed, '2026-06-03', 28)
      return { ...prepared, transactionIds: [await insertRow(seed, { date: '2026-06-17', description: 'Kund AB agent kontant', amount: 3500 })] }
    },
    run: async (seed, { invoiceIds, transactionIds }) => {
      await approve(seed, await stageOperation(seed, 'match_transaction_invoice', { transaction_id: transactionIds![0], invoice_id: invoiceIds![0] }))
    },
    events: [
      { ...CASH, occurred_on: '2026-06-17', subject: invoice0, amount: 3500, amount_sek: 3500, vat: vat(28), direction: 'in', link_basis: STAGED },
    ],
  },
  {
    name: 'reversal hook: a payment marked by the dashboard, reversed, puts the invoice back to unpaid',
    setup: async (seed) => ({ invoiceIds: [await issued(seed, '2026-07-01', 29)] }),
    run: async (seed, { invoiceIds }) => {
      const id = invoiceIds![0]!
      await markPaid(id, { payment_date: '2026-07-10' })
      await runWithActor({ type: 'user' }, async () => reverseEntry(seed.supabase, seed.companyId, seed.userId, await paymentEntryOf(id)))
    },
    events: [{ ...PAID, occurred_on: '2026-07-10', subject: invoice0, amount: 3625, amount_sek: 3625, link_basis: 'user_created' }],
    unmoved: ['storno'],
  },
  {
    name: 'reversal hook: a kontantmetoden payment, reversed, puts the invoice back to unpaid',
    setup: (seed) => issuedUnderCash(seed, '2026-07-02', 30),
    run: async (seed, { invoiceIds }) => {
      const id = invoiceIds![0]!
      await markPaid(id, { payment_date: '2026-07-11' })
      await runWithActor({ type: 'user' }, async () => reverseEntry(seed.supabase, seed.companyId, seed.userId, await paymentEntryOf(id)))
    },
    events: [{ ...CASH, occurred_on: '2026-07-11', subject: invoice0, amount: 3750, amount_sek: 3750, vat: vat(30), link_basis: 'user_created' }],
    unmoved: ['storno'],
  },
  {
    name: 'reversal hook: a bank match, reversed, puts the invoice back to unpaid',
    setup: async (seed) => ({
      invoiceIds: [await issued(seed, '2026-07-03', 31)],
      transactionIds: [await insertRow(seed, { date: '2026-07-14', description: 'Kund AB återförd', amount: 3875 })],
    }),
    run: async (seed, { invoiceIds, transactionIds }) => {
      const id = invoiceIds![0]!
      await match(transactionIds![0]!, { invoice_id: id })
      await runWithActor({ type: 'user' }, async () => reverseEntry(seed.supabase, seed.companyId, seed.userId, await paymentEntryOf(id)))
    },
    events: [{ ...MATCHED, occurred_on: '2026-07-14', subject: invoice0, amount: 3875, amount_sek: 3875 }],
    unmoved: ['storno'],
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
}

interface DumpEntry {
  voucher_series: string
  voucher_number: number | null
  entry_date: string
  description: string
  source_type: string
  status: string
  notes: string | null
  lines: DumpLine[]
}

interface FlowDump {
  flow: string
  entries: DumpEntry[]
}

/** Every verifikat of the company, live or not, by id. */
async function entryIdsOf(companyId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1`, [companyId])
  return new Set(rows.map((r) => r.id))
}

/**
 * The verifikat a flow's door wrote, in series and number order, normalised:
 * no ids, no timestamps. A storno lists its original's lines in the order
 * reverseEntry reads them back (an unordered embed), so lines are compared in
 * account, amount, text and dimension order.
 */
async function dumpEntries(companyId: string, entryIds: string[]): Promise<Array<DumpEntry & { id: string }>> {
  const { rows } = await getPool().query<DumpEntry & { id: string }>(
    `SELECT je.id::text AS id, je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status, je.notes,
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
                       'dimensions', l.dimensions)
                     ORDER BY l.account_number, l.debit_amount, l.credit_amount, l.line_description, l.dimensions::text)
                FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = je.id
            ), '[]'::jsonb) AS lines
       FROM public.journal_entries je
      WHERE je.company_id = $1 AND je.id = ANY($2::uuid[])
      ORDER BY je.voucher_series, je.voucher_number NULLS LAST, je.entry_date, je.created_at`,
    [companyId, entryIds],
  )
  return rows
}

/** What the doors and the payment sync write beside the verifikat: invoices, payment rows and bank lines. */
async function registerOf(seed: Seed): Promise<unknown> {
  const voucher = (alias: string) => `${alias}.voucher_series || coalesce(${alias}.voucher_number::text, '-') || ':' || ${alias}.status`
  const [invoices, payments, transactions] = await Promise.all([
    getPool().query(
      `SELECT i.invoice_number, i.status, i.currency, i.total::text AS total, i.paid_amount::text AS paid_amount,
              i.remaining_amount::text AS remaining_amount, i.paid_at::text AS paid_at, ${voucher('je')} AS voucher
         FROM public.invoices i
         LEFT JOIN public.journal_entries je ON je.id = i.journal_entry_id
        WHERE i.company_id = $1
        ORDER BY i.created_at, i.invoice_date`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT i.invoice_number, p.payment_date::text AS payment_date, p.amount::text AS amount, p.currency,
              p.exchange_rate::text AS exchange_rate, p.source, p.notes, p.link_basis,
              ${voucher('je')} AS voucher, t.description AS transaction
         FROM public.invoice_payments p
         JOIN public.invoices i ON i.id = p.invoice_id
         LEFT JOIN public.journal_entries je ON je.id = p.journal_entry_id
         LEFT JOIN public.transactions t ON t.id = p.transaction_id
        WHERE p.company_id = $1
        ORDER BY p.payment_date, i.invoice_number, p.amount`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT t.date::text AS date, t.description, t.amount::text AS amount, t.currency, t.category, t.is_business,
              t.link_basis, t.reconciliation_method, ${voucher('je')} AS voucher, i.invoice_number AS invoice
         FROM public.transactions t
         LEFT JOIN public.journal_entries je ON je.id = t.journal_entry_id
         LEFT JOIN public.invoices i ON i.id = t.invoice_id
        WHERE t.company_id = $1
        ORDER BY t.date, t.description, t.amount`,
      [seed.companyId],
    ),
  ])
  return { invoices: invoices.rows, payments: payments.rows, transactions: transactions.rows }
}

interface FlowRun {
  seed: Seed
  dumps: FlowDump[]
  register: unknown
  posted: Array<Prepared & { entries: Array<{ id: string; source_type: string; status: string }> }>
}

async function seedAll(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, entity_type, accounting_method, vat_registered, vat_number, company_name, org_number,
        bankgiro, invoice_payment_accounts)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true, 'SE556677889901', 'Konsultbolaget AB', '556677-8899',
             '5050-1055', $3)`,
    [userId, companyId, JSON.stringify({ EUR: { iban: 'SE4550000000058398257466', bic: 'ESSESESS' } })],
  )
  // The day's Riksbanken rate, as the bank sync caches it, so the EUR drafts never call out.
  await getPool().query(
    `INSERT INTO public.exchange_rates (currency, rate_date, rate, observation_date, source)
     VALUES ('EUR', '2026-03-10', 11.5, '2026-03-10', 'riksbanken')
     ON CONFLICT (currency, rate_date) DO NOTHING`,
  )
  const customer = async (name: string, type: string, extra: Record<string, unknown>) => {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.customers (user_id, company_id, name, customer_type, country, vat_number, vat_number_validated, org_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
      [userId, companyId, name, type, extra.country ?? 'SE', extra.vat_number ?? null, extra.vat_number_validated ?? false, extra.org_number ?? null],
    )
    return rows[0]!.id
  }
  const domestic = await customer('Kund AB', 'swedish_business', { org_number: '559900-1234', vat_number: 'SE559900123401' })
  const eu = await customer('Kunde GmbH', 'eu_business', { country: 'DE', vat_number: 'DE123456789', vat_number_validated: true })
  const key = generateApiKey('live')
  await getPool().query(
    `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
     VALUES ($1, $2, $3, $4, 'Bokföringsnyckel', $5)`,
    [userId, companyId, key.hash, key.prefix, V1_SCOPES],
  )
  session.userId = userId
  session.companyId = companyId
  return { userId, companyId, fiscalPeriodId, domestic, eu, apiKey: key.key, supabase: createServiceClientNoCookies() }
}

async function runFlows(): Promise<FlowRun> {
  const seed = await seedAll()
  const dumps: FlowDump[] = []
  const posted: FlowRun['posted'] = []
  for (const flow of FLOWS) {
    const prepared = await flow.setup(seed)
    const before = await entryIdsOf(seed.companyId)
    try {
      await flow.run(seed, prepared)
    } finally {
      await prepared.restore?.()
    }
    const written = [...(await entryIdsOf(seed.companyId))].filter((id) => !before.has(id))
    const entries = await dumpEntries(seed.companyId, written)
    expect(entries.length, `${flow.name}: the door wrote a verifikat`).toBeGreaterThan(0)
    posted.push({ ...prepared, entries: entries.map(({ id, source_type, status }) => ({ id, source_type, status })) })
    dumps.push({ flow: flow.name, entries: entries.map(({ id: _id, ...entry }) => entry) })
  }
  return { seed, dumps, register: await registerOf(seed), posted }
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
  tax_amounts: Array<{ tax: string; treatment: string | null; amount_sek: number }>
  evidence: Record<string, unknown>
  pending_operation_id: string | null
  actor_type: string | null
  mapping_version: string | null
  jurisdiction: string
  idempotency_key: string | null
  role: string | null
  journal_entry_id: string | null
  entry_status: string | null
}

/** Every event of the company, once per link, with the status of the verifikat each link points at. */
async function eventLinks(companyId: string): Promise<EventLinkRow[]> {
  const { rows } = await getPool().query<EventLinkRow>(
    `SELECT e.id::text AS id, e.kind, e.category, e.occurred_on::text AS occurred_on,
            e.subject_type, e.subject_id::text AS subject_id, e.party_type, e.party_id::text AS party_id,
            e.currency, e.amount::text AS amount, e.amount_sek::text AS amount_sek, e.tax_amounts, e.evidence,
            e.pending_operation_id::text AS pending_operation_id, e.actor_type, e.mapping_version, e.jurisdiction,
            e.idempotency_key, l.role, l.journal_entry_id::text AS journal_entry_id, je.status AS entry_status
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
       LEFT JOIN public.journal_entries je ON je.id = l.journal_entry_id
      WHERE e.company_id = $1
      ORDER BY e.created_at, je.voucher_number`,
    [companyId],
  )
  return rows
}

/** How many event links each of these verifikat has. */
async function linkCounts(entryIds: string[]): Promise<Array<{ id: string; source_type: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; source_type: string; links: number }>(
    `SELECT je.id::text AS id, je.source_type,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.journal_entry_id = je.id) AS links
       FROM public.journal_entries je
      WHERE je.id = ANY($1::uuid[])`,
    [entryIds],
  )
  return rows
}

async function linksOf(entryId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.business_event_entries WHERE journal_entry_id = $1`,
    [entryId],
  )
  return rows[0]!.n
}

/** How many voucher numbers the company has drawn, over every series. */
async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(sum(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** A trigger that refuses every insert into `table`. */
async function failInserts(table: 'business_events' | 'business_event_entries'): Promise<() => Promise<void>> {
  const fn = `pg_test_ip_fail_${table}`
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

const LIVE = new Set(['draft', 'posted', 'reversed'])

function subjectOf(prepared: Prepared, subject: ExpectedEvent['subject']): string {
  const ids = subject.type === 'invoice' ? prepared.invoiceIds : prepared.transactionIds
  return ids![subject.index]!
}

/** An approval through the dispatcher that may refuse: its outcome, as a door's HTTP status would be. */
async function approveStatus(seed: Seed, op: PendingOperation): Promise<number> {
  const result = await runWithActor({ type: 'user' }, () =>
    commitPendingOperation(seed.supabase, seed.userId, seed.companyId, op, { commitMethod: 'user_accept', actor: { type: 'user' } }),
  )
  return result.status === 'committed' ? 200 : 409
}

/**
 * One door each, on records prepared beforehand (their registration verifikat
 * drawn before the doors run): the dashboard mark-paid (generated and the
 * person's own rows), the v1 mark-paid, the staged mark_invoice_paid, the
 * kontantfaktura at issue, and two dashboard, two v1 and one staged bank
 * match on free rows. Answers each door's HTTP status (or the lib door's
 * outcome as 200 / 409).
 */
interface DoorSet {
  run: () => Promise<number[]>
  /** The invoices the doors pay, to read their state after a refusal. */
  invoiceIds: string[]
  /** The bank lines the doors match, with the verifikat each carried before. */
  rows: Array<{ id: string; journalEntryId: string | null }>
}

/** The verifikat the doors post: one payment each. */
const DOOR_VOUCHERS = 10

let doorSeq = 0

async function prepareDoors(seed: Seed, date: string): Promise<DoorSet> {
  const n = ++doorSeq
  // Distinct amounts per door and per set, so no door reads another's payment as its duplicate.
  const hours = (k: number) => 40 + n * 12 + k
  const invoice = (k: number) => issued(seed, date, hours(k))
  const [markPaidId, ownRowsId, v1MarkPaidId, stagedPaidId] = [await invoice(0), await invoice(1), await invoice(2), await invoice(3)]
  const kontantfakturaId = await draft(seed, date, hours(4))
  const [matchId, secondMatchId, v1MatchId, secondV1Id, stagedMatchId] = [
    await invoice(5),
    await invoice(6),
    await invoice(7),
    await invoice(8),
    await invoice(9),
  ]
  const row = (k: number) => insertRow(seed, { date, description: `Inbetalning ${n}-${k}`, amount: hours(k) * 125 })
  const matchRow = await row(5)
  const secondMatchRow = await row(6)
  const v1MatchRow = await row(7)
  const secondV1Row = await row(8)
  const stagedMatchRow = await row(9)
  const rowIds = [matchRow, secondMatchRow, v1MatchRow, secondV1Row, stagedMatchRow]
  const { rows } = await getPool().query<{ id: string; journal_entry_id: string | null }>(
    `SELECT id::text AS id, journal_entry_id::text AS journal_entry_id FROM public.transactions WHERE id = ANY($1::uuid[])`,
    [rowIds],
  )
  const v1 = (pathname: string, body: unknown) => v1Request(seed, `/api/v1/companies/${seed.companyId}${pathname}`, body)
  return {
    invoiceIds: [markPaidId, ownRowsId, v1MarkPaidId, stagedPaidId, kontantfakturaId, matchId, secondMatchId, v1MatchId, secondV1Id, stagedMatchId],
    rows: rowIds.map((id) => ({ id, journalEntryId: rows.find((r) => r.id === id)!.journal_entry_id })),
    run: async () => [
      (await markPaidRoute(sessionRequest(`/api/invoices/${markPaidId}/mark-paid`, { payment_date: date }), params({ id: markPaidId }))).status,
      (
        await markPaidRoute(
          sessionRequest(`/api/invoices/${ownRowsId}/mark-paid`, {
            payment_date: date,
            lines: [
              { account_number: '1930', debit_amount: 300, credit_amount: 0 },
              { account_number: '1510', debit_amount: 0, credit_amount: 300 },
            ],
          }),
          params({ id: ownRowsId }),
        )
      ).status,
      (await v1MarkPaidRoute(v1(`/invoices/${v1MarkPaidId}/mark-paid`, { payment_date: date }), params({ companyId: seed.companyId, id: v1MarkPaidId })))
        .status,
      await approveStatus(seed, await stageOperation(seed, 'mark_invoice_paid', { invoice_id: stagedPaidId, payment_date: date })),
      await (async () => {
        const { invoice, settings } = await issuable(seed, kontantfakturaId)
        const result = await runWithActor({ type: 'user' }, () =>
          issueAndBookInvoice({
            supabase: seed.supabase,
            companyId: seed.companyId,
            userId: seed.userId,
            invoice,
            settings,
            log,
            paidAtIssue: { settlementAccountNumber: '1930' },
          }),
        )
        return result.ok ? 200 : 409
      })(),
      (await matchInvoiceRoute(sessionRequest(`/api/transactions/${matchRow}/match-invoice`, { invoice_id: matchId }), params({ id: matchRow }))).status,
      (
        await matchInvoiceRoute(
          sessionRequest(`/api/transactions/${secondMatchRow}/match-invoice`, { invoice_id: secondMatchId }),
          params({ id: secondMatchRow }),
        )
      ).status,
      (
        await v1MatchInvoiceRoute(
          v1(`/transactions/${v1MatchRow}/match-invoice`, { invoice_id: v1MatchId }),
          params({ companyId: seed.companyId, id: v1MatchRow }),
        )
      ).status,
      (
        await v1MatchInvoiceRoute(
          v1(`/transactions/${secondV1Row}/match-invoice`, { invoice_id: secondV1Id }),
          params({ companyId: seed.companyId, id: secondV1Row }),
        )
      ).status,
      await approveStatus(
        seed,
        await stageOperation(seed, 'match_transaction_invoice', { transaction_id: stagedMatchRow, invoice_id: stagedMatchId }),
      ),
    ],
  }
}

/** Every flow books on a fresh company: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 300_000

describe('posting port parity, customer invoice payments and bank matches (pg)', () => {
  it('books the flows exactly as before the move, with POSTING_EVENTS off', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { dumps, register } = await runFlows()

    const recorded = { dumps, register }
    if (process.env.UPDATE_POSTING_PARITY_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
  })

  it('off writes no business event', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { seed } = await runFlows()
    expect(await eventLinks(seed.companyId)).toEqual([])
  })

  it(
    'books the same verifikat with POSTING_EVENTS=shadow and links exactly one event to every verifikat a moved door wrote',
    { timeout: FLOW_TIMEOUT * 2 },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'off')
      const off = await runFlows()
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const shadow = await runFlows()

      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual({ dumps: off.dumps, register: off.register })
      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

      const { companyId } = shadow.seed
      // Every verifikat a moved door wrote has exactly one link; a storno a
      // reversal-hook flow made directly through the engine has none.
      const unmovedIds = new Set<string>()
      for (const [i, flow] of FLOWS.entries()) {
        for (const role of flow.unmoved ?? []) {
          for (const e of shadow.posted[i]!.entries.filter((x) => x.source_type === role)) unmovedIds.add(e.id)
        }
      }
      const written = shadow.posted.flatMap((p) => p.entries.map((e) => e.id))
      const counts = await linkCounts(written)
      expect(counts).toHaveLength(written.length)
      expect(counts.filter((e) => e.links !== (unmovedIds.has(e.id) ? 0 : 1))).toEqual([])

      const links = await eventLinks(companyId)
      const doorEvents = new Set(links.filter((l) => written.includes(l.journal_entry_id ?? '')).map((l) => l.id))
      expect(doorEvents.size).toBe(FLOWS.reduce((n, f) => n + f.events.length, 0))
      const today = (await getPool().query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS d`)).rows[0]!.d
      const operations = new Set<string>()
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        // Every verifikat the door wrote belongs to one of its events, or to a storno made outside the doors.
        const claimed = [...flow.events.flatMap((e) => e.entries), ...(flow.unmoved ?? [])]
        expect(posted.entries.map((e) => e.source_type).sort(), flow.name).toEqual([...claimed].sort())
        for (const [j, expected] of flow.events.entries()) {
          const label = `${flow.name} #${j}`
          const wanted = posted.entries
            .filter((e) => expected.entries.includes(e.source_type as EntryRole) && !unmovedIds.has(e.id))
            .map((e) => e.id)
          const owners = [...new Set(links.filter((l) => wanted.includes(l.journal_entry_id!)).map((l) => l.id))]
          expect(owners, label).toHaveLength(1)
          const rows = links.filter((l) => l.id === owners[0])
          const live = rows.filter((l) => LIVE.has(l.entry_status ?? '')).map((l) => l.journal_entry_id)
          expect(new Set(live), label).toEqual(new Set(wanted))
          const event = rows[0]!
          const partyId = expected.party ? shadow.seed[expected.party] : null
          expect(event, label).toMatchObject({
            kind: expected.kind,
            role: expected.role,
            category: null,
            occurred_on: expected.occurred_on === 'today' ? today : expected.occurred_on,
            subject_type: expected.subject.type,
            subject_id: subjectOf(posted, expected.subject),
            party_type: partyId ? 'customer' : null,
            party_id: partyId,
            currency: expected.currency,
            tax_amounts: expected.vat ? [{ tax: 'vat', treatment: expected.vat.treatment, amount_sek: expected.vat.amount_sek }] : [],
            jurisdiction: 'SE',
            idempotency_key: null,
          })
          expect(rows.every((l) => l.role === expected.role), label).toBe(true)
          expect(event.amount === null ? null : Number(event.amount), label).toBe(expected.amount)
          expect(event.amount_sek === null ? null : Number(event.amount_sek), label).toBe(expected.amount_sek)
          expect(event.evidence.link_basis, label).toBe(expected.link_basis)
          expect(event.evidence.direction ?? null, label).toBe(expected.direction)
          // References only: no customer name in the evidence.
          expect(JSON.stringify(event.evidence)).not.toMatch(/Kund AB|Kunde GmbH/)
          if (expected.mappingSource) {
            expect(event.mapping_version?.startsWith(`${expected.mappingSource}@`), `${label}: ${event.mapping_version}`).toBe(true)
          } else {
            expect(event.mapping_version, label).toBeNull()
          }
          // The session and lib doors run as the user, the v1 doors on the API key.
          expect(event.actor_type, label).toBe(flow.name.includes('(v1)') ? 'api_key' : 'user')
          if (flow.name.includes('(staged)')) {
            // Inside an approval every event names its operation, the storno's included.
            expect(event.pending_operation_id, label).toMatch(/^[0-9a-f-]{36}$/)
            expect(event.evidence.link_evidence, label).toEqual({ pending_operation_id: event.pending_operation_id })
            operations.add(event.pending_operation_id!)
          } else {
            expect(event.pending_operation_id, label).toBeNull()
            expect(event.evidence.link_evidence ?? null, label).toBeNull()
          }
        }
      }
      // The staged mark_invoice_paid, the three staged matches and the undo before one of them.
      expect(operations.size).toBe(5)

      // The payment sync ran on every reversed payment exactly as with the
      // port off (the registers above are equal); here, that it did run.
      for (const [i, flow] of FLOWS.entries()) {
        if (!flow.name.startsWith('reversal hook:')) continue
        const posted = shadow.posted[i]!
        const { rows } = await getPool().query<{ status: string; paid_amount: string; payments: number }>(
          `SELECT status, paid_amount::text AS paid_amount,
                  (SELECT count(*)::int FROM public.invoice_payments p WHERE p.invoice_id = i.id) AS payments
             FROM public.invoices i WHERE id = $1`,
          [posted.invoiceIds![0]],
        )
        expect(rows[0], flow.name).toMatchObject({ status: 'sent', paid_amount: '0' })
        expect(posted.entries.find((e) => e.source_type !== 'storno')!.status, flow.name).toBe('reversed')
      }
    },
  )

  it(
    'shadow posts through a failed event or link write; strict stops every door before a voucher number is drawn',
    { timeout: FLOW_TIMEOUT * 2 },
    async () => {
      const seed = await seedAll()
      const { companyId } = seed
      for (const table of ['business_events', 'business_event_entries'] as const) {
        // Shadow: every door posts, without the event (or its link).
        vi.stubEnv('POSTING_EVENTS', 'shadow')
        const shadowDoors = await prepareDoors(seed, table === 'business_events' ? '2026-08-03' : '2026-08-10')
        const before = await entryIdsOf(companyId)
        const drawnBefore = await lastVoucherNumber(companyId)
        const restore = await failInserts(table)
        let statuses: number[]
        try {
          statuses = await shadowDoors.run()
        } finally {
          await restore()
        }
        expect(statuses, table).toEqual(statuses.map(() => 200))
        const written = [...(await entryIdsOf(companyId))].filter((id) => !before.has(id))
        expect(written, table).toHaveLength(DOOR_VOUCHERS)
        for (const id of written) expect(await linksOf(id), table).toBe(0)
        expect(await lastVoucherNumber(companyId), table).toBe(drawnBefore + DOOR_VOUCHERS)

        // Strict: each door stops before a voucher number is drawn.
        const strictDoors = await prepareDoors(seed, table === 'business_events' ? '2026-08-17' : '2026-08-24')
        const strictBefore = await entryIdsOf(companyId)
        const restoreStrict = await failInserts(table)
        try {
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)
          const refused = await strictDoors.run()
          for (const [i, status] of refused.entries()) expect(status, `${table} door ${i}`).toBeGreaterThanOrEqual(400)
          expect(await lastVoucherNumber(companyId), table).toBe(drawn)
          // Nothing reached the books: no posted verifikat, no invoice paid,
          // every bank line still on the verifikat it carried before.
          const strictWritten = [...(await entryIdsOf(companyId))].filter((id) => !strictBefore.has(id))
          const { rows: posted } = await getPool().query(
            `SELECT id FROM public.journal_entries WHERE id = ANY($1::uuid[]) AND status <> 'cancelled'`,
            [strictWritten],
          )
          expect(posted, table).toEqual([])
          const { rows: invoices } = await getPool().query<{ status: string; paid_amount: string }>(
            `SELECT status, paid_amount::text AS paid_amount FROM public.invoices WHERE id = ANY($1::uuid[])`,
            [strictDoors.invoiceIds],
          )
          expect(invoices, table).toHaveLength(strictDoors.invoiceIds.length)
          expect(invoices.filter((r) => Number(r.paid_amount) !== 0 || r.status === 'paid'), table).toEqual([])
          const { rows: rowState } = await getPool().query<{ id: string; journal_entry_id: string | null; invoice_id: string | null }>(
            `SELECT id::text AS id, journal_entry_id::text AS journal_entry_id, invoice_id::text AS invoice_id
               FROM public.transactions WHERE id = ANY($1::uuid[])`,
            [strictDoors.rows.map((r) => r.id)],
          )
          for (const r of strictDoors.rows) {
            expect(rowState.find((x) => x.id === r.id), table).toMatchObject({ journal_entry_id: r.journalEntryId, invoice_id: null })
          }
        } finally {
          await restoreStrict()
          vi.stubEnv('POSTING_EVENTS', 'shadow')
        }
      }

      // With nothing refused, strict books every door with its event, the
      // next numbers in each series: none of the refusals above left a gap.
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const strictDoors = await prepareDoors(seed, '2026-09-07')
      const before = await entryIdsOf(companyId)
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const drawn = await lastVoucherNumber(companyId)
      expect(await strictDoors.run()).toEqual(Array.from({ length: 10 }, () => 200))
      expect(await lastVoucherNumber(companyId)).toBe(drawn + DOOR_VOUCHERS)
      const written = [...(await entryIdsOf(companyId))].filter((id) => !before.has(id))
      expect(written).toHaveLength(DOOR_VOUCHERS)
      for (const id of written) expect(await linksOf(id)).toBe(1)
      const { rows: series } = await getPool().query<{ voucher_series: string }>(
        `SELECT DISTINCT voucher_series FROM public.journal_entries WHERE company_id = $1 AND voucher_number IS NOT NULL`,
        [companyId],
      )
      expect(series.length).toBeGreaterThan(0)
      for (const { voucher_series } of series) {
        const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, $3)`, [companyId, seed.fiscalPeriodId, voucher_series])
        expect(gaps.rows, voucher_series).toEqual([])
      }
    },
  )
})
