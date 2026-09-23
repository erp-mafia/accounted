/**
 * pg-real tests for 20260919105035_salary_payment_files.sql.
 *
 * The salary payment file archive is WORM räkenskapsinformation (BFL 7 kap.
 * 1 §): a company member archives a file and reads it back under RLS, nobody
 * updates or deletes a row (not even the superuser: the trigger raises),
 * other companies' rows stay invisible, a row can never point at a run in
 * another company, and the only sanctioned delete is sandbox teardown.
 */
import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

const XML = '<?xml version="1.0" encoding="UTF-8"?><Document>lön</Document>'
const XML_SHA = createHash('sha256').update(Buffer.from(XML, 'utf8')).digest('hex')

async function insertRun(companyId: string, userId: string, status = 'approved'): Promise<string> {
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 4, '2026-04-24', $4)`,
    [runId, companyId, userId, status],
  )
  return runId
}

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const runId = await insertRun(companyId, userId)
  return { userId, companyId, runId }
}

interface FileRow {
  id?: string
  companyId: string
  runId: string
  userId: string
  format?: 'pain001' | 'bg_lb'
  sha256?: string
}

async function insertFile(client: Pool | PoolClient, row: FileRow): Promise<string> {
  const id = row.id ?? randomUUID()
  const format = row.format ?? 'pain001'
  await client.query(
    `INSERT INTO public.salary_payment_files
       (id, company_id, salary_run_id, user_id, format, filename, content_type, charset,
        content, sha256, byte_size, payment_date, employee_count, total_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '2026-04-24', 1, 20000)`,
    [
      id,
      row.companyId,
      row.runId,
      row.userId,
      format,
      format === 'pain001' ? 'pain001_lon_2026-04.xml' : 'bg_lb_lon_2026-04.txt',
      format === 'pain001' ? 'application/xml' : 'text/plain',
      format === 'pain001' ? 'utf-8' : 'iso-8859-1',
      XML,
      row.sha256 ?? XML_SHA,
      Buffer.byteLength(XML, 'utf8'),
    ],
  )
  return id
}

async function countFiles(client: Pool | PoolClient, where: string, params: unknown[]): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.salary_payment_files WHERE ${where}`,
    params,
  )
  return rows[0]!.n
}

