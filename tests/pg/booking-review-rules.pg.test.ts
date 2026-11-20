/**
 * Hard blocks on booking (accounted#130 step 2, migration 20261031150000)
 * against the real schema:
 *
 *   1. booking_review_rules: written only by save_booking_review_rule and
 *      archive_booking_review_rule, by an owner or admin from a signed-in
 *      session, each change in audit_log; versioned (a new version supersedes
 *      the old), archived rather than deleted, never changed in place; read
 *      by the company's members only.
 *   2. The matching in SQL agrees with src/lib/booking-review/match.ts: the
 *      VAT classes a verifikat's lines carry, and the counterparty identity.
 *   3. commit_journal_entry refuses a bank-row draft a rule matches unless a
 *      person commits it from a review (commit_reviewed_journal_entry, which
 *      stamps it in the same transaction): an API key, a bulk accept and a
 *      person's plain commit are refused before a voucher number is drawn.
 *      Each criterion (counterparty, amount from, accounts, VAT) matches on
 *      its own; a draft no rule matches commits as before.
 *   4. Storno and import drafts are never matched, whatever their lines.
 *   5. With any booking_review limit in company_attest_limits, the reviewer
 *      needs one that covers the bank amount.
 *
 * Every test runs in one transaction on the connection's own (superuser)
 * role, which stands in for the service role, and is rolled back. A step
 * "as" a person switches to their signed-in session inside a savepoint
 * (step below); a refused step rolls back to its savepoint, so the test
 * can go on and read what was (not) written.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { grantCounterpartyKey, vatClassesFromLines } from '@/lib/booking-review/match'
import { getClient } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

interface World {
  ownerId: string
  adminId: string
  memberId: string
  viewerId: string
  companyId: string
  fiscalPeriodId: string
}

interface StepResult {
  rows: Array<Record<string, unknown>>
  error: { code?: string; message: string } | null
}

type Line = { account_number: string; debit_amount: number; credit_amount: number }

const DATE = '2026-06-01'

/** A 1 250 kr purchase from the bank at 25 % moms. */
const PURCHASE_25: Line[] = [
  { account_number: '6540', debit_amount: 1000, credit_amount: 0 },
  { account_number: '2641', debit_amount: 250, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
]

let db: PoolClient
let w: World

beforeEach(async () => {
  const seeded = await seedCompany()
  const adminId = await insertAuthUser()
  const memberId = await insertAuthUser()
  const viewerId = await insertAuthUser()
  await insertCompanyMember({ companyId: seeded.companyId, userId: adminId, role: 'admin' })
  await insertCompanyMember({ companyId: seeded.companyId, userId: memberId, role: 'member' })
  await insertCompanyMember({ companyId: seeded.companyId, userId: viewerId, role: 'viewer' })
  w = {
    ownerId: seeded.userId,
    adminId,
    memberId,
    viewerId,
    companyId: seeded.companyId,
    fiscalPeriodId: seeded.fiscalPeriodId,
  }
  db = await getClient()
  await db.query('BEGIN')
})

afterEach(async () => {
  await db.query('ROLLBACK')
  db.release()
})

/**
 * One statement in its own savepoint: as the connection's own role (null),
 * as a person's signed-in session (a user id), or as the service role. The
 * session is dropped again before the savepoint is released, so the writes
 * stay and the next step starts on the connection's own role.
 */
async function step(as: string | null | 'service', sql: string, params: unknown[] = []): Promise<StepResult> {
  await db.query('SAVEPOINT step')
  try {
    if (as === 'service') {
      await db.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true),
                             set_config('request.jwt.claim.role', 'service_role', true)`)
      await db.query('SET LOCAL ROLE service_role')
    } else if (as) {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
        JSON.stringify({ sub: as, role: 'authenticated' }),
        as,
      ])
      await db.query('SET LOCAL ROLE authenticated')
    }
    const { rows } = await db.query(sql, params)
    if (as) {
      await db.query('RESET ROLE')
      await db.query(`SELECT set_config('request.jwt.claims', '', true),
                             set_config('request.jwt.claim.sub', '', true),
                             set_config('request.jwt.claim.role', '', true)`)
    }
    await db.query('RELEASE SAVEPOINT step')
    return { rows, error: null }
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT step')
    const e = err as { code?: string; message?: string }
    return { rows: [], error: { code: e.code, message: e.message ?? String(err) } }
  }
}

interface RuleArgs {
  accounts?: string[] | null
  counterparty?: string | null
  amountFrom?: number | null
  vat?: string | null
  note?: string | null
  supersedes?: string | null
}

const SAVE_SQL = `SELECT public.save_booking_review_rule($1::uuid, $2::text[], $3::text, $4::numeric, $5::text, $6::text, $7::uuid) AS r`

function saveParams(args: RuleArgs): unknown[] {
  return [
    w.companyId,
    args.accounts ?? null,
    args.counterparty ?? null,
    args.amountFrom ?? null,
    args.vat ?? null,
    args.note ?? null,
    args.supersedes ?? null,
  ]
}

/** A rule saved by the owner; throws when the save is refused. */
async function saveRule(args: RuleArgs): Promise<{ id: string; rule_id: string; version: number }> {
  const result = await step(w.ownerId, SAVE_SQL, saveParams(args))
  if (result.error) throw new Error(`save_booking_review_rule refused: ${result.error.message}`)
  return result.rows[0].r as { id: string; rule_id: string; version: number }
}

async function insertTx(opts: { merchant?: string | null; description?: string; amount?: number } = {}): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.transactions (id, company_id, user_id, currency, amount, date, description, merchant_name, category)
     VALUES ($1, $2, $3, 'SEK', $4, $5, $6, $7, 'uncategorized')`,
    [
      id,
      w.companyId,
      w.ownerId,
      opts.amount ?? -1250,
      DATE,
      opts.description ?? 'SPOTIFY AB',
      opts.merchant === undefined ? 'Spotify AB' : opts.merchant,
    ],
  )
  return id
}

/**
 * A draft booking a bank row: the row has no cash account and the company
 * none either, so its settlement ledger is 1930 (guard_bank_booking_context's
 * fallback), which the lines credit for a withdrawal.
 */
async function bankDraft(
  opts: { sourceType?: 'bank_transaction' | 'manual' | 'storno' | 'import'; lines?: Line[]; txId?: string; amount?: number } = {},
): Promise<{ entryId: string; txId: string }> {
  const amount = opts.amount ?? -1250
  const txId = opts.txId ?? (await insertTx({ amount }))
  const entryId = randomUUID()
  const sourceType = opts.sourceType ?? 'bank_transaction'
  const context = [{ transaction_id: txId, cash_account_id: null, settlement_account: '1930', date: DATE, amount, currency: 'SEK' }]
  let batch: string | null = null
  if (sourceType === 'import') {
    const { rows } = await db.query(
      `INSERT INTO public.sie_imports (company_id, user_id, filename, file_hash, sie_type, status)
       VALUES ($1, $2, 'pg-booking-review.se', md5(gen_random_uuid()::text), 4, 'completed') RETURNING id`,
      [w.companyId, w.ownerId],
    )
    batch = rows[0].id as string
  }
  await db.query(
    `INSERT INTO public.journal_entries (id, company_id, user_id, fiscal_period_id, voucher_number, entry_date, description,
                                         source_type, source_id, status, bank_booking_context,
                                         import_batch_id, source_ordinal, source_content_hash)
     VALUES ($1, $2, $3, $4, 0, $5, 'PG booking review', $6, $7, 'draft', $8::jsonb,
             $9::uuid, CASE WHEN $9::uuid IS NOT NULL THEN 0 END, CASE WHEN $9::uuid IS NOT NULL THEN repeat('a', 64) END)`,
    [
      entryId,
      w.companyId,
      w.ownerId,
      w.fiscalPeriodId,
      DATE,
      sourceType,
      sourceType === 'bank_transaction' ? txId : null,
      JSON.stringify(context),
      batch,
    ],
  )
  for (const line of opts.lines ?? PURCHASE_25) {
    await db.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
      [entryId, line.account_number, line.debit_amount, line.credit_amount],
    )
  }
  return { entryId, txId }
}

