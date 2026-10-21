/**
 * Posting port, step 2i: proof that booking output does not change when the
 * ledger's own doors move onto the port: manual vouchers, storno and
 * corrections, the owner's reopen of a closed year, the sandbox seed and the
 * reconciliation residual.
 *
 * Each producer is driven through its real door on a freshly seeded company:
 * the dashboard voucher form (a voucher posted, a draft saved and then posted
 * from the draft list, a momsredovisning from its template), the v1 voucher
 * API on an API key (a draft then its commit, batch-create then a commit
 * per draft), the staged create_voucher approval (and one whose inbox claim
 * is refused, so its voucher is reversed), the storno door on the dashboard,
 * v1 and as a staged approval, the correction door on all three, the move of
 * a verifikat to the year before (recordate) on all three, the
 * momsdeklaration's basis fix, the reconciliation worksheet's residual, the
 * owner's reopen of a year closed with a bokslut (its own company) and the
 * sandbox seed of an anonymous visitor (its own company, on a fixed clock).
 * Every verifikat a door writes is dumped normalised (series, number, date,
 * description, source type, status and every line, in account order so a
 * storno that reads its original through an unordered embed compares as a
 * set) together with what the doors write beside them (bank lines and their
 * voucher links, inbox items, the reopened year), and the dump is compared
 * with the committed fixture (posting-parity-ledger.fixture.json), which was
 * taken before these doors went through the port. A flow's setup (the
 * verifikat it reverses or corrects) is not part of its dump.
 *
 * With the doors on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every verifikat a door wrote has exactly ONE event linked: a voucher
 *      the kind its source type names (ledger.manual, vat.settled,
 *      sale.webshop_order), a storno ledger.storno (role reversal) of the
 *      verifikat reversed, the corrected verifikat of a rättelse
 *      ledger.correction (role correction) of the verifikat corrected, the
 *      reopen's stornos ledger.storno of the year, the residual ledger.manual
 *      of its bank line and every sandbox verifikat ledger.system; each with
 *      the door's link basis (user_created on the dashboard, client_asserted
 *      on a key, agent_proposed_user_approved with the operation for a staged
 *      approval, system_derived for a compensation and the seed), and each
 *      naming the actor its verifikat names;
 *   3. a failed event or link write under shadow still books; under strict
 *      every door stops before a voucher number is drawn; a correction link
 *      refused under strict after the storno is numbered cancels the
 *      corrected draft and the posted storno, which keeps its number; and
 *      detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-ledger.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test); the session doors' cookie auth, replaced by the signed-in user on
 * the service-role client (the reopen and the sandbox seed run on an
 * authenticated client as their database functions require); the sandbox
 * seed's rate limit, agent profile, personnummer key, tax table download and
 * payroll configuration, as in its route test. The v1 doors run on a real API
 * key.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies, generateApiKey } from '@/lib/auth/api-keys'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import type { PendingOperation } from '@/types'
import { POST as createVoucherRoute } from '@/app/api/bookkeeping/journal-entries/route'
import { POST as commitRoute } from '@/app/api/bookkeeping/journal-entries/[id]/commit/route'
import { POST as reverseRoute } from '@/app/api/bookkeeping/journal-entries/[id]/reverse/route'
import { POST as correctRoute } from '@/app/api/bookkeeping/journal-entries/[id]/correct/route'
import { POST as recordateRoute } from '@/app/api/bookkeeping/journal-entries/[id]/recordate/route'
import { POST as reopenRoute } from '@/app/api/bookkeeping/fiscal-periods/[id]/reopen/route'
import { POST as rcFixRoute } from '@/app/api/reports/vat-declaration/rc-basis-gaps/fix/route'
import { POST as residualRoute } from '@/app/api/reconciliation/accounts/[accountKey]/residual/route'
import { POST as sandboxSeedRoute } from '@/app/api/sandbox/seed/route'
import { POST as v1CreateRoute } from '@/app/api/v1/companies/[companyId]/journal-entries/route'
import { POST as v1BatchRoute } from '@/app/api/v1/companies/[companyId]/journal-entries/batch-create/route'
import { POST as v1CommitRoute } from '@/app/api/v1/companies/[companyId]/journal-entries/[id]/commit/route'
import { POST as v1ReverseRoute } from '@/app/api/v1/companies/[companyId]/journal-entries/[id]/reverse/route'
import { POST as v1CorrectRoute } from '@/app/api/v1/companies/[companyId]/journal-entries/[id]/correct/route'
import { POST as v1RedateRoute } from '@/app/api/v1/companies/[companyId]/journal-entries/[id]/redate/route'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  seedCompany,
  setActiveCompany,
} from './fixtures'
import { getPool } from './setup'
import { createPgRest, type PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))
/**
 * Who the session doors run as: the seeded owner of the seeded company, on
 * the service-role client, or on `client` when a flow needs an authenticated
 * one (the reopen and the sandbox seed check auth.uid() in the database).
 */
const session = vi.hoisted(() => ({ userId: '', companyId: '', anonymous: false, client: null as unknown }))

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
    requireAuth: async () => ({
      user: { id: session.userId, is_anonymous: session.anonymous },
      supabase: session.client ?? client(),
      error: null,
    }),
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
// The reopen gate reads the TIC snapshot the flow writes; nothing is fetched.
vi.mock('@/lib/agent/composer/tic-fetch', () => ({ ensureTicSnapshot: async () => undefined }))
// The sandbox seed's outside world, as in its route test.
vi.mock('@/lib/auth/rate-limit-http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/rate-limit-http')>()),
  checkRateLimit: async () => ({ ok: true }),
}))
vi.mock('@/lib/sandbox/ensure-agent', () => ({ ensureSandboxAgentProfile: async () => undefined }))
vi.mock('@/lib/salary/personnummer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/personnummer')>()),
  encryptPersonnummer: (value: string) => `encrypted:${value}`,
  decryptPersonnummer: (value: string) => value.replace(/^encrypted:/, ''),
}))
vi.mock('@/lib/salary/payroll-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payroll-config')>()),
  loadPayrollConfig: async (_db: unknown, year: number) => ({
    configYear: year,
    avgifterTotal: 0.3142,
    avgifterReduced65plus: 0.1021,
    avgifterYouthRate: 0.2081,
    avgifterYouthSalaryCap: 25000,
    avgifterVaxaStodRate: 0.1021,
    avgifterVaxaStodCap: 35000,
    reducedAvgiftAge: 67,
    slpRate: 0.2426,
    sjuklonRate: 0.8,
    karensavdragFactor: 0.2,
  }),
}))
vi.mock('@/lib/salary/tax-tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/tax-tables')>()),
  fetchTaxTableRates: async (year: number, tableNumber: number, column: number) => ({
    rates: [{ tableYear: year, tableNumber, columnNumber: column, incomeFrom: 0, incomeTo: 9999999, kind: 'amount', taxAmount: 5000 }],
    source: 'fallback',
  }),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  session.client = null
  session.anonymous = false
  const unsupported = [...(shim.rest?.unsupported.splice(0) ?? []), ...authenticatedShims.flatMap((s) => s.unsupported.splice(0))]
  expect(unsupported).toEqual([])
})

const FIXTURE = path.join(__dirname, 'posting-parity-ledger.fixture.json')
const V1_SCOPES = ['bookkeeping:read', 'bookkeeping:write']

/** An aktiebolag under faktureringsmetoden with 2025 and 2026 open, a bank account and an API key. */
interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  period2025: string
  cashAccountId: string
  apiKey: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow's setup made: the records its door acts on. */
