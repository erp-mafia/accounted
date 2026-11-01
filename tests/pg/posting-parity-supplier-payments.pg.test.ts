/**
 * Posting port, step 2e: proof that booking output does not change when the
 * supplier payments, the supplier bank matches, the single bank-line booking,
 * the uncategorize stornos and the inbox book-direct move onto the port.
 *
 * Each producer is driven through its real door on a freshly seeded company:
 * the dashboard mark-paid route (the 2440 clearing, the person's own rows, a
 * kontantmetoden payment), the v1 mark-paid route on an API key (an EUR
 * payment with a kursdifferens, and one whose invoice flip fails, so its
 * payment is cancelled), the dashboard bank match route (a fee on top), the
 * debit of a signed payment order (bookSupplierBankMatch with a rule basis,
 * as lib/payments/orders/auto-settle.ts calls it), the v1 bank match (a row
 * categorized first, whose verifikat is reversed, and a kontantmetoden
 * match), the dashboard book route (a withdrawal, a foreign deposit, and one
 * whose bank line refuses the link, so the verifikat is reversed), both
 * uncategorize routes, and the inbox book-direct (a receipt with and without
 * its bank row, and one whose item refuses the claim, so the verifikat is
 * reversed). Every verifikat a door writes is dumped normalised (series,
 * number, date, description, source type, status and every line) together
 * with the supplier invoices, payment rows, bank lines, inbox items and
 * underlag the doors write beside them, and the dump is compared with the
 * committed fixture (posting-parity-supplier-payments.fixture.json), which
 * was taken before these producers went through the port. A flow's setup
 * (the invoice it pays, the row it books) is not part of its dump.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every verifikat a door wrote has exactly ONE event linked: a payment
 *      purchase.paid (the invoice as subject, the supplier as party, the debt
 *      settled and the kronor paid out, kontantmetoden's moms), a bank line
 *      booked on the person's own rows bank.categorized, an underlag booked
 *      from the inbox purchase.document_booked, and each storno
 *      ledger.storno (role reversal) of the record whose booking it reverses,
 *      with the door's link basis as evidence;
 *   3. a failed event or link write under shadow still posts; under strict
 *      every door stops before a voucher number is drawn; and
 *      detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-supplier-payments.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test); the session doors' cookie auth, replaced by the signed-in user on
 * the service-role client (requireAuth and the active company are mocked,
 * the write-role check passes); the v1 doors run on a real API key.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies, generateApiKey } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { bookSupplierBankMatch } from '@/lib/invoices/book-supplier-bank-match'
import { PAYMENT_ORDER_MATCH_METHOD } from '@/lib/payments/orders/auto-settle'
import { createSupplierInvoice, type CreateSupplierInvoiceInput } from '@/lib/supplier-invoices/create'
import { categorizeTransaction } from '@/lib/transactions/categorize-core'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { OperationContext } from '@/lib/operations/types'
import type { SupplierInvoice } from '@/types'
import { POST as markPaidRoute } from '@/app/api/supplier-invoices/[id]/mark-paid/route'
import { POST as matchSupplierInvoiceRoute } from '@/app/api/transactions/[id]/match-supplier-invoice/route'
import { POST as bookRoute } from '@/app/api/transactions/[id]/book/route'
import { POST as uncategorizeRoute } from '@/app/api/transactions/[id]/uncategorize/route'
import { POST as v1MarkPaidRoute } from '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/mark-paid/route'
import { POST as v1MatchSupplierInvoiceRoute } from '@/app/api/v1/companies/[companyId]/transactions/[id]/match-supplier-invoice/route'
import { POST as v1UncategorizeRoute } from '@/app/api/v1/companies/[companyId]/transactions/[id]/uncategorize/route'
import { testRoutes } from '../helpers'
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

afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const FIXTURE = path.join(__dirname, 'posting-parity-supplier-payments.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const V1_SCOPES = ['suppliers:read', 'suppliers:write', 'transactions:read', 'transactions:write']

/** An aktiebolag under faktureringsmetoden, VAT-registered, with a Swedish and an EU supplier and an API key. */
interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  domestic: string
  eu: string
  apiKey: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow's setup made: the records its door acts on. */
interface Prepared {
  invoiceIds?: string[]
  transactionIds?: string[]
  inboxItemIds?: string[]
  documentIds?: string[]
  /** Undone after the door ran (a refusing trigger, a switched accounting method). */
  restore?: () => Promise<void>
}

type EntryRole =
  | 'supplier_invoice_paid'
  | 'supplier_invoice_cash_payment'
  | 'bank_transaction'
  | 'inbox_item'
  | 'storno'

/** One business event shadow mode records for a flow, and the verifikat it is linked to. */
interface ExpectedEvent {
  kind: string
  role: 'produced' | 'reversal'
  /** The act's date; 'today' for a storno, dated the day it is made. */
  occurred_on: string
  subject: { type: 'supplier_invoice' | 'transaction' | 'inbox_item'; index: number }
  party: 'domestic' | 'eu' | null
  currency: string | null
  amount: number | null
  amount_sek: number | null
  /** The moms the payment books, in SEK, under this treatment; null for none. */
  vat: { treatment: string; amount_sek: number } | null
  /** Index into the flow's documentIds and inboxItemIds; null for none. */
  document: number | null
  inbox: number | null
  link_basis: string
  link_evidence?: Record<string, unknown>
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
}

function ctxOf(seed: Seed): OperationContext {
  return { supabase: seed.supabase, companyId: seed.companyId, userId: seed.userId, log } as OperationContext
}

/** A domestic invoice at 25 %: 1 000 on förbrukningsinventarier and 200 on kontorsmaterial. */
function domesticInvoice(seed: Seed, number: string, date: string): CreateSupplierInvoiceInput {
  return {
    supplier_id: seed.domestic,
    supplier_invoice_number: number,
    invoice_date: date,
    due_date: '2026-12-31',
    items: [
      { description: 'Skärmar', amount: 1000, account_number: '5410', vat_rate: 0.25 },
      { description: 'Pärmar', amount: 200, account_number: '6110', vat_rate: 0.25 },
    ],
  } as CreateSupplierInvoiceInput
}

