/**
 * Phase 1 exit check of the building-blocks plan, as one pg-real walk:
 *
 *   "every new posting has an actor and a receipt; a harness on a service
 *    account sees the capabilities, stages an attest over REST and receives
 *    the decision as an event that survives a crash."
 *
 * The walk goes the way a harness would, against the real schema (every
 * migration replayed, triggers and RPC bodies live), through the real route
 * handlers:
 *
 *   1. the owner, with a key of their own, creates a service account
 *      (POST /service-accounts) and mints its key (POST
 *      /service-accounts/{id}/keys): the routes call create_service_account
 *      and create_service_account_key;
 *   2. the key validates as the account (validate_and_increment_api_key and
 *      validateApiKey): its company only, acting for its sponsor;
 *   3. the harness reads GET /capabilities with that key;
 *   4. it stages a balanced verifikat with ?stage=true (POST
 *      /fiscal-periods/{id}/opening-balances/manual, an operation write that
 *      stages), the attest is decided with POST /pending-operations/{id}/approve,
 *      and the posted row carries the actor, the verified principal, the
 *      sponsor, a voucher number and debit = credit. The hand-entered IB is
 *      the verifikat because it is the v1 write that stages a plain balanced
 *      posting: a free-form voucher (create_voucher) stages only over MCP,
 *      and POST /journal-entries is hand-written and refuses ?stage=true;
 *   5. the decision reaches the harness as journal_entry.committed on
 *      GET /api/events, and that event row is written in the commit's own
 *      transaction: a connection killed before COMMIT loses the verifikat and
 *      the event together, one killed after COMMIT keeps both.
 *
 * The receipt half of "an actor and a receipt" does not hold for this
 * posting: GET /journal-entries/{id} answers decision_receipts: []. Kept as
 * an it.fails with the reason, next to the passing walk.
 *
 * What is not real, and why. pg-real has Postgres and nothing else: no
 * PostgREST, no GoTrue, no Next.js runtime.
 *   - The HTTP hop to PostgREST. The production client constructor
 *     (createServiceRoleClient, behind createServiceClientNoCookies and the
 *     API-key surface) is called as is, with one change: its fetch is
 *     tests/pg/postgrest-over-pg.ts, which runs each PostgREST request as the
 *     SQL PostgREST would run, in its own committed transaction under the
 *     service role. Every request the walk sends must stay inside that
 *     shim's grammar (asserted after each test), so nothing is answered that
 *     PostgREST would answer differently. GoTrue's admin user read (the
 *     approver's e-mail) is served from auth.users the same way.
 *   - createServiceClient (@supabase/ssr, used by event handlers) is the same
 *     service-role client; the cookie client throws, as there is no request
 *     scope.
 *   - The Next.js runtime: route handlers are called as functions with a
 *     Request and their params promise, as the app router calls them.
 *   - The crash: the committing transaction runs on a connection of its own,
 *     killed with pg_terminate_backend before or after COMMIT, because the
 *     route's commit is one PostgREST request and cannot be interrupted from
 *     outside it.
 *
 * Named as Phase 1's exit check in src/lib/modules/README.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { eventDedupeKey } from '@/lib/events/dedupe-key'
import { createServiceClientNoCookies, generateApiKey, validateApiKey } from '@/lib/auth/api-keys'
import { GET as capabilitiesRoute } from '@/app/api/v1/companies/[companyId]/capabilities/route'
import { POST as createServiceAccountRoute } from '@/app/api/v1/companies/[companyId]/service-accounts/route'
import { POST as mintKeyRoute } from '@/app/api/v1/companies/[companyId]/service-accounts/[id]/keys/route'
import { POST as openingBalancesManualRoute } from '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/opening-balances/manual/route'
import { POST as approveRoute } from '@/app/api/v1/companies/[companyId]/pending-operations/[id]/approve/route'
import { GET as journalEntryRoute } from '@/app/api/v1/companies/[companyId]/journal-entries/[id]/route'
import { GET as eventsRoute } from '@/app/api/events/route'
import { insertAuthUser, insertBalancedLines, insertCompany, insertCompanyMember, insertDraftJournalEntry, seedCompany } from './fixtures'
import { getPool, runAsServiceRole } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes (see tests/tool-pg/client.ts). */
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

