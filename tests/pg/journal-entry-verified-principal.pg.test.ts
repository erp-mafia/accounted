import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompanyMember,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261016110000_journal_entry_verified_principal and
 * 20261016110100_verified_actor_disagreements.
 *
 * Every commit records, beside the actor the application asserts
 * (committed_actor_type / committed_actor_label), the principal the database
 * itself observed: committed_auth_role (the role the request ran as) and
 * committed_auth_uid (auth.uid()). Record-only: the stamp never refuses and
 * never fails a commit, whatever the request's claims look like, and nothing
 * else about a commit changes. verified_actor_disagreements() lists the
 * commits the planned refusal rules would have stopped.
 */

interface Stamp {
  status: string
  voucher_number: number
  commit_method: string | null
  committed_actor_type: string | null
  committed_actor_label: string | null
  committed_by: string | null
  committed_auth_role: string | null
  committed_auth_uid: string | null
}

const STAMP_SQL = `
  SELECT status, voucher_number, commit_method, committed_actor_type, committed_actor_label,
         committed_by, committed_auth_role, committed_auth_uid::text AS committed_auth_uid
    FROM public.journal_entries WHERE id = $1`

const COMMIT_SQL = `SELECT voucher_number FROM public.commit_journal_entry($1, $2, $3, $4, $5, $6)`

async function stamp(entryId: string, client?: PoolClient): Promise<Stamp> {
  const { rows } = await (client ?? getPool()).query<Stamp>(STAMP_SQL, [entryId])
  return rows[0]
}

async function preparedDraft(seed?: { userId: string; companyId: string; fiscalPeriodId: string }) {
  const s = seed ?? (await seedCompany())
  const entryId = await insertDraftJournalEntry({
    userId: s.userId,
    companyId: s.companyId,
    fiscalPeriodId: s.fiscalPeriodId,
  })
  await insertBalancedLines(entryId, 1250)
  return { ...s, entryId }
}

/**
 * Commit as a signed-in user the way PostgREST presents one (JWT claims, then
 * SET LOCAL ROLE authenticated) and keep the result: unlike withUserContext,
 * this COMMITs, so later assertions and the diagnostic see the posted row.
 */
