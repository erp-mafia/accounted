/**
 * Company grants against the real schema (migrations 20261017100000-100500):
 * the tables, their RLS and immutability, the create / revoke / pause /
 * review writes and their audit rows, and above all the claim gate that
 * decides whether a staged bank-line categorization may go through without a
 * person. Every refusal the gate names is driven here, and for each the
 * staged operation is asserted still pending with no use recorded:
 *
 *   a non-matching staging stays pending; an amount above the limit stays
 *   pending; a revoked grant stops applying; a period-locked date stays
 *   pending; the kill switch stops all; the key's unattended ceiling still
 *   wins; plus the credential, counterparty, override and monthly cases.
 *
 * The end-to-end walk through the TypeScript (detector, approval, the MCP
 * door's enforcement, the receipt, the review list, behandlingshistorik) is
 * tests/pg/grants-exit-check.pg.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { namesCounterparty } from '@/lib/bookkeeping/counterparty-templates'
import { roundOre } from '@/lib/money'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompanyMember,
  insertPostedJournalEntry,
  seedCompany,
} from './fixtures'

const SPOTIFY_LINES = [
  { account_number: '6540', debit_amount: 95.2, credit_amount: 0, description: '' },
  { account_number: '2641', debit_amount: 23.8, credit_amount: 0, description: '' },
  { account_number: '1930', debit_amount: 0, credit_amount: 119, description: '' },
]

interface World {
  userId: string
  companyId: string
  fiscalPeriodId: string
  apiKeyId: string
}

async function seedWorld(opts: { keyLimit?: number | null } = {}): Promise<World> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     SELECT $1, $2, n, 'Grant test', c, t, b FROM (VALUES
       ('1930', 1, 'asset', 'debit'), ('2641', 2, 'liability', 'debit'), ('6540', 6, 'expense', 'debit'),
       ('5410', 5, 'expense', 'debit')) AS a(n, c, t, b)`,
    [userId, companyId],
  )
  const apiKeyId = await insertKey(userId, companyId, { limit: opts.keyLimit ?? null })
  return { userId, companyId, fiscalPeriodId, apiKeyId }
}

async function insertKey(
  userId: string,
  companyId: string,
  opts: { limit?: number | null; serviceAccountId?: string | null; mode?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.api_keys (id, user_id, company_id, key_hash, key_prefix, name, scopes, unattended_commit_limit,
                                  service_account_id, mode)
     VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'Agent key', NULL, $5, $6, $7)`,
    [id, userId, companyId, randomUUID().replaceAll('-', ''), opts.limit ?? null, opts.serviceAccountId ?? null, opts.mode ?? 'live'],
  )
  return id
}

async function insertTx(
  w: Pick<World, 'userId' | 'companyId'>,
  opts: { merchant?: string | null; description?: string; amount?: number; date?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions (id, company_id, user_id, currency, amount, date, description, merchant_name, category)
     VALUES ($1, $2, $3, 'SEK', $4, $5, $6, $7, 'uncategorized')`,
    [id, w.companyId, w.userId, opts.amount ?? -119, opts.date ?? '2026-06-01', opts.description ?? 'SPOTIFY AB', opts.merchant === undefined ? 'Spotify AB' : opts.merchant],
  )
  return id
}

function linesFor(amount: number, account = '6540') {
  const net = roundOre(amount / 1.25)
  const vat = roundOre(amount - net)
  return [
    { account_number: account, debit_amount: net, credit_amount: 0, description: '' },
    { account_number: '2641', debit_amount: vat, credit_amount: 0, description: '' },
    { account_number: '1930', debit_amount: 0, credit_amount: amount, description: '' },
  ]
}

async function stageCategorize(
  w: World,
  txId: string,
  opts: {
    params?: Record<string, unknown>
    lines?: unknown[]
    debitAccount?: string
    date?: string
    actorType?: string
    actorId?: string | null
    status?: string
  } = {},
): Promise<string> {
  const id = randomUUID()
  const params = {
    transaction_id: txId,
    category: 'expense_software',
    vat_treatment: 'standard_25',
    vat_amount: null,
    account_override: null,
    notes: null,
    allow_duplicate: false,
    ...(opts.params ?? {}),
  }
  const preview = {
    debit_account: opts.debitAccount ?? '6540',
    credit_account: '1930',
    amount: 119,
    currency: 'SEK',
    date: opts.date ?? '2026-06-01',
    lines: opts.lines ?? SPOTIFY_LINES,
    vat_lines: [],
    category: 'expense_software',
  }
  await getPool().query(
    `INSERT INTO public.pending_operations (id, company_id, user_id, operation_type, title, params, preview_data,
                                            actor_type, actor_id, actor_label, risk_level, status)
     VALUES ($1, $2, $3, 'categorize_transaction', 'Kategorisera: Spotify', $4, $5, $6, $7, 'Agent key', 'medium', $8)`,
    [id, w.companyId, w.userId, JSON.stringify(params), JSON.stringify(preview), opts.actorType ?? 'api_key',
     opts.actorId === undefined ? w.apiKeyId : opts.actorId, opts.status ?? 'pending'],
  )
  return id
}

async function createGrant(
  w: World,
  opts: {
    decidedBy?: string
    actorType?: string | null
    key?: string
    account?: string
    lines?: string[]
    limit?: number
    monthly?: number | null
    scope?: string
    credentialId?: string | null
    vat?: string | null
    category?: string
  } = {},
): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query(
    `SELECT public.create_company_grant($1, $2, $3, 'anna@example.se', NULL, 'categorize_transaction', $4, 'Spotify AB', 'out',
                                        $5, $6, NULL, $7, $8, $9, $10, $11, $12, '{"booking_count": 5}'::jsonb) AS r`,
    [
      w.companyId,
      opts.decidedBy ?? w.userId,
      // The person approving in the app: the only actor that may accept a grant.
      opts.actorType === undefined ? 'user' : opts.actorType,
      opts.key ?? 'spotify',
      opts.category ?? 'expense_software',
      opts.vat === undefined ? 'standard_25' : opts.vat,
      opts.account ?? '6540',
      opts.lines ?? ['1930', '2641', '6540'],
      opts.limit ?? 500,
      opts.monthly ?? null,
      opts.scope ?? 'any',
      opts.credentialId ?? null,
    ],
  )
  return rows[0].r as Record<string, unknown>
}

async function claim(operationId: string, apiKeyId: string): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query(`SELECT public.claim_company_grant($1, $2) AS r`, [operationId, apiKeyId])
  return rows[0].r as Record<string, unknown>
}

/** A refusal leaves the operation pending and writes no use. */
async function expectRefused(operationId: string, apiKeyId: string, reason: string) {
  const result = await claim(operationId, apiKeyId)
  expect(result).toMatchObject({ matched: false, reason })
  const { rows: op } = await getPool().query(`SELECT status FROM public.pending_operations WHERE id = $1`, [operationId])
  expect(op[0].status).toBe('pending')
  const { rows: uses } = await getPool().query(`SELECT id FROM public.company_grant_uses WHERE pending_operation_id = $1`, [operationId])
  expect(uses).toEqual([])
}

