import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, getClient, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember, insertCashAccount, insertTransaction } from './fixtures'

// pg-real coverage for 20260904171000_expense_payout_batch_rpc:
// create_expense_payout_batch books one payout verifikat, links the batch
// and marks the claims paid in one transaction, refuses non-writers, and
// serializes concurrent callers so the same claims can never be paid twice.

type RpcResult = {
  ok: boolean
  code?: string
  transaction_id?: string | null
  batch_id?: string
  journal_entry_id?: string
  voucher_number?: number
  total_sek?: string | number
  claim_count?: number
}

async function seedChart(companyId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     SELECT $1, $2, n, name, cls, atype, nbal, true
     FROM (VALUES
       ('1930', 'Företagskonto',        1, 'asset',     'debit'),
       ('2893', 'Skuld till aktieägare', 2, 'liability', 'credit')
     ) AS t(n, name, cls, atype, nbal)`,
    [userId, companyId],
  )
}

async function insertClaim(
  companyId: string,
  userId: string,
  amountSek: number,
  overrides: Partial<{ claimantName: string; status: string }> = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.expense_claims
       (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account, liability_account, status)
     VALUES ($1, $2, $3, $4, 'Kvitto', '2026-08-25', $5, 0, '5410', '2893', $6)`,
    [id, companyId, userId, overrides.claimantName ?? 'Ägare', amountSek, overrides.status ?? 'registered'],
  )
  return id
}

async function callRpc(
  client: PoolClient,
  companyId: string,
  claimIds: string[],
  opts: Partial<{ date: string; cash: string; transactionId: string }> = {},
): Promise<RpcResult> {
  const { rows } = await client.query<{ r: RpcResult }>(
    `SELECT public.create_expense_payout_batch($1, $2::uuid[], $3::date, $4, NULL, NULL, $5::uuid) AS r`,
    [companyId, claimIds, opts.date ?? '2026-08-31', opts.cash ?? '1930', opts.transactionId ?? null],
  )
  return rows[0].r
}