async function commitAsUser(
  userId: string,
  companyId: string,
  entryId: string,
  actorType: string | null,
  actorLabel: string | null,
): Promise<number> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`)
    await client.query('SET LOCAL ROLE authenticated')
    const { rows } = await client.query<{ voucher_number: number }>(COMMIT_SQL, [
      companyId,
      entryId,
      'user_accept',
      null,
      actorType,
      actorLabel,
    ])
    await client.query('COMMIT')
    return rows[0].voucher_number
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

describe('commit_journal_entry stamps the verified principal beside the asserted actor', () => {
  it('a signed-in user: role authenticated and the uid of the JWT', async () => {
    const { userId, companyId, entryId } = await preparedDraft()

    const after = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ voucher_number: number }>(COMMIT_SQL, [
        companyId,
        entryId,
        'user_accept',
        null,
        'user',
        'anna@example.test',
      ])
      expect(rows[0].voucher_number).toBe(1)
      return stamp(entryId, client)
    })

    expect(after).toEqual({
      status: 'posted',
      voucher_number: 1,
      commit_method: 'user_accept',
      committed_actor_type: 'user',
      committed_actor_label: 'anna@example.test',
      committed_by: userId,
      committed_auth_role: 'authenticated',
      committed_auth_uid: userId,
    })
  })

  it('the service role (API key, MCP, cron routes): role service_role and no uid', async () => {
    const { userId, companyId, entryId } = await preparedDraft()

    await runAsServiceRole((client) =>
      client.query(COMMIT_SQL, [companyId, entryId, null, null, 'cron', 'bank-sync']),
    )

    expect(await stamp(entryId)).toEqual({
      status: 'posted',
      voucher_number: 1,
      commit_method: null,
      committed_actor_type: 'cron',
      committed_actor_label: 'bank-sync',
      committed_by: userId,
      committed_auth_role: 'service_role',
      committed_auth_uid: null,
    })
  })

  it('a direct connection with no claims at all still commits, stamped with its login role', async () => {
    const { companyId, entryId } = await preparedDraft()

    await getPool().query(COMMIT_SQL, [companyId, entryId, null, null, 'system', 'operator script'])

    expect(await stamp(entryId)).toMatchObject({
      status: 'posted',
      voucher_number: 1,
      committed_actor_type: 'system',
      committed_actor_label: 'operator script',
      committed_auth_role: 'postgres',
      committed_auth_uid: null,
    })
  })

  // Claims the posting path itself already tolerates (it parses them as
  // JSON before the stamp is reached) but that name no subject: the commit
  // goes through and the stamp records no uid.
  it.each(['', '[]', 'null', '"not an object"', '{"role":["authenticated"]}', '{}'])(
    'request.jwt.claims %j without a usable subject still commits',
    async (claims) => {
      const { companyId, entryId } = await preparedDraft()
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims])
        await client.query(`SELECT set_config('request.jwt.claim.sub', '', true)`)
        await client.query(COMMIT_SQL, [companyId, entryId, null, null, null, null])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }

      expect(await stamp(entryId)).toMatchObject({
        status: 'posted',
        voucher_number: 1,
        committed_auth_role: 'postgres',
        committed_auth_uid: null,
      })
    },
  )

  // The stamp alone, on a scratch table carrying the columns it reads: claims
  // that are not JSON and a sub that is not a uuid make auth.uid() raise. The
  // existing posting path refuses those before the stamp runs (it parses the
  // claims itself), so this pins that the stamp would never be the reason.
  it('never raises on a malformed claims setting or a sub that is not a uuid, and keeps the role it read', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`
        CREATE TEMP TABLE verified_principal_probe (
          id integer PRIMARY KEY,
          status text NOT NULL DEFAULT 'draft',
          committed_auth_role text,
          committed_auth_uid uuid
        ) ON COMMIT DROP`)
      await client.query(`
        CREATE TRIGGER stamp_probe BEFORE INSERT OR UPDATE ON verified_principal_probe
          FOR EACH ROW EXECUTE FUNCTION public.stamp_journal_entry_verified_principal()`)
      await client.query('GRANT SELECT, INSERT, UPDATE ON verified_principal_probe TO authenticated')
      await client.query(`SELECT set_config('request.jwt.claims', 'this is not json', true)`)
      await client.query(`SELECT set_config('request.jwt.claim.sub', 'not-a-uuid', true)`)

      // The probe really exercises the failure: auth.uid() raises here.
      await client.query('SAVEPOINT uid_raises')
      await expect(client.query('SELECT auth.uid()')).rejects.toMatchObject({ code: expect.any(String) })
      await client.query('ROLLBACK TO SAVEPOINT uid_raises')

      await client.query(`INSERT INTO verified_principal_probe (id) VALUES (1), (2)`)
      await client.query(`UPDATE verified_principal_probe SET status = 'posted' WHERE id = 1`)

      await client.query('SET LOCAL ROLE authenticated')
      await client.query(`UPDATE verified_principal_probe SET status = 'posted' WHERE id = 2`)
      await client.query('RESET ROLE')

      const { rows } = await client.query(
        `SELECT id, status, committed_auth_role, committed_auth_uid FROM verified_principal_probe ORDER BY id`,
      )
      expect(rows).toEqual([
        { id: 1, status: 'posted', committed_auth_role: 'postgres', committed_auth_uid: null },
        { id: 2, status: 'posted', committed_auth_role: 'authenticated', committed_auth_uid: null },
      ])
      await client.query('ROLLBACK')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })
})

describe('the stamp is the database observation, never the caller value', () => {
  it('a draft carries no stamp, whatever its insert or update says', async () => {
    const s = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId })

    await getPool().query(
      `UPDATE public.journal_entries
          SET committed_auth_role = 'service_role', committed_auth_uid = $2
        WHERE id = $1`,
      [entryId, s.userId],
    )

    expect(await stamp(entryId)).toMatchObject({ status: 'draft', committed_auth_role: null, committed_auth_uid: null })
  })

  it('the commit overwrites a value the posting statement sets itself', async () => {
    const { userId, entryId } = await preparedDraft()

    await getPool().query(
      `UPDATE public.journal_entries
          SET status = 'posted', committed_auth_role = 'authenticated', committed_auth_uid = $2
        WHERE id = $1`,
      [entryId, userId],
    )

    expect(await stamp(entryId)).toMatchObject({
      status: 'posted',
      committed_auth_role: 'postgres',
      committed_auth_uid: null,
    })
  })

  it('is frozen once posted: a direct edit is refused, and a reversal keeps the stamp', async () => {
    const { userId, companyId, fiscalPeriodId, entryId } = await preparedDraft()
    await commitAsUser(userId, companyId, entryId, 'user', null)

    await expect(
      getPool().query(`UPDATE public.journal_entries SET committed_auth_role = 'service_role' WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/Cannot modify a posted journal entry/i)

    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.journal_entries
         (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
          description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, 0, 'A', '2026-06-15', 'storno', 'storno', 'draft', $4)
       RETURNING id`,
      [userId, companyId, fiscalPeriodId, entryId],
    )
    const stornoId = rows[0].id
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 0, 1250), ($1, '3001', 1250, 0)`,
      [stornoId],
    )
    await runAsServiceRole((client) => client.query(COMMIT_SQL, [companyId, stornoId, null, null, 'api_key', 'Key']))
    // The reversed branch of the immutability trigger lists the fields it
    // locks; the stamp is held by its own trigger, so a statement that tries
    // to rewrite it during the reversal leaves it as it was.
    await getPool().query(
      `UPDATE public.journal_entries
          SET status = 'reversed', reversed_by_id = $2,
              committed_auth_role = 'service_role', committed_auth_uid = NULL
        WHERE id = $1 AND status = 'posted'`,
      [entryId, stornoId],
    )

    expect(await stamp(entryId)).toMatchObject({
      status: 'reversed',
      committed_auth_role: 'authenticated',
      committed_auth_uid: userId,
    })
    expect(await stamp(stornoId)).toMatchObject({
      status: 'posted',
      committed_actor_type: 'api_key',
      committed_auth_role: 'service_role',
      committed_auth_uid: null,
    })
  })
})

