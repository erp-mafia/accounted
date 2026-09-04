/**
 * pg-real tests for 20260904120000_employees_jamkning_both_dates_trigger.sql
 * (#2256: the jämkning both-dates invariant enforced in the database).
 *
 * The application validator (lib/salary/jamkning-rules.ts, PR #2240) refuses
 * a jamkning_percentage without both validity dates on every write path, but
 * a concurrent PATCH that validated a stale snapshot, or a direct SQL /
 * service-role write, could still store one. The trigger is the backstop.
 *
 * Verifies:
 *   - trigger shape: BEFORE INSERT OR UPDATE OF the three columns, SECURITY
 *     INVOKER, commented
 *   - INSERT: percentage without valid_to / valid_from rejected; percentage
 *     with both dates accepted; no percentage with stray dates accepted;
 *     valid_to before valid_from rejected
 *   - UPDATE: nulling valid_to while the percentage stays rejected; ordering
 *     rejected; clearing the beslut (with or without the dates) accepted
 *   - legacy incomplete rows (seeded with the trigger disabled, the shape
 *     stored before #2240): unrelated edits succeed, a whole-row write with
 *     unchanged jamkning values succeeds, touching a jamkning column while
 *     the row stays incomplete is refused
 *   - the concurrent-PATCH race from the issue: two updates where the second
 *     nulls valid_to must fail, both sequentially and with the second
 *     statement blocked on the first transaction's row lock
 *   - the error is SQLSTATE 23514 with the stable JAMKNING_INCOMPLETE prefix
 *     and the same Swedish sentence validateJamkning produces
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

const TRIGGER = 'trg_enforce_employee_jamkning_dates'
const PREFIX = 'JAMKNING_INCOMPLETE: '
const START_REQUIRED = 'Jämkningens startdatum måste anges när jämkningsprocent sätts'
const END_REQUIRED = 'Jämkningens slutdatum måste anges när jämkningsprocent sätts'
const ORDER = 'Jämkningens slutdatum måste vara efter startdatumet'

interface PgError extends Error {
  code?: string
  column?: string
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

// A row stored before #2240: percentage set, valid_to missing. The trigger
// refuses that shape on INSERT, so the seed disables it for exactly this
// statement, inside one transaction so the trigger is back before anything
// else can run against the table.
async function insertLegacyIncompleteEmployee(seed: { companyId: string; userId: string }): Promise<string> {
  const id = randomUUID()
  const q = insertSql(id, seed.companyId, seed.userId, { percentage: 15, from: '2026-01-01', to: null })
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`ALTER TABLE public.employees DISABLE TRIGGER ${TRIGGER}`)
    await client.query(q.text, q.values)
    await client.query(`ALTER TABLE public.employees ENABLE TRIGGER ${TRIGGER}`)
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

function expectJamkningRejection(err: PgError, sentence: string, column: string) {
  expect(err.code).toBe('23514')
  expect(err.message).toBe(`${PREFIX}${sentence}`)
  expect(err.column).toBe(column)
}

describe('trigger shape', () => {
  it('is BEFORE INSERT OR UPDATE OF the three jamkning columns, SECURITY INVOKER, commented', async () => {
    const res = await getPool().query<{
      tgtype: number
      cols: string[]
      prosecdef: boolean
      trigger_comment: string | null
      function_comment: string | null
    }>(
      `SELECT t.tgtype,
              (SELECT array_agg(a.attname::text ORDER BY a.attname)
                 FROM unnest(t.tgattr) AS col(attnum)
                 JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = col.attnum) AS cols,
              p.prosecdef,
              obj_description(t.oid, 'pg_trigger') AS trigger_comment,
              obj_description(p.oid, 'pg_proc') AS function_comment
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgname = $1 AND t.tgrelid = 'public.employees'::regclass`,
      [TRIGGER],
    )
    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    // tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT, 16 = UPDATE (8 = DELETE must be off).
    expect(row.tgtype & 1).toBe(1)
    expect(row.tgtype & 2).toBe(2)
    expect(row.tgtype & 4).toBe(4)
    expect(row.tgtype & 16).toBe(16)
    expect(row.tgtype & 8).toBe(0)
    expect(row.cols).toEqual(['jamkning_percentage', 'jamkning_valid_from', 'jamkning_valid_to'])
    expect(row.prosecdef).toBe(false)
    expect(row.trigger_comment).toContain('#2256')
    expect(row.function_comment).toContain('JAMKNING_INCOMPLETE')
  })
})

describe('INSERT', () => {
  it('rejects a percentage without an end date (#2058 shape)', async () => {
    const seed = await seedCompany()
    const err = await captureError(insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: null }))
    expectJamkningRejection(err, END_REQUIRED, 'jamkning_valid_to')
  })

  it('rejects a percentage without a start date', async () => {
    const seed = await seedCompany()
    const err = await captureError(insertEmployee(seed, { percentage: 20, from: null, to: '2026-12-31' }))
    expectJamkningRejection(err, START_REQUIRED, 'jamkning_valid_from')
  })

  it('rejects a percentage with no dates at all, naming the start date first (validator order)', async () => {
    const seed = await seedCompany()
    const err = await captureError(insertEmployee(seed, { percentage: 20, from: null, to: null }))
    expectJamkningRejection(err, START_REQUIRED, 'jamkning_valid_from')
  })

  it('rejects an end date before the start date', async () => {
    const seed = await seedCompany()
    const err = await captureError(insertEmployee(seed, { percentage: 20, from: '2026-06-01', to: '2026-01-31' }))
    expectJamkningRejection(err, ORDER, 'jamkning_valid_to')
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
    expectJamkningRejection(err, END_REQUIRED, 'jamkning_valid_to')
    expect(await readJamkning(id)).toMatchObject({ percentage: 20, from: '2026-01-01', to: '2026-12-31' })
  })

  it('rejects setting a percentage on a row that has no dates', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: null, from: null, to: null })
    const err = await captureError(
      getPool().query(`UPDATE public.employees SET jamkning_percentage = 20 WHERE id = $1`, [id]),
    )
    expectJamkningRejection(err, START_REQUIRED, 'jamkning_valid_from')
    expect(await readJamkning(id)).toMatchObject({ percentage: null })
  })

  it('rejects an end date before the stored start date', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-06-01', to: '2026-12-31' })
    const err = await captureError(
      getPool().query(`UPDATE public.employees SET jamkning_valid_to = '2026-01-31' WHERE id = $1`, [id]),
    )
    expectJamkningRejection(err, ORDER, 'jamkning_valid_to')
  })

  it('rejects an inverted window even when the percentage is cleared in the same write (validator parity)', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: '2026-12-31' })
    const err = await captureError(
      getPool().query(
        `UPDATE public.employees
            SET jamkning_percentage = NULL, jamkning_valid_from = '2026-06-01', jamkning_valid_to = '2026-01-31'
          WHERE id = $1`,
        [id],
      ),
    )
    expectJamkningRejection(err, ORDER, 'jamkning_valid_to')
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

  it('fires for the authenticated role too (the route and PostgREST path)', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: '2026-12-31' })
    const err = await withUserContext(seed.userId, async (client) =>
      captureError(
        client.query(
          `UPDATE public.employees SET jamkning_valid_to = NULL WHERE id = $1 AND company_id = $2`,
          [id, seed.companyId],
        ),
      ),
    )
    expectJamkningRejection(err, END_REQUIRED, 'jamkning_valid_to')
  })
})

describe('legacy incomplete rows (stored before #2240)', () => {
  it('seeds with the trigger disabled for that one statement and re-enables it', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)
    expect(await readJamkning(id)).toMatchObject({ percentage: 15, from: '2026-01-01', to: null })
    // And the trigger is back on after the seed transaction.
    const enabled = await getPool().query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = 'public.employees'::regclass`,
      [TRIGGER],
    )
    expect(enabled.rows[0]?.tgenabled).toBe('O')
  })

  it('can still be edited in an unrelated column', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)
    await getPool().query(`UPDATE public.employees SET first_name = 'Ny' WHERE id = $1`, [id])
    expect(await readJamkning(id)).toMatchObject({ first_name: 'Ny', percentage: 15, from: '2026-01-01', to: null })
  })

  it('can be written back whole with the jamkning columns unchanged (routes that send the full row)', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)
    await getPool().query(
      `UPDATE public.employees
          SET first_name = 'Ny',
              jamkning_percentage = 15,
              jamkning_valid_from = '2026-01-01',
              jamkning_valid_to = NULL
        WHERE id = $1`,
      [id],
    )
    expect(await readJamkning(id)).toMatchObject({ first_name: 'Ny', percentage: 15, from: '2026-01-01', to: null })
  })

  it('is refused once a jamkning column changes and the row is still incomplete', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)
    const err = await captureError(
      getPool().query(`UPDATE public.employees SET jamkning_percentage = 20 WHERE id = $1`, [id]),
    )
    expectJamkningRejection(err, END_REQUIRED, 'jamkning_valid_to')
    expect(await readJamkning(id)).toMatchObject({ percentage: 15 })
  })

  it('can be completed by supplying the missing end date', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)
    await getPool().query(`UPDATE public.employees SET jamkning_valid_to = '2026-12-31' WHERE id = $1`, [id])
    expect(await readJamkning(id)).toMatchObject({ percentage: 15, from: '2026-01-01', to: '2026-12-31' })
  })

  it('can be cleared by nulling the percentage', async () => {
    const seed = await seedCompany()
    const id = await insertLegacyIncompleteEmployee(seed)
    await getPool().query(
      `UPDATE public.employees SET jamkning_percentage = NULL, jamkning_valid_from = NULL WHERE id = $1`,
      [id],
    )
    expect(await readJamkning(id)).toMatchObject({ percentage: null, from: null, to: null })
  })
})

describe('the concurrent-PATCH race (#2256)', () => {
  it('sequential: A writes a complete beslut, B nulls the end date, B fails and A stands', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: null, from: null, to: null })

    await getPool().query(
      `UPDATE public.employees
          SET jamkning_percentage = 20, jamkning_valid_from = '2026-01-01', jamkning_valid_to = '2026-12-31'
        WHERE id = $1`,
      [id],
    )
    const err = await captureError(
      getPool().query(`UPDATE public.employees SET jamkning_valid_to = NULL WHERE id = $1`, [id]),
    )
    expectJamkningRejection(err, END_REQUIRED, 'jamkning_valid_to')
    expect(await readJamkning(id)).toMatchObject({ percentage: 20, from: '2026-01-01', to: '2026-12-31' })
  })

  it('interleaved: B blocks on A\'s row lock, then re-evaluates against A\'s committed row and fails', async () => {
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
      // commits, so the trigger sees NEW = A's beslut with valid_to nulled.
      const bUpdate = b.query(`UPDATE public.employees SET jamkning_valid_to = NULL WHERE id = $1`, [id])
      // Give B a moment to actually queue behind the lock before A commits.
      await new Promise((resolve) => setTimeout(resolve, 100))
      await a.query('COMMIT')

      const err = await captureError(bUpdate)
      expectJamkningRejection(err, END_REQUIRED, 'jamkning_valid_to')
      await b.query('ROLLBACK')
    } finally {
      await a.query('ROLLBACK').catch(() => {})
      await b.query('ROLLBACK').catch(() => {})
      a.release()
      b.release()
    }

    expect(await readJamkning(id)).toMatchObject({ percentage: 20, from: '2026-01-01', to: '2026-12-31' })
  })

  it('interleaved the other way: A clears, B sets the percentage only, B fails against the cleared row', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { percentage: 20, from: '2026-01-01', to: '2026-12-31' })

    const a = await getClient()
    const b = await getClient()
    try {
      await a.query('BEGIN')
      await a.query(
        `UPDATE public.employees
            SET jamkning_percentage = NULL, jamkning_valid_from = NULL, jamkning_valid_to = NULL
          WHERE id = $1`,
        [id],
      )

      await b.query('BEGIN')
      // B validated against the complete row, so "just change the rate" passed.
      const bUpdate = b.query(`UPDATE public.employees SET jamkning_percentage = 25 WHERE id = $1`, [id])
      await new Promise((resolve) => setTimeout(resolve, 100))
      await a.query('COMMIT')

      const err = await captureError(bUpdate)
      expectJamkningRejection(err, START_REQUIRED, 'jamkning_valid_from')
      await b.query('ROLLBACK')
    } finally {
      await a.query('ROLLBACK').catch(() => {})
      await b.query('ROLLBACK').catch(() => {})
      a.release()
      b.release()
    }

    expect(await readJamkning(id)).toMatchObject({ percentage: null, from: null, to: null })
  })
})
