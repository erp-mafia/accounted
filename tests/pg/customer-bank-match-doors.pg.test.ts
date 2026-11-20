/**
 * One 1500 kr bank row, one open 1500 kr invoice: every door that matches
 * them, on every shape a bank row can have, on real Postgres.
 *
 * The doors: the dashboard route, the v1 route on a real API key and the
 * approval of a staged match. They all book through bookCustomerBankMatch, so
 * the row decides the answer and the door does not:
 *
 *   - a row a posted verifikat already books is refused and nothing is
 *     written: the bank account moves once. It used to get a second verifikat
 *     (1930 moved 3000 for one 1500 row), and an approval reversed the
 *     independent verifikat of a reconciliation link;
 *   - an ignored row is refused: it used to answer 500 with the verifikat
 *     posted and the invoice paid;
 *   - a pointer at a verifikat that is no longer posted books no one: it used
 *     to answer 400 or fail the approval;
 *   - a free row books once, and every door leaves the same audit row and
 *     underlag.
 *
 * Then the ways out the refusal names, each run for real: the row is undone,
 * the same match books once and the ledger agrees.
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts),
 * the session door's cookie auth, and the invoice PDF rendering and upload.
 */
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies, generateApiKey } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { issueAndBookInvoice, type IssuableInvoice } from '@/lib/invoices/issue-and-book-invoice'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { categorizeTransaction } from '@/lib/transactions/categorize-core'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { unlinkReconciliation } from '@/lib/reconciliation/bank-reconciliation'
import type { CompanySettings, PendingOperation } from '@/types'
import { POST as matchInvoiceRoute } from '@/app/api/transactions/[id]/match-invoice/route'
import { POST as uncategorizeRoute } from '@/app/api/transactions/[id]/uncategorize/route'
import { POST as v1MatchInvoiceRoute } from '@/app/api/v1/companies/[companyId]/transactions/[id]/match-invoice/route'
import { insertCashAccount, insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'
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
const AMOUNT = 1500
const BANK_DATE = '2026-03-10'
const DOORS = ['session', 'v1', 'staged'] as const
type Door = (typeof DOORS)[number]

interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  customer: string
  cash: string
  apiKey: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

async function seed(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, entity_type, accounting_method, vat_registered, vat_number, company_name, org_number, bankgiro)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true, 'SE556677889901', 'Konsultbolaget AB', '556677-8899', '5050-1055')`,
    [userId, companyId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.customers (user_id, company_id, name, customer_type, country, vat_number, org_number)
     VALUES ($1, $2, 'Kund AB', 'swedish_business', 'SE', 'SE559900123401', '559900-1234') RETURNING id::text AS id`,
    [userId, companyId],
  )
  const cash = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK', isPrimary: true })
  for (const [number, name, cls, type, normal] of [
    ['1930', 'Bank', 1, 'asset', 'debit'],
    ['1510', 'Kundfordringar', 1, 'asset', 'debit'],
    ['3001', 'Försäljning', 3, 'revenue', 'credit'],
    ['3740', 'Öresavrundning', 3, 'revenue', 'credit'],
    ['2611', 'Utgående moms', 2, 'liability', 'credit'],
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
    [userId, companyId, key.hash, key.prefix, ['invoices:read', 'invoices:write', 'transactions:read', 'transactions:write']],
  )
  session.userId = userId
  session.companyId = companyId
  return { userId, companyId, fiscalPeriodId, customer: rows[0]!.id, cash, apiKey: key.key, supabase: createServiceClientNoCookies() }
}

async function stage(s: Seed, type: string, params: Record<string, unknown>): Promise<PendingOperation> {
  const { rows } = await getPool().query(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [s.userId, s.companyId, type, type, JSON.stringify(params)],
  )
  return rows[0] as PendingOperation
}

function approve(s: Seed, op: PendingOperation) {
  return runWithActor({ type: 'user' }, () =>
    commitPendingOperation(s.supabase, s.userId, s.companyId, op, { commitMethod: 'user_accept', actor: { type: 'user' } }),
  )
}