describe('everything else about a commit is unchanged', () => {
  it('voucher numbers stay sequential across principals, and the audit row and the outbox event name the asserted actor', async () => {
    const first = await preparedDraft()
    const second = await preparedDraft(first)
    const third = await preparedDraft(first)

    const n1 = await commitAsUser(first.userId, first.companyId, first.entryId, 'user', null)
    const [n2] = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ voucher_number: number }>(COMMIT_SQL, [
        first.companyId, second.entryId, 'api_key', null, 'api_key', 'Key A',
      ])
      return rows.map((r) => r.voucher_number)
    })
    const { rows: direct } = await getPool().query<{ voucher_number: number }>(COMMIT_SQL, [
      first.companyId, third.entryId, null, null, null, null,
    ])
    expect([n1, n2, direct[0].voucher_number]).toEqual([1, 2, 3])

    const { rows: audit } = await getPool().query(
      `SELECT actor_type, actor_label FROM public.audit_log WHERE record_id = $1 AND action = 'COMMIT'`,
      [second.entryId],
    )
    expect(audit).toEqual([{ actor_type: 'api_key', actor_label: 'Key A' }])

    const { rows: events } = await getPool().query<{ data: { entry: Record<string, unknown> } }>(
      `SELECT data FROM public.event_log WHERE entity_id = $1 AND event_type = 'journal_entry.committed'`,
      [first.entryId],
    )
    expect(events).toHaveLength(1)
    expect(events[0].data.entry).toMatchObject({
      committed_actor_type: 'user',
      committed_auth_role: 'authenticated',
      committed_auth_uid: first.userId,
    })
  })

  it('an unbalanced entry is still refused, and stays an unstamped draft', async () => {
    const s = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 100, 0), ($1, '3001', 0, 90)`,
      [entryId],
    )

    // The balance check is deferred to COMMIT, so this commits rather than
    // rolling back the way withUserContext does.
    await expect(commitAsUser(s.userId, s.companyId, entryId, 'user', null)).rejects.toThrow()

    expect(await stamp(entryId)).toMatchObject({
      status: 'draft',
      voucher_number: 0,
      committed_auth_role: null,
      committed_auth_uid: null,
    })
  })

  it('a locked period is still refused, and the entry stays an unstamped draft', async () => {
    const { userId, companyId, fiscalPeriodId, entryId } = await preparedDraft()
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [fiscalPeriodId])

    await expect(
      withUserContext(userId, (client) => client.query(COMMIT_SQL, [companyId, entryId, null, null, 'user', null])),
    ).rejects.toThrow(/locked\/closed fiscal period/)

    expect(await stamp(entryId)).toMatchObject({
      status: 'draft',
      voucher_number: 0,
      committed_auth_role: null,
      committed_auth_uid: null,
    })
  })

  it('the stamp is a plain trigger: not SECURITY DEFINER, one per table, no constraint on the columns', async () => {
    const { rows: fn } = await getPool().query(
      `SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'stamp_journal_entry_verified_principal'`,
    )
    expect(fn).toEqual([{ prosecdef: false }])

    const { rows: triggers } = await getPool().query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'public.journal_entries'::regclass AND NOT tgisinternal
          AND tgfoid = 'public.stamp_journal_entry_verified_principal()'::regprocedure`,
    )
    expect(triggers).toEqual([{ tgname: 'stamp_journal_entry_verified_principal' }])

    const { rows: constraints } = await getPool().query(
      `SELECT conname FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'public.journal_entries'::regclass
          AND a.attname IN ('committed_auth_role', 'committed_auth_uid')`,
    )
    expect(constraints).toEqual([])
  })
})