describe('company_grants: tables, RLS, immutability', () => {
  it('accepts the two operation types in the pending_operations CHECK', async () => {
    const w = await seedWorld()
    for (const type of ['create_grant', 'revoke_grant']) {
      await getPool().query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title) VALUES ($1, $2, $3, 't')`,
        [w.userId, w.companyId, type],
      )
    }
  })

  it('lets members read their company grants and nobody write them directly', async () => {
    const w = await seedWorld()
    expect(await createGrant(w)).toMatchObject({ ok: true, version: 1 })
    const outsider = await seedWorld()

    await withUserContext(w.userId, async (client) => {
      const { rows } = await client.query(`SELECT counterparty_key FROM public.company_grants WHERE company_id = $1`, [w.companyId])
      expect(rows).toEqual([{ counterparty_key: 'spotify' }])
    })
    // One refused statement aborts its transaction: each write gets its own.
    for (const sql of [
      `UPDATE public.company_grants SET amount_limit_sek = 1 WHERE company_id = $1`,
      `INSERT INTO public.company_grant_settings (company_id, paused) VALUES ($1, true)`,
      `UPDATE public.company_grant_uses SET reviewed_at = now() WHERE company_id = $1`,
    ]) {
      await expect(withUserContext(w.userId, (client) => client.query(sql, [w.companyId]))).rejects.toThrow(/permission denied/)
    }
    await withUserContext(outsider.userId, async (client) => {
      const { rows } = await client.query(`SELECT id FROM public.company_grants WHERE company_id = $1`, [w.companyId])
      expect(rows).toEqual([])
      const { rows: postings } = await client.query(`SELECT * FROM public.list_company_grant_postings($1, false, 50)`, [w.companyId])
      expect(postings).toEqual([])
    })
    const { rows: anon } = await getPool().query(
      `SELECT has_table_privilege('anon', 'public.company_grants', 'SELECT') AS g,
              has_function_privilege('anon', 'public.claim_company_grant(uuid, uuid)', 'EXECUTE') AS c,
              has_function_privilege('authenticated', 'public.create_company_grant(uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text, text[], numeric, numeric, text, uuid, jsonb)', 'EXECUTE') AS a`,
    )
    expect(anon[0]).toEqual({ g: false, c: false, a: false })
  })

  it('never changes a grant in place, never deletes it, and keeps a revocation final', async () => {
    const w = await seedWorld()
    const created = await createGrant(w)
    await expect(
      getPool().query(`UPDATE public.company_grants SET amount_limit_sek = 99999 WHERE id = $1`, [created.grant_id]),
    ).rejects.toThrow(/dated rule/)
    await expect(getPool().query(`DELETE FROM public.company_grants WHERE id = $1`, [created.grant_id])).rejects.toThrow(/never deleted/)
    await getPool().query(`SELECT public.revoke_company_grant($1, $2, $3)`, [w.companyId, created.grant_id, w.userId])
    await expect(
      getPool().query(`UPDATE public.company_grants SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1`, [created.grant_id]),
    ).rejects.toThrow(/stays revoked/)
  })

  it('goes with its company when the company row itself is deleted, and only then', async () => {
    // Inserted directly (no audit row, which would itself keep the company):
    // what is under test is the guard's cascade branch.
    const userId = await insertAuthUser()
    const companyId = randomUUID()
    await getPool().query(`INSERT INTO public.companies (id, name, entity_type, created_by) VALUES ($1, 'Sandbox AB', 'aktiebolag', $2)`, [companyId, userId])
    await getPool().query(
      `INSERT INTO public.company_grants (company_id, operation_type, counterparty_key, counterparty_label, version, direction, category,
                                          vat_treatment, account_number, line_accounts, amount_limit_sek, accepted_by, accepted_actor_type)
       VALUES ($1, 'categorize_transaction', 'spotify', 'Spotify AB', 1, 'out', 'expense_software', 'standard_25', '6540',
               ARRAY['1930','2641','6540'], 500, $2, 'user')`,
      [companyId, userId],
    )
    await expect(getPool().query(`DELETE FROM public.company_grants WHERE company_id = $1`, [companyId])).rejects.toThrow(/never deleted/)
    await getPool().query(`DELETE FROM public.companies WHERE id = $1`, [companyId])
    const { rows } = await getPool().query(`SELECT id FROM public.company_grants WHERE company_id = $1`, [companyId])
    expect(rows).toEqual([])
  })
})

describe('create_company_grant and revoke_company_grant', () => {
  it('refuses a member who is not owner or admin', async () => {
    const w = await seedWorld()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: w.companyId, userId: member, role: 'member' })
    expect(await createGrant(w, { decidedBy: member })).toEqual({ ok: false, code: 'GRANT_ADMIN_REQUIRED' })
  })

  it("accepts a grant only as the person in the app: an owner's key, the OAuth connector, the in-app assistant, a service account and no actor are refused", async () => {
    const w = await seedWorld()
    for (const actorType of ['api_key', 'mcp_oauth', 'agent_chat', 'service_account', 'cron', 'system', '', null]) {
      expect(await createGrant(w, { actorType }), String(actorType)).toEqual({ ok: false, code: 'GRANT_NEEDS_PERSON' })
    }
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.company_grants WHERE company_id = $1`, [w.companyId])
    expect(rows[0].n).toBe(0)
    expect(await createGrant(w)).toMatchObject({ ok: true, version: 1 })
  })

  it('refuses a counterparty without identity, an inactive account and an unknown credential', async () => {
    const w = await seedWorld()
    for (const key of ['internet bet', 'paypal', 'swish', 'x']) {
      expect(await createGrant(w, { key })).toEqual({ ok: false, code: 'GRANT_UNKNOWN_COUNTERPARTY' })
    }
    expect(await createGrant(w, { account: '6999', lines: ['1930', '6999'] })).toMatchObject({ ok: false, code: 'GRANT_ACCOUNT_INACTIVE' })
    expect(await createGrant(w, { scope: 'api_key', credentialId: randomUUID() })).toEqual({ ok: false, code: 'GRANT_CREDENTIAL_UNKNOWN' })
    expect(await createGrant(w, { lines: ['1930', '2641'] })).toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'line_accounts' })
  })

  it('creates version 1 with an audit row, and a second decision supersedes it as version 2', async () => {
    const w = await seedWorld()
    const first = await createGrant(w, { limit: 300 })
    const second = await createGrant(w, { limit: 400 })
    expect(first).toMatchObject({ ok: true, version: 1, superseded_grant_id: null })
    expect(second).toMatchObject({ ok: true, version: 2, superseded_grant_id: first.grant_id })

    const { rows } = await getPool().query(
      `SELECT version, revoked_reason, amount_limit_sek::float AS limit, accepted_by, accepted_actor_type, line_accounts
         FROM public.company_grants WHERE company_id = $1 ORDER BY version`,
      [w.companyId],
    )
    expect(rows).toEqual([
      { version: 1, revoked_reason: 'superseded', limit: 300, accepted_by: w.userId, accepted_actor_type: 'user', line_accounts: ['1930', '2641', '6540'] },
      { version: 2, revoked_reason: null, limit: 400, accepted_by: w.userId, accepted_actor_type: 'user', line_accounts: ['1930', '2641', '6540'] },
    ])
    const { rows: audit } = await getPool().query(
      `SELECT action, actor_type, actor_label, description FROM public.audit_log
        WHERE company_id = $1 AND table_name = 'company_grants' ORDER BY created_at, action`,
      [w.companyId],
    )
    expect(audit.map((a) => a.action).sort()).toEqual(['INSERT', 'INSERT', 'UPDATE'])
    expect(audit.every((a) => a.actor_type === 'user' && a.actor_label === 'anna@example.se')).toBe(true)
  })

  it('revokes once, answers the postings the grant let through, and a second revoke changes nothing', async () => {
    const w = await seedWorld()
    const grant = await createGrant(w)
    const tx = await insertTx(w)
    const op = await stageCategorize(w, tx)
    const claimed = await claim(op, w.apiKeyId)
    expect(claimed).toMatchObject({ matched: true })
    const entry = await insertPostedJournalEntry({
      userId: w.userId, companyId: w.companyId, fiscalPeriodId: w.fiscalPeriodId,
      lines: [
        { accountNumber: '6540', debitAmount: 95.2, creditAmount: 0 },
        { accountNumber: '2641', debitAmount: 23.8, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 119 },
      ],
    })
    await getPool().query(`SELECT public.complete_company_grant_use($1, $2)`, [claimed.use_id, entry])

    const { rows } = await getPool().query(`SELECT public.revoke_company_grant($1, $2, $3, 'user', 'anna@example.se') AS r`, [w.companyId, grant.grant_id, w.userId])
    expect(rows[0].r).toMatchObject({
      ok: true, unchanged: false, revoked_reason: 'revoked', postings_count: 1,
      postings: [expect.objectContaining({ use_id: claimed.use_id, journal_entry_id: entry, amount_sek: 119, entry_status: 'posted' })],
    })
    const { rows: again } = await getPool().query(`SELECT public.revoke_company_grant($1, $2, $3) AS r`, [w.companyId, grant.grant_id, w.userId])
    expect(again[0].r).toMatchObject({ ok: true, unchanged: true, postings_count: 1 })
    const { rows: audit } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.audit_log WHERE company_id = $1 AND table_name = 'company_grants' AND action = 'UPDATE'`,
      [w.companyId],
    )
    expect(audit[0].n).toBe(1)
    expect(await claim(await stageCategorize(w, await insertTx(w)), w.apiKeyId)).toMatchObject({ matched: false, reason: 'no_grant' })
  })
})

describe('claim_company_grant: exact match only', () => {
  it('matches an exact staging, records a claimed use, and leaves the operation for the commit', async () => {
    const w = await seedWorld()
    const grant = await createGrant(w)
    const tx = await insertTx(w)
    const op = await stageCategorize(w, tx)
    const result = await claim(op, w.apiKeyId)
    expect(result).toMatchObject({ matched: true, company_id: w.companyId, grant_id: grant.grant_id, grant_version: 1, amount_sek: 119 })
    const { rows } = await getPool().query(
      `SELECT u.status, u.amount_sek::float AS amount, u.entry_date::text AS date, u.api_key_id, p.status AS op_status
         FROM public.company_grant_uses u JOIN public.pending_operations p ON p.id = u.pending_operation_id WHERE u.id = $1`,
      [result.use_id],
    )
    expect(rows[0]).toEqual({ status: 'claimed', amount: 119, date: '2026-06-01', api_key_id: w.apiKeyId, op_status: 'pending' })
    // The same bank line cannot be claimed twice while the first claim is live.
    const again = await stageCategorize(w, tx)
    await expectRefused(again, w.apiKeyId, 'transaction_already_claimed')
  })

  it('a non-matching staging stays pending: another account, VAT treatment, category or set of accounts', async () => {
    const w = await seedWorld()
    await createGrant(w)
    await expectRefused(await stageCategorize(w, await insertTx(w), { debitAccount: '5410', lines: linesFor(119, '5410') }), w.apiKeyId, 'pattern_mismatch')
    await expectRefused(await stageCategorize(w, await insertTx(w), { params: { vat_treatment: 'reduced_12' } }), w.apiKeyId, 'pattern_mismatch')
    await expectRefused(await stageCategorize(w, await insertTx(w), { params: { category: 'expense_office' } }), w.apiKeyId, 'pattern_mismatch')
    await expectRefused(
      await stageCategorize(w, await insertTx(w), {
        lines: [
          { account_number: '6540', debit_amount: 119, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 119 },
        ],
      }),
      w.apiKeyId,
      'pattern_mismatch',
    )
    // Money in for a grant on money out.
    await expectRefused(await stageCategorize(w, await insertTx(w, { amount: 119 })), w.apiKeyId, 'pattern_mismatch')
  })

  it('an amount above the limit stays pending', async () => {
    const w = await seedWorld()
    await createGrant(w, { limit: 100 })
    await expectRefused(await stageCategorize(w, await insertTx(w)), w.apiKeyId, 'above_limit')
  })

  it("the key's unattended ceiling still wins over a higher grant limit", async () => {
    const w = await seedWorld({ keyLimit: 100 })
    await createGrant(w, { limit: 500 })
    await expectRefused(await stageCategorize(w, await insertTx(w)), w.apiKeyId, 'above_unattended_limit')
  })

  it('a revoked grant stops applying', async () => {
    const w = await seedWorld()
    const grant = await createGrant(w)
    // A second grant keeps the company "with grants", so the refusal is about this counterparty.
    await createGrant(w, { key: 'telia' })
    await getPool().query(`SELECT public.revoke_company_grant($1, $2, $3)`, [w.companyId, grant.grant_id, w.userId])
    await expectRefused(await stageCategorize(w, await insertTx(w)), w.apiKeyId, 'no_grant_for_counterparty')
  })

  it('a period-locked date stays pending: locked period, closed period, company lock date, no period', async () => {
    const w = await seedWorld()
    await createGrant(w)
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [w.fiscalPeriodId])
    await expectRefused(await stageCategorize(w, await insertTx(w)), w.apiKeyId, 'period_locked')
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = NULL, is_closed = true, closed_at = now() WHERE id = $1`, [w.fiscalPeriodId])
    await expectRefused(await stageCategorize(w, await insertTx(w)), w.apiKeyId, 'period_locked')
    await getPool().query(`UPDATE public.fiscal_periods SET is_closed = false, closed_at = NULL WHERE id = $1`, [w.fiscalPeriodId])
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, bookkeeping_locked_through) VALUES ($1, '2026-06-30')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [w.companyId],
    )
    await expectRefused(await stageCategorize(w, await insertTx(w)), w.apiKeyId, 'period_locked')
    await getPool().query(`UPDATE public.company_settings SET bookkeeping_locked_through = NULL WHERE company_id = $1`, [w.companyId])
    const outside = await insertTx(w, { date: '2027-02-01' })
    await expectRefused(await stageCategorize(w, outside, { date: '2027-02-01' }), w.apiKeyId, 'period_locked')
  })

  it('the kill switch stops all grants, set by an owner or admin only', async () => {
    const w = await seedWorld()
    await createGrant(w)
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: w.companyId, userId: member, role: 'member' })
    const refused = await withUserContext(member, (c) => c.query(`SELECT public.set_company_grants_paused($1, true) AS r`, [w.companyId]))
    expect(refused.rows[0].r).toEqual({ ok: false, code: 'GRANT_ADMIN_REQUIRED' })

    // withUserContext rolls back; the owner's switch is committed through a definer call as the owner.
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: w.userId, role: 'authenticated' })])
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [w.userId])
      await client.query('SET LOCAL ROLE authenticated')
      const { rows } = await client.query(`SELECT public.set_company_grants_paused($1, true) AS r`, [w.companyId])
      expect(rows[0].r).toMatchObject({ ok: true, unchanged: false, paused: true })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    await expectRefused(await stageCategorize(w, await insertTx(w)), w.apiKeyId, 'paused')
    const { rows: audit } = await getPool().query(
      `SELECT action, description FROM public.audit_log WHERE company_id = $1 AND table_name = 'company_grant_settings'`,
      [w.companyId],
    )
    expect(audit).toEqual([{ action: 'INSERT', description: 'All grants paused' }])
  })

  it('refuses what the agent asked for beyond the plain booking', async () => {
    const w = await seedWorld()
    await createGrant(w)
    await expectRefused(await stageCategorize(w, await insertTx(w), { params: { allow_duplicate: true } }), w.apiKeyId, 'allow_duplicate')
    await expectRefused(await stageCategorize(w, await insertTx(w), { params: { vat_amount: 20 } }), w.apiKeyId, 'vat_amount_override')
    await expectRefused(await stageCategorize(w, await insertTx(w), { params: { dimensions: { '6': 'P1' } } }), w.apiKeyId, 'dimensions')
  })

  it('never applies to an unknown counterparty, an already booked line, or a staging by anyone but this live key', async () => {
    const w = await seedWorld()
    await createGrant(w)
    await expectRefused(
      await stageCategorize(w, await insertTx(w, { merchant: null, description: 'INTERNET BET 4' })),
      w.apiKeyId,
      'unknown_counterparty',
    )
    await expectRefused(await stageCategorize(w, await insertTx(w, { merchant: 'PAYPAL' })), w.apiKeyId, 'unknown_counterparty')
    const booked = await insertTx(w)
    await getPool().query(`UPDATE public.transactions SET is_business = true WHERE id = $1`, [booked])
    await expectRefused(await stageCategorize(w, booked), w.apiKeyId, 'transaction_already_booked')
    await expectRefused(await stageCategorize(w, await insertTx(w), { actorType: 'user', actorId: null }), w.apiKeyId, 'not_a_key_credential')
    const otherKey = await insertKey(w.userId, w.companyId)
    await expectRefused(await stageCategorize(w, await insertTx(w)), otherKey, 'credential_mismatch')
    const testKey = await insertKey(w.userId, w.companyId, { mode: 'test' })
    await expectRefused(await stageCategorize(w, await insertTx(w), { actorId: testKey }), testKey, 'credential_not_live')
    await getPool().query(`UPDATE public.api_keys SET revoked_at = now() WHERE id = $1`, [w.apiKeyId])
    await expectRefused(await stageCategorize(w, await insertTx(w)), w.apiKeyId, 'credential_revoked')
  })

  it('a grant naming a service account applies to that account only', async () => {
    const w = await seedWorld()
    const { rows } = await getPool().query(
      `INSERT INTO public.service_accounts (company_id, name, sponsor_user_id, created_by) VALUES ($1, 'Bokföringsagent', $2, $2) RETURNING id`,
      [w.companyId, w.userId],
    )
    const serviceAccountId = rows[0].id as string
    const accountKey = await insertKey(w.userId, w.companyId, { serviceAccountId })
    await createGrant(w, { scope: 'service_account', credentialId: serviceAccountId })
    await expectRefused(await stageCategorize(w, await insertTx(w)), w.apiKeyId, 'credential_not_allowed')
    const op = await stageCategorize(w, await insertTx(w), { actorType: 'service_account', actorId: accountKey })
    expect(await claim(op, accountKey)).toMatchObject({ matched: true })
  })

  it('the monthly limit counts committed and live claimed uses of the posting month, and not released ones', async () => {
    const w = await seedWorld()
    await createGrant(w, { limit: 150, monthly: 200 })
    const first = await claim(await stageCategorize(w, await insertTx(w)), w.apiKeyId)
    expect(first).toMatchObject({ matched: true })
    await expectRefused(await stageCategorize(w, await insertTx(w, { date: '2026-06-15' }), { date: '2026-06-15' }), w.apiKeyId, 'above_monthly_limit')
    const july = await claim(await stageCategorize(w, await insertTx(w, { date: '2026-07-02' }), { date: '2026-07-02' }), w.apiKeyId)
    expect(july).toMatchObject({ matched: true })
    await getPool().query(`SELECT public.release_company_grant_use($1, 'commit_refused')`, [first.use_id])
    const { rows } = await getPool().query(`SELECT status, release_reason FROM public.company_grant_uses WHERE id = $1`, [first.use_id])
    expect(rows[0]).toEqual({ status: 'released', release_reason: 'commit_refused' })
    expect(await claim(await stageCategorize(w, await insertTx(w, { date: '2026-06-20' }), { date: '2026-06-20' }), w.apiKeyId)).toMatchObject({ matched: true })
  })

  it('answers no_grant for a company without grants, before any lock', async () => {
    const w = await seedWorld()
    expect(await claim(await stageCategorize(w, await insertTx(w)), w.apiKeyId)).toEqual({ matched: false, reason: 'no_grant' })
    expect(await claim(randomUUID(), w.apiKeyId)).toEqual({ matched: false, reason: 'operation_not_found' })
  })
})