describe('salary_payment_files (pg)', () => {
  it('lets a company member archive a file and read it back through RLS', async () => {
    const { userId, companyId, runId } = await seed()

    await withUserContext(userId, async (client) => {
      const id = await insertFile(client, { companyId, runId, userId })
      const { rows } = await client.query<{
        format: string
        charset: string
        sha256: string
        byte_size: number
        content: string
        user_id: string
        generated_at: string
      }>(
        `SELECT format, charset, sha256, byte_size, content, user_id, generated_at
         FROM public.salary_payment_files WHERE id = $1`,
        [id],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        format: 'pain001',
        charset: 'utf-8',
        sha256: XML_SHA,
        byte_size: Buffer.byteLength(XML, 'utf8'),
        content: XML,
        user_id: userId,
      })
      expect(rows[0]!.generated_at).toBeTruthy()
    })
  })

  it('refuses UPDATE and DELETE even for the superuser (WORM)', async () => {
    const { userId, companyId, runId } = await seed()
    const id = await insertFile(getPool(), { companyId, runId, userId })

    await expect(
      getPool().query(`UPDATE public.salary_payment_files SET content = 'tampered' WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be modified or deleted/)
    await expect(
      getPool().query(`UPDATE public.salary_payment_files SET sha256 = $2 WHERE id = $1`, [id, 'f'.repeat(64)]),
    ).rejects.toThrow(/cannot be modified or deleted/)
    await expect(
      getPool().query(`DELETE FROM public.salary_payment_files WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be modified or deleted/)

    const { rows } = await getPool().query<{ content: string; sha256: string }>(
      `SELECT content, sha256 FROM public.salary_payment_files WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ content: XML, sha256: XML_SHA })
  })

  it('gives a company member no UPDATE or DELETE path through RLS either', async () => {
    const { userId, companyId, runId } = await seed()
    const id = await insertFile(getPool(), { companyId, runId, userId })

    await withUserContext(userId, async (client) => {
      // No UPDATE/DELETE policy: the row is invisible to the write, 0 rows
      // affected and nothing raised (the trigger never sees a row).
      const upd = await client.query(
        `UPDATE public.salary_payment_files SET content = 'tampered' WHERE id = $1`,
        [id],
      )
      expect(upd.rowCount).toBe(0)
      const del = await client.query(`DELETE FROM public.salary_payment_files WHERE id = $1`, [id])
      expect(del.rowCount).toBe(0)
      expect(await countFiles(client, 'id = $1 AND content = $2', [id, XML])).toBe(1)
    })
  })

  it('hides other companies rows and refuses a cross-company insert', async () => {
    const a = await seed()
    const b = await seed()
    const fileA = await insertFile(getPool(), { companyId: a.companyId, runId: a.runId, userId: a.userId })

    await withUserContext(b.userId, async (client) => {
      expect(await countFiles(client, 'id = $1', [fileA])).toBe(0)
      expect(await countFiles(client, 'company_id = $1', [a.companyId])).toBe(0)
      await client.query('SAVEPOINT cross_company')
      await expect(
        insertFile(client, { companyId: a.companyId, runId: a.runId, userId: b.userId }),
      ).rejects.toThrow(/row-level security|does not belong to company/)
      await client.query('ROLLBACK TO SAVEPOINT cross_company')
    })

    await withUserContext(a.userId, async (client) => {
      expect(await countFiles(client, 'id = $1', [fileA])).toBe(1)
    })
  })

  it('refuses a row whose run belongs to another company, regardless of role', async () => {
    const a = await seed()
    const b = await seed()

    await expect(
      insertFile(getPool(), { companyId: a.companyId, runId: b.runId, userId: a.userId }),
    ).rejects.toThrow(/does not belong to company/)
    expect(await countFiles(getPool(), 'company_id = $1', [a.companyId])).toBe(0)
  })

  it('validates the digest, format and charset shape', async () => {
    const { userId, companyId, runId } = await seed()

    await expect(
      insertFile(getPool(), { companyId, runId, userId, sha256: 'not-a-digest' }),
    ).rejects.toThrow(/salary_payment_files_sha256_check/)
    await expect(
      getPool().query(
        `INSERT INTO public.salary_payment_files
           (company_id, salary_run_id, user_id, format, filename, content_type, charset,
            content, sha256, byte_size, payment_date, employee_count, total_amount)
         VALUES ($1, $2, $3, 'csv', 'x.csv', 'text/plain', 'utf-8', 'x', $4, 1, '2026-04-24', 1, 1)`,
        [companyId, runId, userId, XML_SHA],
      ),
    ).rejects.toThrow(/salary_payment_files_format_check/)
  })

  it('blocks hard-deleting the author while the archive references them (RESTRICT, not CASCADE)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const runId = await insertRun(companyId, userId)
    await insertFile(getPool(), { companyId, runId, userId })
    await expect(
      getPool().query(`DELETE FROM auth.users WHERE id = $1`, [userId]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('blocks deleting a run that has an archived payment file', async () => {
    const { userId, companyId, runId } = await seed()
    await insertFile(getPool(), { companyId, runId, userId })

    await expect(getPool().query(`DELETE FROM public.salary_runs WHERE id = $1`, [runId])).rejects.toThrow(
      /salary_payment_files_salary_run_id_fkey/,
    )
  })

  it('purges the archive during sandbox teardown, and only then', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, name: 'Sandbox AB' })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    // A direct database session may create a sandbox settings row (the
    // insert guard only challenges PostgREST callers).
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, user_id, is_sandbox) VALUES ($1, $2, true)`,
      [companyId, userId],
    )
    const runId = await insertRun(companyId, userId)
    const fileId = await insertFile(getPool(), { companyId, runId, userId })

    // Plain deletes stay refused for a sandbox row too: the flag is what
    // unlocks it, and only cleanup_sandbox_user sets the flag.
    await expect(
      getPool().query(`DELETE FROM public.salary_payment_files WHERE id = $1`, [fileId]),
    ).rejects.toThrow(/cannot be modified or deleted/)

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [userId])

    expect(await countFiles(getPool(), 'id = $1', [fileId])).toBe(0)
    const { rows } = await getPool().query<{ users: number; runs: number }>(
      `SELECT
         (SELECT count(*)::int FROM auth.users WHERE id = $1) AS users,
         (SELECT count(*)::int FROM public.salary_runs WHERE id = $2) AS runs`,
      [userId, runId],
    )
    expect(rows[0]).toEqual({ users: 0, runs: 0 })
  })
})