const COMMIT_SQL = 'SELECT * FROM public.commit_journal_entry($1, $2, $3, NULL, $4, NULL)'
const REVIEWED_SQL = 'SELECT * FROM public.commit_reviewed_journal_entry($1, $2, $3, NULL, NULL)'

/** commit_journal_entry as the application calls it, with the actor and method of the door. */
function commitAs(entryId: string, actorType: string | null, method: string | null, as: string | null = null): Promise<StepResult> {
  return step(as, COMMIT_SQL, [w.companyId, entryId, method, actorType])
}

async function entryState(entryId: string): Promise<{ status: string; voucher_number: number; commit_method: string | null; committed_actor_type: string | null }> {
  const { rows } = await db.query(
    'SELECT status, voucher_number, commit_method, committed_actor_type FROM public.journal_entries WHERE id = $1',
    [entryId],
  )
  return rows[0]
}

async function sequences(): Promise<number> {
  const { rows } = await db.query(
    'SELECT coalesce(sum(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1',
    [w.companyId],
  )
  return rows[0].n as number
}

async function stamp(entryId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.query(
    `SELECT reviewed_by::text, amount_sek::float8 AS amount_sek, limit_sek::float8 AS limit_sek, rules
       FROM public.booking_review_stamps WHERE journal_entry_id = $1`,
    [entryId],
  )
  return rows[0]
}