/** A sent invoice of 1500 kr incl. moms, booked at issue, its PDF on the verifikat. */
async function sentInvoice(s: Seed): Promise<{ id: string; journalEntryId: string }> {
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
  const journalEntryId = issued.journalEntryId as string
  await getPool().query(
    `INSERT INTO public.document_attachments
       (user_id, company_id, uploaded_by, upload_source, storage_path, file_name, file_size_bytes, mime_type, sha256_hash, journal_entry_id)
     VALUES ($1, $2, $1, 'system', $3, 'faktura.pdf', 1024, 'application/pdf', $4, $5)`,
    [s.userId, s.companyId, `${s.companyId}/${id}.pdf`, 'a'.repeat(64), journalEntryId],
  )
  return { id, journalEntryId }
}

function independentEntry(s: Seed, amount: number = AMOUNT) {
  return insertPostedJournalEntry({
    userId: s.userId,
    companyId: s.companyId,
    fiscalPeriodId: s.fiscalPeriodId,
    entryDate: BANK_DATE,
    description: 'Oberoende verifikat',
    lines: [
      { accountNumber: '1930', debitAmount: amount, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: amount },
    ],
  })
}

type Shape = 'free' | 'stale_pointer' | 'link_only' | 'reconciliation' | 'own_booking' | 'other_pointer' | 'ignored'

/** A 1500 kr row in the given shape. `entry`: the verifikat that books it, when one does. */
async function bankRow(s: Seed, shape: Shape): Promise<{ tx: string; entry: string | null }> {
  if (shape === 'own_booking') {
    const tx = await insertTransaction({ companyId: s.companyId, userId: s.userId, date: BANK_DATE, amount: AMOUNT, cashAccountId: s.cash })
    const categorized = await runWithActor({ type: 'user' }, () =>
      categorizeTransaction(s.supabase, s.userId, s.companyId, tx, { is_business: true, category: 'income_other' }, {
        onBooked: 'refuse',
        invoiceMatchIntercept: false,
      }),
    )
    expect(categorized.ok, JSON.stringify(categorized)).toBe(true)
    const { rows } = await getPool().query<{ journal_entry_id: string }>(`SELECT journal_entry_id FROM public.transactions WHERE id = $1`, [tx])
    return { tx, entry: rows[0]!.journal_entry_id }
  }
  const booked = shape !== 'free' && shape !== 'ignored'
  const entry = booked ? await independentEntry(s) : null
  const tx = await insertTransaction({
    companyId: s.companyId,
    userId: s.userId,
    date: BANK_DATE,
    amount: AMOUNT,
    cashAccountId: s.cash,
    isIgnored: shape === 'ignored',
    journalEntryId: shape === 'link_only' ? null : entry,
  })
  if (booked) await getPool().query(`UPDATE public.transactions SET is_business = true WHERE id = $1`, [tx])
  if (shape === 'link_only') {
    await getPool().query(
      `INSERT INTO public.transaction_voucher_links (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
       VALUES ($1, $2, $3, $4, $5, $6, 'bank_line')`,
      [randomUUID(), s.userId, s.companyId, tx, entry, AMOUNT],
    )
  }
  if (shape === 'reconciliation') {
    await getPool().query(`UPDATE public.transactions SET reconciliation_method = 'manual' WHERE id = $1`, [tx])
  }
  if (shape === 'stale_pointer') {
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [entry])
  }
  return { tx, entry }
}