interface Prepared {
  entryIds?: string[]
  transactionIds?: string[]
  inboxItemIds?: string[]
  documentIds?: string[]
  /** A flow that books in a company of its own (the reopen, the sandbox seed). */
  companyId?: string
  /** The year a reopen reopens. */
  periodId?: string
  /** Undone after the door ran (a refusing trigger). */
  restore?: () => Promise<void>
  /** The staged operations the flow approved. */
  opIds?: string[]
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  setup?: (seed: Seed) => Promise<Prepared>
  /** Answers the ids of what the door made that a later flow or check needs (the staged operation). */
  run: (seed: Seed, prepared: Prepared) => Promise<void>
}

const authenticatedShims: PgRest[] = []

/** A supabase client that runs every request as `userId` (role authenticated), as a cookie session does. */
function authenticatedClient(userId: string, claims?: Record<string, unknown>): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId, claims })
  authenticatedShims.push(rest)
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: rest.fetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

type Line = [account: string, debit: number, credit: number]

function lines(rows: Line[], text?: Record<string, string>) {
  return rows.map(([account_number, debit_amount, credit_amount]) => ({
    account_number,
    debit_amount,
    credit_amount,
    ...(text?.[account_number] ? { line_description: text[account_number] } : {}),
  }))
}

const OFFICE: Line[] = [
  ['6110', 400, 0],
  ['2641', 100, 0],
  ['1930', 0, 500],
]
const SCREEN: Line[] = [
  ['5410', 400, 0],
  ['2641', 100, 0],
  ['1930', 0, 500],
]

/** A verifikat the flows act on, posted through the engine directly and never dumped. */
async function postSetupEntry(seed: Seed, entryDate: string, description: string, rows: Line[], extra: { notes?: string } = {}): Promise<string> {
  const entry = await createJournalEntry(seed.supabase, seed.companyId, seed.userId, {
    fiscal_period_id: entryDate.startsWith('2025') ? seed.period2025 : seed.fiscalPeriodId,
    entry_date: entryDate,
    description,
    source_type: 'manual',
    ...extra,
    lines: rows.map(([account_number, debit_amount, credit_amount]) => ({
      account_number,
      debit_amount,
      credit_amount,
      dimensions: account_number === '6110' || account_number === '6540' ? { '1': 'BUTIK' } : undefined,
    })),
  })
  return entry.id
}

function sessionRequest(pathname: string, body?: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

let idempotency = 0

function v1Request(seed: Seed, pathname: string, body?: unknown): Request {
  return new Request(`http://localhost/api/v1/companies/${seed.companyId}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${seed.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `pg-parity-ledger-${Date.now()}-${++idempotency}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function expectStatus(response: Response, status: number, code?: string): Promise<string> {
  const text = await response.text()
  expect(response.status, text).toBe(status)
  if (code) expect(text).toContain(code)
  return text
}

function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) }
}

/** The dashboard voucher form's door (POST /api/bookkeeping/journal-entries). */
const createRoute = (request: Request) => createVoucherRoute(request, params({}))

/** Every staged operation approved, in order (runFlows hands each flow its own). */
const approvals: string[] = []

/** A pending operation as the MCP staging door leaves it, approved by the owner in the app. */
async function approve(seed: Seed, type: string, opParams: Record<string, unknown>): Promise<{ id: string; status: string }> {
  const id = randomUUID()
  approvals.push(id)
  await getPool().query(
    `INSERT INTO public.pending_operations (id, user_id, company_id, operation_type, status, title, params, preview_data, actor_type, actor_label, risk_level)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, '{}'::jsonb, 'api_key', 'Bokföringsagent', 'high')`,
    [id, seed.userId, seed.companyId, type, `pg parity ${type}`, JSON.stringify(opParams)],
  )
  const { rows } = await getPool().query<PendingOperation>(`SELECT * FROM public.pending_operations WHERE id = $1`, [id])
  const result = await commitPendingOperation(seed.supabase, seed.userId, seed.companyId, rows[0]!, {
    commitMethod: 'user_accept',
    actor: { type: 'user' },
  })
  return { id, status: result.status }
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
    [id, seed.companyId, seed.userId, documentId, JSON.stringify({ documentKind: 'receipt', totals: { total: 500 }, invoice: { currency: 'SEK' } })],
  )
  return id
}