function expectRefused(result: StepResult, prefix: string, code?: string) {
  expect(result.error, `expected ${prefix}`).not.toBeNull()
  expect(result.error!.message.startsWith(prefix), result.error!.message).toBe(true)
  if (code) expect(result.error!.code).toBe(code)
}

// ── 1. The table and its writers ─────────────────────────────────────

describe('booking_review_rules: written by an owner or admin, through the functions only', () => {
  it('saves a rule as the owner and as an admin, normalised, with an audit row', async () => {
    const result = await step(w.ownerId, SAVE_SQL, saveParams({
      accounts: ['6540', '5410', '6540'], counterparty: '  Spotify AB ', amountFrom: 1000, vat: 'standard_25', note: 'Kontrollant',
    }))
    expect(result.error).toBeNull()
    const saved = result.rows[0].r as { ok: boolean; id: string; rule_id: string; version: number; superseded_id: string | null }
    expect(saved).toMatchObject({ ok: true, version: 1, superseded_id: null })
    expect(saved.rule_id).toBe(saved.id)

    const { rows } = await db.query('SELECT * FROM public.booking_review_rules WHERE id = $1', [saved.id])
    expect(rows[0]).toMatchObject({
      company_id: w.companyId,
      accounts: ['5410', '6540'],
      counterparty_key: 'spotify',
      counterparty_label: 'Spotify AB',
      vat_treatment: 'standard_25',
      note: 'Kontrollant',
      created_by: w.ownerId,
      revoked_at: null,
    })
    expect(Number(rows[0].amount_from_sek)).toBe(1000)

    const { rows: audit } = await db.query(
      `SELECT action, user_id::text, actor_type FROM public.audit_log WHERE table_name = 'booking_review_rules' AND record_id = $1`,
      [saved.id],
    )
    expect(audit).toEqual([{ action: 'INSERT', user_id: w.ownerId, actor_type: 'user' }])

    const byAdmin = await step(w.adminId, SAVE_SQL, saveParams({ vat: 'reverse_charge' }))
    expect(byAdmin.error).toBeNull()
    expect(byAdmin.rows[0].r).toMatchObject({ ok: true, version: 1 })
  })

  it('refuses a member, a viewer, a call without a session and the service role', async () => {
    for (const as of [w.memberId, w.viewerId]) {
      expectRefused(await step(as, SAVE_SQL, saveParams({ vat: 'none' })), 'BOOKING_REVIEW_RULE_FORBIDDEN', '42501')
    }
    // The connection's own role, no session: auth.uid() is NULL.
    expectRefused(await step(null, SAVE_SQL, saveParams({ vat: 'none' })), 'BOOKING_REVIEW_RULE_FORBIDDEN', '42501')
    // The service role carries no session either: refused, by the grant or by the function.
    const service = await step('service', SAVE_SQL, saveParams({ vat: 'none' }))
    expect(service.error?.code).toBe('42501')
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.booking_review_rules WHERE company_id = $1', [w.companyId])
    expect(rows[0].n).toBe(0)
  })

  it.each([
    ['no criterion', {}, 'BOOKING_REVIEW_RULE_INVALID'],
    ['an account that is not four digits', { accounts: ['193'] }, 'BOOKING_REVIEW_RULE_INVALID'],
    ['a counterparty that names no one', { counterparty: 'PAYPAL' }, 'BOOKING_REVIEW_RULE_UNKNOWN_COUNTERPARTY'],
    ['a bank wording only', { counterparty: 'INTERNET BET 4' }, 'BOOKING_REVIEW_RULE_UNKNOWN_COUNTERPARTY'],
    ['a zero amount', { amountFrom: 0 }, 'BOOKING_REVIEW_RULE_INVALID'],
    ['an unknown VAT treatment', { vat: 'zero' }, 'BOOKING_REVIEW_RULE_INVALID'],
  ] as Array<[string, RuleArgs, string]>)('refuses %s', async (_case, args, prefix) => {
    expectRefused(await step(w.ownerId, SAVE_SQL, saveParams(args)), prefix, '22023')
  })

  it('supersedes a rule with a new version and archives a rule, both in audit_log', async () => {
    const v1 = await saveRule({ counterparty: 'Spotify AB' })
    const v2 = await saveRule({ counterparty: 'Spotify AB', amountFrom: 500, supersedes: v1.rule_id })
    expect(v2).toMatchObject({ rule_id: v1.rule_id, version: 2 })
    const { rows } = await db.query(
      `SELECT version, revoked_reason, revoked_by::text, rule_id::text FROM public.booking_review_rules WHERE rule_id = $1 ORDER BY version`,
      [v1.rule_id],
    )
    expect(rows).toEqual([
      { version: 1, revoked_reason: 'superseded', revoked_by: w.ownerId, rule_id: v1.rule_id },
      { version: 2, revoked_reason: null, revoked_by: null, rule_id: v1.rule_id },
    ])

    const archived = await step(w.adminId, 'SELECT public.archive_booking_review_rule($1, $2) AS r', [w.companyId, v1.rule_id])
    expect(archived.error).toBeNull()
    expect(archived.rows[0].r).toMatchObject({ ok: true, version: 2, rule_id: v1.rule_id })
    const { rows: after } = await db.query(
      `SELECT revoked_reason, revoked_by::text FROM public.booking_review_rules WHERE id = $1`,
      [v2.id],
    )
    expect(after[0]).toEqual({ revoked_reason: 'archived', revoked_by: w.adminId })

    // Nothing active is left to archive or supersede.
    expectRefused(
      await step(w.ownerId, 'SELECT public.archive_booking_review_rule($1, $2) AS r', [w.companyId, v1.rule_id]),
      'BOOKING_REVIEW_RULE_NOT_FOUND',
      'P0002',
    )
    expectRefused(
      await step(w.ownerId, SAVE_SQL, saveParams({ vat: 'none', supersedes: v1.rule_id })),
      'BOOKING_REVIEW_RULE_NOT_FOUND',
      'P0002',
    )
    // A member may not archive.
    const other = await saveRule({ vat: 'none' })
    expectRefused(
      await step(w.memberId, 'SELECT public.archive_booking_review_rule($1, $2) AS r', [w.companyId, other.rule_id]),
      'BOOKING_REVIEW_RULE_FORBIDDEN',
      '42501',
    )

    const { rows: audit } = await db.query(
      `SELECT action, record_id::text FROM public.audit_log
        WHERE table_name = 'booking_review_rules' AND record_id = ANY ($1::uuid[]) ORDER BY created_at, id`,
      [[v1.id, v2.id]],
    )
    expect(audit.map((a) => `${a.action}:${a.record_id === v1.id ? 'v1' : 'v2'}`).sort()).toEqual(
      ['INSERT:v1', 'INSERT:v2', 'UPDATE:v1', 'UPDATE:v2'],
    )
  })

  it('never changes a rule in place, never deletes it, and keeps an archive final', async () => {
    const rule = await saveRule({ accounts: ['6540'] })
    const update = await step(null, `UPDATE public.booking_review_rules SET accounts = ARRAY['5410'] WHERE id = $1`, [rule.id])
    expect(update.error?.message).toMatch(/never in place/)
    const del = await step(null, 'DELETE FROM public.booking_review_rules WHERE id = $1', [rule.id])
    expect(del.error?.message).toMatch(/never deleted/)
    const archived = await step(w.ownerId, 'SELECT public.archive_booking_review_rule($1, $2) AS r', [w.companyId, rule.rule_id])
    expect(archived.error).toBeNull()
    const revive = await step(null, 'UPDATE public.booking_review_rules SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1', [rule.id])
    expect(revive.error?.message).toMatch(/stays archived/)
  })

  it('lets members read their own company rules, nobody else, and nobody write the tables directly', async () => {
    const rule = await saveRule({ accounts: ['6540'] })
    const outsider = await seedCompany()

    const own = await step(w.viewerId, 'SELECT id::text FROM public.booking_review_rules WHERE company_id = $1', [w.companyId])
    expect(own.rows).toEqual([{ id: rule.id }])
    const foreign = await step(outsider.userId, 'SELECT id FROM public.booking_review_rules WHERE company_id = $1', [w.companyId])
    expect(foreign.rows).toEqual([])

    for (const sql of [
      `INSERT INTO public.booking_review_rules (company_id, rule_id, version, vat_treatment, created_by)
       VALUES ($1, gen_random_uuid(), 1, 'none', auth.uid())`,
      `UPDATE public.booking_review_rules SET note = 'x' WHERE company_id = $1`,
      `INSERT INTO public.booking_review_stamps (journal_entry_id, company_id, reviewed_by, amount_sek)
       SELECT id, company_id, auth.uid(), 1 FROM public.journal_entries WHERE company_id = $1 LIMIT 1`,
    ]) {
      const result = await step(w.ownerId, sql, [w.companyId])
      expect(result.error?.message, sql).toMatch(/permission denied/)
    }

    const { rows } = await db.query(
      `SELECT has_table_privilege('anon', 'public.booking_review_rules', 'SELECT') AS anon_rules,
              has_table_privilege('anon', 'public.booking_review_stamps', 'SELECT') AS anon_stamps,
              has_table_privilege('service_role', 'public.booking_review_stamps', 'INSERT') AS service_stamps,
              has_function_privilege('authenticated', 'public.booking_review_entry_matches(uuid, uuid)', 'EXECUTE') AS matches,
              has_function_privilege('anon', 'public.save_booking_review_rule(uuid, text[], text, numeric, text, text, uuid)', 'EXECUTE') AS anon_save,
              has_function_privilege('anon', 'public.commit_reviewed_journal_entry(uuid, uuid, uuid, text, text)', 'EXECUTE') AS anon_commit`,
    )
    expect(rows[0]).toEqual({
      anon_rules: false,
      anon_stamps: false,
      service_stamps: false,
      matches: false,
      anon_save: false,
      anon_commit: false,
    })
  })
})