let idempotency = 0
/** One match through one door: the answer's HTTP status or result, and its code. */
async function match(s: Seed, door: Door, tx: string, invoiceId: string): Promise<{ ok: boolean; status: number; code: string | null; body: unknown }> {
  const body = JSON.stringify({ invoice_id: invoiceId })
  if (door === 'staged') {
    const result = await approve(s, await stage(s, 'match_transaction_invoice', { transaction_id: tx, invoice_id: invoiceId }))
    const ok = (result as { status: string }).status === 'committed'
    return {
      ok,
      status: (result as { http_status?: number }).http_status ?? (ok ? 200 : 500),
      code: (result as { code?: string }).code ?? null,
      body: result,
    }
  }
  const response = await runWithActor({ type: 'user' }, () =>
    door === 'session'
      ? matchInvoiceRoute(
          new Request(`http://localhost/api/transactions/${tx}/match-invoice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          }),
          { params: Promise.resolve({ id: tx }) },
        )
      : v1MatchInvoiceRoute(
          new Request(`http://localhost/api/v1/companies/${s.companyId}/transactions/${tx}/match-invoice`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${s.apiKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': `pg-${Date.now()}-${++idempotency}`,
            },
            body,
          }),
          { params: Promise.resolve({ companyId: s.companyId, id: tx }) },
        ),
  )
  const parsed = (await response.json()) as { error?: { code?: string } }
  return { ok: response.ok, status: response.status, code: parsed.error?.code ?? null, body: parsed }
}