describe('after the commit: completion, review list, mark reviewed', () => {
  it('completes with the verifikat, verifies it against the rule, lists it until a member marks it reviewed', async () => {
    const w = await seedWorld()
    await createGrant(w)
    const op = await stageCategorize(w, await insertTx(w))
    const claimed = await claim(op, w.apiKeyId)
    const entry = await insertPostedJournalEntry({
      userId: w.userId, companyId: w.companyId, fiscalPeriodId: w.fiscalPeriodId,
      lines: [
        { accountNumber: '6540', debitAmount: 95.2, creditAmount: 0 },
        { accountNumber: '2641', debitAmount: 23.8, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 119 },
      ],
    })
    const { rows } = await getPool().query(`SELECT public.complete_company_grant_use($1, $2) AS r`, [claimed.use_id, entry])
    expect(rows[0].r).toEqual({ ok: true, unchanged: false, pattern_verified: true })

    const listed = await withUserContext(w.userId, (c) =>
      c.query(`SELECT use_id, journal_entry_id, amount_sek::float AS amount, pattern_verified FROM public.list_company_grant_postings($1)`, [w.companyId]),
    )
    expect(listed.rows).toEqual([{ use_id: claimed.use_id, journal_entry_id: entry, amount: 119, pattern_verified: true }])

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: w.companyId, userId: viewer, role: 'viewer' })
    const forbidden = await withUserContext(viewer, (c) =>
      c.query(`SELECT public.mark_company_grant_uses_reviewed($1, $2) AS r`, [w.companyId, [claimed.use_id]]),
    )
    expect(forbidden.rows[0].r).toEqual({ ok: false, code: 'GRANT_REVIEW_FORBIDDEN' })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: w.userId, role: 'authenticated' })])
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [w.userId])
      await client.query('SET LOCAL ROLE authenticated')
      const { rows: marked } = await client.query(`SELECT public.mark_company_grant_uses_reviewed($1, $2) AS r`, [w.companyId, [claimed.use_id]])
      expect(marked[0].r).toEqual({ ok: true, reviewed: 1 })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const after = await withUserContext(w.userId, (c) => c.query(`SELECT use_id FROM public.list_company_grant_postings($1)`, [w.companyId]))
    expect(after.rows).toEqual([])
  })

  it('flags a posted verifikat that does not touch exactly the rule accounts', async () => {
    const w = await seedWorld()
    await createGrant(w)
    const claimed = await claim(await stageCategorize(w, await insertTx(w)), w.apiKeyId)
    const entry = await insertPostedJournalEntry({
      userId: w.userId, companyId: w.companyId, fiscalPeriodId: w.fiscalPeriodId,
      lines: [
        { accountNumber: '5410', debitAmount: 119, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 119 },
      ],
    })
    const { rows } = await getPool().query(`SELECT public.complete_company_grant_use($1, $2) AS r`, [claimed.use_id, entry])
    expect(rows[0].r).toMatchObject({ ok: true, pattern_verified: false })
  })
})

