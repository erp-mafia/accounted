/**
 * The exit check of the Profiles and Suggestions design's step 4 (grants as
 * suggestions), as one pg-real walk through production code against the
 * real schema:
 *
 *   "An agent books the same counterparty the same way five times, each
 *    approved by the owner; the system proposes 'Godkänn automatiskt nästa
 *    gång, upp till X kr?'; the agent cannot accept it, the owner does, in
 *    the app; the next
 *    bank line from that counterparty, staged by the agent, is booked at once
 *    with the grant on its receipt; one above the limit and one booked
 *    another way wait for a person; the owner sees the posting under
 *    'Bokfört enligt regel', revokes the rule and gets the postings it let
 *    through; behandlingshistorik dates the rule and its revocation."
 *
 * Every staging goes through the MCP tool gnubok_categorize_transaction and
 * the dispatcher's grant door (src/extensions/general/mcp-server/grant-door.ts),
 * every approval through commitPendingOperation, the executor every approval
 * door ends in. The detector is the bus subscription lib/init registers,
 * switched on here with GRANT_SUGGESTIONS.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in the Phase 1 and suggestions
 * exit checks (every request must stay inside the shim's grammar, asserted
 * after each test).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { listOpenSuggestions } from '@/lib/suggestions/list'
import { runEventDetectors } from '@/lib/suggestions/handler'
import { loadGrantReview } from '@/lib/grants/review'
import { stageGrantRevocation } from '@/lib/grants/actions'
import { generateBehandlingshistorik } from '@/lib/reports/behandlingshistorik'
import { createLogger } from '@/lib/logger'
import type { PendingOperation, Transaction } from '@/types'
import { tools } from '@/extensions/general/mcp-server/server'
import { applyGrantDoor, type GrantDoorActor } from '@/extensions/general/mcp-server/grant-door'
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

const previousFlag = process.env.GRANT_SUGGESTIONS
beforeAll(() => {
  process.env.GRANT_SUGGESTIONS = 'true'
})
afterAll(() => {
  if (previousFlag === undefined) delete process.env.GRANT_SUGGESTIONS
  else process.env.GRANT_SUGGESTIONS = previousFlag
})

afterEach(() => {
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const log = createLogger('grants-exit-check')
const categorize = tools.find((t) => t.name === 'gnubok_categorize_transaction')!

interface World {
  userId: string
  companyId: string
  fiscalPeriodId: string
  apiKeyId: string
  actor: GrantDoorActor & { type: 'api_key' }
}

async function seedWorld(): Promise<World> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, 'aktiebolag')`, [companyId])
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, entity_type, vat_registered, accounting_method)
     VALUES ($1, 'aktiebolag', true, 'accrual')
     ON CONFLICT (company_id) DO UPDATE SET entity_type = 'aktiebolag', vat_registered = true`,
    [companyId],
  )
  await getPool().query(
    `INSERT INTO public.cash_accounts (company_id, ledger_account, currency, is_primary, enabled, source)
     VALUES ($1, '1930', 'SEK', true, true, 'manual')`,
    [companyId],
  )
  const apiKeyId = randomUUID()
  await getPool().query(
    `INSERT INTO public.api_keys (id, user_id, company_id, key_hash, key_prefix, name, scopes)
     VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'Claude', NULL)`,
    [apiKeyId, userId, companyId, randomUUID().replaceAll('-', '')],
  )
  return {
    userId,
    companyId,
    fiscalPeriodId,
    apiKeyId,
    actor: { type: 'api_key', id: apiKeyId, label: 'Claude', unattendedCommitLimit: null, oauthKey: false, serviceAccountId: null },
  }
}

async function bankLine(w: World, opts: { amount?: number; date: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions (id, company_id, user_id, currency, amount, amount_sek, date, description, merchant_name, category,
                                      cash_account_id)
     VALUES ($1, $2, $3, 'SEK', $4, $4, $5, 'SPOTIFY AB', 'Spotify AB', 'uncategorized',
             (SELECT id FROM public.cash_accounts WHERE company_id = $2 AND ledger_account = '1930'))`,
    [id, w.companyId, w.userId, -(opts.amount ?? 119), opts.date],
  )
  return id
}

/** What the agent does: the MCP tool stages, the dispatcher's grant door decides. */
async function agentStages(w: World, transactionId: string, extra: Record<string, unknown> = {}) {
  const supabase = createServiceClientNoCookies()
  const args = { transaction_id: transactionId, category: 'expense_software', vat_treatment: 'standard_25', ...extra }
  const staged = await categorize.execute(args, w.companyId, w.userId, supabase, w.actor)
  return (await applyGrantDoor(staged, {
    toolName: 'gnubok_categorize_transaction',
    toolArgs: args,
    supabase,
    companyId: w.companyId,
    userId: w.userId,
    actor: w.actor,
    log,
  })) as Record<string, unknown>
}

