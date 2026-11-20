import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'

/**
 * A proposal's number (migration 20261117192101):
 * pending_operations.operation_number, per company, counting up in the order
 * proposals are staged, assigned by the BEFORE INSERT trigger
 * pending_operations_assign_number from the per-company counter
 * pending_operation_sequences, and frozen from then on by
 * enforce_pending_operations_input_frozen.
 *
 * What must hold, whoever writes and through whichever door:
 *   - a company's proposals are numbered 1, 2, 3 in staging order, and every
 *     company starts at 1;
 *   - stagings that overlap, and one statement that stages many rows, never
 *     share a number;
 *   - a number is the database's: a writer cannot choose it, nobody can
 *     change it, and it is never handed out twice;
 *   - the table's RLS is what it was, and no API role reaches the counter.
 *
 * Numbering the rows that existed before the migration is proven where
 * existing rows are: tests/pg/upgrade (seed.sql, assert.sql).
 */

type Queryable = Pool | PoolClient

interface Staged {
  id: string
  operation_number: number | null
}

/** Stage one proposal the way the server does: a plain INSERT, no number sent. */
async function stage(client: Queryable, userId: string, companyId: string, title = 'Skapa leverantör'): Promise<Staged> {
  const { rows } = await client.query<Staged>(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params)
     VALUES ($1, $2, 'create_supplier', $3, '{}')
     RETURNING id, operation_number`,
    [userId, companyId, title],
  )
  return rows[0]!
}

async function numberOf(id: string): Promise<number | null> {
  const { rows } = await getPool().query<{ operation_number: number | null }>(
    `SELECT operation_number FROM public.pending_operations WHERE id = $1`,
    [id],
  )
  return rows[0]!.operation_number
}

async function counterOf(companyId: string): Promise<number | null> {
  const { rows } = await getPool().query<{ last_number: number }>(
    `SELECT last_number FROM public.pending_operation_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]?.last_number ?? null
}

async function existingCountOf(companyId: string): Promise<number | null> {
  const { rows } = await getPool().query<{ existing_count: number }>(
    `SELECT existing_count FROM public.pending_operation_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]?.existing_count ?? null
}

/** Run `fn` as `role` in a transaction that is always rolled back. */
async function asRole<T>(role: 'anon' | 'authenticated', fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL ROLE ${role}`)
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('operation_number: per company, in staging order', () => {
  it('numbers a company\'s proposals 1, 2, 3 as they are staged, and starts every company at 1', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    expect(await counterOf(a.companyId)).toBeNull()

    expect((await stage(getPool(), a.userId, a.companyId)).operation_number).toBe(1)
    expect((await stage(getPool(), a.userId, a.companyId)).operation_number).toBe(2)
    expect((await stage(getPool(), b.userId, b.companyId)).operation_number).toBe(1)
    expect((await stage(getPool(), a.userId, a.companyId)).operation_number).toBe(3)
    expect((await stage(getPool(), b.userId, b.companyId)).operation_number).toBe(2)

    expect(await counterOf(a.companyId)).toBe(3)
    expect(await counterOf(b.companyId)).toBe(2)
    // A company that had no proposal when numbering began owes no number to
    // an older one (tests/pg/upgrade proves the count for one that had).
    expect(await existingCountOf(a.companyId)).toBe(0)
  })

  it('gives every row of one statement its own number, in row order', async () => {
    const { userId, companyId } = await seedCompany()
    // What a run that stages many proposals at once sends: one INSERT.
    const { rows } = await getPool().query<{ title: string; operation_number: number }>(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params)
       SELECT $1, $2, 'create_supplier', 'Rad ' || g, '{}' FROM generate_series(1, 25) g
       RETURNING title, operation_number`,
      [userId, companyId],
    )
    expect(rows).toHaveLength(25)
    for (const row of rows) expect(row.title).toBe(`Rad ${row.operation_number}`)
    expect(new Set(rows.map((row) => row.operation_number)).size).toBe(25)
    expect(await counterOf(companyId)).toBe(25)
  })

  it('counts each company on its own inside one statement that stages for two', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const { rows } = await getPool().query<{ company_id: string; title: string; operation_number: number }>(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params)
       VALUES ($1, $2, 'create_supplier', 'a1', '{}'),
              ($3, $4, 'create_supplier', 'b1', '{}'),
              ($1, $2, 'create_supplier', 'a2', '{}'),
              ($1, $2, 'create_supplier', 'a3', '{}'),
              ($3, $4, 'create_supplier', 'b2', '{}')
       RETURNING company_id, title, operation_number`,
      [a.userId, a.companyId, b.userId, b.companyId],
    )
    expect(Object.fromEntries(rows.map((row) => [row.title, row.operation_number]))).toEqual({ a1: 1, b1: 1, a2: 2, a3: 3, b2: 2 })
  })
})