describe('the counterparty identity', () => {
  it('agrees with namesCounterparty() on what names someone, and keys stay stable', async () => {
    const samples = [
      'SPOTIFY AB', 'INTERNET BET 4', 'Överföring via internet', 'Kortköp ICA Maxi', 'SWISH TILL ANNA', 'BG-betalning 123',
      'Autogiro', 'Telia Sverige AB', 'Insättning', 'PAYPAL *SPOTIFY',
    ]
    for (const raw of samples) {
      const { rows } = await getPool().query(`SELECT public.grant_names_counterparty($1) AS n`, [raw])
      expect(rows[0].n, raw).toBe(namesCounterparty(raw))
    }
    for (const key of ['spotify', 'telia sverige', 'ica maxi']) {
      const { rows } = await getPool().query(`SELECT public.grant_counterparty_key($1, NULL, NULL) AS k`, [key])
      expect(rows[0].k).toBe(key)
    }
    const { rows: keys } = await getPool().query(
      `SELECT public.grant_counterparty_key('Spotify AB', NULL, 'x') AS a,
              public.grant_counterparty_key(NULL, NULL, 'PAYPAL') AS b,
              public.grant_counterparty_key('', 'INTERNET BET 4', 'x') AS c,
              public.grant_counterparty_key(NULL, NULL, 'PAYPAL *SPOTIFY') AS d`,
    )
    expect(keys[0]).toEqual({ a: 'spotify', b: '', c: '', d: 'spotify' })
  })
})

