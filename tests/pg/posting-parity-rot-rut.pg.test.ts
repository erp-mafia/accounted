/**
 * Posting port, step 2f-2: proof that booking output does not change when the
 * ROT/RUT postings move onto the port: Skatteverket's payout of a begäran,
 * the payout of several begäran in one transfer, the reclaim of a refused
 * share and the migrated invoice's deduction reclassification.
 *
 * Each producer is driven through its real door on a freshly seeded
 * aktiebolag whose RUT invoices are issued through the issue step (the
 * receivable split over 1510 and 1513): the settle route (a begäran paid in
 * full; a partial beslut paid to another bank account), the
 * bank row match route (one begäran; two begäran paid in one transfer), the
 * staged settle_rot_rut_payout approval, the reclaim route, and the migrated
 * deduction step of the Visma migration (applyMigratedDeduction, as the
 * deduction backfill calls it). Two flows storno a verifikat a moved door
 * posted, so the engine's reversal hooks run on it: the reclaim hook hands
 * the refused share back to Skatteverket's side, the migrated deduction hook
 * puts the deduction back on 1510. Every verifikat a door writes is dumped
 * normalised (series, number, date, description, source type, status and
 * every line) together with the invoices, the payout requests and their
 * items and the bank lines the doors and the hooks write beside them, and
 * the dump is compared with the committed fixture
 * (posting-parity-rot-rut.fixture.json), which was taken before these
 * producers went through the port. A flow's setup (the invoices, the
 * begäran, the bank row) is not part of its dump.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every verifikat a moved door wrote has exactly ONE event linked: a
 *      payout se.rot_rut.payout_received (one for a transfer paying several
 *      begäran), a reclaim se.rot_rut.reclaimed, both without subject and
 *      party, a reclassification se.rot_rut.reclassified with the migrated
 *      invoice as subject, the kronor as magnitudes and the door's link basis
 *      as evidence; the stornos the reversal-hook flows make directly through
 *      the engine carry none, and the reclaim and migrated deduction hooks
 *      hand the shares back exactly as with the port off;
 *   3. a failed event or link write under shadow still posts; under strict
 *      every door stops before a voucher number is drawn, leaving every
 *      begäran and invoice as it was; and detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-rot-rut.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test); the session doors' cookie auth, replaced by the signed-in user on
 * the service-role client (requireAuth and the active company are mocked,
 * the write-role check passes); the invoice PDF the issue archives as
 * underlag (rendering and the storage upload are stubbed); and the begäran,
 * which are written as rows (the XML file Skatteverket receives is not a
 * posting) with the beslut already recorded on them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { issueAndBookInvoice, type IssuableInvoice } from '@/lib/invoices/issue-and-book-invoice'
import { applyMigratedDeduction } from '@/lib/invoices/migrated-deduction-apply'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import type { CompanySettings, PendingOperation } from '@/types'
import { POST as settleRoute } from '@/app/api/rot-rut/payout-requests/[id]/settle/route'
import { POST as reclaimRoute } from '@/app/api/rot-rut/payout-requests/[id]/reclaim/route'
import { POST as matchPayoutRoute } from '@/app/api/transactions/[id]/match-rot-rut-payout/route'
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

const FIXTURE = path.join(__dirname, 'posting-parity-rot-rut.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

/** An aktiebolag under faktureringsmetoden, VAT-registered, selling RUT work to private persons. */
interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  /** A private person: RUT. */
  private: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow's setup made: the records its door acts on. */
interface Prepared {
  invoiceIds?: string[]
  requestIds?: string[]
  transactionIds?: string[]
}

type EntryRole = 'rot_rut_payout' | 'rot_rut_reclaim' | 'rot_rut_reclassification' | 'storno'

