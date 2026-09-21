import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { primaryIneligibleReason } from '@/lib/cash-accounts/primary'
import { insertAuthUser, insertCashAccount, insertCompany, insertCompanyMember } from './fixtures'
import { getPool, runAsServiceRole, withUserContext } from './setup'

/**
 * Migration 20260921070500 (desk crm#59).
 *
 * cash_accounts.enabled and .is_primary redirect an automatic account choice
 * (resolveSettlementAccount, the skattekonto __PRIMARY_SEK__ counter account),
 * so a change is a behandlingsregel change (BFNAR 2013:2 p. 9.16): the
 * audit_cash_accounts_routing trigger writes who, when and from/to into the
 * immutable audit_log. make_cash_account_primary checks eligibility and swaps
 * the flag in one transaction; set_cash_account_primary keeps carrying the
 * flag for system merges with no rule.
 */

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

interface RoutingLogRow {
  action: string
  user_id: string | null
  actor_id: string | null
  actor_type: string
  company_id: string
  old_enabled: boolean | null
  new_enabled: boolean | null
  old_primary: boolean | null
  new_primary: boolean | null
}

/** Rows this migration's trigger wrote for one account, read on `client`. */
async function routingLog(client: PoolClient | ReturnType<typeof getPool>, recordId: string): Promise<RoutingLogRow[]> {
  const res = await client.query<RoutingLogRow>(
    `SELECT action, user_id, actor_id, actor_type, company_id,
            (old_state->>'enabled')::boolean    AS old_enabled,
            (new_state->>'enabled')::boolean    AS new_enabled,
            (old_state->>'is_primary')::boolean AS old_primary,
            (new_state->>'is_primary')::boolean AS new_primary
       FROM public.audit_log
      WHERE table_name = 'cash_accounts' AND record_id = $1
      ORDER BY created_at, id`,
    [recordId],
  )
  return res.rows
}

async function seedCompany(role: 'owner' | 'admin' | 'member' = 'owner') {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role })
  await setActiveCompany(userId, companyId)
  return { userId, companyId }
}

describe('audit_cash_accounts_routing trigger', () => {
  it('logs a user turning an account off with the user as actor and from/to', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertCashAccount({ companyId, ledgerAccount: '1930' })

    await withUserContext(userId, async (client) => {
      const upd = await client.query(`UPDATE public.cash_accounts SET enabled = false WHERE id = $1`, [id])
      expect(upd.rowCount).toBe(1)
      // withUserContext rolls back, so the log is read inside the transaction.
      // audit_log is service-role readable only through RLS: read as superuser
      // would miss the uncommitted row, so switch role for the read.
      await client.query('RESET ROLE')
      expect(await routingLog(client, id)).toEqual([
        {
          action: 'UPDATE',
          user_id: userId,
          actor_id: userId,
          actor_type: 'user',
          company_id: companyId,
          old_enabled: true,
          new_enabled: false,
          old_primary: false,
          new_primary: false,
        },
      ])
    })
  })

  it('logs a service-role change explicitly as system, with no user', async () => {
    const { companyId } = await seedCompany()
    const id = await insertCashAccount({ companyId, ledgerAccount: '1930', enabled: false })

    // The shape of reenableIfUnused() on a service client (Stripe sync, cron).
    await runAsServiceRole(async (client) => {
      await client.query(`UPDATE public.cash_accounts SET enabled = true WHERE id = $1`, [id])
    })

    expect(await routingLog(getPool(), id)).toEqual([
      {
        action: 'UPDATE',
        user_id: null,
        actor_id: null,
        actor_type: 'system',
        company_id: companyId,
        old_enabled: false,
        new_enabled: true,
        old_primary: false,
        new_primary: false,
      },
    ])
  })

  it('lets an actor type the caller set win over the default', async () => {
    const { companyId } = await seedCompany()
    const id = await insertCashAccount({ companyId, ledgerAccount: '1930' })
    await runAsServiceRole(async (client) => {
      await client.query(`SELECT set_config('gnubok.actor_type', 'cron', true)`)
      await client.query(`UPDATE public.cash_accounts SET enabled = false WHERE id = $1`, [id])
    })
    expect((await routingLog(getPool(), id)).map((r) => r.actor_type)).toEqual(['cron'])
  })

  it('writes nothing when neither column changes: sync churn and same-value rewrites', async () => {
    const { companyId } = await seedCompany()
    const id = await insertCashAccount({ companyId, ledgerAccount: '1930' })
    await runAsServiceRole(async (client) => {
      // What a bank sync does all day: balances and names, and an upsert that
      // rewrites enabled/is_primary with the value they already have.
      await client.query(
        `UPDATE public.cash_accounts
            SET balance = 1234.56, name = 'Renamed', enabled = true, is_primary = false
          WHERE id = $1`,
        [id],
      )
    })
    expect(await routingLog(getPool(), id)).toEqual([])
  })

  it('logs both rows of a primary swap', async () => {
    const { companyId } = await seedCompany()
    const from = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const to = await insertCashAccount({ companyId, ledgerAccount: '1940' })
    await runAsServiceRole(async (client) => {
      await client.query(`SELECT public.make_cash_account_primary($1, $2)`, [companyId, to])
    })
    expect((await routingLog(getPool(), from)).map((r) => [r.old_primary, r.new_primary])).toEqual([[true, false]])
    expect((await routingLog(getPool(), to)).map((r) => [r.old_primary, r.new_primary])).toEqual([[false, true]])
  })
})