describe('verified_actor_disagreements: the commits the planned refusal rules would stop', () => {
  it('lists an end user asserting a machine actor and a uid other than the entry user, and nothing else', async () => {
    const s = await seedCompany()
    const colleagueId = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: colleagueId, role: 'member' })

    const honest = await preparedDraft(s)
    const machine = await preparedDraft(s)
    const colleague = await preparedDraft(s)
    const serviceCron = await preparedDraft(s)
    const direct = await preparedDraft(s)

    await commitAsUser(s.userId, s.companyId, honest.entryId, 'user', null)
    await commitAsUser(s.userId, s.companyId, machine.entryId, 'cron', 'nightly')
    // A colleague posts the owner's draft: legitimate today, and exactly the
    // case the data has to size before the uid rule may refuse anything.
    await commitAsUser(colleagueId, s.companyId, colleague.entryId, 'user', null)
    await runAsServiceRole((client) => client.query(COMMIT_SQL, [s.companyId, serviceCron.entryId, null, null, 'cron', 'nightly']))
    await getPool().query(COMMIT_SQL, [s.companyId, direct.entryId, null, null, 'system', 'script'])

    const { rows } = await getPool().query(
      `SELECT journal_entry_id::text, asserted_actor_type, asserted_user_id::text, verified_role,
              verified_uid::text, reason
         FROM public.verified_actor_disagreements($1)`,
      [s.companyId],
    )
    expect(rows).toEqual([
      {
        journal_entry_id: machine.entryId,
        asserted_actor_type: 'cron',
        asserted_user_id: s.userId,
        verified_role: 'authenticated',
        verified_uid: s.userId,
        reason: 'end_user_asserted_machine_actor',
      },
      {
        journal_entry_id: colleague.entryId,
        asserted_actor_type: 'user',
        asserted_user_id: s.userId,
        verified_role: 'authenticated',
        verified_uid: colleagueId,
        reason: 'verified_uid_differs_from_entry_user',
      },
    ])

    const { rows: later } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.verified_actor_disagreements($1, now() + interval '1 day')`,
      [s.companyId],
    )
    expect(later).toEqual([{ n: 0 }])
  })

  it('flags an authenticated commit whose uid could not be read', async () => {
    const { companyId, entryId } = await preparedDraft()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // No real path can produce this (an authenticated caller without a
      // readable sub cannot write the company), so the row is forged with the
      // stamp switched off inside a rolled-back transaction.
      await client.query('ALTER TABLE public.journal_entries DISABLE TRIGGER stamp_journal_entry_verified_principal')
      await client.query(
        `UPDATE public.journal_entries
            SET status = 'posted', committed_auth_role = 'authenticated', committed_auth_uid = NULL
          WHERE id = $1`,
        [entryId],
      )
      const { rows } = await client.query(
        `SELECT journal_entry_id::text, reason FROM public.verified_actor_disagreements($1)`,
        [companyId],
      )
      expect(rows).toEqual([{ journal_entry_id: entryId, reason: 'end_user_without_uid' }])
      await client.query('ROLLBACK')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  it('is for operators only: service_role may run it, the Data API end-user roles may not', async () => {
    const { rows } = await getPool().query(
      `SELECT r.rolname,
              has_function_privilege(r.rolname, 'public.verified_actor_disagreements(uuid, timestamptz)', 'EXECUTE') AS can
         FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') ORDER BY r.rolname`,
    )
    expect(rows).toEqual([
      { rolname: 'anon', can: false },
      { rolname: 'authenticated', can: false },
      { rolname: 'service_role', can: true },
    ])

    const { userId, companyId } = await seedCompany()
    await expect(
      withUserContext(userId, (client) => client.query(`SELECT * FROM public.verified_actor_disagreements($1)`, [companyId])),
    ).rejects.toMatchObject({ code: '42501' })
  })
})
