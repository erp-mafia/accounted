/**
 * Posting port, step 2f: proof that booking output does not change when the
 * customer invoice issue, booking and crediting move onto the port.
 *
 * Each producer is driven through its real door on a freshly seeded
 * aktiebolag: the issue step of Markera som skickad (issueAndBookInvoice: a
 * domestic invoice, one with the send dialog's user-edited lines, an EU
 * business customer's EUR invoice under reverse charge, a RUT invoice that
 * splits the receivable over 1510 and 1513) and its staged approval
 * (mark_invoice_sent), the deferred Bokför step (bookInvoice), the received
 * självfaktura (createSelfBilledSaleInvoice), Kreditera (creditInvoice) and
 * its staged approval (credit_invoice), a credit of a deferred original that
 * books the original first, and a kontantmetoden invoice that is paid and then
 * credited. Two flows storno a verifikat the moved producers do not post, on
 * an invoice they booked, so the engine's reversal hooks run: a payment
 * reversed (the payment sync puts the invoice back to unpaid) and a refused
 * RUT share reclaimed and the reclaim reversed (the reclaim hook hands the
 * share back to Skatteverket's side). Every verifikat a flow writes is dumped
 * normalised (series, number, date, description, source type, status and
 * every line) together with the invoices, their payments and the payout
 * requests the doors and the hooks write beside them, and the dump is
 * compared with the committed fixture (posting-parity-invoices.fixture.json),
 * which was taken before these producers went through the port.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, every
 *      verifikat a moved door wrote has exactly ONE event linked (the
 *      registration sale.invoiced, the kreditfaktura sale.credited with the
 *      credit note as subject), with the customer as party, the total and its
 *      moms as magnitudes, the link basis (the staged ones naming their
 *      pending operation) as evidence; the payments and the RUT reclaim,
 *      which step 2f-2 moved (their events are proven in
 *      posting-parity-invoice-payments.pg.test.ts and
 *      posting-parity-rot-rut.pg.test.ts), carry exactly one, and the
 *      stornos made directly through the engine none;
 *      the reversal hooks put the paid invoice back to unpaid and hand the
 *      reclaimed RUT share back to Skatteverket's side, exactly as with the
 *      port off;
 *   3. a failed event or link write under shadow still posts; under strict
 *      the issue, the Bokför step, the självfaktura and the credit each stop
 *      before a voucher number is drawn; and detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-invoices.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test); the clock of the credit doors (todayIsoStockholm, fixed at
 * 2026-09-30 so a credit note's date is the same every day the test runs);
 * and the invoice PDF the issue archives as underlag (rendering and the
 * storage upload, which pg-real does not have, are stubbed: the archive is
 * not a posting, and a failed archive is a partial failure the doors already
 * answer with).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { bookInvoice } from '@/lib/invoices/book-service'
import { creditInvoice } from '@/lib/invoices/credit-invoice'
import { issueAndBookInvoice, type IssuableInvoice } from '@/lib/invoices/issue-and-book-invoice'
import { reclaimRotRutRefusal } from '@/lib/invoices/rot-rut-reclaim'
import { createSelfBilledSaleInvoice } from '@/lib/invoices/self-billed-sale'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import type { CustomIssuanceLine } from '@/lib/invoices/issuance-custom-lines'
import type { OperationContext } from '@/lib/operations/types'
import type { CompanySettings, PendingOperation } from '@/types'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

/** The day the credit doors date a kreditfaktura (see the header). */
const TODAY = '2026-09-30'

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
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => TODAY,
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

