/**
 * pg-real test: the storno of a verifikat that carries a legacy negative-side
 * line (debit -0.25, booked before journal_entry_lines_amounts_non_negative,
 * which was added NOT VALID in 20260908164944).
 *
 * reverseEntry always built its storno on each line's net; correctEntry swapped
 * the two columns as they stood, so the legacy line came out as credit -0.25,
 * which the CHECK refuses: a rättelse of such a verifikat failed where a plain
 * storno worked. Both now take their lines from buildStornoLines
 * (lib/bookkeeping/line-side.ts). This suite pins, against the real
 * constraint and the balance trigger:
 *
 *   - the buildStornoLines storno of the legacy verifikat inserts and posts;
 *   - the plain column swap the rättelse used to write is refused (23514 on
 *     journal_entry_lines_amounts_non_negative).
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getClient, getPool } from './setup'
import { insertDraftJournalEntry, seedCompany } from './fixtures'
import { buildStornoLines } from '@/lib/bookkeeping/line-side'

const CONSTRAINT = 'journal_entry_lines_amounts_non_negative'

interface StoredLine {
  account_number: string
  debit_amount: string
  credit_amount: string
}

// A posted verifikat with a line written before the constraint existed. The
// constraint refuses that shape on INSERT, so the seed drops it for exactly
// these statements and re-adds it NOT VALID (its own definition and comment,
// read back from the catalog), inside one transaction.
async function insertLegacyVerifikat(seed: { userId: string; companyId: string; fiscalPeriodId: string }): Promise<string> {
  const id = randomUUID()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const def = await client.query<{ def: string; comment: string | null }>(
      `SELECT pg_get_constraintdef(oid) AS def, obj_description(oid, 'pg_constraint') AS comment
         FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'public.journal_entry_lines'::regclass`,
      [CONSTRAINT],
    )
    const definition = def.rows[0]?.def
    if (!definition) throw new Error(`${CONSTRAINT} is missing: did the migration apply?`)
    await client.query(`ALTER TABLE public.journal_entry_lines DROP CONSTRAINT ${CONSTRAINT}`)

    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-01', 'Leverantörsfaktura med öresavrundning', 'manual', 'draft')`,
      [id, seed.userId, seed.companyId, seed.fiscalPeriodId],
    )
    const lines: Array<[string, number, number]> = [
      ['5410', 1000.25, 0],
      ['3740', -0.25, 0], // the legacy shape: a credit of 0.25 written as a negative debit
      ['2440', 0, 1000],
    ]
    for (const [index, [account, debit, credit]] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, account, debit, credit, index],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])

    await client.query(
      `ALTER TABLE public.journal_entry_lines ADD CONSTRAINT ${CONSTRAINT} ${
        definition.includes('NOT VALID') ? definition : `${definition} NOT VALID`
      }`,
    )
    const comment = def.rows[0]?.comment
    if (comment) {
      await client.query(`SELECT set_config('pgtest.non_negative_comment', $1, true)`, [comment])
      await client.query(
        `DO $do$
         BEGIN
           EXECUTE format(
             'COMMENT ON CONSTRAINT ${CONSTRAINT} ON public.journal_entry_lines IS %L',
             current_setting('pgtest.non_negative_comment')
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

async function storedLines(entryId: string): Promise<StoredLine[]> {
  const { rows } = await getPool().query<StoredLine>(
    `SELECT account_number, debit_amount, credit_amount FROM public.journal_entry_lines
      WHERE journal_entry_id = $1 ORDER BY sort_order`,
    [entryId],
  )
  return rows
}

async function insertStornoLines(entryId: string, lines: Array<{ account_number: string; debit: number; credit: number }>) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    for (const [index, line] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [entryId, line.account_number, line.debit, line.credit, index],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

describe('storno of a verifikat with a legacy negative-side line', () => {
  it('posts the buildStornoLines storno: the legacy line reverses to a positive line on the other side', async () => {
    const seed = await seedCompany()
    const original = await insertLegacyVerifikat(seed)
    const storno = await insertDraftJournalEntry({ ...seed, sourceType: 'storno', description: 'Storno' })

    const lines = buildStornoLines(await storedLines(original)).map(({ line, debit_amount, credit_amount }) => ({
      account_number: line.account_number,
      debit: debit_amount,
      credit: credit_amount,
    }))
    expect(lines).toEqual([
      { account_number: '5410', debit: 0, credit: 1000.25 },
      { account_number: '3740', debit: 0.25, credit: 0 },
      { account_number: '2440', debit: 1000, credit: 0 },
    ])

    await insertStornoLines(storno, lines)
    const { rows } = await getPool().query<{ status: string }>(`SELECT status FROM public.journal_entries WHERE id = $1`, [storno])
    expect(rows[0].status).toBe('posted')
  })

  it('refuses the plain column swap the rättelse used to write', async () => {
    const seed = await seedCompany()
    const original = await insertLegacyVerifikat(seed)
    const storno = await insertDraftJournalEntry({ ...seed, sourceType: 'storno', description: 'Storno' })

    const swapped = (await storedLines(original)).map((line) => ({
      account_number: line.account_number,
      debit: Number(line.credit_amount),
      credit: Number(line.debit_amount),
    }))

    const error = await insertStornoLines(storno, swapped).then(
      () => null,
      (err: Error & { code?: string; constraint?: string }) => err,
    )
    expect(error?.code).toBe('23514')
    expect(error?.constraint).toBe(CONSTRAINT)
  })
})
