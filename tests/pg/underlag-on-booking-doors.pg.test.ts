/**
 * One bank row with a document pinned to it and an inbox item matched to it:
 * every door that books the row, on real Postgres. Whatever the door, the
 * verifikat that books the row carries both documents and the item is stamped
 * (BFL 5 kap 6-7 §: a verifikation refers to its underlag). The step is
 * propagateUnderlagForBookedTransaction.
 *
 * What the doors must not do, on the same fixtures: move a document that
 * already sits on another verifikat, or anchor anything on a verifikat the
 * match then cancels (anchoring is permanent, and a loser would keep it).
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts)
 * and the session doors' cookie auth.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createServiceClientNoCookies, generateApiKey } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import type { ExtensionContext } from '@/lib/extensions/types'
import { bookSupplierBankMatch } from '@/lib/invoices/book-supplier-bank-match'
import { issueAndBookInvoice, type IssuableInvoice } from '@/lib/invoices/issue-and-book-invoice'
import type { OperationContext } from '@/lib/operations/types'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { createSupplierInvoice, type CreateSupplierInvoiceInput } from '@/lib/supplier-invoices/create'
import { matchTransactionBatch } from '@/lib/transactions/match-batch'
import type { CompanySettings, PendingOperation, SupplierInvoice, Transaction } from '@/types'
import { POST as matchInvoiceRoute } from '@/app/api/transactions/[id]/match-invoice/route'
import { POST as matchExpensePayoutRoute } from '@/app/api/transactions/[id]/match-expense-payout/route'
import { POST as matchSupplierInvoiceRoute } from '@/app/api/transactions/[id]/match-supplier-invoice/route'
import { POST as v1MatchInvoiceRoute } from '@/app/api/v1/companies/[companyId]/transactions/[id]/match-invoice/route'
import { POST as v1MatchSupplierInvoiceRoute } from '@/app/api/v1/companies/[companyId]/transactions/[id]/match-supplier-invoice/route'
import { testRoutes } from '../helpers'
import { insertCashAccount, seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))
const session = vi.hoisted(() => ({ userId: '', companyId: '' }))

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
vi.mock('@/lib/auth/require-auth', async () => {
  const { createServiceClientNoCookies: client } = await import('@/lib/auth/api-keys')
  return { requireAuth: async () => ({ user: { id: session.userId }, supabase: client(), error: null }) }
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

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const BANK_DATE = '2026-03-10'

interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  customer: string
  supplier: string
  cash: string
  apiKey: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

async function seed(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, entity_type, accounting_method, vat_registered, vat_number, company_name, org_number, bankgiro, address_line1, postal_code, city)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true, 'SE556677889901', 'Konsultbolaget AB', '556677-8899', '5050-1055', 'Testgatan 1', '111 22', 'Stockholm')`,
    [userId, companyId],
  )
  const { rows: customer } = await getPool().query<{ id: string }>(
    `INSERT INTO public.customers (user_id, company_id, name, customer_type, country, vat_number, org_number, address_line1, postal_code, city)
     VALUES ($1, $2, 'Kund AB', 'swedish_business', 'SE', 'SE559900123401', '559900-1234', 'Storgatan 1', '111 22', 'Stockholm') RETURNING id::text AS id`,
    [userId, companyId],
  )
  const { rows: supplier } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name, supplier_type, default_currency)
     VALUES ($1, $2, 'Kontorsbolaget AB', 'swedish_business', 'SEK') RETURNING id::text AS id`,
    [userId, companyId],
  )
  const cash = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK', isPrimary: true })
  for (const [number, name, cls, type, normal] of [
    ['1930', 'Bank', 1, 'asset', 'debit'],
    ['1510', 'Kundfordringar', 1, 'asset', 'debit'],
    ['2440', 'Leverantörsskulder', 2, 'liability', 'credit'],
    ['2611', 'Utgående moms', 2, 'liability', 'credit'],
    ['2641', 'Ingående moms', 2, 'asset', 'debit'],
    ['3001', 'Försäljning', 3, 'revenue', 'credit'],
    ['3740', 'Öresavrundning', 3, 'revenue', 'credit'],
    ['6110', 'Kontorsmaterial', 6, 'expense', 'debit'],
    ['6540', 'IT-tjänster', 6, 'expense', 'debit'],
  ] as const) {
    await getPool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [userId, companyId, number, name, cls, type, normal],
    )
  }
  const key = generateApiKey('live')
  await getPool().query(
    `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes) VALUES ($1, $2, $3, $4, 'Bokföringsnyckel', $5)`,
    [userId, companyId, key.hash, key.prefix, ['invoices:read', 'invoices:write', 'suppliers:read', 'suppliers:write', 'transactions:read', 'transactions:write']],
  )
  session.userId = userId
  session.companyId = companyId
  return { userId, companyId, fiscalPeriodId, customer: customer[0]!.id, supplier: supplier[0]!.id, cash, apiKey: key.key, supabase: createServiceClientNoCookies() }
}

const opContext = (s: Seed) => ({ supabase: s.supabase, companyId: s.companyId, userId: s.userId, log }) as OperationContext

function approve(s: Seed, op: PendingOperation) {
  return runWithActor({ type: 'user' }, () =>
    commitPendingOperation(s.supabase, s.userId, s.companyId, op, { commitMethod: 'user_accept', actor: { type: 'user' } }),
  )
}

async function stage(s: Seed, type: string, params: Record<string, unknown>): Promise<PendingOperation> {
  const { rows } = await getPool().query(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [s.userId, s.companyId, type, type, JSON.stringify(params)],
  )
  return rows[0] as PendingOperation
}

/** A sent invoice of 1500 kr incl. moms, booked at issue. */
async function sentInvoice(s: Seed): Promise<string> {
  const created = await approve(
    s,
    await stage(s, 'create_invoice', {
      customer_id: s.customer,
      invoice_date: '2026-02-02',
      due_date: '2026-03-31',
      currency: 'SEK',
      items: [{ description: 'Konsulttimmar', quantity: 12, unit: 'tim', unit_price: 100, vat_rate: 25 }],
    }),
  )
  const id = (created as { data?: { invoice_id?: string } }).data!.invoice_id as string
  const { data: invoice } = await s.supabase.from('invoices').select('*, customer:customers(*), items:invoice_items(*)').eq('id', id).single()
  const { data: settings } = await s.supabase.from('company_settings').select('*').eq('company_id', s.companyId).single()
  const issued = await issueAndBookInvoice({
    supabase: s.supabase,
    companyId: s.companyId,
    userId: s.userId,
    invoice: invoice as IssuableInvoice,
    settings: settings as CompanySettings,
    log,
  })
  if (!issued.ok) throw new Error(JSON.stringify(issued))
  return id
}