afterEach(() => {
  // Every request the walk sent stayed inside the shim's grammar: nothing was
  // answered that PostgREST would answer differently.
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const ACCOUNT_NAME = 'Attestharness'
const HARNESS_SCOPES = ['companies:read', 'reports:read', 'bookkeeping:write', 'pending_operations:approve', 'events:read']
const OWNER_SCOPES = ['service_accounts:manage', ...HARNESS_SCOPES]
const IB_LINES = [
  { account_number: '1930', amount: 10000 },
  { account_number: '2081', amount: -10000 },
]

let idempotencyCounter = 0

function request(
  method: 'GET' | 'POST',
  path: string,
  options: { key: string; body?: unknown; idempotent?: boolean } = { key: '' },
): Request {
  const headers: Record<string, string> = { Authorization: `Bearer ${options.key}` }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.idempotent) headers['Idempotency-Key'] = `pg-phase1-${Date.now()}-${idempotencyCounter++}`
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) })

async function json(response: Response): Promise<{ data?: Record<string, unknown>; error?: { code: string; details?: Record<string, unknown> } } & Record<string, unknown>> {
  return (await response.json()) as never
}

interface Harness {
  ownerId: string
  companyId: string
  fiscalPeriodId: string
  ownerKey: string
  accountId: string
  apiKeyId: string
  apiKey: string
}

/**
 * Step 1. The owner's own key is seeded as Settings > API keys stores one
 * (the SHA-256 of a real gnubok_sk_ secret from generateApiKey); everything
 * after it goes through the v1 routes.
 */
async function seedHarness(): Promise<Harness> {
  const { userId: ownerId, companyId, fiscalPeriodId } = await seedCompany()
  const owner = generateApiKey('live')
  await getPool().query(
    `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, sod_acknowledged_at, sod_acknowledged_by)
     VALUES ($1, $2, $3, $4, 'Ägarens nyckel', $5, now(), $1)`,
    [ownerId, companyId, owner.hash, owner.prefix, OWNER_SCOPES],
  )

  const created = await createServiceAccountRoute(
    request('POST', `/api/v1/companies/${companyId}/service-accounts`, {
      key: owner.key,
      body: { name: ACCOUNT_NAME },
      idempotent: true,
    }),
    params({ companyId }),
  )
  const createdBody = await json(created)
  expect(created.status, JSON.stringify(createdBody)).toBe(201)
  expect(createdBody.data).toMatchObject({ name: ACCOUNT_NAME, company_id: companyId, status: 'active' })
  const accountId = createdBody.data!.id as string

  // A key that both stages and approves is refused until the segregation of
  // duties is acknowledged, as the route documents.
  const mintPath = `/api/v1/companies/${companyId}/service-accounts/${accountId}/keys`
  const refused = await mintKeyRoute(
    request('POST', mintPath, { key: owner.key, body: { name: 'Harness', scopes: HARNESS_SCOPES } }),
    params({ companyId, id: accountId }),
  )
  expect((await json(refused)).error?.code).toBe('API_KEY_SOD_CONFLICT')

  const minted = await mintKeyRoute(
    request('POST', mintPath, { key: owner.key, body: { name: 'Harness', scopes: HARNESS_SCOPES, acknowledge_sod: true } }),
    params({ companyId, id: accountId }),
  )
  const mintedBody = await json(minted)
  expect(minted.status, JSON.stringify(mintedBody)).toBe(201)
  expect(mintedBody.data).toMatchObject({ service_account_id: accountId, name: 'Harness' })
  return {
    ownerId,
    companyId,
    fiscalPeriodId,
    ownerKey: owner.key,
    accountId,
    apiKeyId: mintedBody.data!.id as string,
    apiKey: mintedBody.data!.key as string,
  }
}

/** A draft verifikat of the sponsor's, balanced, for the crash cases. */
async function balancedDraft(h: Harness, amount = 1250): Promise<string> {
  const entryId = await insertDraftJournalEntry({
    userId: h.ownerId,
    companyId: h.companyId,
    fiscalPeriodId: h.fiscalPeriodId,
    description: 'Attest via harness',
  })
  await insertBalancedLines(entryId, amount)
  return entryId
}