/** Like withUserContext but COMMITs, so a second session can observe the result. */
async function asUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function payoutState(companyId: string, claimIds: string[]) {
  const claims = await getPool().query<{ status: string; payout_batch_id: string | null }>(
    `SELECT status, payout_batch_id FROM public.expense_claims WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [claimIds],
  )
  const batches = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.expense_payout_batches WHERE company_id = $1`,
    [companyId],
  )
  const entries = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.journal_entries
     WHERE company_id = $1 AND source_type = 'expense_payout' AND status = 'posted'`,
    [companyId],
  )
  return { claims: claims.rows, batches: Number(batches.rows[0].n), postedPayouts: Number(entries.rows[0].n) }
}

describe('create_expense_payout_batch', () => {
  it('books one payout verifikat, links the batch and marks the claims paid', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId, userId)
    const a = await insertClaim(companyId, userId, 500)
    const b = await insertClaim(companyId, userId, 250.5)

    await withUserContext(userId, async (client) => {
      const r = await callRpc(client, companyId, [a, b])
      expect(r.ok).toBe(true)
      expect(Number(r.total_sek)).toBe(750.5)
      expect(r.claim_count).toBe(2)
      expect(r.voucher_number).toBeGreaterThanOrEqual(1)

      const je = await client.query<{
        status: string
        voucher_number: number
        source_type: string
        source_id: string
        entry_date: string
      }>(
        `SELECT status, voucher_number, source_type, source_id::text, entry_date::text
         FROM public.journal_entries WHERE id = $1`,
        [r.journal_entry_id],
      )
      expect(je.rows[0]).toMatchObject({
        status: 'posted',
        voucher_number: r.voucher_number,
        source_type: 'expense_payout',
        source_id: r.batch_id,
        entry_date: '2026-08-31',
      })

      const lines = await client.query<{ account_number: string; debit_amount: string; credit_amount: string }>(
        `SELECT account_number, debit_amount::text, credit_amount::text
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY account_number`,
        [r.journal_entry_id],
      )
      expect(
        lines.rows.map((l) => ({ ...l, debit_amount: Number(l.debit_amount), credit_amount: Number(l.credit_amount) })),
      ).toEqual([
        { account_number: '1930', debit_amount: 0, credit_amount: 750.5 },
        { account_number: '2893', debit_amount: 750.5, credit_amount: 0 },
      ])

      const batch = await client.query<{ journal_entry_id: string; total_sek: string; claimant_name: string }>(
        `SELECT journal_entry_id, total_sek::text, claimant_name FROM public.expense_payout_batches WHERE id = $1`,
        [r.batch_id],
      )
      expect(batch.rows[0]).toEqual({
        journal_entry_id: r.journal_entry_id,
        total_sek: '750.50',
        claimant_name: 'Ägare',
      })

      const claims = await client.query<{ status: string; payout_batch_id: string }>(
        `SELECT status, payout_batch_id FROM public.expense_claims WHERE id = ANY($1::uuid[])`,
        [[a, b]],
      )
      expect(claims.rows).toEqual([
        { status: 'paid', payout_batch_id: r.batch_id },
        { status: 'paid', payout_batch_id: r.batch_id },
      ])
    })
  })

  it('refuses a retry once the claims are paid, leaving a single transfer', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId, userId)
    const a = await insertClaim(companyId, userId, 100)

    const first = await asUser(userId, (client) => callRpc(client, companyId, [a]))
    expect(first.ok).toBe(true)

    const second = await asUser(userId, (client) => callRpc(client, companyId, [a]))
    expect(second).toMatchObject({ ok: false, code: 'ALREADY_PAID' })

    expect(await payoutState(companyId, [a])).toMatchObject({ batches: 1, postedPayouts: 1 })
  })

  it('serializes concurrent payouts of the same claims: the loser gets ALREADY_PAID', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId, userId)
    const a = await insertClaim(companyId, userId, 100)
    const b = await insertClaim(companyId, userId, 200)

    const setContext = async (client: PoolClient) => {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ])
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
      await client.query('SET LOCAL ROLE authenticated')
    }

    const c1 = await getClient()
    const c2 = await getClient()
    try {
      await setContext(c1)
      await setContext(c2)

      // Session 1 books the payout but does not commit yet: it holds the
      // row locks on both claims.
      const r1 = await callRpc(c1, companyId, [a, b])
      expect(r1.ok).toBe(true)

      // Session 2 issues the identical request. Without the FOR UPDATE it
      // would read both claims as 'registered' and book a second transfer.
      let settled = false
      const pending = callRpc(c2, companyId, [b, a]).then((r) => {
        settled = true
        return r
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(settled).toBe(false)

      await c1.query('COMMIT')
      const r2 = await pending
      expect(r2).toMatchObject({ ok: false, code: 'ALREADY_PAID' })
      await c2.query('ROLLBACK')
    } finally {
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    const state = await payoutState(companyId, [a, b])
    expect(state.batches).toBe(1)
    expect(state.postedPayouts).toBe(1)
    expect(state.claims.map((c) => c.status)).toEqual(['paid', 'paid'])
  })

  it('refuses viewers and non-members without touching the ledger', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId, userId)
    const a = await insertClaim(companyId, userId, 100)

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    const stranger = await insertAuthUser()

    for (const uid of [viewer, stranger]) {
      await withUserContext(uid, async (client) => {
        const r = await callRpc(client, companyId, [a])
        expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      })
    }

    expect(await payoutState(companyId, [a])).toMatchObject({
      batches: 0,
      postedPayouts: 0,
      claims: [{ status: 'registered', payout_batch_id: null }],
    })
  })

  it('refuses mixed claimants, unknown ids, and an off-chart cash account', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId, userId)
    const owner = await insertClaim(companyId, userId, 100)
    const other = await insertClaim(companyId, userId, 100, { claimantName: 'Anna Anställd' })

    await withUserContext(userId, async (client) => {
      expect(await callRpc(client, companyId, [owner, other])).toMatchObject({
        ok: false,
        code: 'MIXED_CLAIMANTS',
      })
      expect(await callRpc(client, companyId, [owner, randomUUID()])).toMatchObject({
        ok: false,
        code: 'CLAIMS_NOT_FOUND',
      })
      expect(await callRpc(client, companyId, [owner], { cash: '1940' })).toMatchObject({
        ok: false,
        code: 'ACCOUNT_NOT_IN_CHART',
      })
      expect(await callRpc(client, companyId, [owner], { date: '2027-03-01' })).toMatchObject({
        ok: false,
        code: 'FISCAL_PERIOD_NOT_FOUND',
      })
    })

    expect(await payoutState(companyId, [owner, other])).toMatchObject({ batches: 0, postedPayouts: 0 })
  })

  it('books the payout FROM an unbooked bank outflow and links the row in the same transaction', async () => {
    const { companyId, userId } = await seedCompany()
    await seedChart(companyId, userId)
    const c1 = await insertClaim(companyId, userId, 1196)
    const c2 = await insertClaim(companyId, userId, 400)
    const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1930' })
    const txId = await insertTransaction({
      companyId,
      userId,
      amount: -1596,
      date: '2026-08-31',
      description: 'Överföring Ägare',
      cashAccountId,
    })

    const result = await asUser(userId, (c) => callRpc(c, companyId, [c1, c2], { transactionId: txId }))
    expect(result.ok).toBe(true)
    expect(result.transaction_id).toBe(txId)

    const { rows: tx } = await getPool().query(
      `SELECT journal_entry_id, is_business, reconciliation_method FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(tx[0]).toEqual({
      journal_entry_id: result.journal_entry_id,
      is_business: true,
      reconciliation_method: 'manual',
    })
    const { rows: claims } = await getPool().query(
      `SELECT status FROM public.expense_claims WHERE id = ANY($1::uuid[])`,
      [[c1, c2]],
    )
    expect(claims.map((r) => r.status)).toEqual(['paid', 'paid'])
    const { rows: booked } = await getPool().query(`SELECT public.is_transaction_booked($1) AS b`, [txId])
    expect(booked[0].b).toBe(true)
  })

  it('refuses a bank row whose amount differs from the claims, or that is already booked, without touching anything', async () => {
    const { companyId, userId } = await seedCompany()
    await seedChart(companyId, userId)
    const c1 = await insertClaim(companyId, userId, 1240)
    const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1930' })
    const wrongAmount = await insertTransaction({ companyId, userId, amount: -1200, cashAccountId })

    const mismatch = await asUser(userId, (c) => callRpc(c, companyId, [c1], { transactionId: wrongAmount }))
    expect(mismatch).toMatchObject({ ok: false, code: 'TX_AMOUNT_MISMATCH' })

    const inflow = await insertTransaction({ companyId, userId, amount: 1240, cashAccountId })
    const notOutflow = await asUser(userId, (c) => callRpc(c, companyId, [c1], { transactionId: inflow }))
    expect(notOutflow).toMatchObject({ ok: false, code: 'TX_AMOUNT_MISMATCH' })

    // Book the right row once, then try to book it again: the second call must
    // see it as booked (the claims are already paid too, but the row check
    // runs first for a fresh set of claims).
    const right = await insertTransaction({ companyId, userId, amount: -1240, cashAccountId })
    const first = await asUser(userId, (c) => callRpc(c, companyId, [c1], { transactionId: right }))
    expect(first.ok).toBe(true)
    const c2 = await insertClaim(companyId, userId, 1240)
    const again = await asUser(userId, (c) => callRpc(c, companyId, [c2], { transactionId: right }))
    expect(again).toMatchObject({ ok: false, code: 'TX_ALREADY_BOOKED' })

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1 AND source_type = 'expense_payout'`,
      [companyId],
    )
    expect(rows[0].n).toBe(1)
    const { rows: c2rows } = await getPool().query(`SELECT status FROM public.expense_claims WHERE id = $1`, [c2])
    expect(c2rows[0].status).toBe('registered')
  })
})