/** A registered supplier invoice of 1500 kr incl. moms, booked at registration. */
async function registeredInvoice(s: Seed, number: string): Promise<string> {
  const result = await runWithActor({ type: 'user' }, () =>
    createSupplierInvoice(opContext(s), {
      supplier_id: s.supplier,
      supplier_invoice_number: number,
      invoice_date: '2026-02-02',
      due_date: '2026-03-31',
      items: [{ description: 'Pärmar', amount: 1200, account_number: '6110', vat_rate: 0.25 }],
    } as CreateSupplierInvoiceInput),
  )
  if (!result.ok || result.dryRun) throw new Error(JSON.stringify(result))
  return result.invoice.id as string
}

async function document(s: Seed, fileName: string, journalEntryId: string | null = null): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, storage_path, file_name, sha256_hash, mime_type, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', $7)`,
    [id, s.companyId, s.userId, `${s.companyId}/${id}/${fileName}`, `sha-${id}`, id, journalEntryId],
  )
  return id
}

/** A bank row with a document pinned to it and an inbox item matched to it. */
async function rowWithUnderlag(s: Seed, amount: number) {
  const pin = await document(s, 'kvitto.pdf')
  const matchedDocument = await document(s, 'avi.pdf')
  const tx = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions (id, company_id, user_id, date, description, amount, currency, category, cash_account_id, document_id)
     VALUES ($1, $2, $3, $4, 'Rad', $5, 'SEK', 'uncategorized', $6, $7)`,
    [tx, s.companyId, s.userId, BANK_DATE, amount, s.cash, pin],
  )
  const item = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, matched_transaction_id, extracted_data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [item, s.companyId, s.userId, matchedDocument, tx, JSON.stringify({ documentKind: 'receipt', totals: { total: 1500 }, invoice: { currency: 'SEK' } })],
  )
  return { tx, pin, matchedDocument, item }
}

async function bookedEntry(tx: string): Promise<string> {
  const { rows } = await getPool().query<{ journal_entry_id: string | null }>(`SELECT journal_entry_id FROM public.transactions WHERE id = $1`, [tx])
  expect(rows[0]?.journal_entry_id, 'the row is booked').toBeTruthy()
  return rows[0]!.journal_entry_id!
}

async function onVerifikat(documentId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ journal_entry_id: string | null }>(`SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`, [documentId])
  return rows[0]!.journal_entry_id
}

async function stampOf(item: string): Promise<string | null> {
  const { rows } = await getPool().query<{ created_journal_entry_id: string | null }>(`SELECT created_journal_entry_id FROM public.invoice_inbox_items WHERE id = $1`, [item])
  return rows[0]!.created_journal_entry_id
}

function postRequest(pathname: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

let idempotency = 0
const v1Headers = (s: Seed) => ({ Authorization: `Bearer ${s.apiKey}`, 'Idempotency-Key': `pg-underlag-${Date.now()}-${++idempotency}` })

const CUSTOMER_DOORS = {
  session: (s: Seed, tx: string, invoice: string) =>
    matchInvoiceRoute(postRequest(`/api/transactions/${tx}/match-invoice`, { invoice_id: invoice }), { params: Promise.resolve({ id: tx }) }),
  v1: (s: Seed, tx: string, invoice: string) =>
    v1MatchInvoiceRoute(
      postRequest(`/api/v1/companies/${s.companyId}/transactions/${tx}/match-invoice`, { invoice_id: invoice }, v1Headers(s)),
      { params: Promise.resolve({ companyId: s.companyId, id: tx }) },
    ),
} as const

const SUPPLIER_DOORS = {
  session: (s: Seed, tx: string, invoice: string) =>
    matchSupplierInvoiceRoute(postRequest(`/api/transactions/${tx}/match-supplier-invoice`, { supplier_invoice_id: invoice }), { params: Promise.resolve({ id: tx }) }),
  v1: (s: Seed, tx: string, invoice: string) =>
    v1MatchSupplierInvoiceRoute(
      postRequest(`/api/v1/companies/${s.companyId}/transactions/${tx}/match-supplier-invoice`, { supplier_invoice_id: invoice }, v1Headers(s)),
      { params: Promise.resolve({ companyId: s.companyId, id: tx }) },
    ),
} as const

const bookDirect = () => testRoutes(invoiceInboxExtension).find((r) => r.method === 'POST' && r.path === '/items/:id/book-direct')!

function extensionCtx(s: Seed): ExtensionContext {
  return {
    userId: s.userId,
    companyId: s.companyId,
    extensionId: 'invoice-inbox',
    supabase: s.supabase,
    emit: async () => {},
    settings: { get: async () => null, set: async () => {} },
    log,
    services: {},
  } as unknown as ExtensionContext
}

async function expectOk(response: Response): Promise<void> {
  const text = await response.text()
  expect(response.status, text).toBe(200)
}

async function expectUnderlagLanded(fixture: { tx: string; pin: string; matchedDocument: string; item: string }): Promise<void> {
  const entry = await bookedEntry(fixture.tx)
  expect(await onVerifikat(fixture.pin), 'the pinned document').toBe(entry)
  expect(await onVerifikat(fixture.matchedDocument), 'the matched item\'s document').toBe(entry)
  expect(await stampOf(fixture.item), 'the matched item').toBe(entry)
}

beforeEach(() => {
  vi.stubEnv('POSTING_EVENTS', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  expect(shim.rest?.unsupported.splice(0) ?? []).toEqual([])
})

describe('a customer bank match carries the row\'s underlag onto the payment verifikat', () => {
  it.each(['session', 'v1'] as const)('%s', { timeout: 60_000 }, async (door) => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const fixture = await rowWithUnderlag(s, 1500)

    await expectOk(await runWithActor({ type: 'user' }, () => CUSTOMER_DOORS[door](s, fixture.tx, invoice)))

    await expectUnderlagLanded(fixture)
  })

  it('the approval of a staged match', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const fixture = await rowWithUnderlag(s, 1500)

    const result = await approve(s, await stage(s, 'match_transaction_invoice', { transaction_id: fixture.tx, invoice_id: invoice }))

    expect((result as { status: string }).status, JSON.stringify(result)).toBe('committed')
    await expectUnderlagLanded(fixture)
  })

  it('leaves a document another verifikat holds where it is, and the row still books', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const fixture = await rowWithUnderlag(s, 1500)
    const { rows } = await getPool().query<{ journal_entry_id: string }>(`SELECT journal_entry_id FROM public.invoices WHERE id = $1`, [invoice])
    const other = rows[0]!.journal_entry_id
    await getPool().query(`UPDATE public.document_attachments SET journal_entry_id = $2 WHERE id = $1`, [fixture.pin, other])

    await expectOk(await runWithActor({ type: 'user' }, () => CUSTOMER_DOORS.session(s, fixture.tx, invoice)))

    expect(await onVerifikat(fixture.pin)).toBe(other)
    const entry = await bookedEntry(fixture.tx)
    expect(await onVerifikat(fixture.matchedDocument)).toBe(entry)
  })
})

describe('a batch match carries the row\'s underlag onto its samlingsverifikat', () => {
  it('one row, two invoices, one verifikat', { timeout: 60_000 }, async () => {
    const s = await seed()
    const [first, second] = [await sentInvoice(s), await sentInvoice(s)]
    const fixture = await rowWithUnderlag(s, 3000)

    const outcome = await runWithActor({ type: 'user' }, () =>
      matchTransactionBatch(opContext(s), fixture.tx, {
        allocations: [
          { kind: 'customer_invoice', invoice_id: first, amount: 1500 },
          { kind: 'customer_invoice', invoice_id: second, amount: 1500 },
        ],
      } as never),
    )

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true })
    await expectUnderlagLanded(fixture)
  })
})

describe('a supplier bank match carries the row\'s underlag onto the payment verifikat', () => {
  it.each(['session', 'v1'] as const)('%s', { timeout: 60_000 }, async (door) => {
    const s = await seed()
    const invoice = await registeredInvoice(s, `F-${door}`)
    const fixture = await rowWithUnderlag(s, -1500)

    await expectOk(await runWithActor({ type: 'user' }, () => SUPPLIER_DOORS[door](s, fixture.tx, invoice)))

    await expectUnderlagLanded(fixture)
  })

  it('the debit of a signed payment order', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoiceId = await registeredInvoice(s, 'F-order')
    const fixture = await rowWithUnderlag(s, -1500)
    const { data: invoice } = await s.supabase.from('supplier_invoices').select('*, supplier:suppliers(*), items:supplier_invoice_items(*)').eq('id', invoiceId).single()
    const { data: transaction } = await s.supabase.from('transactions').select('*').eq('id', fixture.tx).single()

    const outcome = await runWithActor({ type: 'user' }, () =>
      bookSupplierBankMatch(s.supabase, {
        transaction: transaction as Transaction,
        invoice: invoice as SupplierInvoice,
        userId: s.userId,
        companyId: s.companyId,
        log,
        match: { action: 'auto_matched', method: 'payment_order', confidence: 1 },
        linkBasis: { basis: 'rule_ocr_reference', evidence: { rule_id: 'payment_order:end_to_end_id', score: 1 } },
      }),
    )

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true })
    await expectUnderlagLanded(fixture)
  })

  it('leaves a superseded version of the pinned document off the verifikat', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await registeredInvoice(s, 'F-version')
    const fixture = await rowWithUnderlag(s, -1500)
    await getPool().query(`UPDATE public.document_attachments SET is_current_version = false WHERE id = $1`, [fixture.pin])

    await expectOk(await runWithActor({ type: 'user' }, () => SUPPLIER_DOORS.session(s, fixture.tx, invoice)))

    expect(await onVerifikat(fixture.pin)).toBeNull()
  })
})

describe('an expense payout matched to a bank row carries the row\'s underlag onto its verifikat', () => {
  it('one row, one registered claim', { timeout: 60_000 }, async () => {
    const s = await seed()
    await getPool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, '2893', 'Skuld till ägare', 2, 'liability', 'credit'), ($1, $2, '5410', 'Förbrukningsinventarier', 5, 'expense', 'debit') ON CONFLICT DO NOTHING`,
      [s.userId, s.companyId],
    )
    const fixture = await rowWithUnderlag(s, -1500)
    const claim = randomUUID()
    await getPool().query(
      `INSERT INTO public.expense_claims (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account, liability_account, status)
       VALUES ($1, $2, $3, 'Anställd', 'Utlägg', '2026-03-01', 1500, 0, '5410', '2893', 'registered')`,
      [claim, s.companyId, s.userId],
    )

    await expectOk(
      await runWithActor({ type: 'user' }, () =>
        matchExpensePayoutRoute(postRequest(`/api/transactions/${fixture.tx}/match-expense-payout`, { claim_ids: [claim] }), { params: Promise.resolve({ id: fixture.tx }) }),
      ),
    )

    await expectUnderlagLanded(fixture)
  })
})