/** One business event shadow mode records for a flow, and the verifikat it is linked to. */
interface ExpectedEvent {
  kind: 'se.rot_rut.payout_received' | 'se.rot_rut.reclaimed' | 'se.rot_rut.reclassified'
  /** The act's date. */
  occurred_on: string
  /** Index into the flow's invoiceIds; null for none (a begäran has no handle). */
  subject: number | null
  /** None: Skatteverket has no party row, a begäran spans customers, a reclassification moves the company's own receivable. */
  party: null
  amount: number
  link_basis: string
  link_evidence?: Record<string, unknown>
  direction: 'in' | null
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
 * A RUT invoice to the private customer through the staged create_invoice
 * door, issued by Markera som skickad: `hours` of cleaning at `rate` kr and
 * 800 kr of material, 25 % moms, half the work incl. moms from Skatteverket.
 */
async function rutInvoice(seed: Seed, date: string, hours: number, rate = 400): Promise<string> {
  const data = await approve(
    seed,
    await stageOperation(seed, 'create_invoice', {
      customer_id: seed.private,
      invoice_date: date,
      due_date: '2026-12-31',
      currency: 'SEK',
      items: [
        { description: 'Städning', quantity: hours, unit: 'tim', unit_price: rate, vat_rate: 25, deduction_type: 'rut', labor_hours: hours, work_type: 'STAD' },
        { description: 'Material', quantity: 1, unit: 'st', unit_price: 800, vat_rate: 25 },
      ],
    }),
  )
  const id = data.invoice_id as string
  const { data: invoice, error } = await seed.supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', id)
    .single()
  expect(error).toBeNull()
  const { data: settings } = await seed.supabase.from('company_settings').select('*').eq('company_id', seed.companyId).single()
  const result = await runWithActor({ type: 'user' }, () =>
    issueAndBookInvoice({
      supabase: seed.supabase,
      companyId: seed.companyId,
      userId: seed.userId,
      invoice: invoice as IssuableInvoice,
      settings: settings as CompanySettings,
      log,
    }),
  )
  expect(result.ok, JSON.stringify(result)).toBe(true)
  return id
}

/** The whole kronor of an invoice's deduction: the BegartBelopp a begäran asks for. */
async function requestedAmount(invoiceId: string): Promise<number> {
  const { rows } = await getPool().query<{ d: string }>(`SELECT deduction_total::text AS d FROM public.invoices WHERE id = $1`, [invoiceId])
  return Math.floor(Number(rows[0]!.d))
}

let requestSeq = 0

/**
 * A begäran over the invoices, with Skatteverket's beslut recorded: `decided`
 * per invoice (the requested amount when absent), its status following the
 * beslut (submitted while undecided).
 */
async function payoutRequest(
  seed: Seed,
  invoiceIds: string[],
  beslut: { status: 'submitted' | 'partially_paid' | 'rejected'; decided?: (requested: number) => number } = { status: 'submitted' },
): Promise<string> {
  const id = randomUUID()
  const requested = await Promise.all(invoiceIds.map(requestedAmount))
  const decided = beslut.decided ? requested.map(beslut.decided) : null
  const sum = (values: number[]) => values.reduce((s, v) => s + v, 0)
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_requests
       (id, company_id, user_id, deduction_type, name, status, requested_total, decided_total, decided_at, submitted_at, file_name)
     VALUES ($1, $2, $3, 'rut', $4, $5, $6, $7, $8, '2026-01-15T09:00:00Z', $9)`,
    [
      id,
      seed.companyId,
      seed.userId,
      `RUT 2026-${String(++requestSeq).padStart(2, '0')}`,
      beslut.status,
      sum(requested),
      decided ? sum(decided) : null,
      decided ? '2026-01-20T09:00:00Z' : null,
      `rut-${requestSeq}.xml`,
    ],
  )
  for (const [i, invoiceId] of invoiceIds.entries()) {
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_request_items (request_id, invoice_id, requested_amount, decided_amount)
       VALUES ($1, $2, $3, $4)`,
      [id, invoiceId, requested[i], decided ? decided[i] : null],
    )
  }
  return id
}