/** Steps 4 in one go, for the tests that only need the posted result: stage, then approve with confirmation. */
async function stageAndApprove(h: Harness): Promise<{ operationId: string; entryId: string }> {
  const base = `/api/v1/companies/${h.companyId}`
  const staged = await openingBalancesManualRoute(
    request('POST', `${base}/fiscal-periods/${h.fiscalPeriodId}/opening-balances/manual?stage=true`, {
      key: h.apiKey,
      body: { lines: IB_LINES },
      idempotent: true,
    }),
    params({ companyId: h.companyId, id: h.fiscalPeriodId }),
  )
  expect(staged.status).toBe(202)
  const operationId = (await json(staged)).data!.pending_operation_id as string
  const approved = await approveRoute(
    request('POST', `${base}/pending-operations/${operationId}/approve`, { key: h.apiKey, body: { confirmed: true }, idempotent: true }),
    params({ companyId: h.companyId, id: operationId }),
  )
  expect(approved.status).toBe(200)
  const entryId = ((await json(approved)).data!.result as { journal_entry_id: string }).journal_entry_id
  return { operationId, entryId }
}

/** GET /journal-entries/{id} with the harness key: the posting as a client reads it, decision receipts included. */
async function readEntry(h: Harness, entryId: string) {
  const response = await journalEntryRoute(
    request('GET', `/api/v1/companies/${h.companyId}/journal-entries/${entryId}`, { key: h.apiKey }),
    params({ companyId: h.companyId, id: entryId }),
  )
  const body = await json(response)
  expect(response.status, JSON.stringify(body)).toBe(200)
  return body.data as { id: string; voucher_number: number; decision_receipts: Array<Record<string, unknown>> | null }
}

const COMMIT_SQL = `SELECT voucher_number FROM public.commit_journal_entry($1, $2, 'api_key', NULL, 'service_account', $3)`

/**
 * A transaction under the service role on a connection outside the shared
 * pool, as PostgREST runs one request: the connection is killed below and
 * must not be handed back to the pool.
 */
async function openServiceRoleTransaction(): Promise<Client> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres',
  })
  // The FATAL a killed backend sends is the point of crash(); without a
  // listener it would surface as an uncaught exception.
  client.on('error', () => {})
  await client.connect()
  await client.query('BEGIN')
  await client.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
  await client.query('SET LOCAL ROLE service_role')
  return client
}

/** Kills the backend behind `client`, the way a crashed function or a dropped connection ends a request. */
async function crash(client: Client): Promise<void> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  const ended = new Promise<void>((resolve) => client.once('end', () => resolve()))
  await getPool().query('SELECT pg_terminate_backend($1)', [rows[0]!.pid])
  await ended
}