describe('make_cash_account_primary', () => {
  it('swaps the primary for an owner, logged with the owner as actor', async () => {
    const { userId, companyId } = await seedCompany('owner')
    const from = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const to = await insertCashAccount({ companyId, ledgerAccount: '1940' })

    await withUserContext(userId, async (client) => {
      const res = await client.query<{ id: string; is_primary: boolean }>(
        `SELECT (r).id, (r).is_primary FROM public.make_cash_account_primary($1, $2) AS r`,
        [companyId, to],
      )
      expect(res.rows).toEqual([{ id: to, is_primary: true }])
      const flags = await client.query<{ id: string; is_primary: boolean }>(
        `SELECT id, is_primary FROM public.cash_accounts WHERE company_id = $1 ORDER BY ledger_account`,
        [companyId],
      )
      expect(flags.rows).toEqual([
        { id: from, is_primary: false },
        { id: to, is_primary: true },
      ])
      await client.query('RESET ROLE')
      const log = await routingLog(client, to)
      expect(log.map((r) => [r.user_id, r.actor_type])).toEqual([[userId, 'user']])
    })
  })

  it('is a no-op on the account that is already primary: no write, no log row', async () => {
    const { companyId } = await seedCompany()
    const id = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    await runAsServiceRole(async (client) => {
      await client.query(`SELECT public.make_cash_account_primary($1, $2)`, [companyId, id])
    })
    expect(await routingLog(getPool(), id)).toEqual([])
  })

  it('refuses a member inside the function, whatever the route said', async () => {
    const { userId, companyId } = await seedCompany('member')
    await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const to = await insertCashAccount({ companyId, ledgerAccount: '1940' })
    await expect(
      withUserContext(userId, (client) =>
        client.query(`SELECT public.make_cash_account_primary($1, $2)`, [companyId, to]),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('CASH_ACCOUNT_PRIMARY_ADMIN_ONLY') })
  })

  it("refuses another company's account as not found", async () => {
    const { userId, companyId } = await seedCompany()
    const other = await seedCompany()
    const foreign = await insertCashAccount({ companyId: other.companyId, ledgerAccount: '1940' })
    await expect(
      withUserContext(userId, (client) =>
        client.query(`SELECT public.make_cash_account_primary($1, $2)`, [companyId, foreign]),
      ),
    ).rejects.toMatchObject({ code: 'P0002', message: expect.stringContaining('CASH_ACCOUNT_NOT_FOUND') })
  })

  // Each refusal, and the same cases through the UI-side mirror: the settings
  // row must never offer a button the database refuses, nor hide one it allows.
  const cases = [
    { label: 'an enabled SEK bank account', ledgerAccount: '1940', currency: 'SEK', enabled: true, reason: null },
    { label: 'the low end of the range', ledgerAccount: '1920', currency: 'SEK', enabled: true, reason: null },
    { label: 'a disabled account', ledgerAccount: '1940', currency: 'SEK', enabled: false, reason: 'disabled' },
    { label: 'a currency account', ledgerAccount: '1950', currency: 'EUR', enabled: true, reason: 'not_sek' },
    { label: 'a PSP clearing account', ledgerAccount: '1686', currency: 'SEK', enabled: true, reason: 'not_bank_account' },
    { label: 'a till', ledgerAccount: '1910', currency: 'SEK', enabled: true, reason: 'not_bank_account' },
    // Order: disabled wins over currency, currency over ledger.
    { label: 'disabled and EUR and 1686', ledgerAccount: '1686', currency: 'EUR', enabled: false, reason: 'disabled' },
    { label: 'EUR and 1686', ledgerAccount: '1686', currency: 'EUR', enabled: true, reason: 'not_sek' },
  ] as const

  it.each(cases)('agrees with primaryIneligibleReason() for $label', async (c) => {
    const { companyId } = await seedCompany()
    const previous = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const target = await insertCashAccount({
      companyId,
      ledgerAccount: c.ledgerAccount,
      currency: c.currency,
      enabled: c.enabled,
    })

    expect(
      primaryIneligibleReason({ enabled: c.enabled, currency: c.currency, ledger_account: c.ledgerAccount }),
    ).toBe(c.reason)

    const call = runAsServiceRole((client) =>
      client.query(`SELECT public.make_cash_account_primary($1, $2)`, [companyId, target]),
    )
    if (c.reason === null) {
      await call
    } else {
      await expect(call).rejects.toMatchObject({
        code: '23514',
        message: `CASH_ACCOUNT_PRIMARY_INELIGIBLE: ${c.reason}`,
      })
    }

    const primary = await getPool().query<{ id: string }>(
      `SELECT id FROM public.cash_accounts WHERE company_id = $1 AND is_primary`,
      [companyId],
    )
    expect(primary.rows).toEqual([{ id: c.reason === null ? target : previous }])
  })

  // The window the TypeScript check had: a disable that commits between the
  // eligibility read and the swap. Inside the function there is no such gap.
  it('refuses a target that was disabled before the call, leaving the old primary', async () => {
    const { companyId } = await seedCompany()
    const previous = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const target = await insertCashAccount({ companyId, ledgerAccount: '1940' })
    await getPool().query(`UPDATE public.cash_accounts SET enabled = false WHERE id = $1`, [target])

    await expect(
      runAsServiceRole((client) =>
        client.query(`SELECT public.make_cash_account_primary($1, $2)`, [companyId, target]),
      ),
    ).rejects.toMatchObject({ message: 'CASH_ACCOUNT_PRIMARY_INELIGIBLE: disabled' })
    const primary = await getPool().query<{ id: string }>(
      `SELECT id FROM public.cash_accounts WHERE company_id = $1 AND is_primary`,
      [companyId],
    )
    expect(primary.rows).toEqual([{ id: previous }])
  })

  it('holds the row lock: a concurrent disable waits, then no longer matches its own predicate', async () => {
    const { companyId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const target = await insertCashAccount({ companyId, ledgerAccount: '1940' })

    const swapper = await getPool().connect()
    const disabler = await getPool().connect()
    try {
      await swapper.query('BEGIN')
      await swapper.query(`SELECT public.make_cash_account_primary($1, $2)`, [companyId, target])

      // setEnabled(false)'s exact predicate, from another session. It blocks on
      // the row the swap holds until that transaction ends.
      const disable = disabler.query(
        `UPDATE public.cash_accounts SET enabled = false
          WHERE id = $1 AND company_id = $2 AND bank_connection_id IS NULL AND is_primary = false`,
        [target, companyId],
      )
      const raced = await Promise.race([
        disable.then(() => 'finished' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 400)),
      ])
      expect(raced).toBe('blocked')

      await swapper.query('COMMIT')
      // READ COMMITTED re-checks the WHERE against the committed row: it is
      // primary now, so the disable matches nothing.
      expect((await disable).rowCount).toBe(0)
    } finally {
      await swapper.query('ROLLBACK').catch(() => {})
      swapper.release()
      disabler.release()
    }

    const row = await getPool().query<{ enabled: boolean; is_primary: boolean }>(
      `SELECT enabled, is_primary FROM public.cash_accounts WHERE id = $1`,
      [target],
    )
    expect(row.rows).toEqual([{ enabled: true, is_primary: true }])
  })
})