/** A trigger refusing one update, undone by the returned function. */
async function refuseUpdate(table: 'invoice_inbox_items', condition: string): Promise<() => Promise<void>> {
  const fn = `pg_test_ledger_refuse_${randomUUID().replace(/-/g, '')}`
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

/** A bank line on the seeded bank account, as the feed leaves it. */
async function insertRow(seed: Seed, row: { date: string; description: string; amount: number }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions (id, company_id, user_id, date, description, amount, currency, category, cash_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'SEK', 'uncategorized', $7)`,
    [id, seed.companyId, seed.userId, row.date, row.description, row.amount, seed.cashAccountId],
  )
  return id
}

async function createdId(response: Response, status: number): Promise<string> {
  const body = JSON.parse(await expectStatus(response, status)) as { data: { id: string } }
  return body.data.id
}

const ORG = '5560125790'

/**
 * A company of its own whose 2025 is closed with a bokslut, 2026 holds the
 * IB and the 2099 -> 2098 omföring, as tests/pg/fiscal-year-reopen.pg.test.ts
 * seeds it, with nothing registered at Bolagsverket.
 */
async function seedClosedYear(): Promise<Prepared & { ownerId: string }> {
  const ownerId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  await setActiveCompany(ownerId, companyId)
  await getPool().query(
    `UPDATE public.companies SET org_number = $2, tic_snapshot = $3::jsonb, tic_snapshot_fetched_at = now() WHERE id = $1`,
    [companyId, ORG, JSON.stringify({ orgNumber: ORG, financialReports: [], financialReportsComplete: true })],
  )
  const closedId = await insertFiscalPeriod({ userId: ownerId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
  const nextId = await insertFiscalPeriod({ userId: ownerId, companyId, name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' })
  await getPool().query(`UPDATE public.fiscal_periods SET previous_period_id = $2 WHERE id = $1`, [nextId, closedId])
  // The kontoplan the stornos book on.
  await getPool().query(`SELECT public.seed_chart_of_accounts($1, 'aktiebolag')`, [companyId])
  await getPool().query(
    `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
     VALUES ($1, $2, '2098', 'Vinst eller förlust från föregående år', 2, '20', 'equity', 'credit', 'k1', false)
     ON CONFLICT DO NOTHING`,
    [ownerId, companyId],
  )
  const closingId = await insertPostedJournalEntry({
    userId: ownerId,
    companyId,
    fiscalPeriodId: closedId,
    entryDate: '2025-12-31',
    description: 'Årsbokslut 2025',
    sourceType: 'year_end',
    voucherNumber: 9001,
    lines: [
      { accountNumber: '3001', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2099', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  await getPool().query(
    `UPDATE public.fiscal_periods SET closing_entry_id = $2, locked_at = now(), is_closed = true, closed_at = now() WHERE id = $1`,
    [closedId, closingId],
  )
  const ibId = await insertPostedJournalEntry({
    userId: ownerId,
    companyId,
    fiscalPeriodId: nextId,
    entryDate: '2026-01-01',
    description: 'Ingående balans 2026',
    sourceType: 'opening_balance',
    voucherNumber: 9001,
    lines: [
      { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2099', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  await getPool().query(
    `UPDATE public.fiscal_periods SET opening_balance_entry_id = $2, opening_balances_set = true, continuity_verified = true WHERE id = $1`,
    [nextId, ibId],
  )
  await insertPostedJournalEntry({
    userId: ownerId,
    companyId,
    fiscalPeriodId: nextId,
    entryDate: '2026-01-01',
    description: 'Omföring av föregående års resultat',
    sourceType: 'result_appropriation',
    voucherNumber: 9002,
    lines: [
      { accountNumber: '2099', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2098', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  return { ownerId, companyId, periodId: closedId }
}

const FLOWS: Flow[] = [
  {
    name: 'dashboard: a manual voucher posted from the form',
    run: async (seed) => {
      await expectStatus(
        await createRoute(
          sessionRequest('/api/bookkeeping/journal-entries', {
            fiscal_period_id: seed.fiscalPeriodId,
            entry_date: '2026-02-03',
            description: 'Kontorsmaterial, Clas Ohlson',
            notes: 'Kvitto i pärmen',
            lines: lines(OFFICE, { '6110': 'Pärmar' }),
          }),
        ),
        200,
      )
    },
  },
  {
    name: 'dashboard: a draft saved, then posted from the draft list',
    run: async (seed) => {
      const id = await createdId(
        await createRoute(
          sessionRequest('/api/bookkeeping/journal-entries?as_draft=true', {
            fiscal_period_id: seed.fiscalPeriodId,
            entry_date: '2026-02-04',
            description: 'Skärm till kontoret',
            voucher_series: 'B',
            lines: lines(SCREEN),
          }),
        ),
        200,
      )
      await expectStatus(await commitRoute(sessionRequest(`/api/bookkeeping/journal-entries/${id}/commit`), params({ id })), 200)
    },
  },
  {
    name: 'dashboard: a momsredovisning booked from its template',
    run: async (seed) => {
      await expectStatus(
        await createRoute(
          sessionRequest('/api/bookkeeping/journal-entries', {
            fiscal_period_id: seed.fiscalPeriodId,
            entry_date: '2026-02-12',
            description: 'Momsredovisning januari',
            source_type: 'vat_settlement',
            lines: lines([
              ['2611', 2500, 0],
              ['2641', 0, 900],
              ['2650', 0, 1600],
            ]),
          }),
        ),
        200,
      )
    },
  },
  {
    name: 'v1: a draft created on an API key, then committed',
    run: async (seed) => {
      const id = await createdId(
        await v1CreateRoute(
          v1Request(seed, '/journal-entries', {
            fiscal_period_id: seed.fiscalPeriodId,
            entry_date: '2026-02-05',
            description: 'Bankavgift februari',
            lines: lines([
              ['6570', 50, 0],
              ['1930', 0, 50],
            ]),
          }),
          params({ companyId: seed.companyId }),
        ),
        201,
      )
      await expectStatus(
        await v1CommitRoute(v1Request(seed, `/journal-entries/${id}/commit`), params({ companyId: seed.companyId, id })),
        200,
      )
    },
  },
  {
    name: 'v1: batch-create of a webshop order an integration labels and a manual voucher, each committed',
    run: async (seed) => {
      const text = await expectStatus(
        await v1BatchRoute(
          v1Request(seed, '/journal-entries/batch-create', {
            journal_entries: [
              {
                fiscal_period_id: seed.fiscalPeriodId,
                entry_date: '2026-01-15',
                description: 'Order 1001',
                source_type: 'webshop_order',
                lines: lines([
                  ['1510', 1250, 0],
                  ['3001', 0, 1000],
                  ['2611', 0, 250],
                ]),
              },
              {
                fiscal_period_id: seed.fiscalPeriodId,
                entry_date: '2026-02-06',
                description: 'Porto',
                lines: lines([
                  ['6250', 120, 0],
                  ['1930', 0, 120],
                ]),
              },
            ],
          }),
          params({ companyId: seed.companyId }),
        ),
        200,
      )
      const results = (JSON.parse(text) as { data: { results: Array<{ ok: boolean; data: { id: string } }> } }).data.results
      expect(results.every((r) => r.ok), text).toBe(true)
      for (const { data } of results) {
        await expectStatus(
          await v1CommitRoute(v1Request(seed, `/journal-entries/${data.id}/commit`), params({ companyId: seed.companyId, id: data.id })),
          200,
        )
      }
    },
  },
  {
    name: 'staged: create_voucher approved',
    run: async (seed) => {
      const op = await approve(seed, 'create_voucher', {
        entry_date: '2026-02-07',
        description: 'Skärm, agentens förslag',
        fiscal_period_id: seed.fiscalPeriodId,
        notes: 'Underlag mejlat',
        lines: lines(SCREEN),
      })
      expect(op.status).toBe('committed')
    },
  },
  {
    name: 'staged: create_voucher of a kvitto whose inbox claim is refused, so the voucher is reversed',
    setup: async (seed) => {
      const documentId = await insertDocument(seed, 'kvitto-ledger-1.pdf')
      const itemId = await insertInboxItem(seed, documentId)
      return {
        documentIds: [documentId],
        inboxItemIds: [itemId],
        restore: await refuseUpdate('invoice_inbox_items', `NEW.id = '${itemId}'`),
      }
    },
    run: async (seed, { inboxItemIds, documentIds }) => {
      const op = await approve(seed, 'create_voucher', {
        entry_date: '2026-02-08',
        description: 'Kvitto Clas Ohlson',
        fiscal_period_id: seed.fiscalPeriodId,
        inbox_item_id: inboxItemIds![0],
        document_id: documentIds![0],
        lines: lines(OFFICE),
      })
      expect(op.status).toBe('failed')
    },
  },
  {
    name: 'dashboard: a posted voucher reversed',
    setup: async (seed) => ({ entryIds: [await postSetupEntry(seed, '2026-02-10', 'Felbokad kontorsvara', OFFICE, { notes: 'Dubblett' })] }),
    run: async (_seed, { entryIds }) => {
      const id = entryIds![0]!
      await expectStatus(await reverseRoute(sessionRequest(`/api/bookkeeping/journal-entries/${id}/reverse`), params({ id })), 200)
    },
  },
  {
    name: 'v1: a posted voucher reversed on a later date in its year',
    setup: async (seed) => ({ entryIds: [await postSetupEntry(seed, '2026-02-11', 'Dubbelbokad bankavgift', [['6570', 50, 0], ['1930', 0, 50]])] }),
    run: async (seed, { entryIds }) => {
      const id = entryIds![0]!
      await expectStatus(
        await v1ReverseRoute(v1Request(seed, `/journal-entries/${id}/reverse`, { reversal_date: '2026-02-28' }), params({ companyId: seed.companyId, id })),
        200,
      )
    },
  },
  {
    name: 'staged: reverse_entry approved',
    setup: async (seed) => ({ entryIds: [await postSetupEntry(seed, '2026-02-13', 'Felbokad skärm', SCREEN)] }),
    run: async (seed, { entryIds }) => {
      const op = await approve(seed, 'reverse_entry', { entry_id: entryIds![0] })
      expect(op.status).toBe('committed')
    },
  },
  {
    name: 'dashboard: a posted voucher corrected with new lines and its own text',
    setup: async (seed) => ({ entryIds: [await postSetupEntry(seed, '2026-02-14', 'Kontorsmaterial', OFFICE, { notes: 'Kvitto i pärmen' })] }),
    run: async (_seed, { entryIds }) => {
      const id = entryIds![0]!
      await expectStatus(
        await correctRoute(
          sessionRequest(`/api/bookkeeping/journal-entries/${id}/correct`, {
            description: 'Rättelse: skärm, inte kontorsmaterial',
            lines: lines(SCREEN, { '5410': 'Skärm' }),
          }),
          params({ id }),
        ),
        200,
      )
    },
  },
  {
    name: 'v1: a posted voucher corrected',
    setup: async (seed) => ({ entryIds: [await postSetupEntry(seed, '2026-02-15', 'Bankavgift', [['6570', 50, 0], ['1930', 0, 50]])] }),
    run: async (seed, { entryIds }) => {
      const id = entryIds![0]!
      await expectStatus(
        await v1CorrectRoute(
          v1Request(seed, `/journal-entries/${id}/correct`, { lines: lines([['6064', 50, 0], ['1930', 0, 50]]) }),
          params({ companyId: seed.companyId, id }),
        ),
        200,
      )
    },
  },
  {
    name: 'staged: correct_entry approved',
    setup: async (seed) => ({ entryIds: [await postSetupEntry(seed, '2026-02-16', 'Skärm', SCREEN)] }),
    run: async (seed, { entryIds }) => {
      const op = await approve(seed, 'correct_entry', {
        entry_id: entryIds![0],
        description: 'Rättelse: inventarie',
        lines: lines([
          ['1220', 400, 0],
          ['2641', 100, 0],
          ['1930', 0, 500],
        ]),
      })
      expect(op.status).toBe('committed')
    },
  },
  {
    name: 'dashboard: a posted voucher moved to the year before (recordate)',
    setup: async (seed) => ({ entryIds: [await postSetupEntry(seed, '2026-02-17', 'Hyra december', [['5010', 8000, 0], ['1930', 0, 8000]])] }),
    run: async (_seed, { entryIds }) => {
      const id = entryIds![0]!
      await expectStatus(
        await recordateRoute(sessionRequest(`/api/bookkeeping/journal-entries/${id}/recordate`, { new_entry_date: '2025-12-17' }), params({ id })),
        200,
      )
    },
  },
  {
    name: 'v1: a posted voucher moved to the year before (redate)',
    setup: async (seed) => ({ entryIds: [await postSetupEntry(seed, '2026-02-18', 'El december', [['5020', 900, 0], ['1930', 0, 900]])] }),
    run: async (seed, { entryIds }) => {
      const id = entryIds![0]!
      await expectStatus(
        await v1RedateRoute(v1Request(seed, `/journal-entries/${id}/redate`, { new_entry_date: '2025-12-18' }), params({ companyId: seed.companyId, id })),
        200,
      )
    },
  },
  {
    name: 'staged: redate_entry approved',
    setup: async (seed) => ({ entryIds: [await postSetupEntry(seed, '2026-02-19', 'Telefon december', [['6212', 300, 0], ['1930', 0, 300]])] }),
    run: async (seed, { entryIds }) => {
      const op = await approve(seed, 'redate_entry', { journal_entry_id: entryIds![0], new_entry_date: '2025-12-19' })
      expect(op.status).toBe('committed')
    },
  },
  {
    name: 'momsdeklaration: the basis a reverse-charge verifikat lacks added by correction',
    setup: async (seed) => ({
      entryIds: [
        await postSetupEntry(seed, '2026-02-20', 'Hosting, EU-leverantör', [
          ['6540', 10000, 0],
          ['2440', 0, 10000],
          ['2645', 2500, 0],
          ['2614', 0, 2500],
        ]),
      ],
    }),
    run: async (_seed, { entryIds }) => {
      await expectStatus(
        await rcFixRoute(
          sessionRequest('/api/reports/vat-declaration/rc-basis-gaps/fix', { entryId: entryIds![0], supplierType: 'eu_business', supplyType: 'service' }),
          params({}),
        ),
        200,
      )
    },
  },
  {
    name: 'reconciliation: a bank fee booked as the residual of a selection',
    setup: async (seed) => ({
      entryIds: [await postSetupEntry(seed, '2026-02-21', 'Leverantörsbetalning', [['2440', 1000, 0], ['1930', 0, 1000]])],
      transactionIds: [await insertRow(seed, { date: '2026-02-21', description: 'Betalning Leverantör AB', amount: -1010 })],
    }),
    run: async (seed, { entryIds, transactionIds }) => {
      const accountKey = `bank:${seed.cashAccountId}`
      await expectStatus(
        await residualRoute(
          sessionRequest(`/api/reconciliation/accounts/${accountKey}/residual`, {
            external_ids: transactionIds,
            journal_entry_id: entryIds![0],
            kind: 'bank_fee',
          }),
          params({ accountKey }),
        ),
        200,
      )
    },
  },
  {
    name: 'fiscal year reopen: the bokslut of a closed year reversed by the owner',
    setup: async () => seedClosedYear(),
    run: async (_seed, prepared) => {
      const { companyId, periodId } = prepared
      const ownerId = (prepared as Prepared & { ownerId: string }).ownerId
      session.userId = ownerId
      session.companyId = companyId!
      session.client = authenticatedClient(ownerId)
      await expectStatus(
        await reopenRoute(
          sessionRequest(`/api/bookkeeping/fiscal-periods/${periodId}/reopen`, { confirm_name: '2025', confirm_annual_report_not_adopted: true }),
          params({ id: periodId! }),
        ),
        200,
      )
    },
  },
  {
    name: 'sandbox seed: an anonymous visitor gets a demo company with its ledger history, invoice and payroll',
    setup: async () => {
      const userId = await insertAuthUser()
      await getPool().query(`UPDATE auth.users SET is_anonymous = true WHERE id = $1`, [userId])
      return { companyId: userId }
    },
    run: async (_seed, prepared) => {
      const userId = prepared.companyId!
      session.userId = userId
      session.anonymous = true
      session.client = authenticatedClient(userId, { is_anonymous: true })
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 4, 15, 12, 0, 0) })
      try {
        const response = await sandboxSeedRoute(
          new Request('http://localhost/api/sandbox/seed', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.15' } }),
        )
        await expectStatus(response, 200)
      } finally {
        vi.useRealTimers()
      }
      const { rows } = await getPool().query<{ company_id: string }>(`SELECT company_id::text FROM public.sandbox_seed_attempts WHERE user_id = $1`, [userId])
      prepared.companyId = rows[0]!.company_id
    },
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
  dimensions: Record<string, string>
}

interface DumpEntry {
  voucher_series: string
  voucher_number: number | null
  entry_date: string
  description: string
  source_type: string
  status: string
  notes: string | null
  /** The original a storno reverses or a correction corrects, as its own dump position. */
  reverses: string | null
  corrects: string | null
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
 * no ids, no timestamps (an original is named by its series, number and
 * status). A storno lists its original's lines in the order the engine reads
 * them back (an unordered embed), so lines are compared in account, amount,
 * text and dimension order.
 */
async function dumpEntries(companyId: string, entryIds: string[]): Promise<Array<DumpEntry & { id: string }>> {
  const voucher = (alias: string) => `${alias}.voucher_series || coalesce(${alias}.voucher_number::text, '-') || ':' || ${alias}.status`
  const { rows } = await getPool().query<DumpEntry & { id: string }>(
    `SELECT je.id::text AS id, je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status, je.notes,
            (SELECT ${voucher('o')} FROM public.journal_entries o WHERE o.id = je.reverses_id) AS reverses,
            (SELECT ${voucher('o')} FROM public.journal_entries o WHERE o.id = je.correction_of_id) AS corrects,
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
      ORDER BY je.voucher_series, je.voucher_number NULLS LAST, je.entry_date, je.description, je.created_at`,
    [companyId, entryIds],
  )
  return rows
}

/** What the doors write beside the verifikat: bank lines and their links, inbox items, the reopened year. */
async function registerOf(companyId: string, reopenedCompanyId: string | null): Promise<unknown> {
  const voucher = (alias: string) => `${alias}.voucher_series || coalesce(${alias}.voucher_number::text, '-') || ':' || ${alias}.status`
  const [transactions, links, inbox, periods] = await Promise.all([
    getPool().query(
      `SELECT t.date::text AS date, t.description, t.amount::text AS amount, t.category, ${voucher('je')} AS voucher
         FROM public.transactions t
         LEFT JOIN public.journal_entries je ON je.id = t.journal_entry_id
        WHERE t.company_id = $1
        ORDER BY t.date, t.description`,
      [companyId],
    ),
    getPool().query(
      `SELECT t.description AS transaction, ${voucher('je')} AS voucher, l.allocated_amount::text AS allocated_amount, l.role, l.link_basis
         FROM public.transaction_voucher_links l
         JOIN public.transactions t ON t.id = l.transaction_id
         JOIN public.journal_entries je ON je.id = l.journal_entry_id
        WHERE l.company_id = $1
        ORDER BY t.description, je.voucher_number`,
      [companyId],
    ),
    getPool().query(
      `SELECT d.file_name, ${voucher('je')} AS voucher
         FROM public.invoice_inbox_items i
         LEFT JOIN public.document_attachments d ON d.id = i.document_id
         LEFT JOIN public.journal_entries je ON je.id = i.created_journal_entry_id
        WHERE i.company_id = $1
        ORDER BY d.file_name`,
      [companyId],
    ),
    getPool().query(
      `SELECT p.name, p.is_closed, p.locked_at IS NOT NULL AS locked, ${voucher('ce')} AS closing_entry, ${voucher('ob')} AS opening_balance_entry
         FROM public.fiscal_periods p
         LEFT JOIN public.journal_entries ce ON ce.id = p.closing_entry_id
         LEFT JOIN public.journal_entries ob ON ob.id = p.opening_balance_entry_id
        WHERE p.company_id = $1
        ORDER BY p.period_start, p.name`,
      [reopenedCompanyId],
    ),
  ])
  return { transactions: transactions.rows, links: links.rows, inbox: inbox.rows, reopenedCompanyPeriods: periods.rows }
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
  const period2025 = await insertFiscalPeriod({ userId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
  const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
  const key = generateApiKey('live')
  await getPool().query(
    `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
     VALUES ($1, $2, $3, $4, 'Bokföringsnyckel', $5)`,
    [userId, companyId, key.hash, key.prefix, V1_SCOPES],
  )
  return { userId, companyId, fiscalPeriodId, period2025, cashAccountId, apiKey: key.key, supabase: createServiceClientNoCookies() }
}

async function runFlows(flows: Flow[] = FLOWS): Promise<FlowRun> {
  const seed = await seedAll()
  const dumps: FlowDump[] = []
  const posted: FlowRun['posted'] = []
  let reopened: string | null = null
  for (const flow of flows) {
    session.userId = seed.userId
    session.companyId = seed.companyId
    session.client = null
    session.anonymous = false
    const prepared = (await flow.setup?.(seed)) ?? {}
    const approvedBefore = approvals.length
    const companyBefore = prepared.companyId
    const before = await entryIdsOf(prepared.companyId ?? seed.companyId)
    try {
      await flow.run(seed, prepared)
    } finally {
      await prepared.restore?.()
      session.client = null
      session.anonymous = false
    }
    const companyId = prepared.companyId ?? seed.companyId
    // The sandbox seed creates its company in the run: everything in it was written there.
    const preexisting = companyBefore === undefined || companyBefore === companyId ? before : new Set<string>()
    if (prepared.periodId) reopened = companyId
    const written = [...(await entryIdsOf(companyId))].filter((id) => !preexisting.has(id))
    const entries = await dumpEntries(companyId, written)
    expect(entries.length, `${flow.name}: the door wrote a verifikat`).toBeGreaterThan(0)
    posted.push({
      ...prepared,
      companyId,
      opIds: approvals.slice(approvedBefore),
      entries: entries.map(({ id, source_type, status }) => ({ id, source_type, status })),
    })
    dumps.push({ flow: flow.name, entries: entries.map(({ id: _id, ...entry }) => entry) })
  }
  return { seed, dumps, register: await registerOf(seed.companyId, reopened), posted }
}

/** One business event shadow mode records for a flow, and the verifikat it is linked to. */
interface ExpectedEvent {
  kind: string
  role: 'produced' | 'reversal' | 'correction'
  /** The act's date; 'today' for a storno or a correction, dated the day it is made. */
  occurred_on: string
  /** The flow's setup verifikat, its inbox item, its bank line, the year reopened, or none. */
  subject: 'entry' | 'inbox' | 'transaction' | 'period' | null
  link_basis: string
  /** A staged approval: the flow's operation is the event's pending operation and its evidence. */
  staged?: boolean
  category?: string | null
  amount?: number | null
  direction?: 'in' | 'out' | null
  /** The rule source mapping_version names; null for none. */
  mappingSource?: string | null
  /** Evidence beyond the link basis, by index into the flow's records. */
  inbox?: boolean
  document?: boolean
  /** The source types of the written verifikat the event is linked to. */
  entries: string[]
}

const PERSON = 'user_created'
const KEY = 'client_asserted'
const STAGED = 'agent_proposed_user_approved'
const voucher = (kind: string, link_basis: string, occurred_on: string, entries: string[], extra: Partial<ExpectedEvent> = {}): ExpectedEvent => ({
  kind, role: 'produced', occurred_on, subject: null, link_basis, entries, ...extra,
})
const storno = (link_basis: string, extra: Partial<ExpectedEvent> = {}): ExpectedEvent => ({
  kind: 'ledger.storno', role: 'reversal', occurred_on: 'today', subject: 'entry', link_basis, entries: ['storno'], ...extra,
})
const correction = (link_basis: string, extra: Partial<ExpectedEvent> = {}): ExpectedEvent[] => [
  storno(link_basis, extra),
  { kind: 'ledger.correction', role: 'correction', occurred_on: 'today', subject: 'entry', link_basis, entries: ['correction'], ...extra },
]

/** What each flow records under shadow; the sandbox seed: one ledger.system per verifikat, dated its date. */
const EXPECTED: Record<string, ExpectedEvent[] | 'sandbox'> = {
  'dashboard: a manual voucher posted from the form': [voucher('ledger.manual', PERSON, '2026-02-03', ['manual'])],
  'dashboard: a draft saved, then posted from the draft list': [voucher('ledger.manual', PERSON, '2026-02-04', ['manual'])],
  'dashboard: a momsredovisning booked from its template': [voucher('vat.settled', PERSON, '2026-02-12', ['vat_settlement'])],
  'v1: a draft created on an API key, then committed': [voucher('ledger.manual', KEY, '2026-02-05', ['manual'])],
  'v1: batch-create of a webshop order an integration labels and a manual voucher, each committed': [
    voucher('sale.webshop_order', KEY, '2026-01-15', ['webshop_order']),
    voucher('ledger.manual', KEY, '2026-02-06', ['manual']),
  ],
  'staged: create_voucher approved': [voucher('ledger.manual', STAGED, '2026-02-07', ['manual'], { staged: true })],
  'staged: create_voucher of a kvitto whose inbox claim is refused, so the voucher is reversed': [
    voucher('ledger.manual', STAGED, '2026-02-08', ['manual'], { staged: true, inbox: true, document: true }),
    // The door's own compensation of the claim it lost: of the inbox item, nobody chose it.
    storno('system_derived', { subject: 'inbox', staged: true }),
  ],
  'dashboard: a posted voucher reversed': [storno(PERSON)],
  'v1: a posted voucher reversed on a later date in its year': [storno(KEY)],
  'staged: reverse_entry approved': [storno(STAGED, { staged: true })],
  'dashboard: a posted voucher corrected with new lines and its own text': correction(PERSON),
  'v1: a posted voucher corrected': correction(KEY),
  'staged: correct_entry approved': correction(STAGED, { staged: true }),
  'dashboard: a posted voucher moved to the year before (recordate)': correction(PERSON),
  'v1: a posted voucher moved to the year before (redate)': correction(KEY),
  'staged: redate_entry approved': correction(STAGED, { staged: true }),
  'momsdeklaration: the basis a reverse-charge verifikat lacks added by correction': [
    storno(PERSON),
    {
      kind: 'ledger.correction', role: 'correction', occurred_on: 'today', subject: 'entry', link_basis: PERSON,
      mappingSource: 'se.vat-rc-basis-fix', entries: ['correction'],
    },
  ],
  'reconciliation: a bank fee booked as the residual of a selection': [
    voucher('ledger.manual', PERSON, '2026-02-21', ['manual'], {
      subject: 'transaction', category: 'expense.bank_fees', amount: 10, direction: 'out', mappingSource: 'se.reconciliation-residual',
    }),
  ],
  'fiscal year reopen: the bokslut of a closed year reversed by the owner': [1, 2, 3].map(() => storno(PERSON, { subject: 'period' })),
  'sandbox seed: an anonymous visitor gets a demo company with its ledger history, invoice and payroll': 'sandbox',
}

interface EventLinkRow {
  id: string
  kind: string
  category: string | null
  occurred_on: string
  subject_type: string | null
  subject_id: string | null
  party_type: string | null
  currency: string | null
  amount: string | null
  amount_sek: string | null
  evidence: Record<string, unknown>
  pending_operation_id: string | null
  actor_type: string | null
  actor_label: string | null
  mapping_version: string | null
  jurisdiction: string
  role: string | null
  journal_entry_id: string | null
  entry_source_type: string | null
  entry_status: string | null
  entry_date: string | null
  entry_actor_type: string | null
}

/** Every event of these companies, once per link, with the verifikat each link points at. */
async function eventLinks(companyIds: string[]): Promise<EventLinkRow[]> {
  const { rows } = await getPool().query<EventLinkRow>(
    `SELECT e.id::text AS id, e.kind, e.category, e.occurred_on::text AS occurred_on,
            e.subject_type, e.subject_id::text AS subject_id, e.party_type, e.currency,
            e.amount::text AS amount, e.amount_sek::text AS amount_sek, e.evidence,
            e.pending_operation_id::text AS pending_operation_id, e.actor_type, e.actor_label, e.mapping_version, e.jurisdiction,
            l.role, l.journal_entry_id::text AS journal_entry_id, je.source_type AS entry_source_type, je.status AS entry_status,
            je.entry_date::text AS entry_date, je.committed_actor_type AS entry_actor_type
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
       LEFT JOIN public.journal_entries je ON je.id = l.journal_entry_id
      WHERE e.company_id = ANY($1::uuid[])
      ORDER BY e.created_at, je.voucher_number`,
    [companyIds],
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

/** How many voucher numbers the company has drawn, over every series and year. */
async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(sum(vs.last_number), 0)::int AS n
       FROM public.voucher_sequences vs
       JOIN public.fiscal_periods p ON p.id = vs.fiscal_period_id
      WHERE p.company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** A trigger that refuses every insert into `table` (or only the rows `when` names), undone by the returned function. */
async function failInserts(table: 'business_events' | 'business_event_entries', when = 'true'): Promise<() => Promise<void>> {
  const fn = `pg_test_ledger_fail_${table}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'pg-test: % refused', TG_TABLE_NAME;
    END; $$;
    DROP TRIGGER IF EXISTS ${fn} ON public.${table};
    CREATE TRIGGER ${fn} BEFORE INSERT ON public.${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.${table}; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

/** Every series of the company's years has no unexplained gap. */
async function expectNoVoucherGaps(companyId: string): Promise<void> {
  const { rows: series } = await getPool().query<{ fiscal_period_id: string; voucher_series: string }>(
    `SELECT DISTINCT fiscal_period_id::text AS fiscal_period_id, voucher_series
       FROM public.journal_entries WHERE company_id = $1 AND voucher_number IS NOT NULL AND voucher_number > 0`,
    [companyId],
  )
  expect(series.length).toBeGreaterThan(0)
  for (const { fiscal_period_id, voucher_series } of series) {
    const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, $3)`, [companyId, fiscal_period_id, voucher_series])
    expect(gaps.rows, `${fiscal_period_id} ${voucher_series}`).toEqual([])
  }
}

const LIVE = new Set(['draft', 'posted', 'reversed'])

/**
 * One door each, on records prepared beforehand (their own verifikat drawn
 * before the doors run): the voucher form, its draft and commit, the v1
 * draft and commit, the staged create_voucher, the storno, correction and
 * recordate doors, the basis fix and the residual. Answers each door's
 * HTTP status (a staged approval's outcome as 200 or 409).
 */
interface DoorSet {
  run: () => Promise<number[]>
}

let doorSeq = 0

async function prepareDoors(seed: Seed): Promise<DoorSet> {
  const n = ++doorSeq
  const day = String(n).padStart(2, '0')
  const date = (month: string) => `2026-${month}-${day}`
  const entry = (month: string, description: string, rows: Line[]) => postSetupEntry(seed, date(month), `${description} ${n}`, rows)
  const [reverseOne, reverseV1, reverseStaged] = [
    await entry('03', 'Felbokning a', OFFICE),
    await entry('03', 'Felbokning b', OFFICE),
    await entry('03', 'Felbokning c', OFFICE),
  ]
  const [correctOne, correctV1, correctStaged] = [
    await entry('04', 'Rättas a', OFFICE),
    await entry('04', 'Rättas b', OFFICE),
    await entry('04', 'Rättas c', OFFICE),
  ]
  const recordate = await entry('05', 'Flyttas', [['5010', 800, 0], ['1930', 0, 800]])
  const rc = await entry('06', 'Hosting EU', [['6540', 1000, 0], ['2440', 0, 1000], ['2645', 250, 0], ['2614', 0, 250]])
  const paid = await entry('07', 'Betalning', [['2440', 500, 0], ['1930', 0, 500]])
  const row = await insertRow(seed, { date: date('07'), description: `Betalning ${n}`, amount: -505 })
  const status = async (response: Response) => {
    await response.text()
    return response.status
  }
  const staged = async (type: string, opParams: Record<string, unknown>) => ((await approve(seed, type, opParams)).status === 'committed' ? 200 : 409)
  const accountKey = `bank:${seed.cashAccountId}`
  const voucherBody = (description: string, month: string) => ({
    fiscal_period_id: seed.fiscalPeriodId,
    entry_date: date(month),
    description: `${description} ${n}`,
    lines: lines(SCREEN),
  })
  return {
    run: async () => {
      const draftThenCommit = async () => {
        const draft = await createRoute(sessionRequest('/api/bookkeeping/journal-entries?as_draft=true', voucherBody('Utkast', '08')))
        const text = await draft.text()
        if (draft.status !== 200) return draft.status
        const id = (JSON.parse(text) as { data: { id: string } }).data.id
        return status(await commitRoute(sessionRequest(`/api/bookkeeping/journal-entries/${id}/commit`), params({ id })))
      }
      const v1DraftThenCommit = async () => {
        const draft = await v1CreateRoute(v1Request(seed, '/journal-entries', voucherBody('API-utkast', '08')), params({ companyId: seed.companyId }))
        const text = await draft.text()
        if (draft.status !== 201) return draft.status
        const id = (JSON.parse(text) as { data: { id: string } }).data.id
        return status(await v1CommitRoute(v1Request(seed, `/journal-entries/${id}/commit`), params({ companyId: seed.companyId, id })))
      }
      return [
        await status(await createRoute(sessionRequest('/api/bookkeeping/journal-entries', voucherBody('Verifikat', '08')))),
        await draftThenCommit(),
        await v1DraftThenCommit(),
        await staged('create_voucher', voucherBody('Agentens verifikat', '08')),
        await status(await reverseRoute(sessionRequest(`/api/bookkeeping/journal-entries/${reverseOne}/reverse`), params({ id: reverseOne }))),
        await status(
          await v1ReverseRoute(v1Request(seed, `/journal-entries/${reverseV1}/reverse`), params({ companyId: seed.companyId, id: reverseV1 })),
        ),
        await staged('reverse_entry', { entry_id: reverseStaged }),
        await status(
          await correctRoute(sessionRequest(`/api/bookkeeping/journal-entries/${correctOne}/correct`, { lines: lines(SCREEN) }), params({ id: correctOne })),
        ),
        await status(
          await v1CorrectRoute(
            v1Request(seed, `/journal-entries/${correctV1}/correct`, { lines: lines(SCREEN) }),
            params({ companyId: seed.companyId, id: correctV1 }),
          ),
        ),
        await staged('correct_entry', { entry_id: correctStaged, lines: lines(SCREEN) }),
        await status(
          await recordateRoute(
            sessionRequest(`/api/bookkeeping/journal-entries/${recordate}/recordate`, { new_entry_date: `2025-05-${day}` }),
            params({ id: recordate }),
          ),
        ),
        await status(
          await rcFixRoute(
            sessionRequest('/api/reports/vat-declaration/rc-basis-gaps/fix', { entryId: rc, supplierType: 'eu_business', supplyType: 'service' }),
            params({}),
          ),
        ),
        await status(
          await residualRoute(
            sessionRequest(`/api/reconciliation/accounts/${accountKey}/residual`, { external_ids: [row], journal_entry_id: paid, kind: 'bank_fee' }),
            params({ accountKey }),
          ),
        ),
      ]
    },
  }
}

/** The doors prepareDoors runs, and the verifikat they write when nothing refuses (a rättelse writes two). */
const DOOR_COUNT = 13
const DOOR_VOUCHERS = 18

/** Every flow books on a fresh company: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 300_000

describe('posting port parity, the ledger\'s own doors (pg)', () => {
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
    const { seed, posted } = await runFlows()
    expect(await eventLinks([seed.companyId, ...posted.map((p) => p.companyId!)])).toEqual([])
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

      // Every verifikat the moved doors wrote has exactly one link.
      const written = shadow.posted.flatMap((p) => p.entries.map((e) => e.id))
      const counts = await linkCounts(written)
      expect(counts).toHaveLength(written.length)
      expect(counts.filter((e) => e.links !== 1)).toEqual([])

      const companies = [...new Set([shadow.seed.companyId, ...shadow.posted.map((p) => p.companyId!)])]
      const links = await eventLinks(companies)
      // Every event the doors recorded is linked to a verifikat they wrote: none dangles.
      expect(links.filter((l) => !written.includes(l.journal_entry_id ?? ''))).toEqual([])
      // Each event names the actor its verifikat names.
      expect(links.filter((l) => l.actor_type !== l.entry_actor_type)).toEqual([])
      const today = (await getPool().query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS d`)).rows[0]!.d

      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        const ids = posted.entries.map((e) => e.id)
        const mine = links.filter((l) => ids.includes(l.journal_entry_id!))
        const expected = EXPECTED[flow.name]!
        if (expected === 'sandbox') {
          expect(mine, flow.name).toHaveLength(posted.entries.length)
          for (const link of mine) {
            expect(link, flow.name).toMatchObject({
              kind: 'ledger.system', role: 'produced', occurred_on: link.entry_date, subject_type: null, category: null,
              amount: null, mapping_version: null, pending_operation_id: null, evidence: { link_basis: 'system_derived' },
            })
          }
          continue
        }
        // One link per event here: match each expected event to the event linked to its verifikat.
        const signature = (kind: string, role: string, sourceType: string) => `${kind}/${role}/${sourceType}`
        expect(mine.map((l) => signature(l.kind, l.role!, l.entry_source_type!)).sort(), flow.name).toEqual(
          expected.flatMap((e) => e.entries.map((t) => signature(e.kind, e.role, t))).sort(),
        )
        for (const want of expected) {
          for (const link of mine.filter((l) => l.kind === want.kind && l.role === want.role && want.entries.includes(l.entry_source_type!))) {
            const label = `${flow.name}: ${want.kind}`
            const subject =
              want.subject === 'entry' ? { type: 'journal_entry', id: posted.entryIds![0] }
                : want.subject === 'inbox' ? { type: 'inbox_item', id: posted.inboxItemIds![0] }
                  : want.subject === 'transaction' ? { type: 'transaction', id: posted.transactionIds![0] }
                    : want.subject === 'period' ? { type: 'fiscal_period', id: posted.periodId }
                      : { type: null, id: null }
            expect(link, label).toMatchObject({
              occurred_on: want.occurred_on === 'today' ? today : want.occurred_on,
              subject_type: subject.type,
              subject_id: subject.id,
              category: want.category ?? null,
              party_type: null,
              jurisdiction: 'SE',
              pending_operation_id: want.staged ? posted.opIds![0] : null,
            })
            expect(LIVE.has(link.entry_status ?? ''), label).toBe(true)
            expect(link.amount === null ? null : Number(link.amount), label).toBe(want.amount ?? null)
            expect(link.evidence.link_basis, label).toBe(want.link_basis)
            expect(link.evidence.link_evidence ?? null, label).toEqual(want.staged ? { pending_operation_id: posted.opIds![0] } : null)
            expect(link.evidence.direction ?? null, label).toBe(want.direction ?? null)
            expect(link.evidence.inbox_item_id ?? null, label).toBe(want.inbox ? posted.inboxItemIds![0] : null)
            expect(link.evidence.document_id ?? null, label).toBe(want.document ? posted.documentIds![0] : null)
            if (want.mappingSource) {
              expect(link.mapping_version?.startsWith(`${want.mappingSource}@`), `${label}: ${link.mapping_version}`).toBe(true)
            } else {
              expect(link.mapping_version, label).toBeNull()
            }
          }
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
      session.userId = seed.userId
      session.companyId = companyId
      for (const table of ['business_events', 'business_event_entries'] as const) {
        // Shadow: every door books, without the event (or its link).
        vi.stubEnv('POSTING_EVENTS', 'shadow')
        const shadowDoors = await prepareDoors(seed)
        const before = await entryIdsOf(companyId)
        const drawnBefore = await lastVoucherNumber(companyId)
        const restore = await failInserts(table)
        let statuses: number[]
        try {
          statuses = await shadowDoors.run()
        } finally {
          await restore()
        }
        expect(statuses, table).toEqual(Array.from({ length: DOOR_COUNT }, () => 200))
        const written = [...(await entryIdsOf(companyId))].filter((id) => !before.has(id))
        expect(written, table).toHaveLength(DOOR_VOUCHERS)
        expect((await linkCounts(written)).filter((e) => e.links !== 0), table).toEqual([])
        expect(await lastVoucherNumber(companyId), table).toBe(drawnBefore + DOOR_VOUCHERS)

        // Strict: each door stops before a voucher number is drawn.
        const strictDoors = await prepareDoors(seed)
        const strictBefore = await entryIdsOf(companyId)
        const restoreStrict = await failInserts(table)
        try {
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)
          const refused = await strictDoors.run()
          for (const [i, status] of refused.entries()) expect(status, `${table} door ${i}`).toBeGreaterThanOrEqual(400)
          expect(await lastVoucherNumber(companyId), table).toBe(drawn)
          // Nothing reached the books: every draft a door made is cancelled.
          const strictWritten = [...(await entryIdsOf(companyId))].filter((id) => !strictBefore.has(id))
          const { rows: live } = await getPool().query(
            `SELECT id FROM public.journal_entries WHERE id = ANY($1::uuid[]) AND status <> 'cancelled'`,
            [strictWritten],
          )
          expect(live, table).toEqual([])
          // The originals stay posted: no storno or rättelse half done.
          const { rows: reversed } = await getPool().query(
            `SELECT id FROM public.journal_entries WHERE company_id = $1 AND status = 'reversed' AND reversed_by_id = ANY($2::uuid[])`,
            [companyId, strictWritten],
          )
          expect(reversed, table).toEqual([])
        } finally {
          await restoreStrict()
          vi.stubEnv('POSTING_EVENTS', 'shadow')
        }
      }

      // With nothing refused, strict books every door with its event, the
      // next numbers in each series: none of the refusals above left a gap.
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const strictDoors = await prepareDoors(seed)
      const before = await entryIdsOf(companyId)
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const drawn = await lastVoucherNumber(companyId)
      expect(await strictDoors.run()).toEqual(Array.from({ length: DOOR_COUNT }, () => 200))
      expect(await lastVoucherNumber(companyId)).toBe(drawn + DOOR_VOUCHERS)
      const written = [...(await entryIdsOf(companyId))].filter((id) => !before.has(id))
      expect(written).toHaveLength(DOOR_VOUCHERS)
      expect((await linkCounts(written)).filter((e) => e.links !== 1)).toEqual([])
      await expectNoVoucherGaps(companyId)
    },
  )

  it(
    'strict mid-correction: a correction link refused after the storno is numbered cancels the corrected draft and the posted storno',
    { timeout: FLOW_TIMEOUT },
    async () => {
      const seed = await seedAll()
      session.userId = seed.userId
      session.companyId = seed.companyId
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const original = await postSetupEntry(seed, '2026-09-10', 'Kontorsmaterial', OFFICE)
      const before = await entryIdsOf(seed.companyId)
      const drawn = await lastVoucherNumber(seed.companyId)
      const restore = await failInserts('business_event_entries', `NEW.role = 'correction'`)
      try {
        const response = await correctRoute(
          sessionRequest(`/api/bookkeeping/journal-entries/${original}/correct`, { lines: lines(SCREEN) }),
          params({ id: original }),
        )
        expect(response.status).toBeGreaterThanOrEqual(400)
        await response.text()
      } finally {
        await restore()
      }
      // The storno drew its number before the corrected verifikat was
      // drafted; it is cancelled and keeps that number, the corrected draft
      // never drew one, and the original stays posted.
      expect(await lastVoucherNumber(seed.companyId)).toBe(drawn + 1)
      const written = [...(await entryIdsOf(seed.companyId))].filter((id) => !before.has(id))
      const { rows } = await getPool().query<{ source_type: string; status: string; voucher_number: number }>(
        `SELECT source_type, status, voucher_number FROM public.journal_entries WHERE id = ANY($1::uuid[]) ORDER BY source_type`,
        [written],
      )
      expect(rows).toEqual([
        { source_type: 'correction', status: 'cancelled', voucher_number: 0 },
        { source_type: 'storno', status: 'cancelled', voucher_number: drawn + 1 },
      ])
      const { rows: originalNow } = await getPool().query(`SELECT status FROM public.journal_entries WHERE id = $1`, [original])
      expect(originalNow).toEqual([{ status: 'posted' }])
      // The storno's link was written (role reversal), the correction's refused.
      expect((await linkCounts(written)).map((r) => r.links).sort()).toEqual([0, 1])
      await expectNoVoucherGaps(seed.companyId)
    },
  )

  it(
    'the reopen and the sandbox seed: shadow books through a refused event, strict stops before the first number',
    { timeout: FLOW_TIMEOUT },
    async () => {
      const sandbox = FLOWS.find((f) => f.name.startsWith('sandbox seed'))!
      const seed = await seedAll()
      for (const mode of ['shadow', 'strict'] as const) {
        vi.stubEnv('POSTING_EVENTS', mode)
        const restore = await failInserts('business_events')
        try {
          // The reopen: the database half opens the year either way; the stornos follow only under shadow.
          const closed = await seedClosedYear()
          const before = await entryIdsOf(closed.companyId!)
          session.userId = closed.ownerId
          session.companyId = closed.companyId!
          session.client = authenticatedClient(closed.ownerId)
          const response = await reopenRoute(
            sessionRequest(`/api/bookkeeping/fiscal-periods/${closed.periodId}/reopen`, { confirm_name: '2025', confirm_annual_report_not_adopted: true }),
            params({ id: closed.periodId! }),
          )
          const text = await response.text()
          const written = [...(await entryIdsOf(closed.companyId!))].filter((id) => !before.has(id))
          if (mode === 'shadow') {
            expect(response.status, text).toBe(200)
            expect(written).toHaveLength(3)
          } else {
            expect(response.status, text).toBe(500)
            expect(text).toContain('FISCAL_YEAR_REOPEN_INCOMPLETE')
            const { rows } = await getPool().query(`SELECT id FROM public.journal_entries WHERE id = ANY($1::uuid[]) AND status <> 'cancelled'`, [written])
            expect(rows).toEqual([])
            expect(await lastVoucherNumber(closed.companyId!)).toBe(0)
          }
          session.client = null

          // The sandbox seed: under strict the seed fails before its first verifikat, as any failed seed.
          const prepared = (await sandbox.setup!(seed)) as Prepared
          const userId = prepared.companyId!
          session.userId = userId
          session.anonymous = true
          session.client = authenticatedClient(userId, { is_anonymous: true })
          vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 4, 15, 12, 0, 0) })
          let status: number
          try {
            const seeded = await sandboxSeedRoute(
              new Request('http://localhost/api/sandbox/seed', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.16' } }),
            )
            status = seeded.status
            await seeded.text()
          } finally {
            vi.useRealTimers()
            session.client = null
            session.anonymous = false
          }
          const { rows: attempt } = await getPool().query<{ company_id: string; status: string }>(
            `SELECT company_id::text, status FROM public.sandbox_seed_attempts WHERE user_id = $1`,
            [userId],
          )
          const { rows: posted } = await getPool().query(
            `SELECT id FROM public.journal_entries WHERE company_id = $1 AND status <> 'cancelled'`,
            [attempt[0]!.company_id],
          )
          if (mode === 'shadow') {
            expect(status).toBe(200)
            // 28 until accounted#80 added the representation lunch's registration verifikat.
            expect(posted.length).toBe(29)
          } else {
            expect(status).toBe(500)
            expect(attempt[0]!.status).toBe('failed')
            expect(posted).toEqual([])
            expect(await lastVoucherNumber(attempt[0]!.company_id)).toBe(0)
          }
        } finally {
          await restore()
        }
      }
    },
  )
})