describe('operation_number: stagings at the same time', () => {
  it('hands out 1 to 40, each once, to forty stagings sent at once', async () => {
    const { userId, companyId } = await seedCompany()
    const staged = await Promise.all(Array.from({ length: 40 }, () => stage(getPool(), userId, companyId)))
    const numbers = staged.map((row) => row.operation_number as number).sort((x, y) => x - y)
    expect(numbers).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    expect(await counterOf(companyId)).toBe(40)
  })

  it('makes overlapping transactions take turns: each gets the number after the one that committed before it', async () => {
    const { userId, companyId } = await seedCompany()
    const first = await stage(getPool(), userId, companyId)
    expect(first.operation_number).toBe(1)

    const clients = await Promise.all(Array.from({ length: 6 }, () => getClient()))
    const inCommitOrder: number[] = []
    try {
      await Promise.all(
        clients.map(async (client) => {
          await client.query('BEGIN')
          try {
            // Blocks on the company's counter row until the transaction that
            // holds it commits.
            const row = await stage(client, userId, companyId)
            // Keep it open, so the others really do wait behind this one.
            await new Promise((resolve) => setTimeout(resolve, 30))
            inCommitOrder.push(row.operation_number as number)
            await client.query('COMMIT')
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {})
            throw err
          }
        }),
      )
    } finally {
      for (const client of clients) client.release()
    }

    // Distinct, without a hole, and increasing in the order they committed.
    expect(inCommitOrder).toEqual([2, 3, 4, 5, 6, 7])
    const { rows } = await getPool().query<{ operation_number: number }>(
      `SELECT operation_number FROM public.pending_operations WHERE company_id = $1 ORDER BY created_at, id`,
      [companyId],
    )
    expect(rows.map((row) => row.operation_number).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('does not let one company\'s open staging hold up another company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const holder = await getClient()
    try {
      await holder.query('BEGIN')
      await stage(holder, a.userId, a.companyId)
      // Company A's counter is locked by the open transaction; B stages at
      // once. Were B waiting on A it would wait until the rollback below, so
      // the limit only has to outlast a slow server: the suite runs on
      // several workers against one Postgres (tests/pg/parallel.ts).
      const other = await Promise.race([
        stage(getPool(), b.userId, b.companyId),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 10_000)),
      ])
      expect(other).not.toBe('blocked')
      expect((other as Staged).operation_number).toBe(1)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
  })
})