describe('company_grant_candidate: the detector input', () => {
  async function approvedBooking(w: World, opts: { account?: string; amount?: number; date?: string } = {}) {
    const amount = opts.amount ?? 119
    const account = opts.account ?? '6540'
    const date = opts.date ?? '2026-05-01'
    const tx = await insertTx(w, { amount: -amount, date })
    const lines = linesFor(amount, account)
    const op = await stageCategorize(w, tx, { debitAccount: account, lines, date })
    // Posted after the operation was staged, on the database clock.
    const { rows: clock } = await getPool().query(`SELECT (now() + interval '1 second')::text AS at`)
    const entry = await insertPostedJournalEntry({
      userId: w.userId, companyId: w.companyId, fiscalPeriodId: w.fiscalPeriodId, entryDate: date,
      committedAt: clock[0].at as string,
      lines: lines.map((l) => ({ accountNumber: l.account_number, debitAmount: l.debit_amount, creditAmount: l.credit_amount })),
    })
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2, is_business = true, category = 'expense_software' WHERE id = $1`, [tx, entry])
    await getPool().query(
      `UPDATE public.pending_operations SET status = 'committed', resolved_at = now(), result_data = jsonb_build_object('journal_entry_id', $2::text) WHERE id = $1`,
      [op, entry],
    )
    return tx
  }

  async function candidate(w: World, tx: string) {
    const { rows } = await getPool().query(`SELECT public.company_grant_candidate($1, $2, 5) AS r`, [w.companyId, tx])
    return rows[0].r as Record<string, unknown>
  }

  it('proposes after five approved bookings the same way, with the evidence', async () => {
    const w = await seedWorld()
    let last = ''
    for (const [i, amount] of [119, 119, 129, 119, 139].entries()) last = await approvedBooking(w, { amount, date: `2026-0${i + 1}-03` })
    expect(await candidate(w, last)).toEqual({
      candidate: true,
      counterparty_key: 'spotify',
      counterparty_label: 'Spotify AB',
      pattern: {
        direction: 'out', category: 'expense_software', vat_treatment: 'standard_25', reverse_charge_kind: null,
        account_number: '6540', line_accounts: ['1930', '2641', '6540'],
      },
      booking_count: 5,
      max_amount_sek: 139,
      last_booked: '2026-05-03',
    })
  })

  it('does not propose with four, with one booked another way, with an active grant, or while paused', async () => {
    const w = await seedWorld()
    let last = ''
    for (let i = 0; i < 4; i++) last = await approvedBooking(w)
    expect(await candidate(w, last)).toMatchObject({ candidate: false, reason: 'not_enough', booking_count: 4 })
    last = await approvedBooking(w, { account: '5410' })
    expect(await candidate(w, last)).toMatchObject({ candidate: false, reason: 'not_consistent' })
    last = await approvedBooking(w)
    for (let i = 0; i < 4; i++) last = await approvedBooking(w)
    expect(await candidate(w, last)).toMatchObject({ candidate: true })
    await createGrant(w)
    expect(await candidate(w, last)).toMatchObject({ candidate: false, reason: 'has_grant' })
  })
})

describe('the suggestion decision follows create_grant', () => {
  it('"Visa aldrig" on a grant suggestion declines it for good', async () => {
    const w = await seedWorld()
    const { rows } = await getPool().query(
      `SELECT public.stage_company_suggestion($1, $2, 'create_grant:cp-0123456789abcdef', 'grant-candidate', 15, 'create_grant',
                                              'Godkänn Spotify AB automatiskt?', '{}'::jsonb, '{}'::jsonb, 'high') AS r`,
      [w.companyId, w.userId],
    )
    const staged = rows[0].r as { staged: boolean; pending_operation_id: string }
    expect(staged.staged).toBe(true)
    await getPool().query(
      `UPDATE public.pending_operations SET status = 'rejected', rejection_category = 'other', rejection_reason = 'Visa aldrig' WHERE id = $1`,
      [staged.pending_operation_id],
    )
    const { rows: state } = await getPool().query(
      `SELECT state FROM public.company_suggestions WHERE company_id = $1 AND suggestion_key = 'create_grant:cp-0123456789abcdef'`,
      [w.companyId],
    )
    expect(state).toEqual([{ state: 'declined' }])
  })
})