async function entryState(entryId: string) {
  const { rows } = await getPool().query<{ status: string; voucher_number: number }>(
    `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  return rows[0]
}

async function committedEvents(entryId: string) {
  const { rows } = await getPool().query<{ user_id: string; company_id: string; dedupe_key: string; data: { entry: Record<string, unknown> } }>(
    `SELECT user_id, company_id, dedupe_key, data FROM public.event_log
      WHERE entity_id = $1 AND event_type = 'journal_entry.committed'`,
    [entryId],
  )
  return rows
}

describe('Phase 1 exit check (pg)', () => {
  it('1-2: the owner creates a service account and mints its key over v1; the key validates as the account, pinned to its company, acting for its sponsor', async () => {
    const h = await seedHarness()
    // The sponsor also owns another company: the account's key must never reach it.
    const otherCompany = await insertCompany({ createdBy: h.ownerId })
    await insertCompanyMember({ companyId: otherCompany, userId: h.ownerId, role: 'owner' })

    const { rows } = await runAsServiceRole((client) =>
      client.query(
        `SELECT user_id, api_key_id, company_id, allowed_company_ids, service_account_id, service_account_name
           FROM public.validate_and_increment_api_key(encode(sha256(convert_to($1, 'UTF8')), 'hex'))`,
        [h.apiKey],
      ),
    )
    expect(rows).toEqual([
      {
        user_id: h.ownerId,
        api_key_id: h.apiKeyId,
        company_id: h.companyId,
        allowed_company_ids: [h.companyId],
        service_account_id: h.accountId,
        service_account_name: ACCOUNT_NAME,
      },
    ])

    // The same answer through the application's validation, as every door reads it.
    const auth = await validateApiKey(h.apiKey)
    expect(auth).toMatchObject({
      userId: h.ownerId,
      companyId: h.companyId,
      apiKeyId: h.apiKeyId,
      allowedCompanyIds: [h.companyId],
      serviceAccount: { id: h.accountId, name: ACCOUNT_NAME },
    })
    if ('error' in auth) throw new Error(auth.error)
    expect([...auth.scopes].sort()).toEqual([...HARNESS_SCOPES].sort())

    // Stored only as its hash, owned by the sponsor and the company, the SoD acknowledgement recorded.
    const stored = await getPool().query(
      `SELECT user_id, company_id, service_account_id, sod_acknowledged_at IS NOT NULL AS sod_acknowledged
         FROM public.api_keys WHERE id = $1`,
      [h.apiKeyId],
    )
    expect(stored.rows[0]).toEqual({ user_id: h.ownerId, company_id: h.companyId, service_account_id: h.accountId, sod_acknowledged: true })

    // The other company of the sponsor answers like an unknown one.
    const foreign = await capabilitiesRoute(
      request('GET', `/api/v1/companies/${otherCompany}/capabilities`, { key: h.apiKey }),
      params({ companyId: otherCompany }),
    )
    expect(foreign.status).toBe(404)
  })

  it('3: the harness reads the capabilities of its company with the service account key', async () => {
    const h = await seedHarness()
    const response = await capabilitiesRoute(
      request('GET', `/api/v1/companies/${h.companyId}/capabilities`, { key: h.apiKey }),
      params({ companyId: h.companyId }),
    )
    const body = await json(response)
    expect(response.status, JSON.stringify(body)).toBe(200)
    const data = body.data as { jurisdiction: string; ledger_currency: string; modules: Array<{ id: string; kind: string; status: string; reasons: string[] }> }
    expect(data.jurisdiction).toBe('SE')
    expect(data.ledger_currency).toBe('SEK')
    expect(data.modules.find((m) => m.id === 'ledger')).toMatchObject({ kind: 'kernel', status: 'active', reasons: [] })
    expect(data.modules.find((m) => m.id === 'platform')).toMatchObject({ kind: 'kernel', status: 'active' })
    for (const mod of data.modules) expect(['active', 'off', 'needs_plan', 'unsupported']).toContain(mod.status)
  })

  it('4-5: the harness stages a balanced verifikat over REST, the attest is approved, the posting carries actor, principal and sponsor, and the decision arrives on the event feed', async () => {
    const h = await seedHarness()
    const base = `/api/v1/companies/${h.companyId}`

    // Stage. Nothing is posted yet.
    const staged = await openingBalancesManualRoute(
      request('POST', `${base}/fiscal-periods/${h.fiscalPeriodId}/opening-balances/manual?stage=true`, {
        key: h.apiKey,
        body: { lines: IB_LINES },
        idempotent: true,
      }),
      params({ companyId: h.companyId, id: h.fiscalPeriodId }),
    )
    const stagedBody = await json(staged)
    expect(staged.status, JSON.stringify(stagedBody)).toBe(202)
    expect(stagedBody.data).toMatchObject({
      operation_type: 'set_opening_balances_manual',
      status: 'pending',
      risk_level: 'high',
      actor_type: 'service_account',
      actor_id: h.apiKeyId,
      actor_label: ACCOUNT_NAME,
    })
    const operationId = stagedBody.data!.pending_operation_id as string
    const row = await getPool().query(
      `SELECT company_id, user_id, status, actor_type, actor_label FROM public.pending_operations WHERE id = $1`,
      [operationId],
    )
    expect(row.rows[0]).toEqual({
      company_id: h.companyId,
      user_id: h.ownerId,
      status: 'pending',
      actor_type: 'service_account',
      actor_label: ACCOUNT_NAME,
    })
    const before = await getPool().query(`SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1`, [h.companyId])
    expect(before.rows[0].n).toBe(0)

    // The attest. A high-risk operation needs the explicit confirmation, and
    // without it nothing is consumed: the operation stays pending.
    const approvePath = `${base}/pending-operations/${operationId}/approve`
    const unconfirmed = await approveRoute(
      request('POST', approvePath, { key: h.apiKey, body: {}, idempotent: true }),
      params({ companyId: h.companyId, id: operationId }),
    )
    expect((await json(unconfirmed)).error?.code).toBe('PENDING_OPERATION_CONFIRMATION_REQUIRED')

    // The service account may approve its own staging: its key carries
    // pending_operations:approve (minted with the SoD acknowledgement) and
    // has no unattended ceiling, and set_opening_balances_manual is not an
    // operation only a person may approve in the web app.
    const approved = await approveRoute(
      request('POST', approvePath, { key: h.apiKey, body: { confirmed: true }, idempotent: true }),
      params({ companyId: h.companyId, id: operationId }),
    )
    const approvedBody = await json(approved)
    expect(approved.status, JSON.stringify(approvedBody)).toBe(200)
    expect(approvedBody.data).toMatchObject({ status: 'committed', task_state: 'completed' })
    const entryId = (approvedBody.data!.result as { journal_entry_id: string }).journal_entry_id
    expect(entryId).toBeTruthy()

    // The posting: actor, verified principal, sponsor, voucher, balance.
    const entry = await getPool().query(
      `SELECT user_id, status, voucher_series, voucher_number, source_type, commit_method,
              committed_actor_type, committed_actor_label, committed_auth_role, committed_auth_uid
         FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry.rows[0]).toMatchObject({
      user_id: h.ownerId,
      status: 'posted',
      voucher_series: 'A',
      source_type: 'opening_balance',
      commit_method: 'api_key',
      committed_actor_type: 'service_account',
      committed_actor_label: ACCOUNT_NAME,
      committed_auth_role: 'service_role',
      committed_auth_uid: null,
    })
    expect(entry.rows[0].voucher_number).toBeGreaterThan(0)
    const totals = await getPool().query<{ debit: number; credit: number; lines: number }>(
      `SELECT sum(debit_amount)::float8 AS debit, sum(credit_amount)::float8 AS credit, count(*)::int AS lines
         FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(totals.rows[0]).toEqual({ debit: 10000, credit: 10000, lines: 2 })
    const audit = await getPool().query(
      `SELECT user_id, actor_type, actor_label FROM public.audit_log WHERE record_id = $1 AND action = 'COMMIT'`,
      [entryId],
    )
    expect(audit.rows).toEqual([{ user_id: h.ownerId, actor_type: 'service_account', actor_label: ACCOUNT_NAME }])
    // The client's read of the posting answers (receipts are read, not unknown); what they hold is the it.fails below.
    const read = await readEntry(h, entryId)
    expect(read).toMatchObject({ id: entryId, voucher_number: entry.rows[0].voucher_number })
    expect(Array.isArray(read.decision_receipts)).toBe(true)
    const operation = await getPool().query(
      `SELECT status, result_data->>'journal_entry_id' AS journal_entry_id FROM public.pending_operations WHERE id = $1`,
      [operationId],
    )
    expect(operation.rows[0]).toEqual({ status: 'committed', journal_entry_id: entryId })

    // The decision as an event: the harness polls the feed with its own key.
    const feed = await eventsRoute(request('GET', `/api/events?types=journal_entry.committed`, { key: h.apiKey }))
    const feedBody = (await feed.json()) as { data: Array<{ event_type: string; entity_id: string; data: { entry?: Record<string, unknown> } }> }
    expect(feed.status, JSON.stringify(feedBody)).toBe(200)
    const events = feedBody.data.filter((e) => e.entity_id === entryId)
    expect(events).toHaveLength(1)
    expect(events[0]!.event_type).toBe('journal_entry.committed')
    expect(events[0]!.data.entry).toMatchObject({
      id: entryId,
      status: 'posted',
      voucher_number: entry.rows[0].voucher_number,
      committed_actor_type: 'service_account',
      committed_actor_label: ACCOUNT_NAME,
    })
    // One row however many writers announced it (the RPC's outbox row and the bus handler share the dedupe key).
    const stored = await committedEvents(entryId)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.dedupe_key).toBe(eventDedupeKey('journal_entry.committed', entryId))
  })

  // GAP against "every new posting has an actor and a receipt". The actor
  // half holds (test 4-5). The receipt half does not for a posting that a
  // service account staged and that was approved through a pending
  // operation: GET /journal-entries/{id} answers decision_receipts: [] for
  // it. Decision receipts are suggestion_log rows (src/lib/suggestion-log/
  // receipts.ts reads only those, and joins the pending operation onto a
  // row it already found), and only the bank-line and underlag doors
  // (categorize, bulk book, inbox, attest of a supplier invoice) write one;
  // commitPendingOperation writes none for the operation it commits. So the
  // decision is recorded (pending_operations row with the proposer, the
  // posted row's actor columns, audit_log) but no receipt names it, and a
  // harness reading the posting cannot get from it to who proposed it.
  // Flip to it() once a staged-and-approved posting answers a receipt.
  it.fails('receipt: a posting staged by the service account and approved answers a decision receipt naming the pending operation', async () => {
    const h = await seedHarness()
    const { operationId, entryId } = await stageAndApprove(h)
    const read = await readEntry(h, entryId)
    expect(read.decision_receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decided_by: expect.objectContaining({ actor_type: 'service_account', label: ACCOUNT_NAME }),
          proposed_by: expect.objectContaining({ pending_operation_id: operationId, actor_type: 'service_account' }),
        }),
      ]),
    )
  })

  it('5: the event is written in the commit transaction: a crash before COMMIT loses verifikat and event together', async () => {
    const h = await seedHarness()
    const entryId = await balancedDraft(h)

    const client = await openServiceRoleTransaction()
    const { rows } = await client.query<{ voucher_number: number }>(COMMIT_SQL, [h.companyId, entryId, ACCOUNT_NAME])
    expect(rows[0]!.voucher_number).toBeGreaterThan(0)
    // Inside the transaction both exist ...
    const inside = await client.query(
      `SELECT (SELECT status FROM public.journal_entries WHERE id = $1) AS status,
              (SELECT count(*)::int FROM public.event_log WHERE entity_id = $1 AND event_type = 'journal_entry.committed') AS events`,
      [entryId],
    )
    expect(inside.rows[0]).toEqual({ status: 'posted', events: 1 })
    // ... and neither is visible to anyone else before COMMIT.
    expect(await committedEvents(entryId)).toEqual([])

    await crash(client)

    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await committedEvents(entryId)).toEqual([])
  })

  it('5: a crash after COMMIT keeps both, and the harness reads the event back on the feed', async () => {
    const h = await seedHarness()
    const entryId = await balancedDraft(h)

    const client = await openServiceRoleTransaction()
    const { rows } = await client.query<{ voucher_number: number }>(COMMIT_SQL, [h.companyId, entryId, ACCOUNT_NAME])
    const voucherNumber = rows[0]!.voucher_number
    await client.query('COMMIT')
    await crash(client)

    expect(await entryState(entryId)).toEqual({ status: 'posted', voucher_number: voucherNumber })
    const stored = await committedEvents(entryId)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ user_id: h.ownerId, company_id: h.companyId })

    // Nothing in process announced it (no event bus ran): the feed has it from the outbox row alone.
    const feed = await eventsRoute(request('GET', `/api/events?types=journal_entry.committed`, { key: h.apiKey }))
    const feedBody = (await feed.json()) as { data: Array<{ entity_id: string; data: { entry?: Record<string, unknown> } }> }
    expect(feed.status).toBe(200)
    const event = feedBody.data.find((e) => e.entity_id === entryId)
    expect(event?.data.entry).toMatchObject({
      id: entryId,
      voucher_number: voucherNumber,
      commit_method: 'api_key',
      committed_actor_type: 'service_account',
      committed_actor_label: ACCOUNT_NAME,
    })
  })

  it('the transport seam answers outside its grammar loudly, so the guard after each test means something', async () => {
    const { companyId } = await seedCompany()
    const supabase = createServiceClientNoCookies()
    // Read through the seam: PostgREST's shapes (a JSON row, numbers as numbers).
    const read = await supabase.from('companies').select('id, settings:company_settings(entity_type)').eq('id', companyId).single()
    expect(read.error).toBeNull()
    expect(read.data).toMatchObject({ id: companyId })
    // Full-text search is outside the shim: answered with an error and recorded.
    const unsupported = await supabase.from('companies').select('id').textSearch('name', 'Test')
    expect(unsupported.error?.code).toBe('PGRST100')
    const recorded = shim.rest!.unsupported.splice(0)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toContain('operator fts')
  })

  it('refuses the key of a suspended account: a demoted sponsor stops the harness', async () => {
    const h = await seedHarness()
    const otherOwner = await insertAuthUser()
    await insertCompanyMember({ companyId: h.companyId, userId: otherOwner, role: 'owner' })
    await getPool().query(`UPDATE public.company_members SET role = 'member' WHERE company_id = $1 AND user_id = $2`, [
      h.companyId,
      h.ownerId,
    ])
    const response = await capabilitiesRoute(
      request('GET', `/api/v1/companies/${h.companyId}/capabilities`, { key: h.apiKey }),
      params({ companyId: h.companyId }),
    )
    expect(response.status).toBe(403)
    expect((await json(response)).error?.code).toBe('SERVICE_ACCOUNT_SUSPENDED')
  })
})
