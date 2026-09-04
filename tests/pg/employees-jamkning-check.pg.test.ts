/**
 * pg-real tests for 20260904120000_employees_jamkning_dates_check.sql
 * (#2256: the jämkning both-dates invariant declared as a CHECK constraint).
 *
 * The application validator (lib/salary/jamkning-rules.ts, PR #2240) refuses
 * a jamkning_percentage without both validity dates on every write path, but
 * a concurrent PATCH that validated a stale snapshot, or a direct SQL /
 * service-role write, could still store one. The constraint is the backstop:
 * the same rule, declared on the row, checked on every INSERT and UPDATE.
 *
 * Verifies:
 *   - constraint shape: CHECK on employees, added NOT VALID, commented
 *   - INSERT: percentage without valid_to / valid_from rejected; valid_to
 *     before valid_from rejected; percentage with both dates accepted; no
 *     percentage with stray dates accepted
 *   - UPDATE: nulling valid_to while the percentage stays rejected; valid_to
 *     before valid_from rejected; clearing the beslut accepted
 *   - the concurrent-PATCH race from the issue, with the second statement
 *     blocked on the first transaction's row lock, fails for the second
 *   - the legacy consequence of NOT VALID: a row stored incomplete before the
 *     constraint is refused on its next edit, related or not, until the
 *     beslut is completed or cleared
 *   - the error is SQLSTATE 23514 naming the constraint, which is what the
 *     application keys on (jamkningIssueFromDbError)
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getClient, getPool } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

const CONSTRAINT = 'employees_jamkning_dates_check'

interface PgError extends Error {
  code?: string
  constraint?: string
}

interface Jamkning {
  percentage: number | null
  from: string | null
  to: string | null
}

async function seedCompany(): Promise<{ userId: string; companyId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

function insertSql(id: string, companyId: string, userId: string, j: Jamkning) {
  return {
    text: `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
        employment_start, jamkning_percentage, jamkning_valid_from, jamkning_valid_to)
     VALUES ($1, $2, $3, 'Test', 'Testsson', $4, '0000', '2026-01-01', $5, $6, $7)`,
    // personnummer is unique per company; the ciphertext is never decrypted here.
    values: [id, companyId, userId, `enc-${id}`, j.percentage, j.from, j.to],
  }
}

async function insertEmployee(seed: { companyId: string; userId: string }, j: Jamkning): Promise<string> {
  const id = randomUUID()
  const q = insertSql(id, seed.companyId, seed.userId, j)
  await getPool().query(q.text, q.values)
  return id
}

// A row stored before the constraint existed: percentage set, valid_to
// missing. The constraint refuses that shape on INSERT, so the seed drops it
// for exactly this statement and re-adds it NOT VALID (the migration's own
// definition, read back from the catalog), inside one transaction so the
// constraint is back before anything else can run against the table.
async function insertLegacyIncompleteEmployee(seed: { companyId: string; userId: string }): Promise<string> {
  const id = randomUUID()
  const q = insertSql(id, seed.companyId, seed.userId, { percentage: 15, from: '2026-01-01', to: null })
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const def = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'public.employees'::regclass`,
      [CONSTRAINT],
    )
    const definition = def.rows[0]?.def
    if (!definition) throw new Error(`${CONSTRAINT} is missing: did the migration apply?`)
    await client.query(`ALTER TABLE public.employees DROP CONSTRAINT ${CONSTRAINT}`)
    await client.query(q.text, q.values)
    await client.query(
      `ALTER TABLE public.employees ADD CONSTRAINT ${CONSTRAINT} ${
        definition.includes('NOT VALID') ? definition : `${definition} NOT VALID`
      }`,
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  return id
}

async function readJamkning(id: string): Promise<Jamkning & { first_name: string }> {
  const res = await getPool().query<{
    first_name: string
    jamkning_percentage: string | null
    jamkning_valid_from: string | null
    jamkning_valid_to: string | null
  }>(
    `SELECT first_name, jamkning_percentage,
            to_char(jamkning_valid_from, 'YYYY-MM-DD') AS jamkning_valid_from,
            to_char(jamkning_valid_to, 'YYYY-MM-DD') AS jamkning_valid_to
       FROM public.employees WHERE id = $1`,
    [id],
  )
  const row = res.rows[0]
  return {
    first_name: row.first_name,
    percentage: row.jamkning_percentage === null ? null : Number(row.jamkning_percentage),
    from: row.jamkning_valid_from,
    to: row.jamkning_valid_to,
  }
}

async function captureError(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise
  } catch (err) {
    return err as PgError
  }
  throw new Error('expected the statement to be rejected')
}

// What the application keys on: the SQLSTATE and the constraint name, which
// Postgres puts in the message (PostgREST forwards it verbatim) and
// node-postgres also exposes as `constraint`.
function expectConstraintRejection(err: PgError) {
  expect(err.code).toBe('23514')
  expect(err.constraint).toBe(CONSTRAINT)
  expect(err.message).toBe(`new row for relation "employees" violates check constraint "${CONSTRAINT}"`)
}

describe('constraint shape', () => {
  it('is a CHECK on employees, added NOT VALID, commented', async () => {
    const res = await getPool().query<{
      contype: string
      convalidated: boolean
      def: string
      comment: string | null
    }>(
      `SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS def,
              obj_description(c.oid, 'pg_constraint') AS comment
         FROM pg_constraint c
        WHERE c.conname = $1 AND c.conrelid = 'public.employees'::regclass`,
      [CONSTRAINT],
    )
    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    expect(row.contype).toBe('c')
    // NOT VALID: rows stored before the constraint are not backfilled, they
    // are checked on their next UPDATE (see the legacy block below).
    expect(row.convalidated).toBe(false)
    expect(row.def).toContain('NOT VALID')
    expect(row.def).toContain('jamkning_valid_to >= jamkning_valid_from')
    expect(row.comment).toContain('#2256')
  })
})

describe('INSERT', () => {
  it('rejects a percentage without an end date (#2058 shape)', async () => {
    const seed = await seedCompany()
    const err = await captureError(insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: null }))
    expectConstraintRejection(err)
  })

  it('rejects a percentage without a start date', async () => {
    const seed = await seedCompany()
    const err = await captureError(insertEmployee(seed, { percentage: 20, from: null, to: '2026-12-31' }))
    expectConstraintRejection(err)
  })

  it('rejects an end date before the start date', async () => {
    const seed = await seedCompany()
    const err = await captureError(insertEmployee(seed, { percentage: 20, from: '2026-06-01', to: '2026-01-31' }))
    expectConstraintRejection(err)
  })

  it('rejects an inverted window even without a percentage (validator and Zod parity)', async () => {
    const seed = await seedCompany()
    const err = await captureError(insertEmployee(seed, { percentage: null, from: '2026-06-01', to: '2026-01-31' }))
    expectConstraintRejection(err)
  })

  it('accepts a percentage with both dates', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: '2026-12-31' })
    expect(await readJamkning(id)).toMatchObject({ percentage: 20, from: '2026-01-01', to: '2026-12-31' })
  })

  it('accepts a one-day window (valid_to = valid_from)', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-03-25', to: '2026-03-25' })
    expect(await readJamkning(id)).toMatchObject({ percentage: 20, from: '2026-03-25', to: '2026-03-25' })
  })

  it('accepts no beslut at all, with or without stray dates', async () => {
    const seed = await seedCompany()
    await insertEmployee(seed, { percentage: null, from: null, to: null })
    const id = await insertEmployee(seed, { percentage: null, from: '2026-01-01', to: null })
    expect(await readJamkning(id)).toMatchObject({ percentage: null, from: '2026-01-01', to: null })
  })
})

describe('UPDATE', () => {
  it('rejects nulling the end date while the percentage stays set', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: '2026-12-31' })
    const err = await captureError(
      getPool().query(`UPDATE public.employees SET jamkning_valid_to = NULL WHERE id = $1`, [id]),
    )
    expectConstraintRejection(err)
    expect(await readJamkning(id)).toMatchObject({ percentage: 20, from: '2026-01-01', to: '2026-12-31' })
  })

  it('rejects setting a percentage on a row that has no dates', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: null, from: null, to: null })
    const err = await captureError(
      getPool().query(`UPDATE public.employees SET jamkning_percentage = 20 WHERE id = $1`, [id]),
    )
    expectConstraintRejection(err)
    expect(await readJamkning(id)).toMatchObject({ percentage: null })
  })

  it('rejects an end date before the stored start date', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-06-01', to: '2026-12-31' })
    const err = await captureError(
      getPool().query(`UPDATE public.employees SET jamkning_valid_to = '2026-01-31' WHERE id = $1`, [id]),
    )
    expectConstraintRejection(err)
  })

  it('accepts clearing the percentage together with the dates', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: '2026-12-31' })
    await getPool().query(
      `UPDATE public.employees
          SET jamkning_percentage = NULL, jamkning_valid_from = NULL, jamkning_valid_to = NULL
        WHERE id = $1`,
      [id],
    )
    expect(await readJamkning(id)).toMatchObject({ percentage: null, from: null, to: null })
  })

  it('accepts clearing only the percentage (a null percentage frees the dates)', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: '2026-12-31' })
    await getPool().query(`UPDATE public.employees SET jamkning_percentage = NULL WHERE id = $1`, [id])
    expect(await readJamkning(id)).toMatchObject({ percentage: null, from: '2026-01-01', to: '2026-12-31' })
  })

  it('accepts replacing a complete beslut with another complete beslut', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: '2026-06-30' })
    await getPool().query(
      `UPDATE public.employees
          SET jamkning_percentage = 25, jamkning_valid_from = '2026-07-01', jamkning_valid_to = '2026-12-31'
        WHERE id = $1`,
      [id],
    )
    expect(await readJamkning(id)).toMatchObject({ percentage: 25, from: '2026-07-01', to: '2026-12-31' })
  })
})

describe('the concurrent-PATCH race (#2256)', () => {
  it('B blocks on A\'s row lock, then re-evaluates against A\'s committed row and fails', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: null, from: null, to: null })

    // Both handlers validated the empty row (B's { jamkning_valid_to: null }
    // is a no-op against it) and now issue their unconditional updates.
    const a = await getClient()
    const b = await getClient()
    try {
      await a.query('BEGIN')
      await a.query(
        `UPDATE public.employees
            SET jamkning_percentage = 20, jamkning_valid_from = '2026-01-01', jamkning_valid_to = '2026-12-31'
          WHERE id = $1`,
        [id],
      )

      await b.query('BEGIN')
      // Blocks on A's row lock; READ COMMITTED re-reads the row after A
      // commits, so the constraint is checked against A's beslut with
      // valid_to nulled.
      const bUpdate = b.query(`UPDATE public.employees SET jamkning_valid_to = NULL WHERE id = $1`, [id])
      // Give B a moment to actually queue behind the lock before A commits.
      await new Promise((resolve) => setTimeout(resolve, 100))
      await a.query('COMMIT')

      const err = await captureError(bUpdate)
      expectConstraintRejection(err)
      await b.query('ROLLBACK')
    } finally {
      await a.query('ROLLBACK').catch(() => {})
      await b.query('ROLLBACK').catch(() => {})
      a.release()
      b.release()
    }

    expect(await readJamkning(id)).toMatchObject({ percentage: 20, from: '2026-01-01', to: '2026-12-31' })
  })
})

describe('legacy incomplete rows (stored before the constraint, NOT VALID)', () => {
  it('seeds one by dropping and re-adding the constraint NOT VALID in one transaction', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)
    expect(await readJamkning(id)).toMatchObject({ percentage: 15, from: '2026-01-01', to: null })
    const back = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = 'public.employees'::regclass`,
      [CONSTRAINT],
    )
    expect(back.rows).toHaveLength(1)
    expect(back.rows[0].convalidated).toBe(false)
  })

  it('is refused on an unrelated edit until the beslut is completed or cleared (the NOT VALID trade-off)', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)

    const err = await captureError(
      getPool().query(`UPDATE public.employees SET first_name = 'Ny' WHERE id = $1`, [id]),
    )
    expectConstraintRejection(err)
    expect(await readJamkning(id)).toMatchObject({ first_name: 'Test', percentage: 15, from: '2026-01-01', to: null })
  })

  it('can be completed by supplying the missing end date, and is then freely editable', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)
    await getPool().query(
      `UPDATE public.employees SET first_name = 'Ny', jamkning_valid_to = '2026-12-31' WHERE id = $1`,
      [id],
    )
    expect(await readJamkning(id)).toMatchObject({ first_name: 'Ny', percentage: 15, from: '2026-01-01', to: '2026-12-31' })
  })

  it('can be cleared by nulling the percentage', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)
    await getPool().query(`UPDATE public.employees SET jamkning_percentage = NULL WHERE id = $1`, [id])
    expect(await readJamkning(id)).toMatchObject({ percentage: null, from: '2026-01-01', to: null })
    await getPool().query(`UPDATE public.employees SET first_name = 'Ny' WHERE id = $1`, [id])
    expect(await readJamkning(id)).toMatchObject({ first_name: 'Ny' })
  })
})