// ── 2. SQL and TypeScript agree ──────────────────────────────────────

describe('the matching agrees with src/lib/booking-review/match.ts', () => {
  const cases: Array<[string, Line[], string[]]> = [
    ['a 25 % purchase', PURCHASE_25, ['standard_25']],
    [
      'a 12 % purchase',
      [
        { account_number: '5800', debit_amount: 892.86, credit_amount: 0 },
        { account_number: '2641', debit_amount: 107.14, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ],
      ['reduced_12'],
    ],
    [
      'a 6 % purchase',
      [
        { account_number: '5800', debit_amount: 943.4, credit_amount: 0 },
        { account_number: '2641', debit_amount: 56.6, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ],
      ['reduced_6'],
    ],
    [
      'a car lease with half its moms deductible: every rate, so no block on a rate misses it',
      [
        { account_number: '5615', debit_amount: 1125, credit_amount: 0 },
        { account_number: '2640', debit_amount: 125, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
      ],
      ['reduced_12', 'reduced_6', 'standard_25'],
    ],
    [
      'a refund of a 25 % purchase',
      [
        { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
        { account_number: '6540', debit_amount: 0, credit_amount: 1000 },
        { account_number: '2641', debit_amount: 0, credit_amount: 250 },
      ],
      ['standard_25'],
    ],
    [
      'a reverse-charge purchase',
      [
        { account_number: '6540', debit_amount: 1000, credit_amount: 0 },
        { account_number: '2645', debit_amount: 250, credit_amount: 0 },
        { account_number: '2614', debit_amount: 0, credit_amount: 250 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ],
      ['reverse_charge'],
    ],
    [
      'a 25 % sale',
      [
        { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 250 },
      ],
      ['standard_25'],
    ],
    [
      'a sale at 25 % and 12 %',
      [
        { account_number: '1930', debit_amount: 2370, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 250 },
        { account_number: '3002', debit_amount: 0, credit_amount: 1000 },
        { account_number: '2621', debit_amount: 0, credit_amount: 120 },
      ],
      ['reduced_12', 'standard_25'],
    ],
    [
      'no VAT',
      [
        { account_number: '6570', debit_amount: 100, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      ],
      ['none'],
    ],
    ['no lines', [], ['none']],
  ]

  it.each(cases)('booking_review_vat_classes: %s', async (_case, lines, expected) => {
    const { rows } = await db.query('SELECT public.booking_review_vat_classes($1::jsonb) AS c', [JSON.stringify(lines)])
    const sql = [...(rows[0].c as string[])].sort()
    expect(sql).toEqual([...expected].sort())
    expect([...vatClassesFromLines(lines)].sort()).toEqual(sql)
  })

  it('grant_counterparty_key: the bank row identity is the same on both sides', async () => {
    const samples: Array<[string | null, string | null, string | null]> = [
      ['Spotify AB', null, 'x'],
      [null, null, 'PAYPAL'],
      ['', 'INTERNET BET 4', 'x'],
      [null, null, 'PAYPAL *SPOTIFY'],
      ['Telia Sverige AB', null, null],
      [null, null, 'SPOTIFY AB'],
      [null, null, ''],
      [null, null, 'A'],
    ]
    for (const [merchant, original, description] of samples) {
      const { rows } = await db.query('SELECT public.grant_counterparty_key($1, $2, $3) AS k', [merchant, original, description])
      expect(grantCounterpartyKey(merchant, original, description), JSON.stringify([merchant, original, description])).toBe(rows[0].k)
    }
  })
})

// ── 3. commit_journal_entry: the last line ───────────────────────────

describe('commit_journal_entry refuses a matched draft without a person reviewed commit', () => {
  it('refuses an API key, a bulk accept and a plain commit by the person, before a number is drawn', async () => {
    await saveRule({ counterparty: 'Spotify AB' })
    const { entryId } = await bankDraft()
    const before = await sequences()

    for (const [actor, method, as] of [
      ['api_key', 'api_key', null],
      ['mcp_oauth', 'api_key', null],
      ['user', 'bulk_accept', null],
      ['user', 'user_accept', null],
      [null, null, null],
      // The person's own session, committing without the review stamp.
      ['user', 'user_accept', w.ownerId],
    ] as Array<[string | null, string | null, string | null]>) {
      const result = await commitAs(entryId, actor, method, as)
      expectRefused(result, 'BOOKING_REVIEW_REQUIRED', 'P0001')
      expect(await entryState(entryId)).toMatchObject({ status: 'draft', voucher_number: 0 })
    }
    expect(await sequences()).toBe(before)
    expect(await stamp(entryId)).toBeUndefined()
  })

  it('posts the draft from a person review, as that person, with a stamp', async () => {
    const rule = await saveRule({ counterparty: 'Spotify AB' })
    const { entryId } = await bankDraft()

    const result = await step(w.memberId, REVIEWED_SQL, [w.companyId, entryId, null])
    expect(result.error).toBeNull()
    expect(result.rows[0].voucher_number).toBe(1)
    expect(await entryState(entryId)).toMatchObject({
      status: 'posted',
      voucher_number: 1,
      commit_method: 'user_accept',
      committed_actor_type: 'user',
    })
    expect(await stamp(entryId)).toMatchObject({
      reviewed_by: w.memberId,
      amount_sek: 1250,
      limit_sek: null,
      rules: [{ id: rule.id, rule_id: rule.rule_id, version: 1 }],
    })
  })

  it('lets the service role commit on behalf of the reviewer it names, never a viewer or nobody', async () => {
    await saveRule({ accounts: ['6540'] })
    const { entryId } = await bankDraft()
    expectRefused(await step('service', REVIEWED_SQL, [w.companyId, entryId, null]), 'BOOKING_REVIEW_REVIEWER_DENIED', '42501')
    expectRefused(await step('service', REVIEWED_SQL, [w.companyId, entryId, w.viewerId]), 'BOOKING_REVIEW_REVIEWER_DENIED', '42501')
    const posted = await step('service', REVIEWED_SQL, [w.companyId, entryId, w.adminId])
    expect(posted.error).toBeNull()
    expect(posted.rows[0].voucher_number).toBe(1)
    expect((await stamp(entryId))?.reviewed_by).toBe(w.adminId)
  })

  it('refuses a session that names someone else, and a viewer session', async () => {
    await saveRule({ accounts: ['6540'] })
    const { entryId } = await bankDraft()
    expectRefused(await step(w.ownerId, REVIEWED_SQL, [w.companyId, entryId, w.memberId]), 'BOOKING_REVIEW_REVIEWER_DENIED', '42501')
    expectRefused(await step(w.viewerId, REVIEWED_SQL, [w.companyId, entryId, null]), 'BOOKING_REVIEW_REVIEWER_DENIED', '42501')
    expect(await entryState(entryId)).toMatchObject({ status: 'draft', voucher_number: 0 })
  })

  it('does not count a stamp from an earlier transaction', async () => {
    const rule = await saveRule({ accounts: ['6540'] })
    const { entryId } = await bankDraft()
    await db.query(
      `INSERT INTO public.booking_review_stamps (journal_entry_id, company_id, reviewed_by, reviewed_at, amount_sek, rules)
       VALUES ($1, $2, $3, now() - interval '1 minute', 1250, $4::jsonb)`,
      [entryId, w.companyId, w.ownerId, JSON.stringify([{ id: rule.id, rule_id: rule.rule_id, version: 1 }])],
    )
    expectRefused(await commitAs(entryId, 'user', 'user_accept', w.ownerId), 'BOOKING_REVIEW_REQUIRED', 'P0001')
  })

  it('commits a draft no rule matches as before, from any door, without a stamp', async () => {
    await saveRule({ counterparty: 'Telia Sverige AB' })
    const { entryId } = await bankDraft()
    const result = await commitAs(entryId, 'api_key', 'api_key')
    expect(result.error).toBeNull()
    expect(result.rows[0].voucher_number).toBe(1)

    // The reviewed door on a draft no rule matches: posted, nothing stamped.
    const { entryId: second } = await bankDraft()
    const reviewed = await step(w.ownerId, REVIEWED_SQL, [w.companyId, second, null])
    expect(reviewed.error).toBeNull()
    expect(await stamp(second)).toBeUndefined()
  })

  it('commits as before for a company without rules', async () => {
    const { entryId } = await bankDraft()
    const result = await commitAs(entryId, 'api_key', 'api_key')
    expect(result.error).toBeNull()
    expect(result.rows[0].voucher_number).toBe(1)
  })

  it.each([
    ['the counterparty of the bank row', { counterparty: 'Spotify AB' }, true],
    ['another counterparty', { counterparty: 'Telia Sverige AB' }, false],
    ['an amount the bank row reaches', { amountFrom: 1250 }, true],
    ['an amount above the bank row', { amountFrom: 2000 }, false],
    ['the counterparty from an amount the row does not reach', { counterparty: 'Spotify AB', amountFrom: 2000 }, false],
    ['an account a line touches', { accounts: ['6540'] }, true],
    ['the bank account', { accounts: ['1930'] }, true],
    ['an account no line touches', { accounts: ['5410', '6250'] }, false],
    ['the VAT the lines carry', { vat: 'standard_25' }, true],
    ['another rate', { vat: 'reduced_12' }, false],
    ['reverse charge on a domestic purchase', { vat: 'reverse_charge' }, false],
    ['no VAT on a purchase with VAT', { vat: 'none' }, false],
    ['account and VAT together', { accounts: ['6540'], vat: 'standard_25' }, true],
    ['account matching, VAT not', { accounts: ['6540'], vat: 'reduced_6' }, false],
  ] as Array<[string, RuleArgs, boolean]>)('a rule on %s: matched %s', async (_case, args, matched) => {
    await saveRule(args)
    const { entryId } = await bankDraft()
    const result = await commitAs(entryId, 'api_key', 'api_key')
    if (matched) {
      expectRefused(result, 'BOOKING_REVIEW_REQUIRED', 'P0001')
    } else {
      expect(result.error).toBeNull()
      expect(result.rows[0].voucher_number).toBe(1)
    }
  })

  it('matches a manual samlingsverifikat that books the bank row', async () => {
    await saveRule({ counterparty: 'Spotify AB' })
    const { entryId } = await bankDraft({ sourceType: 'manual' })
    expectRefused(await commitAs(entryId, 'user', 'bulk_accept'), 'BOOKING_REVIEW_REQUIRED', 'P0001')
  })

  it('leaves an archived rule out', async () => {
    const rule = await saveRule({ counterparty: 'Spotify AB' })
    expect((await step(w.ownerId, 'SELECT public.archive_booking_review_rule($1, $2) AS r', [w.companyId, rule.rule_id])).error).toBeNull()
    const { entryId } = await bankDraft()
    expect((await commitAs(entryId, 'api_key', 'api_key')).error).toBeNull()
  })
})

// ── 4. Exempt ────────────────────────────────────────────────────────

describe('storno and imports are never matched', () => {
  it.each(['storno', 'import'] as const)('commits a %s draft with the same lines and bank row from an API key', async (sourceType) => {
    await saveRule({ counterparty: 'Spotify AB', accounts: ['6540'], vat: 'standard_25' })
    const { entryId } = await bankDraft({ sourceType })
    const result = await commitAs(entryId, 'api_key', 'api_key')
    expect(result.error).toBeNull()
    expect(result.rows[0].voucher_number).toBe(1)
    expect(await stamp(entryId)).toBeUndefined()
  })
})

// ── 5. The booking_review attest limit ───────────────────────────────

describe('a covering booking_review limit, when the company has set any', () => {
  async function limit(userId: string, max: number | null, scope = 'booking_review') {
    await db.query(
      `INSERT INTO public.company_attest_limits (company_id, user_id, scope, max_amount_sek, updated_by) VALUES ($1, $2, $3, $4, $5)`,
      [w.companyId, userId, scope, max, w.ownerId],
    )
  }

  it('refuses a reviewer without a booking_review limit once the company has set one', async () => {
    await saveRule({ counterparty: 'Spotify AB' })
    await limit(w.adminId, 50000)
    const { entryId } = await bankDraft()
    expectRefused(await step(w.ownerId, REVIEWED_SQL, [w.companyId, entryId, null]), 'BOOKING_REVIEW_LIMIT', '42501')
    expect(await entryState(entryId)).toMatchObject({ status: 'draft', voucher_number: 0 })
    expect(await stamp(entryId)).toBeUndefined()
  })

  it('refuses a limit below the bank amount', async () => {
    await saveRule({ counterparty: 'Spotify AB' })
    await limit(w.ownerId, 1000)
    const { entryId } = await bankDraft()
    expectRefused(await step(w.ownerId, REVIEWED_SQL, [w.companyId, entryId, null]), 'BOOKING_REVIEW_LIMIT', '42501')
  })

  it.each([
    ['a covering limit', 2000],
    ['a limit equal to the amount', 1250],
    ['no limit (NULL)', null],
  ] as Array<[string, number | null]>)('posts with %s and records it on the stamp', async (_case, max) => {
    await saveRule({ counterparty: 'Spotify AB' })
    await limit(w.ownerId, max)
    const { entryId } = await bankDraft()
    const result = await step(w.ownerId, REVIEWED_SQL, [w.companyId, entryId, null])
    expect(result.error).toBeNull()
    expect(result.rows[0].voucher_number).toBe(1)
    expect(await stamp(entryId)).toMatchObject({ reviewed_by: w.ownerId, amount_sek: 1250, limit_sek: max })
  })

  it('applies no limit when the company has set none for booking_review (supplier_invoice limits do not count)', async () => {
    await saveRule({ counterparty: 'Spotify AB' })
    await limit(w.ownerId, 100, 'supplier_invoice')
    const { entryId } = await bankDraft()
    const result = await step(w.ownerId, REVIEWED_SQL, [w.companyId, entryId, null])
    expect(result.error).toBeNull()
    expect(await stamp(entryId)).toMatchObject({ reviewed_by: w.ownerId, limit_sek: null })
  })
})