describe('booking an inbox item against a bank row carries the row\'s own pin too', () => {
  it('book-direct', { timeout: 60_000 }, async () => {
    const s = await seed()
    const fixture = await rowWithUnderlag(s, -1500)
    const ownDocument = await document(s, 'faktura.pdf')
    const own = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, extracted_data) VALUES ($1, $2, $3, $4, $5)`,
      [own, s.companyId, s.userId, ownDocument, JSON.stringify({ documentKind: 'receipt', totals: { total: 1500 }, invoice: { currency: 'SEK' } })],
    )

    const response = await runWithActor({ type: 'user' }, () =>
      bookDirect().handler(
        postRequest(`/items/${own}/book-direct?_id=${own}`, {
          fiscal_period_id: s.fiscalPeriodId,
          entry_date: BANK_DATE,
          description: 'Kvitto',
          transaction_id: fixture.tx,
          lines: [
            { account_number: '6540', debit_amount: 1200, credit_amount: 0 },
            { account_number: '2641', debit_amount: 300, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 1500 },
          ],
        }),
        extensionCtx(s),
      ),
    )

    await expectOk(response)
    const entry = await bookedEntry(fixture.tx)
    expect(await onVerifikat(ownDocument), 'the booked item\'s document').toBe(entry)
    await expectUnderlagLanded(fixture)
  })
})