/** What the bank account moved after the sale: posted and reversed legs both count, as the ledger nets them. */
async function bankMovement(s: Seed): Promise<number> {
  const { rows } = await getPool().query<{ net: string }>(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0) AS net
     FROM public.journal_entry_lines l JOIN public.journal_entries e ON e.id = l.journal_entry_id
     WHERE e.company_id = $1 AND e.status IN ('posted', 'reversed') AND l.account_number = '1930'`,
    [s.companyId],
  )
  return Number(rows[0]!.net)
}

async function snapshot(s: Seed, tx: string, invoiceId: string) {
  const row = (
    await getPool().query(
      `SELECT journal_entry_id, invoice_id, is_ignored, reconciliation_method FROM public.transactions WHERE id = $1`,
      [tx],
    )
  ).rows[0]
  const entries = (
    await getPool().query(`SELECT id, status FROM public.journal_entries WHERE company_id = $1 ORDER BY created_at, id`, [s.companyId])
  ).rows
  const invoice = (await getPool().query(`SELECT status, paid_amount, remaining_amount FROM public.invoices WHERE id = $1`, [invoiceId])).rows[0]
  const payments = (await getPool().query(`SELECT count(*)::int AS n FROM public.invoice_payments WHERE invoice_id = $1`, [invoiceId])).rows[0].n
  return { row, entries, invoice, payments, bank: await bankMovement(s) }
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe.each(DOORS)('a customer match through the %s door', (door) => {
  it.each(['link_only', 'reconciliation', 'own_booking', 'other_pointer'] as const)(
    'refuses a booked row (%s): nothing is written and the bank moves once',
    { timeout: 60_000 },
    async (shape) => {
      const s = await seed()
      const invoice = await sentInvoice(s)
      const { tx, entry } = await bankRow(s, shape)
      const before = await snapshot(s, tx, invoice.id)
      expect(before.bank).toBe(AMOUNT)

      const answer = await match(s, door, tx, invoice.id)

      expect(answer.ok, JSON.stringify(answer)).toBe(false)
      expect(answer.code).toBe('MATCH_INVOICE_TX_ALREADY_BOOKED')
      expect(await snapshot(s, tx, invoice.id)).toEqual(before)
      const status = (await getPool().query(`SELECT status FROM public.journal_entries WHERE id = $1`, [entry])).rows[0].status
      expect(status).toBe('posted')
    },
  )

  it('refuses an ignored row before anything posts', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx } = await bankRow(s, 'ignored')
    const before = await snapshot(s, tx, invoice.id)

    const answer = await match(s, door, tx, invoice.id)

    expect(answer.ok, JSON.stringify(answer)).toBe(false)
    expect(answer.code).toBe('BANK_ROW_IGNORED')
    expect(await snapshot(s, tx, invoice.id)).toEqual(before)
  })

  it.each(['free', 'stale_pointer'] as const)(
    'books a %s row once, with the same audit row and underlag on every door',
    { timeout: 60_000 },
    async (shape) => {
      const s = await seed()
      const invoice = await sentInvoice(s)
      const { tx } = await bankRow(s, shape)
      const start = await bankMovement(s)

      const answer = await match(s, door, tx, invoice.id)

      expect(answer.ok, JSON.stringify(answer)).toBe(true)
      const after = await snapshot(s, tx, invoice.id)
      expect(after.bank - start).toBe(AMOUNT)
      expect(after.invoice.status).toBe('paid')
      expect(after.payments).toBe(1)
      expect(after.row.invoice_id).toBe(invoice.id)
      const payment = after.row.journal_entry_id as string
      const paymentEntry = (await getPool().query(`SELECT source_type, status FROM public.journal_entries WHERE id = $1`, [payment])).rows[0]
      expect(paymentEntry).toEqual({ source_type: 'invoice_paid', status: 'posted' })

      const logged = (
        await getPool().query(
          `SELECT action, match_method, invoice_id FROM public.payment_match_log WHERE transaction_id = $1 AND action = 'matched'`,
          [tx],
        )
      ).rows
      expect(logged).toEqual([{ action: 'matched', match_method: 'manual_confirm', invoice_id: invoice.id }])
      const underlag = (
        await getPool().query(`SELECT file_name FROM public.document_attachments WHERE journal_entry_id = $1`, [payment])
      ).rows
      expect(underlag).toEqual([{ file_name: 'faktura.pdf' }])
    },
  )

  it('keeps the row\'s own category, never a guessed one', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx } = await bankRow(s, 'free')
    await getPool().query(`UPDATE public.transactions SET category = 'income_products' WHERE id = $1`, [tx])

    const answer = await match(s, door, tx, invoice.id)

    expect(answer.ok, JSON.stringify(answer)).toBe(true)
    const { rows } = await getPool().query(`SELECT category FROM public.transactions WHERE id = $1`, [tx])
    expect(rows[0].category).toBe('income_products')
  })

  it('refuses an invoice with an active credit note', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx } = await bankRow(s, 'free')
    await getPool().query(
      `INSERT INTO public.invoices
         (user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency, subtotal, vat_amount, total, credited_invoice_id, creation_complete)
       SELECT user_id, company_id, customer_id, invoice_number || '-K', invoice_date, due_date, 'draft', currency, -subtotal, -vat_amount, -total, id, true
       FROM public.invoices WHERE id = $1`,
      [invoice.id],
    )
    const before = await snapshot(s, tx, invoice.id)

    const answer = await match(s, door, tx, invoice.id)

    expect(answer.ok, JSON.stringify(answer)).toBe(false)
    expect(answer.code).toBe('MATCH_INVOICE_CREDIT_NOTE')
    expect(await snapshot(s, tx, invoice.id)).toEqual(before)
  })

  it('refuses a sent invoice that already carries a payment verifikat', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const paid = await bankRow(s, 'free')
    const first = await match(s, door, paid.tx, invoice.id)
    expect(first.ok, JSON.stringify(first)).toBe(true)
    // The status leak the guard exists for: the invoice reads open again.
    await getPool().query(`UPDATE public.invoices SET status = 'sent', paid_at = null, paid_amount = 0, remaining_amount = total WHERE id = $1`, [invoice.id])
    const { tx } = await bankRow(s, 'free')
    const before = await snapshot(s, tx, invoice.id)

    const answer = await match(s, door, tx, invoice.id)

    expect(answer.ok, JSON.stringify(answer)).toBe(false)
    expect(answer.code).toBe('MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER')
    expect(await snapshot(s, tx, invoice.id)).toEqual(before)
  })
})

describe('a match that stops after the verifikat posted', () => {
  it.each(DOORS)('%s: a payment row that cannot land undoes the invoice and the row and cancels the verifikat', { timeout: 60_000 }, async (door) => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx } = await bankRow(s, 'free')
    // The unique (transaction_id, invoice_id): the row already pays this
    // invoice by a line with no verifikat, which the hard guard does not read.
    await getPool().query(
      `INSERT INTO public.invoice_payments (user_id, company_id, invoice_id, payment_date, amount, currency, transaction_id)
       VALUES ($1, $2, $3, $4, 1, 'SEK', $5)`,
      [s.userId, s.companyId, invoice.id, BANK_DATE, tx],
    )
    const before = await snapshot(s, tx, invoice.id)

    const answer = await match(s, door, tx, invoice.id)

    expect(answer.ok, JSON.stringify(answer)).toBe(false)
    expect(answer.code).toBe('MATCH_INVOICE_DUPLICATE_PAYMENT')
    const after = await snapshot(s, tx, invoice.id)
    expect(after.row).toEqual(before.row)
    expect(after.invoice).toEqual(before.invoice)
    expect(after.bank).toBe(before.bank)
    const added = after.entries.filter((e: { id: string }) => !before.entries.some((b: { id: string }) => b.id === e.id))
    expect(added.map((e: { status: string }) => e.status)).toEqual(['cancelled'])
    // The cancelled number is documented: no unexplained gap in the series.
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.voucher_gap_explanations WHERE company_id = $1`, [s.companyId])
    expect(rows[0].n).toBe(1)
  })
})