async function pendingOperation(id: string): Promise<PendingOperation> {
  const { rows } = await getPool().query(`SELECT * FROM public.pending_operations WHERE id = $1`, [id])
  return rows[0] as PendingOperation
}

/** The owner approves in the app. */
async function ownerApproves(w: World, operationId: string) {
  return commitPendingOperation(createServiceClientNoCookies(), w.userId, w.companyId, await pendingOperation(operationId), {
    commitMethod: 'user_accept',
    actor: { type: 'user', label: 'owner@example.se' },
  })
}

describe('grants exit check: suggested, accepted by the person in the app, enforced exactly, reviewed and revoked', () => {
  it('walks the whole slice', async () => {
    const w = await seedWorld()
    const supabase = createServiceClientNoCookies()

    // 1. Five bank lines from Spotify, each staged by the agent and approved by the owner.
    //    Nothing books on its own before a grant exists.
    let lastTransaction = ''
    for (const [i, amount] of [119, 119, 129, 119, 139].entries()) {
      lastTransaction = await bankLine(w, { amount, date: `2026-0${i + 1}-03` })
      const staged = await agentStages(w, lastTransaction)
      expect(staged).toMatchObject({ staged: true, operation_id: expect.any(String) })
      expect(staged.grant).toBeUndefined()
      expect((await pendingOperation(staged.operation_id as string)).status).toBe('pending')
      expect(await ownerApproves(w, staged.operation_id as string)).toMatchObject({ status: 'committed' })
    }

    // 2. The detector (bus subscription, and once more by hand: staging is idempotent per key)
    //    proposes the grant as a suggestion.
    const { rows: tx } = await getPool().query(`SELECT * FROM public.transactions WHERE id = $1`, [lastTransaction])
    await runEventDetectors({
      type: 'transaction.categorized',
      payload: { transaction: tx[0] as Transaction, account: '5420', taxCode: '2641', userId: w.userId, companyId: w.companyId },
    })
    const open = await listOpenSuggestions(supabase, w.companyId)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      detector: 'grant-candidate',
      operation_type: 'create_grant',
      title: 'Godkänn Spotify AB automatiskt nästa gång, upp till 200 kr?',
      reason: expect.stringMatching(/^Samma motpart bokad på samma sätt 5 gånger \(konto 5420, moms 25 %\)\./),
    })
    const suggestion = await pendingOperation(open[0].pending_operation_id)
    expect(suggestion).toMatchObject({ actor_type: 'system', risk_level: 'high', status: 'pending' })

    // 3. The agent cannot accept its own authority: approving with the owner's
    //    key is refused and the suggestion still waits.
    const byAgent = await commitPendingOperation(supabase, w.userId, w.companyId, suggestion, {
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Claude' },
    })
    expect(byAgent).toMatchObject({ status: 'failed', code: 'GRANT_NEEDS_PERSON', operation_status: 'pending' })
    expect((await pendingOperation(suggestion.id)).status).toBe('pending')
    expect(await listOpenSuggestions(supabase, w.companyId)).toHaveLength(1)

    //    The owner says yes in Att göra, approving it as a person in the app.
    const accepted = await ownerApproves(w, suggestion.id)
    expect(accepted).toMatchObject({ status: 'committed', data: { version: 1, amount_limit_sek: 200, superseded_grant_id: null } })
    const grantId = (accepted.data as { grant_id: string }).grant_id
    expect(await listOpenSuggestions(supabase, w.companyId)).toEqual([])

    // 4. The next Spotify line, staged by the agent, books at once under the grant.
    const sixth = await bankLine(w, { amount: 149, date: '2026-06-03' })
    const booked = await agentStages(w, sixth)
    expect(booked).toMatchObject({
      staged: true,
      operation_status: 'committed',
      grant: { applied: true, status: 'committed', grant_id: grantId, grant_version: 1, amount_sek: 149 },
      message: expect.stringMatching(/^Booked without approval under the company's rule/),
    })
    expect(booked.approve).toBeUndefined()
    const bookedOp = await pendingOperation(booked.operation_id as string)
    expect(bookedOp.status).toBe('committed')
    expect(bookedOp.result_data).toMatchObject({ grant: { grant_id: grantId, grant_version: 1 } })
    const journalEntryId = (booked.grant as { journal_entry_id: string }).journal_entry_id
    const { rows: entry } = await getPool().query(
      `SELECT status, committed_actor_type, committed_actor_label, commit_method FROM public.journal_entries WHERE id = $1`,
      [journalEntryId],
    )
    expect(entry[0]).toEqual({ status: 'posted', committed_actor_type: 'api_key', committed_actor_label: 'Claude', commit_method: 'api_key' })
    const { rows: receipt } = await getPool().query(
      `SELECT kind, policy_version, confidence_band, actor_type FROM public.suggestion_log
        WHERE company_id = $1 AND pending_operation_id = $2 AND kind = 'operation'`,
      [w.companyId, bookedOp.id],
    )
    expect(receipt).toEqual([
      { kind: 'operation', policy_version: `grant.1;grant_id=${grantId};grant_version=1`, confidence_band: 'direct', actor_type: 'api_key' },
    ])
    const { rows: use } = await getPool().query(
      `SELECT status, pattern_verified, journal_entry_id FROM public.company_grant_uses WHERE pending_operation_id = $1`,
      [bookedOp.id],
    )
    expect(use).toEqual([{ status: 'committed', pattern_verified: true, journal_entry_id: journalEntryId }])

    // 5. Above the limit, and booked another way: both wait for a person, as today.
    const above = await agentStages(w, await bankLine(w, { amount: 999, date: '2026-06-10' }))
    expect(above).toMatchObject({ staged: true, grant: { applied: false, reason: 'above_limit' }, approve: expect.any(Object) })
    expect((await pendingOperation(above.operation_id as string)).status).toBe('pending')
    const otherWay = await agentStages(w, await bankLine(w, { amount: 119, date: '2026-06-11' }), { account_override: '5410' })
    expect(otherWay).toMatchObject({ staged: true, grant: { applied: false, reason: 'pattern_mismatch' } })
    expect((await pendingOperation(otherWay.operation_id as string)).status).toBe('pending')

    // 6. The owner sees it under "Bokfört enligt regel".
    const review = await loadGrantReview(supabase, w.companyId)
    expect(review).toMatchObject({ paused: false, has_active_grants: true })
    expect(review.postings).toEqual([
      expect.objectContaining({ grant_id: grantId, journal_entry_id: journalEntryId, amount_sek: 149, counterparty_label: 'Spotify AB', entry_status: 'posted' }),
    ])

    // 7. The owner revokes the rule: a staged revoke_grant, approved, answering what it let through.
    const revocation = await stageGrantRevocation(supabase, supabase, { companyId: w.companyId, userId: w.userId, userLabel: 'owner@example.se', grantId }, log)
    expect(revocation).toMatchObject({ ok: true })
    const revoked = await ownerApproves(w, (revocation as { operationId: string }).operationId)
    expect(revoked).toMatchObject({
      status: 'committed',
      data: { grant_id: grantId, changed: true, postings_count: 1, postings: [expect.objectContaining({ journal_entry_id: journalEntryId, amount_sek: 149 })] },
    })
    const afterRevoke = await agentStages(w, await bankLine(w, { amount: 119, date: '2026-06-20' }))
    expect(afterRevoke.grant).toBeUndefined()
    expect((await pendingOperation(afterRevoke.operation_id as string)).status).toBe('pending')

    // 8. Behandlingshistorik: the rule accepted and revoked as dated lines, the posting's decision naming the rule.
    const report = await generateBehandlingshistorik(supabase, w.companyId, { periodId: w.fiscalPeriodId })
    const accepted_ = report!.events.find((e) => e.code === 'grant.accepted')
    expect(accepted_).toMatchObject({
      category: 'installningar',
      event: 'Regel för automatisk bokföring godkänd',
      object: 'Regel för automatisk bokföring: Spotify AB, upp till 200 kr',
      actor: expect.objectContaining({ type: 'user' }),
    })
    expect(report!.events.find((e) => e.code === 'grant.revoked')).toMatchObject({ event: 'Regel för automatisk bokföring återkallad' })
    expect(report!.events.some((e) => e.event === 'Bokfört automatiskt enligt regel')).toBe(true)
  }, 30_000)

  it('turns grants that exist off with GRANT_SUGGESTIONS: the next matching line waits for a person', async () => {
    const w = await seedWorld()
    const { rows } = await getPool().query(
      `SELECT public.create_company_grant($1, $2, 'user', 'owner@example.se', NULL, 'categorize_transaction', 'spotify', 'Spotify AB', 'out',
                                          'expense_software', 'standard_25', NULL, '5420', ARRAY['1930','2641','5420'], 500, NULL, 'any', NULL, '{}'::jsonb) AS r`,
      [w.companyId, w.userId],
    )
    expect(rows[0].r).toMatchObject({ ok: true })
    process.env.GRANT_SUGGESTIONS = 'false'
    try {
      const staged = await agentStages(w, await bankLine(w, { amount: 119, date: '2026-06-05' }))
      expect(staged.grant).toBeUndefined()
      expect((await pendingOperation(staged.operation_id as string)).status).toBe('pending')
      const { rows: uses } = await getPool().query(`SELECT count(*)::int AS n FROM public.company_grant_uses WHERE company_id = $1`, [w.companyId])
      expect(uses[0].n).toBe(0)
    } finally {
      process.env.GRANT_SUGGESTIONS = 'true'
    }
    // Back on, the same kind of line books under the rule.
    const booked = await agentStages(w, await bankLine(w, { amount: 119, date: '2026-06-06' }))
    expect(booked).toMatchObject({ operation_status: 'committed', grant: { applied: true, status: 'committed' } })
  })

  it('stages nothing and books nothing unattended while GRANT_SUGGESTIONS is off and no grant exists', async () => {
    process.env.GRANT_SUGGESTIONS = 'false'
    try {
      const w = await seedWorld()
      const supabase = createServiceClientNoCookies()
      let last = ''
      for (const [i, amount] of [119, 119, 119, 119, 119].entries()) {
        last = await bankLine(w, { amount, date: `2026-0${i + 1}-05` })
        const staged = await agentStages(w, last)
        expect(staged.grant).toBeUndefined()
        expect(await ownerApproves(w, staged.operation_id as string)).toMatchObject({ status: 'committed' })
      }
      const { rows: tx } = await getPool().query(`SELECT * FROM public.transactions WHERE id = $1`, [last])
      await runEventDetectors({
        type: 'transaction.categorized',
        payload: { transaction: tx[0] as Transaction, account: '5420', taxCode: '2641', userId: w.userId, companyId: w.companyId },
      })
      expect(await listOpenSuggestions(supabase, w.companyId)).toEqual([])
      const sixth = await agentStages(w, await bankLine(w, { amount: 119, date: '2026-06-05' }))
      expect(sixth.grant).toBeUndefined()
      expect((await pendingOperation(sixth.operation_id as string)).status).toBe('pending')
      const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.company_grants WHERE company_id = $1`, [w.companyId])
      expect(rows[0].n).toBe(0)
    } finally {
      process.env.GRANT_SUGGESTIONS = 'true'
    }
  })
})
