import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'

/**
 * 20260915160200_association_audit.sql: RLS on association_auditors (members
 * read, owner/admin/member write as themselves, viewers read-only), no DELETE
 * (an ended assignment is a date), the kind and date CHECKs, and the four
 * revisionsberättelse columns on annual_report_profiles with the opinion
 * CHECK validated by 20260915160201.
 */

async function insertAuditor(companyId: string, userId: string, over: Record<string, string> = {}): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.association_auditors (company_id, user_id, name, kind, appointed_on, term_ends_on, ended_on)
     VALUES ($1, $2, 'Revisor Ett', $3, $4, $5, $6) RETURNING id`,
    [companyId, userId, over.kind ?? 'auktoriserad_revisor', over.appointed_on ?? '2024-05-20', over.term_ends_on ?? null, over.ended_on ?? null],
  )
  return res.rows[0].id
}

describe('association auditors: RLS', () => {
  it('lets company members read, strangers see nothing, viewers cannot write, members write only as themselves', async () => {
    const { userId, companyId } = await seedCompany()
    const auditorId = await insertAuditor(companyId, userId)
    const stranger = await insertAuthUser()
    expect(
      (await withUserContext(userId, (c) => c.query(`SELECT id FROM public.association_auditors WHERE id = $1`, [auditorId]))).rows,
    ).toHaveLength(1)
    expect(
      (await withUserContext(stranger, (c) => c.query(`SELECT id FROM public.association_auditors WHERE id = $1`, [auditorId]))).rows,
    ).toHaveLength(0)

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    expect(
      (await withUserContext(viewer, (c) => c.query(`SELECT id FROM public.association_auditors WHERE id = $1`, [auditorId]))).rows,
    ).toHaveLength(1)
    await expect(
      withUserContext(viewer, (c) =>
        c.query(
          `INSERT INTO public.association_auditors (company_id, user_id, name, kind, appointed_on)
           VALUES ($1, $2, 'Viewer', 'lekmannarevisor', '2026-05-20')`,
          [companyId, viewer],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    const writer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: writer, role: 'member' })
    const own = await withUserContext(writer, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO public.association_auditors (company_id, user_id, name, kind, appointed_on)
         VALUES ($1, $2, 'Bertil', 'lekmannarevisor', '2026-05-20') RETURNING id`,
        [companyId, writer],
      ),
    )
    expect(own.rows).toHaveLength(1)
    await expect(
      withUserContext(writer, (c) =>
        c.query(
          `INSERT INTO public.association_auditors (company_id, user_id, name, kind, appointed_on)
           VALUES ($1, $2, 'Cecilia', 'lekmannarevisor', '2026-05-20')`,
          [companyId, userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('never deletes a revisor: the assignment is ended with a date instead', async () => {
    const { userId, companyId } = await seedCompany()
    const auditorId = await insertAuditor(companyId, userId)
    await expect(
      withUserContext(userId, (c) => c.query(`DELETE FROM public.association_auditors WHERE id = $1`, [auditorId])),
    ).rejects.toMatchObject({ code: '42501' })
    const ended = await withUserContext(userId, (c) =>
      c.query<{ ended_on: string }>(
        `UPDATE public.association_auditors SET ended_on = '2026-06-30' WHERE id = $1 RETURNING ended_on::text`,
        [auditorId],
      ),
    )
    expect(ended.rows[0].ended_on).toBe('2026-06-30')
  })
})

describe('association auditors: constraints', () => {
  it('accepts only the four kinds and refuses a term or end before the appointment', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(insertAuditor(companyId, userId, { kind: 'granskare' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertAuditor(companyId, userId, { term_ends_on: '2024-01-01' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertAuditor(companyId, userId, { ended_on: '2024-01-01' })).rejects.toMatchObject({ code: '23514' })
    for (const kind of ['lekmannarevisor', 'godkand_revisor', 'auktoriserad_revisor', 'revisionsbolag']) {
      await expect(insertAuditor(companyId, userId, { kind })).resolves.toBeTruthy()
    }
  })
})

describe('annual_report_profiles: archived revisionsberättelse', () => {
  it('stores signed date, opinion, deviations and document, and validates the opinion CHECK', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const ok = await getPool().query<{ auditor_report_opinion: string; auditor_report_signed_on: string }>(
      `INSERT INTO public.annual_report_profiles
         (company_id, fiscal_period_id, user_id, auditor_report_included, auditor_report_signed_on, auditor_report_opinion, auditor_report_deviations)
       VALUES ($1, $2, $3, true, '2026-03-10', 'qualified', 'Lager ej inventerat.')
       RETURNING auditor_report_opinion, auditor_report_signed_on::text`,
      [companyId, fiscalPeriodId, userId],
    )
    expect(ok.rows[0]).toEqual({ auditor_report_opinion: 'qualified', auditor_report_signed_on: '2026-03-10' })
    await expect(
      getPool().query(
        `UPDATE public.annual_report_profiles SET auditor_report_opinion = 'clean' WHERE company_id = $1`,
        [companyId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    const validated = await getPool().query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('annual_report_profiles_auditor_report_opinion_check', 'annual_report_profiles_auditor_report_deviations_length')
        ORDER BY conname`,
    )
    expect(validated.rows).toHaveLength(2)
    expect(validated.rows.every((row) => row.convalidated)).toBe(true)
    // The document FK points at document_attachments; an unknown id is refused.
    await expect(
      getPool().query(
        `UPDATE public.annual_report_profiles SET auditor_report_document_id = gen_random_uuid() WHERE company_id = $1`,
        [companyId],
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })
})