/** A bank line as the feed leaves it: uncategorized, not linked. */
async function insertRow(seed: Seed, row: { date: string; description: string; amount: number }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions (id, company_id, user_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, $4, $5, $6, 'SEK', 'uncategorized')`,
    [id, seed.companyId, seed.userId, row.date, row.description, row.amount],
  )
  return id
}

/** The sum Skatteverket pays for these begäran: decided ?? requested. */
async function payoutOf(requestIds: string[]): Promise<number> {
  const { rows } = await getPool().query<{ s: string }>(
    `SELECT coalesce(sum(coalesce(decided_total, requested_total)), 0)::text AS s FROM public.rot_rut_payout_requests WHERE id = ANY($1::uuid[])`,
    [requestIds],
  )
  return Number(rows[0]!.s)
}

/**
 * An invoice the Visma migration brought over: 8 000 net and 2 000 moms, the
 * work row 6 000 and 1 500 moms, so a 50 % RUT deduction is 3 750; the whole
 * invoice sits on 1510 and nothing is paid.
 */
async function migratedInvoice(seed: Seed, number: string): Promise<{ invoiceId: string; workItemId: string }> {
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-08-03', '2026-09-02', 'SEK', 8000, 2000, 10000, 'standard_25', 25, 'sent', 0, 10000)`,
    [invoiceId, seed.userId, seed.companyId, seed.private, number],
  )
  const workItemId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_items
       (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, line_type)
     VALUES ($1, $3, 1, 'Städning', 12, 'tim', 500, 6000, 25, 1500, 'product'),
            ($2, $3, 2, 'Material', 1, 'st', 2000, 2000, 25, 500, 'product')`,
    [workItemId, randomUUID(), invoiceId],
  )
  return { invoiceId, workItemId }
}

/** The deduction step of the migration run, as the deduction backfill calls it. */
async function applyDeduction(seed: Seed, invoiceId: string, workItemId: string, number: string, bookingDate: string): Promise<void> {
  const outcome = await runWithActor({ type: 'user' }, () =>
    applyMigratedDeduction(
      seed.supabase,
      seed.companyId,
      seed.userId,
      {
        outcome: 'apply',
        invoiceId,
        deductionType: 'rut',
        deductionTotal: 3750,
        personnummer: '198001011231',
        paidOn: null,
        resultingStatus: 'sent',
        expected: { status: 'sent', total: 10000, paid_amount: 0, payment_count: 0, item_count: 2 },
        items: [
          {
            id: workItemId,
            line_total: 6000,
            vat_amount: 1500,
            deduction_amount: 3750,
            labor_hours: 12,
            work_type: 'STAD',
            housing_designation: null,
            apartment_number: null,
            brf_org_number: null,
          },
        ],
        reuseVoucherId: null,
      },
      { bookingDate, invoiceNumber: number, trail: { provider: 'visma', consentId: null, correlationId: randomUUID() } },
    ),
  )
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, applied: true })
}

function sessionRequest(pathname: string, body: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
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

async function settle(requestId: string, body: Record<string, unknown>): Promise<void> {
  await expectStatus(await settleRoute(sessionRequest(`/api/rot-rut/payout-requests/${requestId}/settle`, body), params({ id: requestId })), 200)
}

async function reclaim(requestId: string, bookingDate: string): Promise<void> {
  await expectStatus(
    await reclaimRoute(sessionRequest(`/api/rot-rut/payout-requests/${requestId}/reclaim`, { booking_date: bookingDate }), params({ id: requestId })),
    200,
  )
}

async function matchPayout(transactionId: string, body: Record<string, unknown>): Promise<void> {
  await expectStatus(
    await matchPayoutRoute(sessionRequest(`/api/transactions/${transactionId}/match-rot-rut-payout`, body), params({ id: transactionId })),
    200,
  )
}

/** The live verifikat of a source type for a source id. */
async function liveEntryOf(sourceType: string, sourceId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id::text AS id FROM public.journal_entries WHERE source_id = $1 AND source_type = $2 AND status = 'posted'`,
    [sourceId, sourceType],
  )
  expect(rows).toHaveLength(1)
  return rows[0]!.id
}

const STAGED = 'agent_proposed_user_approved'
const PAYOUT = { kind: 'se.rot_rut.payout_received', subject: null, party: null, entries: ['rot_rut_payout'] } as const
const RECLAIM = { kind: 'se.rot_rut.reclaimed', subject: null, party: null, link_basis: 'user_created', direction: null, entries: ['rot_rut_reclaim'] } as const
const RECLASSIFIED = {
  kind: 'se.rot_rut.reclassified',
  subject: 0,
  party: null,
  amount: 3750,
  link_basis: 'import_carried_over',
  link_evidence: { source_system: 'visma' },
  direction: null,
  entries: ['rot_rut_reclassification'],
} as const