async function register(seed: Seed, body: CreateSupplierInvoiceInput): Promise<string> {
  const result = await runWithActor({ type: 'user' }, () => createSupplierInvoice(ctxOf(seed), body))
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok || result.dryRun) throw new Error('unreachable')
  return result.invoice.id as string
}

async function setMethod(seed: Seed, method: 'accrual' | 'cash'): Promise<void> {
  await getPool().query(`UPDATE public.company_settings SET accounting_method = $2 WHERE company_id = $1`, [seed.companyId, method])
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

/** An underlag in the archive, not yet linked to anything. */
async function insertDocument(seed: Seed, fileName: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, storage_path, file_name, sha256_hash, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf')`,
    [id, seed.companyId, seed.userId, `${seed.companyId}/${fileName}`, fileName, `sha-${fileName}`],
  )
  return id
}

/** An inbox item holding an underlag, as the upload leaves it. */
async function insertInboxItem(seed: Seed, documentId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, extracted_data)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, seed.companyId, seed.userId, documentId, JSON.stringify({ documentKind: 'receipt', totals: { total: 99 }, invoice: { currency: 'SEK' } })],
  )
  return id
}

/** A trigger refusing one update, undone by the returned function. */
async function refuseUpdate(table: 'supplier_invoices' | 'transactions' | 'invoice_inbox_items', condition: string): Promise<() => Promise<void>> {
  const fn = `pg_test_sp_refuse_${randomUUID().replace(/-/g, '')}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ${condition} THEN
        RAISE EXCEPTION 'pg-test: update refused';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ${fn} BEFORE UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.${table}; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
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
      'Idempotency-Key': `pg-parity-payments-${Date.now()}-${++idempotency}`,
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

const bookDirect = () => testRoutes(invoiceInboxExtension).find((r) => r.method === 'POST' && r.path === '/items/:id/book-direct')!

function extensionCtx(seed: Seed): ExtensionContext {
  return {
    userId: seed.userId,
    companyId: seed.companyId,
    extensionId: 'invoice-inbox',
    supabase: seed.supabase,
    emit: async () => {},
    settings: { get: async () => null, set: async () => {} },
    log,
    services: {},
  } as unknown as ExtensionContext
}

/** The open invoice as the doors read it, supplier and items embedded. */
async function invoiceForMatch(seed: Seed, id: string): Promise<SupplierInvoice> {
  const { data, error } = await seed.supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
    .eq('id', id)
    .eq('company_id', seed.companyId)
    .single()
  expect(error).toBeNull()
  return data as SupplierInvoice
}

async function transactionRow(seed: Seed, id: string) {
  const { data, error } = await seed.supabase.from('transactions').select('*').eq('id', id).eq('company_id', seed.companyId).single()
  expect(error).toBeNull()
  return data
}

const RECEIPT_LINES = [
  { account_number: '6540', debit_amount: 79.2, credit_amount: 0 },
  { account_number: '2641', debit_amount: 19.8, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 99 },
]

const LINES = 'se.supplier-payment-lines'
const PAID = {
  kind: 'purchase.paid',
  role: 'produced',
  party: 'domestic',
  currency: 'SEK',
  amount: 1500,
  amount_sek: 1500,
  vat: null,
  document: null,
  inbox: null,
  direction: null,
  mappingSource: LINES,
  entries: ['supplier_invoice_paid'],
} as const
const STORNO = {
  kind: 'ledger.storno',
  role: 'reversal',
  occurred_on: 'today',
  party: null,
  currency: null,
  amount: null,
  amount_sek: null,
  vat: null,
  document: null,
  inbox: null,
  direction: null,
  mappingSource: null,
  entries: ['storno'],
} as const
const BOOKED = {
  kind: 'bank.categorized',
  role: 'produced',
  party: null,
  vat: null,
  document: null,
  inbox: null,
  link_basis: 'user_created',
  mappingSource: null,
  entries: ['bank_transaction'],
} as const

const FLOWS: Flow[] = [
  {
    name: 'mark-paid (dashboard): a registered invoice paid in full from the default account',
    setup: async (seed) => ({ invoiceIds: [await register(seed, domesticInvoice(seed, 'F-2001', '2026-03-02'))] }),
    run: async (seed, { invoiceIds }) => {
      const id = invoiceIds![0]!
      await expectStatus(await markPaidRoute(sessionRequest(`/api/supplier-invoices/${id}/mark-paid`, { payment_date: '2026-03-20' }), params({ id })), 200)
    },
    events: [{ ...PAID, occurred_on: '2026-03-20', subject: { type: 'supplier_invoice', index: 0 }, link_basis: 'user_created' }],
  },
  {
    name: "mark-paid (dashboard): a partial payment on the person's own rows",
    setup: async (seed) => ({ invoiceIds: [await register(seed, domesticInvoice(seed, 'F-2002', '2026-03-03'))] }),
    run: async (seed, { invoiceIds }) => {
      const id = invoiceIds![0]!
      await expectStatus(
        await markPaidRoute(
          sessionRequest(`/api/supplier-invoices/${id}/mark-paid`, {
            payment_date: '2026-03-21',
            amount: 600,
            lines: [
              { account_number: '2440', debit_amount: 600, credit_amount: 0, line_description: 'Delbetalning' },
              { account_number: '1930', debit_amount: 0, credit_amount: 600 },
            ],
          }),
          params({ id }),
        ),
        200,
      )
    },
    // The person's own rows: no rule made them, and no payment account was named.
    events: [
      {
        ...PAID,
        occurred_on: '2026-03-21',
        subject: { type: 'supplier_invoice', index: 0 },
        amount: 600,
        amount_sek: null,
        link_basis: 'user_created',
        mappingSource: null,
      },
    ],
  },
  {
    name: 'mark-paid (dashboard): kontantmetoden books a never-registered invoice with its moms at payment',
    setup: async (seed) => {
      await setMethod(seed, 'cash')
      return {
        invoiceIds: [await register(seed, domesticInvoice(seed, 'F-2003', '2026-03-04'))],
        restore: () => setMethod(seed, 'accrual'),
      }
    },
    run: async (seed, { invoiceIds }) => {
      const id = invoiceIds![0]!
      await expectStatus(await markPaidRoute(sessionRequest(`/api/supplier-invoices/${id}/mark-paid`, { payment_date: '2026-03-22' }), params({ id })), 200)
    },
    events: [
      {
        ...PAID,
        occurred_on: '2026-03-22',
        subject: { type: 'supplier_invoice', index: 0 },
        vat: { treatment: 'standard_25', amount_sek: 300 },
        link_basis: 'user_created',
        entries: ['supplier_invoice_cash_payment'],
      },
    ],
  },
  {
    name: 'mark-paid (v1): an EUR invoice cleared at the booked rate, the kursdifferens from amount_sek',
    setup: async (seed) => ({
      invoiceIds: [
        await register(seed, {
          supplier_id: seed.eu,
          supplier_invoice_number: 'EU-2004',
          invoice_date: '2026-03-10',
          due_date: '2026-04-09',
          currency: 'EUR',
          exchange_rate: 11.5,
          items: [
            { description: 'Hosting', amount: 150, account_number: '6540', vat_rate: 0, reverse_charge_rate: 0.25 },
            { description: 'Support', amount: 50, account_number: '6550', vat_rate: 0 },
          ],
        } as CreateSupplierInvoiceInput),
      ],
    }),
    run: async (seed, { invoiceIds }) => {
      const id = invoiceIds![0]!
      await expectStatus(
        await v1MarkPaidRoute(
          v1Request(seed, `/api/v1/companies/${seed.companyId}/supplier-invoices/${id}/mark-paid`, { payment_date: '2026-04-02', amount_sek: 2311.4 }),
          params({ companyId: seed.companyId, id }),
        ),
        200,
      )
    },
    events: [
      {
        ...PAID,
        occurred_on: '2026-04-02',
        subject: { type: 'supplier_invoice', index: 0 },
        party: 'eu',
        currency: 'EUR',
        amount: 200,
        amount_sek: 2311.4,
        link_basis: 'client_asserted',
      },
    ],
  },
  {
    name: 'mark-paid (v1): the invoice flip fails, so the payment is cancelled',
    setup: async (seed) => {
      const id = await register(seed, domesticInvoice(seed, 'F-2005', '2026-03-12'))
      return {
        invoiceIds: [id],
        restore: await refuseUpdate('supplier_invoices', `NEW.id = '${id}'::uuid AND NEW.payment_journal_entry_id IS DISTINCT FROM OLD.payment_journal_entry_id`),
      }
    },
    run: async (seed, { invoiceIds }) => {
      const id = invoiceIds![0]!
      await expectStatus(
        await v1MarkPaidRoute(
          v1Request(seed, `/api/v1/companies/${seed.companyId}/supplier-invoices/${id}/mark-paid`, { payment_date: '2026-04-03' }),
          params({ companyId: seed.companyId, id }),
        ),
        500,
        'SI_PAID_FAILED',
      )
    },
    events: [
      { ...PAID, occurred_on: '2026-04-03', subject: { type: 'supplier_invoice', index: 0 }, link_basis: 'client_asserted' },
    ],
  },
  {
    name: 'bank match (dashboard): a SEK row paying more than owed, the excess on 6570',
    setup: async (seed) => ({
      invoiceIds: [await register(seed, domesticInvoice(seed, 'F-2006', '2026-04-01'))],
      transactionIds: [await insertRow(seed, { date: '2026-04-15', description: 'Kontorsbolaget F-2006', amount: -1525 })],
    }),
    run: async (seed, { invoiceIds, transactionIds }) => {
      const id = transactionIds![0]!
      await expectStatus(
        await matchSupplierInvoiceRoute(
          sessionRequest(`/api/transactions/${id}/match-supplier-invoice`, { supplier_invoice_id: invoiceIds![0] }),
          params({ id }),
        ),
        200,
      )
    },
    events: [
      {
        ...PAID,
        occurred_on: '2026-04-15',
        subject: { type: 'supplier_invoice', index: 0 },
        amount_sek: 1525,
        direction: 'out',
        link_basis: 'user_confirmed',
      },
    ],
  },
  {
    name: 'bank match (payment order debit): a signed payment settled from its debit on a rule',
    setup: async (seed) => ({
      invoiceIds: [await register(seed, domesticInvoice(seed, 'F-2007', '2026-04-02'))],
      transactionIds: [await insertRow(seed, { date: '2026-04-16', description: 'Betalning F-2007', amount: -1500 })],
    }),
    run: async (seed, { invoiceIds, transactionIds }) => {
      const transaction = await transactionRow(seed, transactionIds![0]!)
      const invoice = await invoiceForMatch(seed, invoiceIds![0]!)
      const booked = await runWithActor({ type: 'user' }, () =>
        bookSupplierBankMatch(seed.supabase, {
          transaction,
          invoice,
          userId: seed.userId,
          companyId: seed.companyId,
          log,
          match: { action: 'auto_matched', method: PAYMENT_ORDER_MATCH_METHOD, confidence: 1 },
          linkBasis: { basis: 'rule_ocr_reference', evidence: { rule_id: `${PAYMENT_ORDER_MATCH_METHOD}:end_to_end_id`, score: 1 } },
        }),
      )
      expect(booked.ok, JSON.stringify(booked)).toBe(true)
    },
    events: [
      {
        ...PAID,
        occurred_on: '2026-04-16',
        subject: { type: 'supplier_invoice', index: 0 },
        direction: 'out',
        link_basis: 'rule_ocr_reference',
        link_evidence: { rule_id: `${PAYMENT_ORDER_MATCH_METHOD}:end_to_end_id`, score: 1 },
      },
    ],
  },
  {
    name: 'bank match (v1): a row categorized first has that verifikat reversed, then the payment is booked',
    setup: async (seed) => {
      const invoiceId = await register(seed, domesticInvoice(seed, 'F-2008', '2026-04-03'))
      const transactionId = await insertRow(seed, { date: '2026-06-22', description: 'Kontorsbolaget F-2008', amount: -1500 })
      const categorized = await runWithActor({ type: 'user' }, () =>
        categorizeTransaction(seed.supabase, seed.userId, seed.companyId, transactionId, { is_business: true, category: 'expense_office' }, {
          onBooked: 'refuse',
          invoiceMatchIntercept: false,
        }),
      )
      expect(categorized.ok, JSON.stringify(categorized)).toBe(true)
      return { invoiceIds: [invoiceId], transactionIds: [transactionId] }
    },
    run: async (seed, { invoiceIds, transactionIds }) => {
      const id = transactionIds![0]!
      await expectStatus(
        await v1MatchSupplierInvoiceRoute(
          // The row is booked by its own categorization: the match reverses
          // it only when asked (storno_existing, accounted#58).
          v1Request(seed, `/api/v1/companies/${seed.companyId}/transactions/${id}/match-supplier-invoice`, {
            supplier_invoice_id: invoiceIds![0],
            storno_existing: true,
          }),
          params({ companyId: seed.companyId, id }),
        ),
        200,
      )
    },
    events: [
      // The caller chose this storno (storno_existing): user_created, as on
      // the uncategorize doors, which an API key records as client_asserted.
      { ...STORNO, subject: { type: 'transaction', index: 0 }, link_basis: 'client_asserted' },
      { ...PAID, occurred_on: '2026-06-22', subject: { type: 'supplier_invoice', index: 0 }, direction: 'out', link_basis: 'client_asserted' },
    ],
  },
  {
    name: 'bank match (v1): kontantmetoden settles a never-registered invoice from the row',
    setup: async (seed) => {
      await setMethod(seed, 'cash')
      return {
        invoiceIds: [await register(seed, domesticInvoice(seed, 'F-2009', '2026-04-04'))],
        transactionIds: [await insertRow(seed, { date: '2026-04-21', description: 'Kontorsbolaget F-2009', amount: -1500 })],
        restore: () => setMethod(seed, 'accrual'),
      }
    },
    run: async (seed, { invoiceIds, transactionIds }) => {
      const id = transactionIds![0]!
      await expectStatus(
        await v1MatchSupplierInvoiceRoute(
          v1Request(seed, `/api/v1/companies/${seed.companyId}/transactions/${id}/match-supplier-invoice`, { supplier_invoice_id: invoiceIds![0] }),
          params({ companyId: seed.companyId, id }),
        ),
        200,
      )
    },
    events: [
      {
        ...PAID,
        occurred_on: '2026-04-21',
        subject: { type: 'supplier_invoice', index: 0 },
        vat: { treatment: 'standard_25', amount_sek: 300 },
        direction: 'out',
        link_basis: 'client_asserted',
        entries: ['supplier_invoice_cash_payment'],
      },
    ],
  },
  {
    name: "book (dashboard): a withdrawal booked on the person's own rows",
    setup: async (seed) => ({ transactionIds: [await insertRow(seed, { date: '2026-05-04', description: 'Programvarulicens', amount: -1250 })] }),
    run: async (seed, { transactionIds }) => {
      const id = transactionIds![0]!
      await expectStatus(
        await bookRoute(
          sessionRequest(`/api/transactions/${id}/book`, {
            fiscal_period_id: seed.fiscalPeriodId,
            entry_date: '2026-05-04',
            description: 'Programvarulicens',
            lines: [
              { account_number: '5420', debit_amount: 1000, credit_amount: 0 },
              { account_number: '2641', debit_amount: 250, credit_amount: 0 },
              { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
            ],
          }),
          params({ id }),
        ),
        200,
      )
    },
    events: [{ ...BOOKED, occurred_on: '2026-05-04', subject: { type: 'transaction', index: 0 }, currency: 'SEK', amount: 1250, amount_sek: 1250, direction: 'out' }],
  },
  {
    name: "book (dashboard): a foreign deposit booked on the person's own rows",
    setup: async (seed) => ({
      transactionIds: [
        await insertRow(seed, { date: '2026-05-06', description: 'Consulting GmbH', amount: 100, currency: 'EUR', amount_sek: 1150.25, exchange_rate: 11.5025 }),
      ],
    }),
    run: async (seed, { transactionIds }) => {
      const id = transactionIds![0]!
      await expectStatus(
        await bookRoute(
          sessionRequest(`/api/transactions/${id}/book`, {
            fiscal_period_id: seed.fiscalPeriodId,
            entry_date: '2026-05-06',
            description: 'Konsultuppdrag EU',
            lines: [
              { account_number: '1930', debit_amount: 1150.25, credit_amount: 0 },
              { account_number: '3308', debit_amount: 0, credit_amount: 1150.25 },
            ],
          }),
          params({ id }),
        ),
        200,
      )
    },
    events: [{ ...BOOKED, occurred_on: '2026-05-06', subject: { type: 'transaction', index: 0 }, currency: 'EUR', amount: 100, amount_sek: 1150.25, direction: 'in' }],
  },
  {
    name: 'book (dashboard): the bank line refuses the link, so the verifikat is reversed',
    setup: async (seed) => {
      const id = await insertRow(seed, { date: '2026-05-08', description: 'Kontorsmaterial', amount: -400 })
      return {
        transactionIds: [id],
        restore: await refuseUpdate('transactions', `NEW.id = '${id}'::uuid AND NEW.journal_entry_id IS NOT NULL AND OLD.journal_entry_id IS NULL`),
      }
    },
    run: async (seed, { transactionIds }) => {
      const id = transactionIds![0]!
      const response = await bookRoute(
        sessionRequest(`/api/transactions/${id}/book`, {
          fiscal_period_id: seed.fiscalPeriodId,
          entry_date: '2026-05-08',
          description: 'Kontorsmaterial',
          lines: [
            { account_number: '6110', debit_amount: 400, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 400 },
          ],
        }),
        params({ id }),
      )
      expect(response.status).toBeGreaterThanOrEqual(400)
    },
    events: [
      { ...BOOKED, occurred_on: '2026-05-08', subject: { type: 'transaction', index: 0 }, currency: 'SEK', amount: 400, amount_sek: 400, direction: 'out' },
      { ...STORNO, subject: { type: 'transaction', index: 0 }, link_basis: 'system_derived' },
    ],
  },
  {
    name: "uncategorize (dashboard): a booked row's verifikat is reversed",
    setup: async (seed) => {
      const id = await insertRow(seed, { date: '2026-05-11', description: 'Felbokad rad', amount: -300 })
      await expectStatus(
        await bookRoute(
          sessionRequest(`/api/transactions/${id}/book`, {
            fiscal_period_id: seed.fiscalPeriodId,
            entry_date: '2026-05-11',
            description: 'Felbokad rad',
            lines: [
              { account_number: '6110', debit_amount: 300, credit_amount: 0 },
              { account_number: '1930', debit_amount: 0, credit_amount: 300 },
            ],
          }),
          params({ id }),
        ),
        200,
      )
      return { transactionIds: [id] }
    },
    run: async (_seed, { transactionIds }) => {
      const id = transactionIds![0]!
      await expectStatus(await uncategorizeRoute(sessionRequest(`/api/transactions/${id}/uncategorize`, {}), params({ id })), 200)
    },
    events: [{ ...STORNO, subject: { type: 'transaction', index: 0 }, link_basis: 'user_created' }],
  },
  {
    name: "uncategorize (v1): a categorized row's verifikat is reversed",
    setup: async (seed) => {
      const id = await insertRow(seed, { date: '2026-05-12', description: 'Kontorsvaror', amount: -500 })
      const categorized = await runWithActor({ type: 'user' }, () =>
        categorizeTransaction(seed.supabase, seed.userId, seed.companyId, id, { is_business: true, category: 'expense_office' }, {
          onBooked: 'refuse',
          invoiceMatchIntercept: false,
        }),
      )
      expect(categorized.ok, JSON.stringify(categorized)).toBe(true)
      return { transactionIds: [id] }
    },
    run: async (seed, { transactionIds }) => {
      const id = transactionIds![0]!
      await expectStatus(
        await v1UncategorizeRoute(
          v1Request(seed, `/api/v1/companies/${seed.companyId}/transactions/${id}/uncategorize`),
          params({ companyId: seed.companyId, id }),
        ),
        200,
      )
    },
    events: [{ ...STORNO, subject: { type: 'transaction', index: 0 }, link_basis: 'client_asserted' }],
  },
  {
    name: 'book-direct (inbox): a receipt without a bank row books the inbox item',
    setup: async (seed) => {
      const documentId = await insertDocument(seed, 'kvitto-2015.pdf')
      return { documentIds: [documentId], inboxItemIds: [await insertInboxItem(seed, documentId)] }
    },
    run: async (seed, { inboxItemIds }) => {
      const id = inboxItemIds![0]!
      const response = await runWithActor({ type: 'user' }, () =>
        bookDirect().handler(
          new Request(`http://localhost/items/${id}/book-direct?_id=${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fiscal_period_id: seed.fiscalPeriodId,
              entry_date: '2026-05-14',
              description: 'Kvitto lunchmöte',
              notes: 'Deltagare: Anna, Per. Syfte: kundmöte',
              lines: RECEIPT_LINES,
            }),
          }),
          extensionCtx(seed),
        ),
      )
      await expectStatus(response, 200)
    },
    events: [
      {
        kind: 'purchase.document_booked',
        role: 'produced',
        occurred_on: '2026-05-14',
        subject: { type: 'inbox_item', index: 0 },
        party: null,
        currency: null,
        amount: null,
        amount_sek: null,
        vat: null,
        document: 0,
        inbox: 0,
        link_basis: 'user_created',
        direction: null,
        mappingSource: null,
        entries: ['inbox_item'],
      },
    ],
  },
  {
    name: 'book-direct (inbox): a receipt booked against the bank row the person picked',
    setup: async (seed) => {
      const documentId = await insertDocument(seed, 'kvitto-2016.pdf')
      return {
        documentIds: [documentId],
        inboxItemIds: [await insertInboxItem(seed, documentId)],
        transactionIds: [await insertRow(seed, { date: '2026-05-15', description: 'SPOTIFY', amount: -99 })],
      }
    },
    run: async (seed, { inboxItemIds, transactionIds }) => {
      const id = inboxItemIds![0]!
      const response = await runWithActor({ type: 'user' }, () =>
        bookDirect().handler(
          new Request(`http://localhost/items/${id}/book-direct?_id=${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fiscal_period_id: seed.fiscalPeriodId,
              entry_date: '2026-05-15',
              description: 'Kvitto från Spotify',
              transaction_id: transactionIds![0],
              lines: RECEIPT_LINES,
            }),
          }),
          extensionCtx(seed),
        ),
      )
      await expectStatus(response, 200)
    },
    events: [
      {
        ...BOOKED,
        occurred_on: '2026-05-15',
        subject: { type: 'transaction', index: 0 },
        currency: 'SEK',
        amount: 99,
        amount_sek: 99,
        document: 0,
        inbox: 0,
        direction: 'out',
      },
    ],
  },
  {
    name: 'book-direct (inbox): the item refuses the claim, so the verifikat is reversed',
    setup: async (seed) => {
      const documentId = await insertDocument(seed, 'kvitto-2017.pdf')
      const itemId = await insertInboxItem(seed, documentId)
      return {
        documentIds: [documentId],
        inboxItemIds: [itemId],
        restore: await refuseUpdate('invoice_inbox_items', `NEW.id = '${itemId}'::uuid AND NEW.created_journal_entry_id IS NOT NULL`),
      }
    },
    run: async (seed, { inboxItemIds }) => {
      const id = inboxItemIds![0]!
      const response = await runWithActor({ type: 'user' }, () =>
        bookDirect().handler(
          new Request(`http://localhost/items/${id}/book-direct?_id=${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fiscal_period_id: seed.fiscalPeriodId,
              entry_date: '2026-05-18',
              description: 'Kvitto taxi',
              lines: RECEIPT_LINES,
            }),
          }),
          extensionCtx(seed),
        ),
      )
      expect(response.status).toBeGreaterThanOrEqual(400)
    },
    events: [
      {
        kind: 'purchase.document_booked',
        role: 'produced',
        occurred_on: '2026-05-18',
        subject: { type: 'inbox_item', index: 0 },
        party: null,
        currency: null,
        amount: null,
        amount_sek: null,
        vat: null,
        document: 0,
        inbox: 0,
        link_basis: 'user_created',
        direction: null,
        mappingSource: null,
        entries: ['inbox_item'],
      },
      { ...STORNO, subject: { type: 'inbox_item', index: 0 }, link_basis: 'system_derived' },
    ],
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

