/**
 * pg-real tests for 20260914075216_journal_entry_lines_single_side.sql
 * (#2551: a journal line carries one side only, declared as a CHECK).
 *
 * The engine (assertLinesWellFormed) and every line schema (isSingleSidedLine)
 * refuse a line with both debit_amount and credit_amount above zero, but a
 * service-role write or a direct SQL statement bypasses both. The constraint
 * is the backstop: the same rule, declared on the row, checked on every
 * INSERT and UPDATE.
 *
 * Why the rule exists: such a line cancels itself, and
 * check_journal_entry_balance() sums the two columns, so it never fires. The
 * entry posts as a nollverifikat, and storno (which reverses each line on its
 * net) then produces {0, 0} lines and dies on the voucher trigger's "has zero
 * total", leaving the entry uncorrectable.
 *
 * Verifies:
 *   - constraint shape: CHECK on journal_entry_lines, added NOT VALID, commented
 *   - INSERT: both sides above zero rejected; either single side accepted;
 *     a {0, 0} line still accepted (the engine rejects those, not the DB)
 *   - UPDATE: filling in the second side on a one-sided line rejected
 *   - the #2551 shape end to end: a both-sides line can no longer reach a
 *     posted entry, while the same amounts split across two lines can
 *   - the error is SQLSTATE 23514 naming the constraint, which is what the
 *     application keys on
 *   - the NOT VALID trade-off: a row stored before the constraint survives
 *     until its next UPDATE, which is then refused
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getClient, getPool } from './setup'
import { insertDraftJournalEntry, insertPostedJournalEntry, seedCompany } from './fixtures'

const CONSTRAINT = 'journal_entry_lines_single_side'

interface PgError extends Error {
  code?: string
  constraint?: string
}

interface Sides {
  debit: number
  credit: number
}

async function newDraftEntry(): Promise<string> {
  const seed = await seedCompany()
  return insertDraftJournalEntry({
    userId: seed.userId,
    companyId: seed.companyId,
    fiscalPeriodId: seed.fiscalPeriodId,
  })
}

function insertSql(entryId: string, account: string, sides: Sides, id: string = randomUUID()) {
  return {
    text: `INSERT INTO public.journal_entry_lines
             (id, journal_entry_id, account_number, debit_amount, credit_amount)
           VALUES ($1, $2, $3, $4, $5)`,
    values: [id, entryId, account, sides.debit, sides.credit],
  }
}

async function insertLine(entryId: string, account: string, sides: Sides): Promise<string> {
  const id = randomUUID()
  const q = insertSql(entryId, account, sides, id)
  await getPool().query(q.text, q.values)
  return id
}

async function readSides(lineId: string): Promise<Sides> {
  const res = await getPool().query<{ debit_amount: string; credit_amount: string }>(
    `SELECT debit_amount, credit_amount FROM public.journal_entry_lines WHERE id = $1`,
    [lineId],
  )
  const row = res.rows[0]
  return { debit: Number(row.debit_amount), credit: Number(row.credit_amount) }
}

// A row stored before the constraint existed. The constraint refuses that
// shape on INSERT, so the seed drops it for exactly this statement and
// re-adds it NOT VALID (the migration's own definition, read back from the
// catalog), inside one transaction so the constraint is back before anything
// else can run against the table.
async function insertLegacyBothSidesLine(entryId: string): Promise<string> {
  const id = randomUUID()
  const q = insertSql(entryId, '1930', { debit: 100, credit: 100 }, id)
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const def = await client.query<{ def: string; comment: string | null }>(
      `SELECT pg_get_constraintdef(oid) AS def,
              obj_description(oid, 'pg_constraint') AS comment
         FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'public.journal_entry_lines'::regclass`,
      [CONSTRAINT],
    )
    const definition = def.rows[0]?.def
    if (!definition) throw new Error(`${CONSTRAINT} is missing: did the migration apply?`)
    await client.query(`ALTER TABLE public.journal_entry_lines DROP CONSTRAINT ${CONSTRAINT}`)
    await client.query(q.text, q.values)
    await client.query(
      `ALTER TABLE public.journal_entry_lines ADD CONSTRAINT ${CONSTRAINT} ${
        definition.includes('NOT VALID') ? definition : `${definition} NOT VALID`
      }`,
    )
    // DROP CONSTRAINT takes the comment with it. Put it back, so this seed
    // leaves the catalog exactly as it found it and the shape test above
    // still passes on a re-run against the same database.
    //
    // COMMENT ON is a utility statement: like the ALTER TABLE above it takes
    // no bind parameters ($1 there is a 42601 syntax error). The text is
    // therefore handed over in a transaction-local GUC and turned into a
    // literal by format(%L), which quotes it correctly without this file
    // splicing catalog text into SQL by hand.
    const comment = def.rows[0]?.comment
    if (comment) {
      await client.query(`SELECT set_config('pgtest.single_side_comment', $1, true)`, [comment])
      await client.query(
        `DO $do$
         BEGIN
           EXECUTE format(
             'COMMENT ON CONSTRAINT ${CONSTRAINT} ON public.journal_entry_lines IS %L',
             current_setting('pgtest.single_side_comment')
           );
         END
         $do$`,
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  return id
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
  expect(err.message).toBe(
    `new row for relation "journal_entry_lines" violates check constraint "${CONSTRAINT}"`,
  )
}

describe('constraint shape', () => {
  it('is a CHECK on journal_entry_lines, added NOT VALID, commented', async () => {
    const res = await getPool().query<{
      contype: string
      convalidated: boolean
      def: string
      comment: string | null
    }>(
      `SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS def,
              obj_description(c.oid, 'pg_constraint') AS comment
         FROM pg_constraint c
        WHERE c.conname = $1 AND c.conrelid = 'public.journal_entry_lines'::regclass`,
      [CONSTRAINT],
    )
    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    expect(row.contype).toBe('c')
    // NOT VALID: prod may hold both-sides rows written before this landed.
    // They are repaired by a separate founder-approved data fix; VALIDATE
    // CONSTRAINT follows once prod reports zero offending rows.
    expect(row.convalidated).toBe(false)
    expect(row.def).toContain('NOT VALID')
    // Both columns are `numeric`, so Postgres renders the literal back as
    // `(0)::numeric`; match around the cast rather than on the source text.
    expect(row.def).toMatch(/debit_amount = \(?0\)?(::numeric)?/)
    expect(row.def).toMatch(/credit_amount = \(?0\)?(::numeric)?/)
    expect(row.def).toContain('OR')
    expect(row.comment).toContain('#2551')
  })

  it('leaves the non-negative companion constraint (20260908164944) in place', async () => {
    const res = await getPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname = 'journal_entry_lines_amounts_non_negative'
          AND conrelid = 'public.journal_entry_lines'::regclass`,
    )
    expect(res.rows).toHaveLength(1)
  })
})

describe('INSERT', () => {
  it('rejects a line carrying both sides (the #2551 shape)', async () => {
    const entryId = await newDraftEntry()
    const err = await captureError(insertLine(entryId, '1930', { debit: 100, credit: 100 }))
    expectConstraintRejection(err)
  })

  it('rejects both sides even when they differ (no self-cancel required)', async () => {
    const entryId = await newDraftEntry()
    const err = await captureError(insertLine(entryId, '1930', { debit: 100, credit: 40 }))
    expectConstraintRejection(err)
  })

  it('rejects a both-sides line below one öre', async () => {
    const entryId = await newDraftEntry()
    const err = await captureError(insertLine(entryId, '3740', { debit: 0.004, credit: 0.004 }))
    expectConstraintRejection(err)
  })

  it('accepts a debit-only line', async () => {
    const entryId = await newDraftEntry()
    const id = await insertLine(entryId, '1930', { debit: 100, credit: 0 })
    expect(await readSides(id)).toEqual({ debit: 100, credit: 0 })
  })

  it('accepts a credit-only line', async () => {
    const entryId = await newDraftEntry()
    const id = await insertLine(entryId, '3001', { debit: 0, credit: 100 })
    expect(await readSides(id)).toEqual({ debit: 0, credit: 100 })
  })

  it('still accepts a zero line: the engine refuses those, the constraint does not', async () => {
    const entryId = await newDraftEntry()
    const id = await insertLine(entryId, '1930', { debit: 0, credit: 0 })
    expect(await readSides(id)).toEqual({ debit: 0, credit: 0 })
  })
})

describe('UPDATE', () => {
  it('rejects filling in the second side on a one-sided line', async () => {
    const entryId = await newDraftEntry()
    const id = await insertLine(entryId, '1930', { debit: 100, credit: 0 })
    const err = await captureError(
      getPool().query(`UPDATE public.journal_entry_lines SET credit_amount = 100 WHERE id = $1`, [id]),
    )
    expectConstraintRejection(err)
    expect(await readSides(id)).toEqual({ debit: 100, credit: 0 })
  })

  it('accepts flipping a line to the other side in one statement', async () => {
    const entryId = await newDraftEntry()
    const id = await insertLine(entryId, '3740', { debit: 0.25, credit: 0 })
    await getPool().query(
      `UPDATE public.journal_entry_lines SET debit_amount = 0, credit_amount = 0.25 WHERE id = $1`,
      [id],
    )
    expect(await readSides(id)).toEqual({ debit: 0, credit: 0.25 })
  })
})

describe('the nollverifikat the issue reported', () => {
  it('cannot be posted any more: the both-sides line is refused before commit', async () => {
    const seed = await seedCompany()
    const entryId = await insertDraftJournalEntry({
      userId: seed.userId,
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      description: 'Nollverifikat, 1930 D 100 / C 100',
    })
    const err = await captureError(insertLine(entryId, '1930', { debit: 100, credit: 100 }))
    expectConstraintRejection(err)

    const count = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(Number(count.rows[0].n)).toBe(0)
  })

  it('the same amounts split across two one-sided lines still post', async () => {
    const seed = await seedCompany()
    const entryId = await insertPostedJournalEntry({
      userId: seed.userId,
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      voucherNumber: 1,
      lines: [
        { accountNumber: '1930', debitAmount: 100, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 100 },
      ],
    })
    const status = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(status.rows[0].status).toBe('posted')
  })

  it('a posted insert carrying a both-sides line is refused outright', async () => {
    const seed = await seedCompany()
    const err = await captureError(
      insertPostedJournalEntry({
        userId: seed.userId,
        companyId: seed.companyId,
        fiscalPeriodId: seed.fiscalPeriodId,
        voucherNumber: 2,
        lines: [{ accountNumber: '1930', debitAmount: 100, creditAmount: 100 }],
      }),
    )
    expectConstraintRejection(err)
  })
})

describe('legacy both-sides rows (stored before the constraint, NOT VALID)', () => {
  it('seeds one by dropping and re-adding the constraint NOT VALID in one transaction', async () => {
    const entryId = await newDraftEntry()
    const id = await insertLegacyBothSidesLine(entryId)
    expect(await readSides(id)).toEqual({ debit: 100, credit: 100 })
    const back = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'public.journal_entry_lines'::regclass`,
      [CONSTRAINT],
    )
    expect(back.rows).toHaveLength(1)
    expect(back.rows[0].convalidated).toBe(false)
  })

  it('survives until its next UPDATE, which is then refused (the NOT VALID trade-off)', async () => {
    const entryId = await newDraftEntry()
    const id = await insertLegacyBothSidesLine(entryId)

    const err = await captureError(
      getPool().query(
        `UPDATE public.journal_entry_lines SET line_description = 'Rättad' WHERE id = $1`,
        [id],
      ),
    )
    expectConstraintRejection(err)
    expect(await readSides(id)).toEqual({ debit: 100, credit: 100 })
  })

  it('is repaired by netting the two amounts onto one side', async () => {
    const entryId = await newDraftEntry()
    const id = await insertLegacyBothSidesLine(entryId)

    // debit 100 / credit 100 nets to zero: the repair the data fix applies.
    await getPool().query(
      `UPDATE public.journal_entry_lines SET debit_amount = 0, credit_amount = 0 WHERE id = $1`,
      [id],
    )
    expect(await readSides(id)).toEqual({ debit: 0, credit: 0 })
  })
})