const FLOWS: Flow[] = [
  {
    name: 'settle (dashboard): a begäran paid in full to the default account',
    setup: async (seed) => {
      const invoiceId = await rutInvoice(seed, '2026-02-02', 7, 401.3)
      return { invoiceIds: [invoiceId], requestIds: [await payoutRequest(seed, [invoiceId])] }
    },
    run: async (_seed, { requestIds }) => settle(requestIds![0]!, { payment_date: '2026-02-20' }),
    events: [{ ...PAYOUT, occurred_on: '2026-02-20', amount: 1755, link_basis: 'user_created', direction: null }],
  },
  {
    name: 'settle (dashboard): a partial beslut, the paid share cleared and the rest left on 1513',
    setup: async (seed) => {
      const invoiceId = await rutInvoice(seed, '2026-02-03', 10)
      return { invoiceIds: [invoiceId], requestIds: [await payoutRequest(seed, [invoiceId], { status: 'partially_paid', decided: () => 2000 })] }
    },
    run: async (_seed, { requestIds }) => settle(requestIds![0]!, { payment_date: '2026-02-21', bank_account: '1940' }),
    events: [{ ...PAYOUT, occurred_on: '2026-02-21', amount: 2000, link_basis: 'user_created', direction: null }],
  },
  {
    name: 'bank match (dashboard): a bank row matched to its begäran',
    setup: async (seed) => {
      const invoiceId = await rutInvoice(seed, '2026-03-02', 12)
      const requestId = await payoutRequest(seed, [invoiceId])
      return {
        invoiceIds: [invoiceId],
        requestIds: [requestId],
        transactionIds: [await insertRow(seed, { date: '2026-03-20', description: 'SKATTEVERKET RUT', amount: await payoutOf([requestId]) })],
      }
    },
    run: async (_seed, { requestIds, transactionIds }) => matchPayout(transactionIds![0]!, { request_id: requestIds![0] }),
    events: [{ ...PAYOUT, occurred_on: '2026-03-20', amount: 3000, link_basis: 'user_confirmed', direction: 'in' }],
  },
  {
    name: 'bank match (dashboard): one transfer paying two begäran, one voucher with a 1513 leg each',
    setup: async (seed) => {
      const first = await rutInvoice(seed, '2026-03-03', 14)
      const second = await rutInvoice(seed, '2026-03-04', 16)
      const requestIds = [await payoutRequest(seed, [first]), await payoutRequest(seed, [second])]
      return {
        invoiceIds: [first, second],
        requestIds,
        transactionIds: [await insertRow(seed, { date: '2026-03-23', description: 'SKATTEVERKET RUT x2', amount: await payoutOf(requestIds) })],
      }
    },
    run: async (_seed, { requestIds, transactionIds }) => matchPayout(transactionIds![0]!, { request_ids: requestIds }),
    events: [{ ...PAYOUT, occurred_on: '2026-03-23', amount: 7500, link_basis: 'user_confirmed', direction: 'in' }],
  },
  {
    name: 'bank match (staged): a settle_rot_rut_payout approved',
    setup: async (seed) => {
      const invoiceId = await rutInvoice(seed, '2026-04-01', 18)
      const requestId = await payoutRequest(seed, [invoiceId])
      return {
        invoiceIds: [invoiceId],
        requestIds: [requestId],
        transactionIds: [await insertRow(seed, { date: '2026-04-20', description: 'SKATTEVERKET RUT agent', amount: await payoutOf([requestId]) })],
      }
    },
    run: async (seed, { requestIds, transactionIds }) => {
      await approve(seed, await stageOperation(seed, 'settle_rot_rut_payout', { transaction_id: transactionIds![0], request_ids: requestIds }))
    },
    events: [{ ...PAYOUT, occurred_on: '2026-04-20', amount: 4500, link_basis: STAGED, direction: 'in' }],
  },
  {
    name: 'reclaim (dashboard): a refused RUT share booked back onto the customer',
    setup: async (seed) => {
      const invoiceId = await rutInvoice(seed, '2026-05-04', 20)
      return { invoiceIds: [invoiceId], requestIds: [await payoutRequest(seed, [invoiceId], { status: 'rejected', decided: () => 0 })] }
    },
    run: async (_seed, { requestIds }) => reclaim(requestIds![0]!, '2026-05-25'),
    events: [{ ...RECLAIM, occurred_on: '2026-05-25', amount: 5000 }],
  },
  {
    name: 'reclaim (dashboard): the refused part of a partial beslut booked back onto the customer',
    setup: async (seed) => {
      const invoiceId = await rutInvoice(seed, '2026-05-05', 22)
      return {
        invoiceIds: [invoiceId],
        requestIds: [await payoutRequest(seed, [invoiceId], { status: 'partially_paid', decided: (requested) => requested - 1500 })],
      }
    },
    run: async (_seed, { requestIds }) => reclaim(requestIds![0]!, '2026-05-26'),
    events: [{ ...RECLAIM, occurred_on: '2026-05-26', amount: 1500 }],
  },
  {
    name: "reversal hook: a reclaim, reversed, hands the refused share back to Skatteverket's side",
    setup: async (seed) => {
      const invoiceId = await rutInvoice(seed, '2026-06-01', 24)
      return { invoiceIds: [invoiceId], requestIds: [await payoutRequest(seed, [invoiceId], { status: 'rejected', decided: () => 0 })] }
    },
    run: async (seed, { requestIds }) => {
      const requestId = requestIds![0]!
      await reclaim(requestId, '2026-06-22')
      await runWithActor({ type: 'user' }, async () =>
        reverseEntry(seed.supabase, seed.companyId, seed.userId, await liveEntryOf('rot_rut_reclaim', requestId)),
      )
    },
    events: [{ ...RECLAIM, occurred_on: '2026-06-22', amount: 6000 }],
    unmoved: ['storno'],
  },
  {
    name: "migrated deduction: a Visma invoice's RUT deduction moved from 1510 to 1513",
    setup: async (seed) => {
      const { invoiceId, workItemId } = await migratedInvoice(seed, 'V-9001')
      // The work row's id rides in transactionIds' place: setup hands it to run.
      return { invoiceIds: [invoiceId], transactionIds: [workItemId] }
    },
    run: async (seed, { invoiceIds, transactionIds }) => applyDeduction(seed, invoiceIds![0]!, transactionIds![0]!, 'V-9001', '2026-08-20'),
    events: [{ ...RECLASSIFIED, occurred_on: '2026-08-20' }],
  },
  {
    name: 'reversal hook: a reclassification, reversed, puts the deduction back on 1510',
    setup: async (seed) => {
      const { invoiceId, workItemId } = await migratedInvoice(seed, 'V-9002')
      return { invoiceIds: [invoiceId], transactionIds: [workItemId] }
    },
    run: async (seed, { invoiceIds, transactionIds }) => {
      const invoiceId = invoiceIds![0]!
      await applyDeduction(seed, invoiceId, transactionIds![0]!, 'V-9002', '2026-08-21')
      await runWithActor({ type: 'user' }, async () =>
        reverseEntry(seed.supabase, seed.companyId, seed.userId, await liveEntryOf('rot_rut_reclassification', invoiceId)),
      )
    },
    events: [{ ...RECLASSIFIED, occurred_on: '2026-08-21' }],
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

/** What the doors and the hooks write beside the verifikat: invoices, payout requests and their items, bank lines. */
async function registerOf(seed: Seed): Promise<unknown> {
  const voucher = (alias: string) => `${alias}.voucher_series || coalesce(${alias}.voucher_number::text, '-') || ':' || ${alias}.status`
  const [invoices, requests, transactions] = await Promise.all([
    getPool().query(
      `SELECT i.invoice_number, i.status, i.total::text AS total, i.paid_amount::text AS paid_amount,
              i.remaining_amount::text AS remaining_amount, i.deduction_total::text AS deduction_total,
              i.deduction_reclaimed_total::text AS deduction_reclaimed_total, ${voucher('je')} AS voucher,
              (SELECT jsonb_agg(jsonb_build_object('description', it.description, 'deduction_type', it.deduction_type,
                                                   'deduction_amount', it.deduction_amount::text) ORDER BY it.sort_order)
                 FROM public.invoice_items it WHERE it.invoice_id = i.id) AS items
         FROM public.invoices i
         LEFT JOIN public.journal_entries je ON je.id = i.journal_entry_id
        WHERE i.company_id = $1
        ORDER BY i.created_at, i.invoice_number`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT r.name, r.status, r.requested_total::text AS requested_total, r.decided_total::text AS decided_total,
              ${voucher('sje')} AS settlement_voucher, ${voucher('rje')} AS reclaim_voucher,
              (SELECT jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'requested', it.requested_amount::text,
                                                   'decided', it.decided_amount::text, 'reclaimed', it.reclaimed_amount::text)
                                ORDER BY i.invoice_number)
                 FROM public.rot_rut_payout_request_items it JOIN public.invoices i ON i.id = it.invoice_id
                WHERE it.request_id = r.id) AS items
         FROM public.rot_rut_payout_requests r
         LEFT JOIN public.journal_entries sje ON sje.id = r.settlement_journal_entry_id
         LEFT JOIN public.journal_entries rje ON rje.id = r.reclaim_journal_entry_id
        WHERE r.company_id = $1
        ORDER BY r.name`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT t.date::text AS date, t.description, t.amount::text AS amount, t.category, t.is_business, t.link_basis,
              ${voucher('je')} AS voucher
         FROM public.transactions t
         LEFT JOIN public.journal_entries je ON je.id = t.journal_entry_id
        WHERE t.company_id = $1
        ORDER BY t.date, t.description`,
      [seed.companyId],
    ),
  ])
  return { invoices: invoices.rows, payoutRequests: requests.rows, transactions: transactions.rows }
}