describe('operation_number: the database\'s, never the writer\'s', () => {
  it('overwrites a number the writer sends, for the table owner and for the service role', async () => {
    const { userId, companyId } = await seedCompany()
    const chosen = `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params, operation_number)
                    VALUES ($1, $2, 'create_supplier', 'Skapa leverantör', '{}', $3)
                    RETURNING operation_number`

    const asOwner = await getPool().query<{ operation_number: number }>(chosen, [userId, companyId, 999])
    expect(asOwner.rows[0]!.operation_number).toBe(1)

    const asService = await runAsServiceRole((client) => client.query<{ operation_number: number }>(chosen, [userId, companyId, 1]))
    expect(asService.rows[0]!.operation_number).toBe(2)
  })

  it('gives a rolled-back staging its number back, and never hands out a deleted proposal\'s number again', async () => {
    const { userId, companyId } = await seedCompany()
    expect((await stage(getPool(), userId, companyId)).operation_number).toBe(1)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      expect((await stage(client, userId, companyId)).operation_number).toBe(2)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    const second = await stage(getPool(), userId, companyId)
    expect(second.operation_number).toBe(2)

    // A waiting proposal can still be deleted by the table owner (the decided
    // ones cannot). Its number is gone with it: a name is not reused.
    await getPool().query(`DELETE FROM public.pending_operations WHERE id = $1`, [second.id])
    expect((await stage(getPool(), userId, companyId)).operation_number).toBe(3)
  })

  it('refuses every change of the number of a waiting proposal, whoever asks', async () => {
    const { userId, companyId } = await seedCompany()
    await setActiveCompany(userId, companyId)
    const { id } = await stage(getPool(), userId, companyId)
    const change = `UPDATE public.pending_operations SET operation_number = $2 WHERE id = $1`
    const frozen = /operation_number is frozen after insert/

    await expect(getPool().query(change, [id, 7])).rejects.toThrow(frozen)
    await expect(getPool().query(change, [id, null])).rejects.toThrow(frozen)
    await expect(runAsServiceRole((client) => client.query(change, [id, 7]))).rejects.toThrow(frozen)

    // The member reaches the row (their UPDATE policy lets a harmless write
    // through), so the refusal below is the trigger's, not RLS hiding the row.
    const touched = await withUserContext(userId, (client) =>
      client.query(`UPDATE public.pending_operations SET title = title WHERE id = $1`, [id]),
    )
    expect(touched.rowCount).toBe(1)
    await expect(withUserContext(userId, (client) => client.query(change, [id, 7]))).rejects.toThrow(frozen)

    expect(await numberOf(id)).toBe(1)
  })

  it('keeps the number through the decision, and on a decided proposal for good', async () => {
    const { userId, companyId } = await seedCompany()
    for (const status of ['committed', 'rejected']) {
      const { id, operation_number } = await stage(getPool(), userId, companyId)
      // An UPDATE that names the number without changing it is not a change.
      await getPool().query(
        `UPDATE public.pending_operations SET status = $2, resolved_at = now(), operation_number = operation_number WHERE id = $1`,
        [id, status],
      )
      expect(await numberOf(id)).toBe(operation_number)
      await expect(
        getPool().query(`UPDATE public.pending_operations SET operation_number = 99 WHERE id = $1`, [id]),
      ).rejects.toThrow(/terminal state/)
      expect(await numberOf(id)).toBe(operation_number)
    }
  })

  it('leaves a row without a company to the table\'s own NOT NULL, and counts nothing for it', async () => {
    const { userId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params)
         VALUES ($1, NULL, 'create_supplier', 'Skapa leverantör', '{}')`,
        [userId],
      ),
    ).rejects.toThrow(/null value in column "company_id" of relation "pending_operations"/)
  })

  it('refuses a second proposal with a number its company already has', async () => {
    const { userId, companyId } = await seedCompany()
    await stage(getPool(), userId, companyId)
    // Only with the trigger out of the way can a duplicate even be tried.
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`ALTER TABLE public.pending_operations DISABLE TRIGGER pending_operations_assign_number`)
      await expect(
        client.query(
          `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params, operation_number)
           VALUES ($1, $2, 'create_supplier', 'Skapa leverantör', '{}', 1)`,
          [userId, companyId],
        ),
      ).rejects.toThrow(/pending_operations_company_operation_number_uniq/)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

describe('operation_number: RLS as it was, and a counter no API role reaches', () => {
  it('leaves pending_operations with the three policies it had', async () => {
    const { rows } = await getPool().query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'pending_operations'
        ORDER BY policyname`,
    )
    expect(rows).toEqual([
      { policyname: 'pending_operations_chat_insert', cmd: 'INSERT' },
      { policyname: 'pending_operations_select', cmd: 'SELECT' },
      { policyname: 'pending_operations_update', cmd: 'UPDATE' },
    ])
  })

  it('lets a member read the number of their company\'s proposal, and shows a stranger no row', async () => {
    const { userId, companyId } = await seedCompany()
    const stranger = await seedCompany()
    const { id } = await stage(getPool(), userId, companyId)
    const read = (reader: string) =>
      withUserContext(reader, async (client) =>
        (await client.query<{ operation_number: number }>(`SELECT operation_number FROM public.pending_operations WHERE id = $1`, [id])).rows,
      )
    expect(await read(userId)).toEqual([{ operation_number: 1 }])
    expect(await read(stranger.userId)).toEqual([])
  })

  it('numbers a proposal the in-app chat stages as the member, who cannot touch the counter', async () => {
    const { userId, companyId } = await seedCompany()
    await stage(getPool(), userId, companyId)

    // withUserContext rolls back: stage and read in one scope.
    const staged = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ operation_number: number }>(
        `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params, actor_type)
         VALUES ($1, $2, 'create_supplier', 'Skapa leverantör', '{}', 'agent_chat')
         RETURNING operation_number`,
        [userId, companyId],
      )
      return rows[0]!.operation_number
    })
    expect(staged).toBe(2)

    // The same member, staging as anything but the chat: no INSERT policy, as before.
    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params, actor_type)
           VALUES ($1, $2, 'create_supplier', 'Skapa leverantör', '{}', 'api_key')`,
          [userId, companyId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('keeps the counter from every API role but the service role: RLS on, no policy, no grant', async () => {
    const { userId, companyId } = await seedCompany()
    await stage(getPool(), userId, companyId)

    const { rows: table } = await getPool().query<{ relrowsecurity: boolean; policies: number }>(
      `SELECT c.relrowsecurity,
              (SELECT count(*)::int FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = 'pending_operation_sequences') AS policies
         FROM pg_class c
        WHERE c.oid = 'public.pending_operation_sequences'::regclass`,
    )
    expect(table).toEqual([{ relrowsecurity: true, policies: 0 }])

    const denied = { code: '42501' }
    for (const sql of [
      `SELECT last_number FROM public.pending_operation_sequences`,
      `UPDATE public.pending_operation_sequences SET last_number = 0`,
      `INSERT INTO public.pending_operation_sequences (company_id, last_number) VALUES ('${companyId}', 0)`,
      `DELETE FROM public.pending_operation_sequences`,
    ]) {
      await expect(withUserContext(userId, (client) => client.query(sql))).rejects.toMatchObject(denied)
      await expect(asRole('anon', (client) => client.query(sql))).rejects.toMatchObject(denied)
    }

    // Nobody calls the trigger function directly either.
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(asRole(role, (client) => client.query(`SELECT public.assign_pending_operation_number()`))).rejects.toMatchObject(denied)
    }
    expect(await counterOf(companyId)).toBe(1)
  })

  it('still numbers for a second member of the company, in the same series', async () => {
    const { userId, companyId } = await seedCompany()
    const colleague = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: colleague, role: 'member' })
    expect((await stage(getPool(), userId, companyId)).operation_number).toBe(1)
    expect((await stage(getPool(), colleague, companyId)).operation_number).toBe(2)
  })
})