describe('the ways out the refusal names', () => {
  it('own booking: undone through uncategorize, the same match books once and the bank moves once', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx, entry } = await bankRow(s, 'own_booking')
    const start = await bankMovement(s)

    const undo = await runWithActor({ type: 'user' }, () =>
      uncategorizeRoute(new Request(`http://localhost/api/transactions/${tx}/uncategorize`, { method: 'POST' }), {
        params: Promise.resolve({ id: tx }),
      }),
    )
    expect(undo.status).toBe(200)

    const answer = await match(s, 'session', tx, invoice.id)
    expect(answer.ok, JSON.stringify(answer)).toBe(true)
    expect((await getPool().query(`SELECT status FROM public.journal_entries WHERE id = $1`, [entry])).rows[0].status).toBe('reversed')
    expect((await bankMovement(s)) - start).toBe(0)
    expect((await snapshot(s, tx, invoice.id)).invoice.status).toBe('paid')
  })

  it('own booking: the agent stages the undo, approves it, then the match', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx, entry } = await bankRow(s, 'own_booking')
    const start = await bankMovement(s)

    const undo = await approve(s, await stage(s, 'uncategorize_transaction', { transaction_id: tx, journal_entry_id: entry }))
    expect((undo as { status: string }).status, JSON.stringify(undo)).toBe('committed')

    const answer = await match(s, 'staged', tx, invoice.id)
    expect(answer.ok, JSON.stringify(answer)).toBe(true)
    expect((await bankMovement(s)) - start).toBe(0)
  })

  it('reconciliation link: koppla bort leaves the verifikat posted, and the soft guard then names it', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx, entry } = await bankRow(s, 'reconciliation')

    const unlinked = await unlinkReconciliation(s.supabase, s.companyId, tx, s.userId)
    expect(unlinked.success, JSON.stringify(unlinked)).toBe(true)
    expect((await getPool().query(`SELECT status FROM public.journal_entries WHERE id = $1`, [entry])).rows[0].status).toBe('posted')

    // The verifikat still books the money, so the row opens but a second
    // booking is the person's explicit choice, bound to that verifikat.
    const answer = await match(s, 'session', tx, invoice.id)
    expect(answer.code).toBe('MATCH_INVOICE_POSSIBLE_DUPLICATE')
    expect((answer.body as { error: { details: { candidate: { journal_entry_id: string } } } }).error.details.candidate.journal_entry_id).toBe(entry)
  })

  it('a verifikat booked elsewhere: uncategorize undoes it, and the same match books once', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx, entry } = await bankRow(s, 'other_pointer')
    const start = await bankMovement(s)

    const undo = await runWithActor({ type: 'user' }, () =>
      uncategorizeRoute(new Request(`http://localhost/api/transactions/${tx}/uncategorize`, { method: 'POST' }), {
        params: Promise.resolve({ id: tx }),
      }),
    )
    expect(undo.status).toBe(200)

    const answer = await match(s, 'session', tx, invoice.id)
    expect(answer.ok, JSON.stringify(answer)).toBe(true)
    expect((await getPool().query(`SELECT status FROM public.journal_entries WHERE id = $1`, [entry])).rows[0].status).toBe('reversed')
    expect((await bankMovement(s)) - start).toBe(0)
  })

  it('an ignored row: restored, the same match books once', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx } = await bankRow(s, 'ignored')
    const start = await bankMovement(s)

    await getPool().query(`UPDATE public.transactions SET is_ignored = false WHERE id = $1`, [tx])

    const answer = await match(s, 'session', tx, invoice.id)
    expect(answer.ok, JSON.stringify(answer)).toBe(true)
    expect((await bankMovement(s)) - start).toBe(AMOUNT)
  })

  it('a samlingsverifikat: uncategorize cannot reach the row, a storno of the verifikat releases it', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx, entry } = await bankRow(s, 'link_only')
    const start = await bankMovement(s)

    const undo = await runWithActor({ type: 'user' }, () =>
      uncategorizeRoute(new Request(`http://localhost/api/transactions/${tx}/uncategorize`, { method: 'POST' }), {
        params: Promise.resolve({ id: tx }),
      }),
    )
    expect(undo.status).toBe(400)

    await runWithActor({ type: 'user' }, () => reverseEntry(s.supabase, s.companyId, s.userId, entry as string))
    const answer = await match(s, 'session', tx, invoice.id)
    expect(answer.ok, JSON.stringify(answer)).toBe(true)
    expect((await bankMovement(s)) - start).toBe(0)
  })
})