const FIXTURE = path.join(__dirname, 'posting-parity-invoices.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

/** An aktiebolag under faktureringsmetoden, VAT-registered, with four customers. */
interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  /** A Swedish business. */
  domestic: string
  /** A German business with a validated VAT number: reverse charge. */
  eu: string
  /** A private person: RUT. */
  private: string
  /** The Swedish business that issues självfakturor on our behalf. */
  selfBilling: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow wrote: the invoices (and credit notes) it is about. */
interface Posted {
  invoiceIds: string[]
}

type CustomerKey = 'domestic' | 'eu' | 'private' | 'selfBilling'
type EntryRole = 'invoice_created' | 'credit_note'
/**
 * The verifikat of producers this step does not move. The payments and the
 * RUT reclaim moved in step 2f-2 and carry one event each (proven by their
 * own parity tests); the stornos made directly through the engine carry none.
 */
type UnmovedRole = 'invoice_paid' | 'invoice_cash_payment' | 'rot_rut_reclaim' | 'storno'

/** One business event shadow mode records for a flow, and the verifikat it is linked to. */
interface ExpectedEvent {
  kind: 'sale.invoiced' | 'sale.credited'
  /** The act's date. */
  occurred_on: string
  /** Index into the flow's invoiceIds. */
  subject: number
  party: CustomerKey
  currency: string
  amount: number
  amount_sek: number
  /** The moms the invoice states, in SEK, under this treatment; null for none. */
  vat: { treatment: string; amount_sek: number } | null
  link_basis: string
  /** The rule source mapping_version names; null for user-edited lines. */
  mappingSource: string | null
  /** The verifikat the flow wrote that are linked to the event, by source type. */
  entries: readonly EntryRole[]
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  run: (seed: Seed) => Promise<Posted>
  events: ExpectedEvent[]
  /** The verifikat the flow writes through producers this step does not move. */
  unmoved?: readonly UnmovedRole[]
}

const STAGED = 'agent_proposed_user_approved'
const LINES = 'se.customer-invoice-lines'
/** A domestic invoice at 25 %: 1 200 net, 300 moms. */
const DOMESTIC = {
  kind: 'sale.invoiced',
  party: 'domestic',
  currency: 'SEK',
  amount: 1500,
  amount_sek: 1500,
  vat: { treatment: 'standard_25', amount_sek: 300 },
  link_basis: 'user_created',
  mappingSource: LINES,
  entries: ['invoice_created'],
} as const
const CREDITED = { ...DOMESTIC, kind: 'sale.credited', occurred_on: TODAY, entries: ['credit_note'] } as const
/** The RUT invoice: 4 000 work and 800 material at 25 %, half the work incl. moms (2 500) from Skatteverket. */
const RUT = { ...DOMESTIC, party: 'private', amount: 6000, amount_sek: 6000, vat: { treatment: 'standard_25', amount_sek: 1200 } } as const

function ctxOf(seed: Seed): OperationContext {
  return { supabase: seed.supabase, companyId: seed.companyId, userId: seed.userId, log } as OperationContext
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
  const result = await commitPendingOperation(seed.supabase, seed.userId, seed.companyId, op, {
    commitMethod: 'user_accept',
    actor: { type: 'user' },
  })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  return (result as { data?: Record<string, unknown> }).data ?? {}
}

interface DraftItem {
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate: number
  deduction_type?: 'rut'
  labor_hours?: number
  work_type?: string
}

const CONSULTING: DraftItem[] = [{ description: 'Konsulttimmar', quantity: 12, unit: 'tim', unit_price: 100, vat_rate: 25 }]
const RUT_ITEMS: DraftItem[] = [
  { description: 'Städning', quantity: 10, unit: 'tim', unit_price: 400, vat_rate: 25, deduction_type: 'rut', labor_hours: 10, work_type: 'STAD' },
  { description: 'Material', quantity: 1, unit: 'st', unit_price: 800, vat_rate: 25 },
]

/** A draft invoice through the staged create_invoice door, which builds it as every invoice door does. */
async function draft(
  seed: Seed,
  customer: CustomerKey,
  date: string,
  items: DraftItem[] = CONSULTING,
  currency = 'SEK',
): Promise<string> {
  const data = await approve(
    seed,
    await stageOperation(seed, 'create_invoice', {
      customer_id: seed[customer],
      invoice_date: date,
      due_date: '2026-12-31',
      currency,
      items,
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

/** Markera som skickad: the issue step, which books the verifikat under faktureringsmetoden. */
async function issue(seed: Seed, invoiceId: string, customLines?: CustomIssuanceLine[]): Promise<void> {
  const { invoice, settings } = await issuable(seed, invoiceId)
  const result = await issueAndBookInvoice({
    supabase: seed.supabase,
    companyId: seed.companyId,
    userId: seed.userId,
    invoice,
    settings,
    log,
    ...(customLines ? { customLines } : {}),
  })
  expect(result.ok, JSON.stringify(result)).toBe(true)
}

async function credit(seed: Seed, invoiceId: string): Promise<string> {
  const result = await creditInvoice(ctxOf(seed), invoiceId, { reason: 'Felaktigt antal timmar' })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok || result.dryRun) throw new Error('unreachable')
  return result.creditNoteId
}

async function creditNoteOf(invoiceId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id::text AS id FROM public.invoices WHERE credited_invoice_id = $1`, [invoiceId])
  return rows[0]!.id
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

async function markPaid(seed: Seed, invoiceId: string, date: string): Promise<void> {
  await approve(seed, await stageOperation(seed, 'mark_invoice_paid', { invoice_id: invoiceId, payment_date: date }))
}

async function setDeferred(seed: Seed, deferred: boolean): Promise<void> {
  await getPool().query(`UPDATE public.company_settings SET defer_invoice_booking = $2 WHERE company_id = $1`, [seed.companyId, deferred])
}

async function setMethod(seed: Seed, method: 'accrual' | 'cash'): Promise<void> {
  await getPool().query(`UPDATE public.company_settings SET accounting_method = $2 WHERE company_id = $1`, [seed.companyId, method])
}

const FLOWS: Flow[] = [
  {
    name: 'issue: a domestic invoice at 25 % issued by Markera som skickad',
    run: async (seed) => {
      const id = await draft(seed, 'domestic', '2026-02-02')
      await issue(seed, id)
      return { invoiceIds: [id] }
    },
    events: [{ ...DOMESTIC, occurred_on: '2026-02-02', subject: 0 }],
  },
  {
    name: 'issue: the send dialog\'s user-edited lines are booked as reviewed',
    run: async (seed) => {
      const id = await draft(seed, 'domestic', '2026-02-09')
      await issue(seed, id, [
        { account_number: '1510', debit_amount: 1500, credit_amount: 0, line_description: 'Kundfordran' },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000, line_description: 'Konsulttjänster februari' },
        { account_number: '3001', debit_amount: 0, credit_amount: 200, line_description: 'Resetid februari' },
        { account_number: '2611', debit_amount: 0, credit_amount: 300, line_description: 'Utgående moms 25 %' },
      ])
      return { invoiceIds: [id] }
    },
    // No rule produced user-edited lines: no mapping version.
    events: [{ ...DOMESTIC, occurred_on: '2026-02-09', subject: 0, mappingSource: null }],
  },
  {
    name: 'issue: an EU business customer\'s EUR invoice under reverse charge',
    run: async (seed) => {
      const id = await draft(seed, 'eu', '2026-03-10', [{ description: 'Hosting', quantity: 1, unit: 'st', unit_price: 200, vat_rate: 0 }], 'EUR')
      await issue(seed, id)
      return { invoiceIds: [id] }
    },
    // Omvänd betalningsskyldighet: the invoice states no moms.
    events: [{ ...DOMESTIC, occurred_on: '2026-03-10', subject: 0, party: 'eu', currency: 'EUR', amount: 200, amount_sek: 2300, vat: null }],
  },
  {
    name: 'issue: a staged mark_invoice_sent approved',
    run: async (seed) => {
      const id = await draft(seed, 'domestic', '2026-03-16')
      await approve(seed, await stageOperation(seed, 'mark_invoice_sent', { invoice_id: id }))
      return { invoiceIds: [id] }
    },
    events: [{ ...DOMESTIC, occurred_on: '2026-03-16', subject: 0, link_basis: STAGED }],
  },
  {
    name: 'issue: a RUT invoice to a private customer splits the receivable over 1510 and 1513',
    run: async (seed) => {
      const id = await draft(seed, 'private', '2026-04-07', RUT_ITEMS)
      await issue(seed, id)
      return { invoiceIds: [id] }
    },
    events: [{ ...RUT, occurred_on: '2026-04-07', subject: 0 }],
  },
  {
    name: 'booking: an invoice issued under deferred booking is booked by the Bokför step',
    run: async (seed) => {
      const id = await draft(seed, 'domestic', '2026-04-20')
      await setDeferred(seed, true)
      try {
        await issue(seed, id)
      } finally {
        await setDeferred(seed, false)
      }
      const booked = await bookInvoice(ctxOf(seed), id)
      expect(booked.ok, JSON.stringify(booked)).toBe(true)
      return { invoiceIds: [id] }
    },
    events: [{ ...DOMESTIC, occurred_on: '2026-04-20', subject: 0 }],
  },
  {
    name: 'self-billing: a received självfaktura is booked on registration',
    run: async (seed) => {
      const result = await createSelfBilledSaleInvoice(seed.supabase, seed.companyId, seed.userId, {
        customer_id: seed.selfBilling,
        external_invoice_number: 'SF-2026-31',
        self_billing_agreement_ref: 'Avtal 2026-01',
        invoice_date: '2026-05-05',
        received_date: '2026-05-06',
        due_date: '2026-06-04',
        currency: 'SEK',
        items: [{ description: 'Provision april', quantity: 1, unit: 'st', unit_price: 2000, vat_rate: 25 }],
      })
      expect(result.ok, JSON.stringify(result)).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      return { invoiceIds: [result.invoice.id] }
    },
    events: [
      {
        ...DOMESTIC,
        occurred_on: '2026-05-05',
        subject: 0,
        party: 'selfBilling',
        amount: 2500,
        amount_sek: 2500,
        vat: { treatment: 'standard_25', amount_sek: 500 },
      },
    ],
  },
  {
    name: 'credit: an issued invoice credited with a kreditfaktura (Kreditera)',
    run: async (seed) => {
      const id = await draft(seed, 'domestic', '2026-05-11')
      await issue(seed, id)
      return { invoiceIds: [id, await credit(seed, id)] }
    },
    events: [
      { ...DOMESTIC, occurred_on: '2026-05-11', subject: 0 },
      { ...CREDITED, subject: 1 },
    ],
  },
  {
    name: 'credit: a staged credit_invoice approved',
    run: async (seed) => {
      const id = await draft(seed, 'domestic', '2026-05-18')
      await issue(seed, id)
      await approve(seed, await stageOperation(seed, 'credit_invoice', { invoice_id: id, reason: 'Dubbelfakturerad' }))
      return { invoiceIds: [id, await creditNoteOf(id)] }
    },
    events: [
      { ...DOMESTIC, occurred_on: '2026-05-18', subject: 0 },
      { ...CREDITED, subject: 1, link_basis: STAGED },
    ],
  },
  {
    name: 'credit: a deferred original never booked is booked first, then credited',
    run: async (seed) => {
      const id = await draft(seed, 'domestic', '2026-06-01')
      await setDeferred(seed, true)
      try {
        await issue(seed, id)
        return { invoiceIds: [id, await credit(seed, id)] }
      } finally {
        await setDeferred(seed, false)
      }
    },
    events: [
      { ...DOMESTIC, occurred_on: '2026-06-01', subject: 0 },
      { ...CREDITED, subject: 1 },
    ],
  },
  {
    name: 'kontantmetoden: an invoice issued without a verifikat, paid, then credited',
    run: async (seed) => {
      await setMethod(seed, 'cash')
      try {
        const id = await draft(seed, 'domestic', '2026-06-15')
        await issue(seed, id)
        await markPaid(seed, id, '2026-06-25')
        return { invoiceIds: [id, await credit(seed, id)] }
      } finally {
        await setMethod(seed, 'accrual')
      }
    },
    // The sale reached the ledger with its cash payment; the credit reverses it.
    events: [{ ...CREDITED, subject: 1 }],
    unmoved: ['invoice_cash_payment'],
  },
  {
    name: 'reversal hook: a payment on an issued invoice reversed puts the invoice back to unpaid',
    run: async (seed) => {
      const id = await draft(seed, 'domestic', '2026-07-01')
      await issue(seed, id)
      await markPaid(seed, id, '2026-07-10')
      await reverseEntry(seed.supabase, seed.companyId, seed.userId, await paymentEntryOf(id))
      return { invoiceIds: [id] }
    },
    events: [{ ...DOMESTIC, occurred_on: '2026-07-01', subject: 0 }],
    unmoved: ['invoice_paid', 'storno'],
  },
  {
    name: 'reversal hook: a refused RUT share reclaimed onto the customer, and the reclaim reversed',
    run: async (seed) => {
      const id = await draft(seed, 'private', '2026-07-14', RUT_ITEMS)
      await issue(seed, id)
      const requestId = randomUUID()
      await getPool().query(
        `INSERT INTO public.rot_rut_payout_requests
           (id, company_id, user_id, deduction_type, name, status, requested_total, decided_total, decided_at, file_name)
         VALUES ($1, $2, $3, 'rut', 'RUT 2026-07', 'rejected', 2500, 0, '2026-08-04T10:00:00Z', 'rut-2026-07.xml')`,
        [requestId, seed.companyId, seed.userId],
      )
      await getPool().query(
        `INSERT INTO public.rot_rut_payout_request_items (request_id, invoice_id, requested_amount, decided_amount)
         VALUES ($1, $2, 2500, 0)`,
        [requestId, id],
      )
      const reclaimed = await reclaimRotRutRefusal(seed.supabase, seed.userId, seed.companyId, { requestId, bookingDate: '2026-08-05' })
      expect(reclaimed.ok, JSON.stringify(reclaimed)).toBe(true)
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT reclaim_journal_entry_id::text AS id FROM public.rot_rut_payout_requests WHERE id = $1`,
        [requestId],
      )
      await reverseEntry(seed.supabase, seed.companyId, seed.userId, rows[0]!.id)
      return { invoiceIds: [id] }
    },
    events: [{ ...RUT, occurred_on: '2026-07-14', subject: 0 }],
    unmoved: ['rot_rut_reclaim', 'storno'],
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
 * The verifikat a flow wrote, in series and number order, normalised: no ids,
 * no timestamps. A storno lists its original's lines in the order
 * reverseEntry reads them back (an unordered embed), so lines are compared
 * in account, amount, text and dimension order.
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
                       'dimensions', l.dimensions,
                       'sort_order', NULL)
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

/** The invoices, their payments and the payout requests, which the doors and the hooks write with the verifikat. */
async function registerOf(seed: Seed): Promise<unknown> {
  const [invoices, payments, requests] = await Promise.all([
    getPool().query(
      `SELECT i.invoice_number, i.external_invoice_number, i.is_self_billed, i.status, i.document_type,
              o.invoice_number AS credits, i.invoice_date::text AS invoice_date, i.currency,
              i.exchange_rate::text AS exchange_rate, i.vat_treatment, i.subtotal::text AS subtotal,
              i.vat_amount::text AS vat_amount, i.total::text AS total, i.total_sek::text AS total_sek,
              i.vat_amount_sek::text AS vat_amount_sek, i.remaining_amount::text AS remaining_amount,
              i.paid_amount::text AS paid_amount, i.deduction_total::text AS deduction_total,
              i.deduction_reclaimed_total::text AS deduction_reclaimed_total,
              je.voucher_series AS voucher_series, je.voucher_number AS voucher_number, je.status AS voucher_status
         FROM public.invoices i
         LEFT JOIN public.invoices o ON o.id = i.credited_invoice_id
         LEFT JOIN public.journal_entries je ON je.id = i.journal_entry_id
        WHERE i.company_id = $1
        ORDER BY i.created_at, i.invoice_date`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT i.invoice_number, p.payment_date::text AS payment_date, p.amount::text AS amount, p.currency, p.source,
              je.voucher_series, je.voucher_number, je.status AS voucher_status
         FROM public.invoice_payments p
         JOIN public.invoices i ON i.id = p.invoice_id
         LEFT JOIN public.journal_entries je ON je.id = p.journal_entry_id
        WHERE p.company_id = $1
        ORDER BY p.payment_date, i.invoice_number`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT r.name, r.status, r.requested_total::text AS requested_total, r.decided_total::text AS decided_total,
              je.voucher_series AS reclaim_series, je.voucher_number AS reclaim_voucher, je.status AS reclaim_status,
              (SELECT jsonb_agg(jsonb_build_object('invoice_number', i.invoice_number, 'requested', it.requested_amount::text,
                                                   'decided', it.decided_amount::text, 'reclaimed', it.reclaimed_amount::text))
                 FROM public.rot_rut_payout_request_items it JOIN public.invoices i ON i.id = it.invoice_id
                WHERE it.request_id = r.id) AS items
         FROM public.rot_rut_payout_requests r
         LEFT JOIN public.journal_entries je ON je.id = r.reclaim_journal_entry_id
        WHERE r.company_id = $1
        ORDER BY r.name`,
      [seed.companyId],
    ),
  ])
  return { invoices: invoices.rows, payments: payments.rows, payoutRequests: requests.rows }
}

interface FlowRun {
  seed: Seed
  dumps: FlowDump[]
  register: unknown
  posted: Array<Posted & { entries: Array<{ id: string; source_type: string; status: string }> }>
}

async function seedAll(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, entity_type, accounting_method, vat_registered, vat_number, company_name, org_number,
        bankgiro, invoice_payment_accounts, address_line1, postal_code, city)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true, 'SE556677889901', 'Konsultbolaget AB', '556677-8899',
             '5050-1055', $3, 'Testgatan 1', '111 22', 'Stockholm')`,
    [userId, companyId, JSON.stringify({ EUR: { iban: 'SE4550000000058398257466', bic: 'ESSESESS' } })],
  )
  // The day's Riksbanken rate, as the bank sync caches it, so the EUR draft never calls out.
  await getPool().query(
    `INSERT INTO public.exchange_rates (currency, rate_date, rate, observation_date, source)
     VALUES ('EUR', '2026-03-10', 11.5, '2026-03-10', 'riksbanken')
     ON CONFLICT (currency, rate_date) DO NOTHING`,
  )
  const customer = async (name: string, type: string, extra: Record<string, unknown>) => {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.customers (user_id, company_id, name, customer_type, country, vat_number, vat_number_validated, personal_number, org_number, address_line1, postal_code, city)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Storgatan 1', '111 22', 'Stockholm') RETURNING id::text AS id`,
      [
        userId,
        companyId,
        name,
        type,
        extra.country ?? 'SE',
        extra.vat_number ?? null,
        extra.vat_number_validated ?? false,
        extra.personal_number ?? null,
        extra.org_number ?? null,
      ],
    )
    return rows[0]!.id
  }
  const domestic = await customer('Kund AB', 'swedish_business', { org_number: '559900-1234', vat_number: 'SE559900123401' })
  const eu = await customer('Kunde GmbH', 'eu_business', { country: 'DE', vat_number: 'DE123456789', vat_number_validated: true })
  const privatePerson = await customer('Privatkund', 'individual', { personal_number: encryptPersonnummer('198001011231') })
  const selfBilling = await customer('Uppdragsgivaren AB', 'swedish_business', { org_number: '559800-4321', vat_number: 'SE559800432101' })
  return {
    userId,
    companyId,
    fiscalPeriodId,
    domestic,
    eu,
    private: privatePerson,
    selfBilling,
    supabase: createServiceClientNoCookies(),
  }
}