interface FlowRun {
  seed: Seed
  dumps: FlowDump[]
  register: unknown
  posted: Array<Prepared & { entries: Array<{ id: string; source_type: string; status: string }> }>
}

async function seedAll(): Promise<Seed> {
  // A begäran's name is unique per company: every company counts from one, so each run names them alike.
  requestSeq = 0
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, entity_type, accounting_method, vat_registered, vat_number, company_name, org_number, bankgiro, f_skatt, address_line1, postal_code, city)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true, 'SE556677889901', 'Städbolaget AB', '556677-8899', '5050-1055', true, 'Testgatan 1', '111 22', 'Stockholm')`,
    [userId, companyId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.customers (user_id, company_id, name, customer_type, country, personal_number, address_line1, postal_code, city)
     VALUES ($1, $2, 'Privatkund', 'individual', 'SE', $3, 'Storgatan 1', '111 22', 'Stockholm') RETURNING id::text AS id`,
    [userId, companyId, encryptPersonnummer('198001011231')],
  )
  session.userId = userId
  session.companyId = companyId
  return { userId, companyId, fiscalPeriodId, private: rows[0]!.id, supabase: createServiceClientNoCookies() }
}

async function runFlows(): Promise<FlowRun> {
  const seed = await seedAll()
  const dumps: FlowDump[] = []
  const posted: FlowRun['posted'] = []
  for (const flow of FLOWS) {
    const prepared = await flow.setup(seed)
    const before = await entryIdsOf(seed.companyId)
    await flow.run(seed, prepared)
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
  tax_amounts: unknown[]
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
async function linkCounts(entryIds: string[]): Promise<Array<{ id: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; links: number }>(
    `SELECT je.id::text AS id,
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
  const fn = `pg_test_rr_fail_${table}`
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

/**
 * One door each, on records prepared beforehand (the RUT invoices issued,
 * the begäran recorded, the bank rows in the feed): the settle route, the
 * bank row match (one begäran; two in one transfer), the staged
 * settle_rot_rut_payout, the reclaim route and the migrated deduction step.
 * Answers each door's HTTP status (or the lib door's outcome as 200 / 409).
 */
interface DoorSet {
  run: () => Promise<number[]>
  requestIds: string[]
  migratedInvoiceId: string
}

/** The verifikat the doors post: one each. */
const DOOR_VOUCHERS = 6

let doorSeq = 0

async function prepareDoors(seed: Seed, date: string): Promise<DoorSet> {
  const n = ++doorSeq
  const hours = (k: number) => 30 + n * 8 + k * 2
  const invoice = (k: number) => rutInvoice(seed, date, hours(k))
  const settleRequest = await payoutRequest(seed, [await invoice(0)])
  const matchRequest = await payoutRequest(seed, [await invoice(1)])
  const setRequests = [await payoutRequest(seed, [await invoice(2)]), await payoutRequest(seed, [await invoice(3)])]
  const stagedRequest = await payoutRequest(seed, [await invoice(4)])
  const reclaimRequest = await payoutRequest(seed, [await invoice(5)], { status: 'rejected', decided: () => 0 })
  const row = async (description: string, requestIds: string[]) => insertRow(seed, { date, description, amount: await payoutOf(requestIds) })
  const matchRow = await row(`SKATTEVERKET ${n} a`, [matchRequest])
  const setRow = await row(`SKATTEVERKET ${n} b`, setRequests)
  const stagedRow = await row(`SKATTEVERKET ${n} c`, [stagedRequest])
  const number = `V-${9100 + n}`
  const migrated = await migratedInvoice(seed, number)
  const status = (response: Response) => response.status
  return {
    requestIds: [settleRequest, matchRequest, ...setRequests, stagedRequest, reclaimRequest],
    migratedInvoiceId: migrated.invoiceId,
    run: async () => [
      status(await settleRoute(sessionRequest(`/api/rot-rut/payout-requests/${settleRequest}/settle`, { payment_date: date }), params({ id: settleRequest }))),
      status(await matchPayoutRoute(sessionRequest(`/api/transactions/${matchRow}/match-rot-rut-payout`, { request_id: matchRequest }), params({ id: matchRow }))),
      status(await matchPayoutRoute(sessionRequest(`/api/transactions/${setRow}/match-rot-rut-payout`, { request_ids: setRequests }), params({ id: setRow }))),
      await (async () => {
        const op = await stageOperation(seed, 'settle_rot_rut_payout', { transaction_id: stagedRow, request_ids: [stagedRequest] })
        const result = await runWithActor({ type: 'user' }, () =>
          commitPendingOperation(seed.supabase, seed.userId, seed.companyId, op, { commitMethod: 'user_accept', actor: { type: 'user' } }),
        )
        return result.status === 'committed' ? 200 : 409
      })(),
      status(await reclaimRoute(sessionRequest(`/api/rot-rut/payout-requests/${reclaimRequest}/reclaim`, { booking_date: date }), params({ id: reclaimRequest }))),
      await (async () => {
        try {
          await applyDeduction(seed, migrated.invoiceId, migrated.workItemId, number, date)
          return 200
        } catch {
          return 409
        }
      })(),
    ],
  }
}

/** Every flow books on a fresh company: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 300_000

describe('posting port parity, ROT/RUT payout, reclaim and reclassification (pg)', () => {
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
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
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
          expect(event, label).toMatchObject({
            kind: expected.kind,
            role: 'produced',
            category: null,
            occurred_on: expected.occurred_on,
            subject_type: expected.subject === null ? null : 'invoice',
            subject_id: expected.subject === null ? null : posted.invoiceIds![expected.subject],
            party_type: null,
            party_id: null,
            currency: 'SEK',
            tax_amounts: [],
            jurisdiction: 'SE',
            idempotency_key: null,
            actor_type: 'user',
          })
          expect(Number(event.amount), label).toBe(expected.amount)
          expect(Number(event.amount_sek), label).toBe(expected.amount)
          expect(event.evidence.link_basis, label).toBe(expected.link_basis)
          expect(event.evidence.direction ?? null, label).toBe(expected.direction)
          expect(event.mapping_version?.startsWith('se.rot-rut-lines@'), `${label}: ${event.mapping_version}`).toBe(true)
          if (expected.link_basis === STAGED) {
            expect(event.pending_operation_id, label).toMatch(/^[0-9a-f-]{36}$/)
            expect(event.evidence.link_evidence, label).toEqual({ pending_operation_id: event.pending_operation_id })
          } else {
            expect(event.pending_operation_id, label).toBeNull()
            expect(event.evidence.link_evidence ?? null, label).toEqual(expected.link_evidence ?? null)
          }
          // References only: no customer name or personnummer in the evidence.
          expect(JSON.stringify(event.evidence)).not.toMatch(/Privatkund|19800101/)
        }
      }

      // The hooks ran on the stornos exactly as with the port off (the
      // registers above are equal); here, that they did run at all.
      const reclaimFlow = FLOWS.findIndex((f) => f.name.startsWith('reversal hook: a reclaim'))
      const { rows: reclaimed } = await getPool().query(
        `SELECT r.reclaim_journal_entry_id, it.reclaimed_amount, i.deduction_reclaimed_total::text AS deduction_reclaimed_total
           FROM public.rot_rut_payout_requests r
           JOIN public.rot_rut_payout_request_items it ON it.request_id = r.id
           JOIN public.invoices i ON i.id = it.invoice_id
          WHERE r.id = $1`,
        [shadow.posted[reclaimFlow]!.requestIds![0]],
      )
      expect(reclaimed).toEqual([{ reclaim_journal_entry_id: null, reclaimed_amount: null, deduction_reclaimed_total: '0.00' }])
      const reclassificationFlow = FLOWS.findIndex((f) => f.name.startsWith('reversal hook: a reclassification'))
      const { rows: reverted } = await getPool().query(
        `SELECT deduction_total::text AS deduction_total, remaining_amount::text AS remaining_amount FROM public.invoices WHERE id = $1`,
        [shadow.posted[reclassificationFlow]!.invoiceIds![0]],
      )
      expect(reverted).toEqual([{ deduction_total: '0.00', remaining_amount: '10000.00' }])
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
        const shadowDoors = await prepareDoors(seed, table === 'business_events' ? '2026-09-01' : '2026-09-08')
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
        const strictDoors = await prepareDoors(seed, table === 'business_events' ? '2026-09-15' : '2026-09-22')
        const strictBefore = await entryIdsOf(companyId)
        const restoreStrict = await failInserts(table)
        try {
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)
          const refused = await strictDoors.run()
          for (const [i, status] of refused.entries()) expect(status, `${table} door ${i}`).toBeGreaterThanOrEqual(400)
          expect(await lastVoucherNumber(companyId), table).toBe(drawn)
          // Nothing reached the books: no posted verifikat, every begäran
          // unsettled and unreclaimed, the migrated invoice without a deduction.
          const strictWritten = [...(await entryIdsOf(companyId))].filter((id) => !strictBefore.has(id))
          const { rows: posted } = await getPool().query(
            `SELECT id FROM public.journal_entries WHERE id = ANY($1::uuid[]) AND status <> 'cancelled'`,
            [strictWritten],
          )
          expect(posted, table).toEqual([])
          const { rows: requests } = await getPool().query(
            `SELECT settlement_journal_entry_id, reclaim_journal_entry_id FROM public.rot_rut_payout_requests WHERE id = ANY($1::uuid[])`,
            [strictDoors.requestIds],
          )
          expect(requests, table).toEqual(strictDoors.requestIds.map(() => ({ settlement_journal_entry_id: null, reclaim_journal_entry_id: null })))
          const { rows: migrated } = await getPool().query(`SELECT deduction_total::text AS d FROM public.invoices WHERE id = $1`, [
            strictDoors.migratedInvoiceId,
          ])
          expect(migrated, table).toEqual([{ d: '0.00' }])
        } finally {
          await restoreStrict()
          vi.stubEnv('POSTING_EVENTS', 'shadow')
        }
      }

      // With nothing refused, strict books every door with its event, the
      // next numbers in each series: none of the refusals above left a gap.
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const strictDoors = await prepareDoors(seed, '2026-09-29')
      const before = await entryIdsOf(companyId)
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const drawn = await lastVoucherNumber(companyId)
      expect(await strictDoors.run()).toEqual(Array.from({ length: DOOR_VOUCHERS }, () => 200))
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