describe('match_batch_allocate reads the same anchors', () => {
  async function allocate(s: Seed, tx: string, invoiceId: string) {
    const { data, error } = await s.supabase.rpc('match_batch_allocate', {
      p_tx_id: tx,
      p_allocations: [{ kind: 'customer_invoice', invoice_id: invoiceId, amount: AMOUNT }],
      p_company_id: s.companyId,
      p_user_id: s.userId,
    })
    expect(error).toBeNull()
    return data as { ok: boolean; code?: string; journal_entry_id?: string }
  }

  it('books a stale pointer once and takes its method off: the payment is no link Koppla bort can free', { timeout: 60_000 }, async () => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx } = await bankRow(s, 'stale_pointer')
    await getPool().query(`UPDATE public.transactions SET reconciliation_method = 'auto_exact' WHERE id = $1`, [tx])
    const start = await bankMovement(s)

    const booked = await allocate(s, tx, invoice.id)

    expect(booked.ok).toBe(true)
    const { rows } = await getPool().query(
      `SELECT journal_entry_id, reconciliation_method, is_business FROM public.transactions WHERE id = $1`,
      [tx],
    )
    expect(rows[0]).toEqual({ journal_entry_id: booked.journal_entry_id, reconciliation_method: null, is_business: true })
    expect(await bankMovement(s)).toBe(start + AMOUNT)

    const unlinked = await unlinkReconciliation(s.supabase, s.companyId, tx, s.userId)
    expect(unlinked.success).toBe(false)

    const second = await runWithActor({ type: 'user' }, () =>
      categorizeTransaction(s.supabase, s.userId, s.companyId, tx, { is_business: true, category: 'income_other' }, {
        onBooked: 'refuse',
        invoiceMatchIntercept: false,
      }),
    )
    expect(second).toMatchObject({ ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED' })
    expect(await bankMovement(s)).toBe(start + AMOUNT)
  })

  it.each([
    ['link_only', 'BATCH_TX_ALREADY_BOOKED'],
    ['reconciliation', 'BATCH_TX_ALREADY_BOOKED'],
    ['ignored', 'BANK_ROW_IGNORED'],
  ] as const)('refuses a %s row in the RPC itself', { timeout: 60_000 }, async (shape, code) => {
    const s = await seed()
    const invoice = await sentInvoice(s)
    const { tx } = await bankRow(s, shape)
    const before = await snapshot(s, tx, invoice.id)

    const result = await allocate(s, tx, invoice.id)

    expect(result.ok).toBe(false)
    expect(result.code).toBe(code)
    expect(await snapshot(s, tx, invoice.id)).toEqual(before)
  })
})