/** What the doors write beside the verifikat: invoices, payment rows, bank lines, inbox items and underlag. */
async function registerOf(seed: Seed): Promise<unknown> {
  const voucher = (alias: string) => `${alias}.voucher_series || coalesce(${alias}.voucher_number::text, '-') || ':' || ${alias}.status`
  const [invoices, payments, transactions, inbox, documents] = await Promise.all([
    getPool().query(
      `SELECT si.supplier_invoice_number, si.status, si.currency, si.paid_amount::text AS paid_amount,
              si.remaining_amount::text AS remaining_amount, si.paid_at::text AS paid_at,
              ${voucher('pje')} AS payment_voucher, t.description AS transaction
         FROM public.supplier_invoices si
         LEFT JOIN public.journal_entries pje ON pje.id = si.payment_journal_entry_id
         LEFT JOIN public.transactions t ON t.id = si.transaction_id
        WHERE si.company_id = $1
        ORDER BY si.arrival_number`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT si.supplier_invoice_number, p.payment_date::text AS payment_date, p.amount::text AS amount, p.currency,
              p.exchange_rate_difference::text AS exchange_rate_difference, p.notes, p.link_basis, p.link_evidence,
              ${voucher('je')} AS voucher, t.description AS transaction
         FROM public.supplier_invoice_payments p
         JOIN public.supplier_invoices si ON si.id = p.supplier_invoice_id
         LEFT JOIN public.journal_entries je ON je.id = p.journal_entry_id
         LEFT JOIN public.transactions t ON t.id = p.transaction_id
        WHERE p.company_id = $1
        ORDER BY si.supplier_invoice_number, p.payment_date`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT t.date::text AS date, t.description, t.amount::text AS amount, t.currency, t.category, t.is_business,
              t.link_basis, ${voucher('je')} AS voucher, si.supplier_invoice_number AS supplier_invoice
         FROM public.transactions t
         LEFT JOIN public.journal_entries je ON je.id = t.journal_entry_id
         LEFT JOIN public.supplier_invoices si ON si.id = t.supplier_invoice_id
        WHERE t.company_id = $1
        ORDER BY t.date, t.description, t.amount`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT d.file_name, ${voucher('je')} AS voucher, t.description AS matched_transaction
         FROM public.invoice_inbox_items i
         LEFT JOIN public.document_attachments d ON d.id = i.document_id
         LEFT JOIN public.journal_entries je ON je.id = i.created_journal_entry_id
         LEFT JOIN public.transactions t ON t.id = i.matched_transaction_id
        WHERE i.company_id = $1
        ORDER BY d.file_name`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT d.file_name, ${voucher('je')} AS voucher, d.link_basis
         FROM public.document_attachments d
         LEFT JOIN public.journal_entries je ON je.id = d.journal_entry_id
        WHERE d.company_id = $1
        ORDER BY d.file_name`,
      [seed.companyId],
    ),
  ])
  return {
    invoices: invoices.rows,
    payments: payments.rows,
    transactions: transactions.rows,
    inbox: inbox.rows,
    documents: documents.rows,
  }
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
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true)`,
    [userId, companyId],
  )
  const supplier = async (name: string, type: string, currency: string) => {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.suppliers (user_id, company_id, name, supplier_type, default_currency)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
      [userId, companyId, name, type, currency],
    )
    return rows[0]!.id
  }
  const domestic = await supplier('Kontorsbolaget AB', 'swedish_business', 'SEK')
  const eu = await supplier('Hosting GmbH', 'eu_business', 'EUR')
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
  const fn = `pg_test_sp_fail_${table}`
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
  const ids = subject.type === 'supplier_invoice' ? prepared.invoiceIds : subject.type === 'transaction' ? prepared.transactionIds : prepared.inboxItemIds
  return ids![subject.index]!
}

/**
 * One door each, on records prepared beforehand (their own verifikat drawn
 * before the door runs): a dashboard and a v1 payment, a dashboard and a v1
 * bank match, a bank line booked, a booked row uncategorized on each door,
 * and an underlag booked with and without its bank row. Answers each door's
 * HTTP status (or the lib door's outcome as 200 / 409).
 */
interface DoorSet {
  run: () => Promise<number[]>
  /** The invoices and the bank line the doors pay and book, to read their state after a refusal. */
  invoiceIds: string[]
  bookedRow: string
}

let doorSeq = 0

async function prepareDoors(seed: Seed, date: string): Promise<DoorSet> {
  const n = ++doorSeq
  const invoice = async () => register(seed, domesticInvoice(seed, `FAIL-${n}-${randomUUID().slice(0, 4)}`, date))
  const [markPaid, v1MarkPaid, match, v1Match] = [await invoice(), await invoice(), await invoice(), await invoice()]
  // Distinct amounts and days, so no door reads another's row as a duplicate.
  const matchRow = await insertRow(seed, { date, description: `Betalning ${n} a`, amount: -1500 })
  const v1MatchRow = await insertRow(seed, { date, description: `Betalning ${n} b`, amount: -1500 })
  const bookRow = await insertRow(seed, { date, description: `Kontorsvaror ${n}`, amount: -(100 + n) })
  const bookedRow = await insertRow(seed, { date, description: `Bokad rad ${n}`, amount: -(200 + n) })
  const categorizedRow = await insertRow(seed, { date, description: `Kategoriserad rad ${n}`, amount: -(300 + n) })
  const receiptDocument = await insertDocument(seed, `kvitto-fail-${n}-a.pdf`)
  const receiptItem = await insertInboxItem(seed, receiptDocument)
  const rowDocument = await insertDocument(seed, `kvitto-fail-${n}-b.pdf`)
  const rowItem = await insertInboxItem(seed, rowDocument)
  const receiptRow = await insertRow(seed, { date, description: `Kvitto ${n}`, amount: -(400 + n) })
  const ownRows = (amount: number) => [
    { account_number: '6110', debit_amount: amount, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: amount },
  ]
  // The rows the uncategorize doors reverse, booked before the doors run.
  await expectStatus(
    await bookRoute(
      sessionRequest(`/api/transactions/${bookedRow}/book`, { fiscal_period_id: seed.fiscalPeriodId, entry_date: date, description: 'Bokad rad', lines: ownRows(200 + n) }),
      params({ id: bookedRow }),
    ),
    200,
  )
  const categorized = await runWithActor({ type: 'user' }, () =>
    categorizeTransaction(seed.supabase, seed.userId, seed.companyId, categorizedRow, { is_business: true, category: 'expense_office' }, {
      onBooked: 'refuse',
      invoiceMatchIntercept: false,
    }),
  )
  expect(categorized.ok, JSON.stringify(categorized)).toBe(true)
  const receipt = (itemId: string, transactionId?: string) =>
    runWithActor({ type: 'user' }, () =>
      bookDirect().handler(
        new Request(`http://localhost/items/${itemId}/book-direct?_id=${itemId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fiscal_period_id: seed.fiscalPeriodId,
            entry_date: date,
            description: 'Kvitto',
            lines: transactionId ? ownRows(400 + n) : RECEIPT_LINES,
            ...(transactionId ? { transaction_id: transactionId } : {}),
          }),
        }),
        extensionCtx(seed),
      ),
    )
  return {
    invoiceIds: [markPaid, v1MarkPaid, match, v1Match],
    bookedRow: bookRow,
    run: async () => [
      (await markPaidRoute(sessionRequest(`/api/supplier-invoices/${markPaid}/mark-paid`, { payment_date: date }), params({ id: markPaid }))).status,
      (
        await v1MarkPaidRoute(
          v1Request(seed, `/api/v1/companies/${seed.companyId}/supplier-invoices/${v1MarkPaid}/mark-paid`, { payment_date: date }),
          params({ companyId: seed.companyId, id: v1MarkPaid }),
        )
      ).status,
      (
        await matchSupplierInvoiceRoute(
          sessionRequest(`/api/transactions/${matchRow}/match-supplier-invoice`, { supplier_invoice_id: match }),
          params({ id: matchRow }),
        )
      ).status,
      (
        await v1MatchSupplierInvoiceRoute(
          v1Request(seed, `/api/v1/companies/${seed.companyId}/transactions/${v1MatchRow}/match-supplier-invoice`, { supplier_invoice_id: v1Match }),
          params({ companyId: seed.companyId, id: v1MatchRow }),
        )
      ).status,
      (
        await bookRoute(
          sessionRequest(`/api/transactions/${bookRow}/book`, { fiscal_period_id: seed.fiscalPeriodId, entry_date: date, description: 'Kontorsvaror', lines: ownRows(100 + n) }),
          params({ id: bookRow }),
        )
      ).status,
      (await uncategorizeRoute(sessionRequest(`/api/transactions/${bookedRow}/uncategorize`, {}), params({ id: bookedRow }))).status,
      (
        await v1UncategorizeRoute(
          v1Request(seed, `/api/v1/companies/${seed.companyId}/transactions/${categorizedRow}/uncategorize`),
          params({ companyId: seed.companyId, id: categorizedRow }),
        )
      ).status,
      (await receipt(receiptItem)).status,
      (await receipt(rowItem, receiptRow)).status,
    ],
  }
}