async function runFlows(): Promise<FlowRun> {
  const seed = await seedAll()
  const dumps: FlowDump[] = []
  const posted: FlowRun['posted'] = []
  for (const flow of FLOWS) {
    const before = await entryIdsOf(seed.companyId)
    const result = await runWithActor({ type: 'user' }, () => flow.run(seed))
    const written = [...(await entryIdsOf(seed.companyId))].filter((id) => !before.has(id))
    const entries = await dumpEntries(seed.companyId, written)
    expect(entries.length, `${flow.name}: the flow wrote a verifikat`).toBeGreaterThan(0)
    posted.push({ ...result, entries: entries.map(({ id, source_type, status }) => ({ id, source_type, status })) })
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

/** Every verifikat of the company with its source type and how many event links it has. */
async function linkCounts(companyId: string): Promise<Array<{ id: string; source_type: string; status: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; source_type: string; status: string; links: number }>(
    `SELECT je.id::text AS id, je.source_type, je.status,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.journal_entry_id = je.id) AS links
       FROM public.journal_entries je
      WHERE je.company_id = $1`,
    [companyId],
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

/** The invoice row as the doors left it. */
async function invoiceRow(
  invoiceId: string,
): Promise<{ status: string; journal_entry_id: string | null; paid_amount: string | null; deduction_reclaimed_total: string } | null> {
  const { rows } = await getPool().query<{
    status: string
    journal_entry_id: string | null
    paid_amount: string | null
    deduction_reclaimed_total: string
  }>(
    `SELECT status, journal_entry_id::text AS journal_entry_id, paid_amount::text AS paid_amount,
            deduction_reclaimed_total::text AS deduction_reclaimed_total
       FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0] ?? null
}

/** A trigger that refuses every insert into `table`. */
async function failInserts(table: 'business_events' | 'business_event_entries'): Promise<() => Promise<void>> {
  const fn = `pg_test_inv_fail_${table}`
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
const MOVED: ReadonlySet<string> = new Set<EntryRole>(['invoice_created', 'credit_note'])
/** Moved in step 2f-2: one event each, whose content their own parity tests prove. */
const MOVED_LATER: ReadonlySet<string> = new Set<UnmovedRole>(['invoice_paid', 'invoice_cash_payment', 'rot_rut_reclaim'])

/** Every flow books on a fresh company: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 300_000

describe('posting port parity, customer invoices (pg)', () => {
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
    expect((await linkCounts(seed.companyId)).filter((e) => e.links > 0)).toEqual([])
  })

  it(
    'books the same verifikat with POSTING_EVENTS=shadow and links exactly one event to every verifikat a moved door wrote',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'off')
      const off = await runFlows()
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const shadow = await runFlows()

      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual({ dumps: off.dumps, register: off.register })
      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

      const { companyId } = shadow.seed
      // Every verifikat the moved producers wrote has exactly one link, as
      // have the payments and the RUT reclaim (moved in step 2f-2); the
      // stornos made directly through the engine have none.
      const counts = await linkCounts(companyId)
      expect(counts.filter((e) => e.links !== (MOVED.has(e.source_type) || MOVED_LATER.has(e.source_type) ? 1 : 0))).toEqual([])
      expect(counts).toHaveLength(shadow.posted.reduce((n, p) => n + p.entries.length, 0))

      const links = await eventLinks(companyId)
      const movedEntries = new Set(counts.filter((e) => MOVED.has(e.source_type)).map((e) => e.id))
      const eventIds = [...new Set(links.filter((l) => movedEntries.has(l.journal_entry_id ?? '')).map((l) => l.id))]
      expect(eventIds).toHaveLength(FLOWS.reduce((n, f) => n + f.events.length, 0))
      const operations = new Set<string>()
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        // Every verifikat the flow wrote belongs to one of its events, or to a producer this step does not move.
        const claimed = [...flow.events.flatMap((e) => e.entries), ...(flow.unmoved ?? [])]
        expect(posted.entries.map((e) => e.source_type).sort(), flow.name).toEqual([...claimed].sort())
        for (const [j, expected] of flow.events.entries()) {
          const label = `${flow.name} #${j}`
          const wanted = posted.entries.filter((e) => expected.entries.includes(e.source_type as EntryRole)).map((e) => e.id)
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
            subject_type: 'invoice',
            subject_id: posted.invoiceIds[expected.subject],
            party_type: 'customer',
            party_id: shadow.seed[expected.party],
            currency: expected.currency,
            tax_amounts: expected.vat ? [{ tax: 'vat', treatment: expected.vat.treatment, amount_sek: expected.vat.amount_sek }] : [],
            jurisdiction: 'SE',
            actor_type: 'user',
            idempotency_key: `${expected.kind}:invoice:${posted.invoiceIds[expected.subject]}`,
          })
          expect(rows.every((l) => l.role === 'produced'), label).toBe(true)
          expect(Number(event.amount), label).toBe(expected.amount)
          expect(Number(event.amount_sek), label).toBe(expected.amount_sek)
          expect(event.evidence.link_basis, label).toBe(expected.link_basis)
          // References only: no customer name or personnummer in the evidence.
          expect(JSON.stringify(event.evidence)).not.toMatch(/Kund AB|Kunde GmbH|Privatkund|Uppdragsgivaren|19800101/)
          if (expected.mappingSource) {
            expect(event.mapping_version?.startsWith(`${expected.mappingSource}@`), `${label}: ${event.mapping_version}`).toBe(true)
          } else {
            expect(event.mapping_version, label).toBeNull()
          }
          if (expected.link_basis === STAGED) {
            expect(event.pending_operation_id, label).toMatch(/^[0-9a-f-]{36}$/)
            expect(event.evidence.link_evidence, label).toEqual({ pending_operation_id: event.pending_operation_id })
            operations.add(event.pending_operation_id!)
          } else {
            expect(event.pending_operation_id, label).toBeNull()
          }
        }
      }
      // The staged issue and the staged credit.
      expect(operations.size).toBe(2)

      // The reversal hooks ran on the stornos exactly as with the port off
      // (the registers above are equal); here, that they did run at all.
      const paidFlow = FLOWS.findIndex((f) => f.name.startsWith('reversal hook: a payment'))
      const paidInvoice = shadow.posted[paidFlow]!.invoiceIds[0]!
      expect(await invoiceRow(paidInvoice)).toMatchObject({ status: 'sent', paid_amount: '0' })
      expect(shadow.posted[paidFlow]!.entries.find((e) => e.source_type === 'invoice_paid')!.status).toBe('reversed')
      const reclaimFlow = FLOWS.findIndex((f) => f.name.startsWith('reversal hook: a refused RUT share'))
      const reclaimInvoice = shadow.posted[reclaimFlow]!.invoiceIds[0]!
      expect(await invoiceRow(reclaimInvoice)).toMatchObject({ status: 'sent', deduction_reclaimed_total: '0.00' })
      expect(shadow.posted[reclaimFlow]!.entries.find((e) => e.source_type === 'rot_rut_reclaim')!.status).toBe('reversed')
      const { rows: requests } = await getPool().query(
        `SELECT r.reclaim_journal_entry_id, it.reclaimed_amount
           FROM public.rot_rut_payout_requests r JOIN public.rot_rut_payout_request_items it ON it.request_id = r.id
          WHERE it.invoice_id = $1`,
        [reclaimInvoice],
      )
      expect(requests).toEqual([{ reclaim_journal_entry_id: null, reclaimed_amount: null }])
    },
  )

  it(
    'shadow posts through a failed event or link write; strict stops before a voucher number is drawn',
    { timeout: FLOW_TIMEOUT },
    async () => {
      const seed = await seedAll()
      const { companyId } = seed
      const asUser = <T>(fn: () => Promise<T>) => runWithActor({ type: 'user' }, fn)
      const ctx = ctxOf(seed)
      let n = 0
      const selfBilled = (date: string) =>
        createSelfBilledSaleInvoice(seed.supabase, companyId, seed.userId, {
          customer_id: seed.selfBilling,
          external_invoice_number: `SF-FAIL-${++n}`,
          invoice_date: date,
          received_date: date,
          due_date: '2026-12-31',
          currency: 'SEK',
          items: [{ description: 'Provision', quantity: 1, unit: 'st', unit_price: 2000, vat_rate: 25 }],
        })
      const issuedDeferred = async (date: string) => {
        const id = await asUser(() => draft(seed, 'domestic', date))
        await setDeferred(seed, true)
        try {
          await asUser(() => issue(seed, id))
        } finally {
          await setDeferred(seed, false)
        }
        return id
      }
      const issued = async (date: string) => {
        const id = await asUser(() => draft(seed, 'domestic', date))
        await asUser(() => issue(seed, id))
        return id
      }

      for (const table of ['business_events', 'business_event_entries'] as const) {
        // Shadow: every door posts, without the event (or its link).
        vi.stubEnv('POSTING_EVENTS', 'shadow')
        const before = await lastVoucherNumber(companyId)
        const toIssue = await asUser(() => draft(seed, 'domestic', '2026-08-03'))
        const deferred = await issuedDeferred('2026-08-04')
        const toCredit = await issued('2026-08-05')
        const restore = await failInserts(table)
        let selfBilledId: string
        let creditNoteId: string
        try {
          await asUser(() => issue(seed, toIssue))
          const booked = await asUser(() => bookInvoice(ctx, deferred))
          expect(booked.ok, JSON.stringify(booked)).toBe(true)
          const sale = await asUser(() => selfBilled('2026-08-06'))
          expect(sale.ok, JSON.stringify(sale)).toBe(true)
          if (!sale.ok) throw new Error('unreachable')
          selfBilledId = sale.invoice.id
          creditNoteId = await asUser(() => credit(seed, toCredit))
        } finally {
          await restore()
        }
        const written = [
          (await invoiceRow(toIssue))!.journal_entry_id,
          (await invoiceRow(deferred))!.journal_entry_id,
          (await invoiceRow(selfBilledId))!.journal_entry_id,
          (await invoiceRow(creditNoteId))!.journal_entry_id,
        ]
        for (const id of written) {
          expect(id, table).toBeTruthy()
          expect(await linksOf(id!), table).toBe(0)
        }
        // The invoice issued before the refusal, then the four above.
        expect(await lastVoucherNumber(companyId), table).toBe(before + 5)

        // Strict: each door stops before a voucher number is drawn.
        const strictIssue = await asUser(() => draft(seed, 'domestic', '2026-08-10'))
        const strictDeferred = await issuedDeferred('2026-08-11')
        const strictToCredit = await issued('2026-08-12')
        const restoreStrict = await failInserts(table)
        try {
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)

          const { invoice, settings } = await issuable(seed, strictIssue)
          const refusedIssue = await asUser(() =>
            issueAndBookInvoice({ supabase: seed.supabase, companyId, userId: seed.userId, invoice, settings, log }),
          )
          expect(refusedIssue, table).toMatchObject({ ok: false, errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED' })
          // Nothing reached the books, so the invoice is a draft again.
          expect(await invoiceRow(strictIssue), table).toMatchObject({ status: 'draft', journal_entry_id: null })

          const refusedBook = await asUser(() => bookInvoice(ctx, strictDeferred))
          expect(refusedBook, table).toMatchObject({ ok: false, code: 'INVOICE_BOOK_FAILED' })
          expect(await invoiceRow(strictDeferred), table).toMatchObject({ status: 'sent', journal_entry_id: null })

          // The självfaktura is removed again, never left unbooked.
          const external = `SF-FAIL-${n + 1}`
          await expect(asUser(() => selfBilled('2026-08-13')), table).rejects.toThrow()
          const { rows: kept } = await getPool().query(
            `SELECT id FROM public.invoices WHERE company_id = $1 AND external_invoice_number = $2`,
            [companyId, external],
          )
          expect(kept, table).toEqual([])

          const refusedCredit = await asUser(() => creditInvoice(ctx, strictToCredit, { reason: 'Fel pris' }))
          expect(refusedCredit, table).toMatchObject({ ok: false, code: 'INVOICE_CREDIT_ISSUE_INCOMPLETE' })
          expect(await invoiceRow(strictToCredit), table).toMatchObject({ status: 'sent' })
          expect(await invoiceRow(await creditNoteOf(strictToCredit)), table).toMatchObject({ status: 'draft', journal_entry_id: null })

          expect(await lastVoucherNumber(companyId), table).toBe(drawn)
        } finally {
          await restoreStrict()
          vi.stubEnv('POSTING_EVENTS', 'shadow')
        }
      }

      // With nothing refused, strict issues and credits with their events,
      // the next numbers in the series: none of the refusals above left a gap.
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const before = await lastVoucherNumber(companyId)
      const strictInvoice = await issued('2026-08-20')
      const strictCredit = await asUser(() => credit(seed, strictInvoice))
      expect(await lastVoucherNumber(companyId)).toBe(before + 2)
      for (const id of [strictInvoice, strictCredit]) {
        const entryId = (await invoiceRow(id))!.journal_entry_id
        expect(entryId).toBeTruthy()
        expect(await linksOf(entryId!)).toBe(1)
      }
      const { rows: series } = await getPool().query<{ voucher_series: string }>(
        `SELECT DISTINCT voucher_series FROM public.journal_entries WHERE company_id = $1 AND voucher_number IS NOT NULL`,
        [companyId],
      )
      expect(series.length).toBeGreaterThan(0)
      for (const { voucher_series } of series) {
        const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, $3)`, [
          companyId,
          seed.fiscalPeriodId,
          voucher_series,
        ])
        expect(gaps.rows, voucher_series).toEqual([])
      }
    },
  )
})