describe('set_cash_account_primary is unchanged for system merges', () => {
  // upsertFromPsd2 and the twin heal carry the flag onto the row a merge keeps,
  // and that row may be disabled or non-SEK (38 such primaries in prod on
  // 2026-09-21). The eligibility rule must not have leaked into this function.
  it.each([
    { label: 'a disabled row', enabled: false, currency: 'SEK', ledgerAccount: '1931' },
    { label: 'a non-SEK row', enabled: true, currency: 'USD', ledgerAccount: '1950' },
  ])('still carries the flag onto $label, and the move is logged', async (c) => {
    const { companyId } = await seedCompany()
    const from = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const keeper = await insertCashAccount({
      companyId,
      ledgerAccount: c.ledgerAccount,
      currency: c.currency,
      enabled: c.enabled,
    })
    await runAsServiceRole(async (client) => {
      await client.query(`SELECT public.set_cash_account_primary($1, $2)`, [companyId, keeper])
    })
    const primary = await getPool().query<{ id: string }>(
      `SELECT id FROM public.cash_accounts WHERE company_id = $1 AND is_primary`,
      [companyId],
    )
    expect(primary.rows).toEqual([{ id: keeper }])
    expect((await routingLog(getPool(), from)).map((r) => r.actor_type)).toEqual(['system'])
    expect((await routingLog(getPool(), keeper)).map((r) => r.actor_type)).toEqual(['system'])
  })
})