/** The doors prepareDoors runs, each posting one verifikat. */
const DOOR_COUNT = 9

/** Every flow books on a fresh company: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 300_000

describe('posting port parity, supplier payments and bank-line booking (pg)', () => {
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
    'books the same verifikat with POSTING_EVENTS=shadow and links exactly one event to every verifikat a door wrote',
    { timeout: FLOW_TIMEOUT * 2 },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'off')
      const off = await runFlows()
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const shadow = await runFlows()

      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual({ dumps: off.dumps, register: off.register })
      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

      const { companyId } = shadow.seed
      // Every verifikat the moved doors wrote has exactly one link.
      const written = shadow.posted.flatMap((p) => p.entries.map((e) => e.id))
      const counts = await linkCounts(written)
      expect(counts).toHaveLength(written.length)
      expect(counts.filter((e) => e.links !== 1)).toEqual([])

      const links = await eventLinks(companyId)
      const doorEvents = new Set(links.filter((l) => written.includes(l.journal_entry_id ?? '')).map((l) => l.id))
      expect(doorEvents.size).toBe(FLOWS.reduce((n, f) => n + f.events.length, 0))
      const today = (await getPool().query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS d`)).rows[0]!.d
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        // Every verifikat the door wrote belongs to one of its events.
        const claimed = flow.events.flatMap((e) => e.entries)
        expect(posted.entries.map((e) => e.source_type).sort(), flow.name).toEqual([...claimed].sort())
        for (const [j, expected] of flow.events.entries()) {
          const label = `${flow.name} #${j}`
          const wanted = posted.entries.filter((e) => expected.entries.includes(e.source_type as EntryRole)).map((e) => e.id)
          const owners = [...new Set(links.filter((l) => wanted.includes(l.journal_entry_id!)).map((l) => l.id))]
          expect(owners, label).toHaveLength(1)
          const rows = links.filter((l) => l.id === owners[0])
          // A cancelled voucher keeps its event, and the fixture holds its status.
          const live = rows.filter((l) => LIVE.has(l.entry_status ?? '')).map((l) => l.journal_entry_id)
          const cancelled = rows.filter((l) => l.entry_status === 'cancelled').map((l) => l.journal_entry_id)
          expect(new Set(live), label).toEqual(new Set(wanted.filter((id) => !cancelled.includes(id))))
          const event = rows[0]!
          const partyId = expected.party ? shadow.seed[expected.party] : null
          expect(event, label).toMatchObject({
            kind: expected.kind,
            role: expected.role,
            category: null,
            occurred_on: expected.occurred_on === 'today' ? today : expected.occurred_on,
            subject_type: expected.subject.type,
            subject_id: subjectOf(posted, expected.subject),
            party_type: partyId ? 'supplier' : null,
            party_id: partyId,
            currency: expected.currency,
            tax_amounts: expected.vat ? [{ tax: 'vat', treatment: expected.vat.treatment, amount_sek: expected.vat.amount_sek }] : [],
            jurisdiction: 'SE',
            idempotency_key: null,
            pending_operation_id: null,
          })
          expect(rows.every((l) => l.role === expected.role), label).toBe(true)
          expect(event.amount === null ? null : Number(event.amount), label).toBe(expected.amount)
          expect(event.amount_sek === null ? null : Number(event.amount_sek), label).toBe(expected.amount_sek)
          expect(event.evidence.link_basis, label).toBe(expected.link_basis)
          expect(event.evidence.link_evidence ?? null, label).toEqual(expected.link_evidence ?? null)
          expect(event.evidence.direction ?? null, label).toBe(expected.direction)
          expect(event.evidence.document_id ?? null, label).toBe(expected.document === null ? null : posted.documentIds![expected.document])
          expect(event.evidence.inbox_item_id ?? null, label).toBe(expected.inbox === null ? null : posted.inboxItemIds![expected.inbox])
          // References only: no supplier name in the evidence.
          expect(JSON.stringify(event.evidence)).not.toMatch(/Kontorsbolaget|Hosting GmbH/)
          if (expected.mappingSource) {
            expect(event.mapping_version?.startsWith(`${expected.mappingSource}@`), `${label}: ${event.mapping_version}`).toBe(true)
          } else {
            expect(event.mapping_version, label).toBeNull()
          }
          // The session doors and the lib door run as the user, the v1 doors on the API key.
          expect(event.actor_type, label).toBe(expected.link_basis === 'client_asserted' || flow.name.includes('(v1)') ? 'api_key' : 'user')
        }
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
        const shadowDoors = await prepareDoors(seed, table === 'business_events' ? '2026-07-06' : '2026-07-13')
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
        expect(written, table).toHaveLength(DOOR_COUNT)
        for (const id of written) expect(await linksOf(id), table).toBe(0)
        expect(await lastVoucherNumber(companyId), table).toBe(drawnBefore + DOOR_COUNT)

        // Strict: each door stops before a voucher number is drawn.
        const strictDoors = await prepareDoors(seed, table === 'business_events' ? '2026-07-20' : '2026-07-27')
        const strictBefore = await entryIdsOf(companyId)
        const restoreStrict = await failInserts(table)
        try {
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)
          const refused = await strictDoors.run()
          for (const [i, status] of refused.entries()) expect(status, `${table} door ${i}`).toBeGreaterThanOrEqual(400)
          expect(await lastVoucherNumber(companyId), table).toBe(drawn)
          // Nothing reached the books: no posted verifikat, the invoices unpaid, the bank line unbooked.
          const strictWritten = [...(await entryIdsOf(companyId))].filter((id) => !strictBefore.has(id))
          const { rows: posted } = await getPool().query(
            `SELECT id FROM public.journal_entries WHERE id = ANY($1::uuid[]) AND status <> 'cancelled'`,
            [strictWritten],
          )
          expect(posted, table).toEqual([])
          const { rows: invoices } = await getPool().query<{ status: string; payment_journal_entry_id: string | null }>(
            `SELECT status, payment_journal_entry_id::text AS payment_journal_entry_id FROM public.supplier_invoices WHERE id = ANY($1::uuid[])`,
            [strictDoors.invoiceIds],
          )
          expect(invoices.map((r) => r.payment_journal_entry_id), table).toEqual(invoices.map(() => null))
          expect(invoices.every((r) => r.status !== 'paid'), table).toBe(true)
          const { rows: row } = await getPool().query(`SELECT journal_entry_id FROM public.transactions WHERE id = $1`, [strictDoors.bookedRow])
          expect(row[0]!.journal_entry_id, table).toBeNull()
        } finally {
          await restoreStrict()
          vi.stubEnv('POSTING_EVENTS', 'shadow')
        }
      }

      // With nothing refused, strict books every door with its event, the
      // next numbers in each series: none of the refusals above left a gap.
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const strictDoors = await prepareDoors(seed, '2026-08-03')
      const before = await entryIdsOf(companyId)
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const drawn = await lastVoucherNumber(companyId)
      expect(await strictDoors.run()).toEqual(Array.from({ length: DOOR_COUNT }, () => 200))
      expect(await lastVoucherNumber(companyId)).toBe(drawn + DOOR_COUNT)
      const written = [...(await entryIdsOf(companyId))].filter((id) => !before.has(id))
      expect(written).toHaveLength(DOOR_COUNT)
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
