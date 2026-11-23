import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'

/**
 * Who corrected a company's entries stays named after the account is deleted
 * (migration *_rattelse_actor_names.sql). erase_user_personal_data copies the
 * person's name and e-mail into rattelse_actor_names, one row per company
 * whose entries they corrected, until the bevarandetid of the latest fiscal
 * year holding one of those corrections has ended (BFL 5 kap. 5 §, 7 kap.
 * 2 §); a daily job deletes the row after that.
 */

async function namedPerson(fullName: string | null, email: string | null): Promise<string> {
  const userId = await insertAuthUser()
  await getPool().query(
    `INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name`,
    [userId, email, fullName],
  )
  return userId
}

async function companyWithYear(
  start = '2026-01-01',
  end = '2026-12-31',
): Promise<{ ownerId: string; companyId: string; periodId: string }> {
  const ownerId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  const periodId = await insertFiscalPeriod({ userId: ownerId, companyId, periodStart: start, periodEnd: end, name: `${start}/${end}` })
  return { ownerId, companyId, periodId }
}

/** An inline rättelse: the log row names the person who made it. */
async function strikeLine(companyId: string, entryId: string, actor: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.journal_entry_rattelse_log (company_id, journal_entry_id, rattelse_type, actor)
     VALUES ($1, $2, 'lines', $3)`,
    [companyId, entryId, actor],
  )
}

/**
 * A storno verifikat (a reversal or a correcting entry) by authorId. With
 * postedBy it is posted by a trusted backend for that person, which stamps
 * committed_by; with draft it is never posted.
 */
async function storno(params: {
  companyId: string
  periodId: string
  authorId: string
  entryDate: string
  reversesId?: string
  correctionOfId?: string
  postedBy?: string
  draft?: boolean
}): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id, correction_of_id)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Rättelse', 'manual', 'draft', $6, $7)`,
      [id, params.authorId, params.companyId, params.periodId, params.entryDate, params.reversesId ?? null, params.correctionOfId ?? null],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '3001', 1000, 0, 'SEK', 0), ($1, '1510', 0, 1000, 'SEK', 1)`,
      [id],
    )
    if (params.postedBy) {
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: params.postedBy, role: 'service_role' }),
      ])
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [params.postedBy])
    }
    if (!params.draft) {
      await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    }
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function erase(userId: string): Promise<void> {
  await getPool().query('SELECT public.erase_user_personal_data($1)', [userId])
}

async function keptNames(userId: string) {
  const { rows } = await getPool().query<{ company_id: string; full_name: string | null; email: string | null; expires: string }>(
    `SELECT company_id, full_name, email, retention_expires_at::text AS expires
       FROM public.rattelse_actor_names
      WHERE user_id = $1
      ORDER BY expires, company_id`,
    [userId],
  )
  return rows
}

describe('names of who corrected entries, after the account is deleted (pg)', () => {
  it('keeps the name of a person who struck a line until the bevarandetid of that year has ended', async () => {
    const { ownerId, companyId, periodId } = await companyWithYear()
    const anna = await namedPerson('Anna Andersson', 'anna@example.se')
    await insertCompanyMember({ companyId, userId: anna, role: 'member' })
    const entryId = await insertPostedJournalEntry({ userId: ownerId, companyId, fiscalPeriodId: periodId })
    await strikeLine(companyId, entryId, anna)

    await erase(anna)

    // Fiscal year ends 2026-12-31: kept through 2033, gone on 1 January 2034.
    expect(await keptNames(anna)).toEqual([
      { company_id: companyId, full_name: 'Anna Andersson', email: 'anna@example.se', expires: '2034-01-01' },
    ])
    // The profile itself is still cleared, and so is the membership.
    const profile = await getPool().query(`SELECT full_name, email FROM public.profiles WHERE id = $1`, [anna])
    expect(profile.rows[0]).toEqual({ full_name: null, email: null })
    const member = await getPool().query(`SELECT 1 FROM public.company_members WHERE user_id = $1`, [anna])
    expect(member.rowCount).toBe(0)
  })

  it('counts from the latest fiscal year holding a correction, a broken year from the calendar year it ends in', async () => {
    const { ownerId, companyId, periodId: first } = await companyWithYear('2025-07-01', '2026-06-30')
    const second = await insertFiscalPeriod({
      userId: ownerId,
      companyId,
      periodStart: '2026-07-01',
      periodEnd: '2027-06-30',
      name: '2026/2027',
    })
    const bo = await namedPerson('Bo Berg', null)
    const original = await insertPostedJournalEntry({ userId: ownerId, companyId, fiscalPeriodId: first, entryDate: '2026-03-01' })
    await storno({ companyId, periodId: first, authorId: bo, entryDate: '2026-03-01', reversesId: original })
    const later = await insertPostedJournalEntry({ userId: ownerId, companyId, fiscalPeriodId: second, entryDate: '2026-09-01' })
    await strikeLine(companyId, later, bo)

    await erase(bo)

    // The latest year ends 2027-06-30: kept through 2034, gone on 1 January 2035.
    expect(await keptNames(bo)).toEqual([{ company_id: companyId, full_name: 'Bo Berg', email: null, expires: '2035-01-01' }])
  })

  it('keeps the names of whoever reversed an entry and whoever posted a correcting verifikat', async () => {
    const { ownerId, companyId, periodId } = await companyWithYear()
    const reverser = await namedPerson('Cecilia Carlsson', 'cecilia@example.se')
    const author = await namedPerson('David Dahl', 'david@example.se')
    const poster = await namedPerson('Eva Ek', 'eva@example.se')
    await insertCompanyMember({ companyId, userId: poster, role: 'member' })
    const first = await insertPostedJournalEntry({ userId: ownerId, companyId, fiscalPeriodId: periodId })
    const second = await insertPostedJournalEntry({ userId: ownerId, companyId, fiscalPeriodId: periodId })
    await storno({ companyId, periodId, authorId: reverser, entryDate: '2026-06-01', reversesId: first })
    await storno({ companyId, periodId, authorId: author, entryDate: '2026-06-01', correctionOfId: second, postedBy: poster })

    for (const person of [reverser, author, poster]) await erase(person)

    expect((await keptNames(reverser)).map((r) => r.full_name)).toEqual(['Cecilia Carlsson'])
    expect((await keptNames(author)).map((r) => r.full_name)).toEqual(['David Dahl'])
    expect((await keptNames(poster)).map((r) => r.full_name)).toEqual(['Eva Ek'])
  })

  it('keeps nothing for a person who only booked, or whose correction never left draft', async () => {
    const { companyId, periodId } = await companyWithYear()
    const fia = await namedPerson('Fia Fors', 'fia@example.se')
    await insertCompanyMember({ companyId, userId: fia, role: 'member' })
    const booked = await insertPostedJournalEntry({ userId: fia, companyId, fiscalPeriodId: periodId })
    await storno({ companyId, periodId, authorId: fia, entryDate: '2026-06-01', reversesId: booked, draft: true })

    await erase(fia)

    expect(await keptNames(fia)).toEqual([])
  })

  it('keeps one row per company, and erasing again changes nothing', async () => {
    const a = await companyWithYear()
    const b = await companyWithYear('2027-01-01', '2027-12-31')
    const gustav = await namedPerson('Gustav Gran', 'gustav@example.se')
    await strikeLine(a.companyId, await insertPostedJournalEntry({ userId: a.ownerId, companyId: a.companyId, fiscalPeriodId: a.periodId }), gustav)
    await strikeLine(
      b.companyId,
      await insertPostedJournalEntry({ userId: b.ownerId, companyId: b.companyId, fiscalPeriodId: b.periodId, entryDate: '2027-02-01' }),
      gustav,
    )

    await erase(gustav)
    const first = await keptNames(gustav)
    await erase(gustav)

    expect(first.map((r) => [r.company_id, r.expires])).toEqual([
      [a.companyId, '2034-01-01'],
      [b.companyId, '2035-01-01'],
    ])
    expect(await keptNames(gustav)).toEqual(first)
  })

  it('deletes a kept name daily once its bevarandetid has ended, not before', async () => {
    const { companyId } = await companyWithYear()
    const due = await namedPerson(null, 'due@example.se')
    const notYet = await namedPerson(null, 'not-yet@example.se')
    await getPool().query(
      `INSERT INTO public.rattelse_actor_names (company_id, user_id, email, retention_expires_at)
       VALUES ($1, $2, 'due@example.se', CURRENT_DATE), ($1, $3, 'not-yet@example.se', CURRENT_DATE + 1)`,
      [companyId, due, notYet],
    )

    const { rows } = await getPool().query<{ deleted: number }>('SELECT public.delete_expired_rattelse_actor_names() AS deleted')

    expect(rows[0]!.deleted).toBeGreaterThanOrEqual(1)
    expect(await keptNames(due)).toEqual([])
    expect((await keptNames(notYet)).map((r) => r.email)).toEqual(['not-yet@example.se'])
    const job = await getPool().query<{ schedule: string; command: string }>(
      `SELECT schedule, command FROM cron.job WHERE jobname = 'delete-expired-rattelse-actor-names'`,
    )
    expect(job.rows).toEqual([{ schedule: '45 3 * * *', command: 'SELECT public.delete_expired_rattelse_actor_names()' }])
  })

  it('is read by the service role only, and written by no API role', async () => {
    const { rows } = await getPool().query<Record<string, boolean>>(
      `SELECT
         has_table_privilege('anon', 'public.rattelse_actor_names', 'SELECT') AS anon_read,
         has_table_privilege('authenticated', 'public.rattelse_actor_names', 'SELECT') AS user_read,
         has_table_privilege('service_role', 'public.rattelse_actor_names', 'SELECT') AS service_read,
         has_table_privilege('authenticated', 'public.rattelse_actor_names', 'INSERT') AS user_write,
         has_table_privilege('service_role', 'public.rattelse_actor_names', 'INSERT') AS service_write`,
    )
    expect(rows[0]).toEqual({ anon_read: false, user_read: false, service_read: true, user_write: false, service_write: false })

    const someone = await insertAuthUser()
    await expect(
      withUserContext(someone, (client) => client.query('SELECT * FROM public.rattelse_actor_names')),
    ).rejects.toThrow(/permission denied/)
    await expect(
      runAsServiceRole((client) => client.query('SELECT count(*) FROM public.rattelse_actor_names')),
    ).resolves.toBeDefined()
  })
})
