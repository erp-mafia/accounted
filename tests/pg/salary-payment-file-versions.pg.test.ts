/**
 * pg-real tests for 20261015230000_salary_payment_file_versions.sql.
 *
 * A salary run's pain.001 version (its MsgId and EndToEndIds) moves only by
 * archiving a file that carries the person's confirmation that the earlier
 * file was not approved at the bank, and only by one (crm#1219). Nothing else
 * can change it: not a re-download, not an unconfirmed file, not a direct
 * UPDATE of the run.
 */
import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

const XML = '<?xml version="1.0" encoding="UTF-8"?><Document>lön</Document>'
const XML_SHA = createHash('sha256').update(Buffer.from(XML, 'utf8')).digest('hex')

async function insertRun(companyId: string, userId: string): Promise<string> {
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 10, '2026-10-23', 'booked')`,
    [runId, companyId, userId],
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
  companyId: string
  runId: string
  userId: string
  version: number
  confirmed?: boolean
  format?: 'pain001' | 'bg_lb'
}

async function archive(client: Pool | PoolClient, row: FileRow): Promise<string> {
  const id = randomUUID()
  const format = row.format ?? 'pain001'
  await client.query(
    `INSERT INTO public.salary_payment_files
       (id, company_id, salary_run_id, user_id, format, filename, content_type, charset,
        content, sha256, byte_size, payment_date, employee_count, total_amount,
        version, previous_not_approved_confirmed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '2026-10-23', 1, 20000, $12, $13)`,
    [
      id,
      row.companyId,
      row.runId,
      row.userId,
      format,
      format === 'pain001' ? 'pain001_lon_2026-10.xml' : 'bg_lb_lon_2026-10.txt',
      format === 'pain001' ? 'application/xml' : 'text/plain',
      format === 'pain001' ? 'utf-8' : 'iso-8859-1',
      XML,
      XML_SHA,
      Buffer.byteLength(XML, 'utf8'),
      row.version,
      row.confirmed ?? false,
    ],
  )
  return id
}

async function runVersion(runId: string): Promise<number> {
  const { rows } = await getPool().query<{ v: number }>(
    'SELECT payment_file_version AS v FROM public.salary_runs WHERE id = $1',
    [runId],
  )
  return rows[0]!.v
}

describe('salary payment file versions (pg)', () => {
  it('starts every run and every existing-shaped file at version 1', async () => {
    const { userId, companyId, runId } = await seed()
    expect(await runVersion(runId)).toBe(1)
    const id = await archive(getPool(), { companyId, runId, userId, version: 1 })
    const { rows } = await getPool().query(
      'SELECT version, previous_not_approved_confirmed FROM public.salary_payment_files WHERE id = $1',
      [id],
    )
    expect(rows[0]).toEqual({ version: 1, previous_not_approved_confirmed: false })
    expect(await runVersion(runId)).toBe(1)
  })

  it('raises the run by one when a company member archives a confirmed new version, and records it', async () => {
    const { userId, companyId, runId } = await seed()

    await withUserContext(userId, async (client) => {
      await archive(client, { companyId, runId, userId, version: 1 })
      const id = await archive(client, { companyId, runId, userId, version: 2, confirmed: true })
      const { rows } = await client.query(
        `SELECT version, previous_not_approved_confirmed, user_id
         FROM public.salary_payment_files WHERE id = $1`,
        [id],
      )
      expect(rows[0]).toEqual({ version: 2, previous_not_approved_confirmed: true, user_id: userId })
      // A re-download of the new version afterwards: same version, no confirmation.
      await archive(client, { companyId, runId, userId, version: 2 })
      const run = await client.query<{ v: number }>(
        'SELECT payment_file_version AS v FROM public.salary_runs WHERE id = $1',
        [runId],
      )
      expect(run.rows[0]!.v).toBe(2)
    })
  })

  it('refuses a new version without the confirmation, and the run stays where it was', async () => {
    const { userId, companyId, runId } = await seed()

    await expect(archive(getPool(), { companyId, runId, userId, version: 2 })).rejects.toThrow(
      /needs the confirmation/,
    )
    expect(await runVersion(runId)).toBe(1)
  })

  it('refuses skipping a version and going back to an old one', async () => {
    const { userId, companyId, runId } = await seed()

    await expect(
      archive(getPool(), { companyId, runId, userId, version: 3, confirmed: true }),
    ).rejects.toThrow(/neither the run's current payment file version/)
    await archive(getPool(), { companyId, runId, userId, version: 2, confirmed: true })
    await expect(archive(getPool(), { companyId, runId, userId, version: 1 })).rejects.toThrow(
      /neither the run's current payment file version/,
    )
    expect(await runVersion(runId)).toBe(2)
  })

  it('keeps Bankgirot LB files at version 1, whatever the run is at', async () => {
    const { userId, companyId, runId } = await seed()
    await archive(getPool(), { companyId, runId, userId, version: 2, confirmed: true })

    await archive(getPool(), { companyId, runId, userId, version: 1, format: 'bg_lb' })
    await expect(
      archive(getPool(), { companyId, runId, userId, version: 2, format: 'bg_lb' }),
    ).rejects.toThrow(/only a pain.001 payment file has versions/)
    await expect(
      archive(getPool(), { companyId, runId, userId, version: 1, confirmed: true, format: 'bg_lb' }),
    ).rejects.toThrow(/only a pain.001 payment file has versions/)
    expect(await runVersion(runId)).toBe(2)
  })

  it('refuses moving the run\'s version by hand, for the superuser and a member alike', async () => {
    const { userId, companyId, runId } = await seed()

    await expect(
      getPool().query('UPDATE public.salary_runs SET payment_file_version = 2 WHERE id = $1', [runId]),
    ).rejects.toThrow(/changes only by archiving a confirmed new version/)

    await withUserContext(userId, async (client) => {
      await client.query('SAVEPOINT by_hand')
      await expect(
        client.query('UPDATE public.salary_runs SET payment_file_version = 2 WHERE id = $1', [runId]),
      ).rejects.toThrow(/changes only by archiving a confirmed new version/)
      await client.query('ROLLBACK TO SAVEPOINT by_hand')
    })

    await expect(
      getPool().query(
        `INSERT INTO public.salary_runs (company_id, user_id, period_year, period_month, payment_date, status, payment_file_version)
         VALUES ($1, $2, 2026, 11, '2026-11-25', 'draft', 2)`,
        [companyId, userId],
      ),
    ).rejects.toThrow(/starts at payment file version 1/)
    expect(await runVersion(runId)).toBe(1)
  })

  it('refuses a new version filed against another company\'s run', async () => {
    const a = await seed()
    const b = await seed()

    await expect(
      archive(getPool(), { companyId: a.companyId, runId: b.runId, userId: a.userId, version: 2, confirmed: true }),
    ).rejects.toThrow(/does not belong to company/)
    expect(await runVersion(b.runId)).toBe(1)
  })
})
