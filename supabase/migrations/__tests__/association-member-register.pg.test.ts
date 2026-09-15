import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertPostedJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'

/**
 * 20260915160000_association_member_register.sql: RLS on the three register
 * tables (members read, owner/admin/member write with user_id = auth.uid(),
 * viewers read-only), the append-only events table (no UPDATE/DELETE grant),
 * the CHECK constraints that keep the register consistent, and the read-only
 * preview_company_entity_type_change() RPC.
 */

async function insertMember(companyId: string, userId: string, memberNumber = '1'): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.association_members (company_id, user_id, member_number, name, admitted_on)
     VALUES ($1, $2, $3, 'Anna Andersson', '2026-01-10') RETURNING id`,
    [companyId, userId, memberNumber],
  )
  return res.rows[0].id
}

describe('association member register: RLS', () => {
  it('lets company members read and strangers see nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertMember(companyId, userId)
    const stranger = await insertAuthUser()
    const own = await withUserContext(userId, (c) =>
      c.query(`SELECT id FROM public.association_members WHERE id = $1`, [memberId]),
    )
    expect(own.rows).toHaveLength(1)
    const other = await withUserContext(stranger, (c) =>
      c.query(`SELECT id FROM public.association_members WHERE id = $1`, [memberId]),
    )
    expect(other.rows).toHaveLength(0)
  })

  it('lets a viewer read but not write, and a member write only as themselves', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertMember(companyId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    const viewerRead = await withUserContext(viewer, (c) =>
      c.query(`SELECT id FROM public.association_members WHERE id = $1`, [memberId]),
    )
    expect(viewerRead.rows).toHaveLength(1)
    await expect(
      withUserContext(viewer, (c) =>
        c.query(
          `INSERT INTO public.association_members (company_id, user_id, member_number, name, admitted_on)
           VALUES ($1, $2, '2', 'Viewer', '2026-02-01')`,
          [companyId, viewer],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    const writer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: writer, role: 'member' })
    const inserted = await withUserContext(writer, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO public.association_members (company_id, user_id, member_number, name, admitted_on)
         VALUES ($1, $2, '3', 'Bertil', '2026-03-01') RETURNING id`,
        [companyId, writer],
      ),
    )
    expect(inserted.rows).toHaveLength(1)
    // user_id must be the caller: a row attributed to someone else is refused.
    await expect(
      withUserContext(writer, (c) =>
        c.query(
          `INSERT INTO public.association_members (company_id, user_id, member_number, name, admitted_on)
           VALUES ($1, $2, '4', 'Cecilia', '2026-03-01')`,
          [companyId, userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('keeps the register: no DELETE on members or contributions, no UPDATE or DELETE on events', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertMember(companyId, userId)
    await getPool().query(
      `INSERT INTO public.association_member_events (company_id, user_id, member_id, event_type, occurred_on)
       VALUES ($1, $2, $3, 'admission', '2026-01-10')`,
      [companyId, userId, memberId],
    )
    await expect(
      withUserContext(userId, (c) => c.query(`DELETE FROM public.association_members WHERE id = $1`, [memberId])),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) =>
        c.query(`UPDATE public.association_member_events SET event_type = 'exit' WHERE member_id = $1`, [memberId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) =>
        c.query(`DELETE FROM public.association_member_events WHERE member_id = $1`, [memberId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('association member register: constraints', () => {
  it('requires one member number per company and an exit not before admission', async () => {
    const { userId, companyId } = await seedCompany()
    await insertMember(companyId, userId, '7')
    await expect(insertMember(companyId, userId, '7')).rejects.toMatchObject({ code: '23505' })
    await expect(
      getPool().query(
        `INSERT INTO public.association_members (company_id, user_id, member_number, name, admitted_on, exited_on)
         VALUES ($1, $2, '8', 'Early', '2026-05-01', '2026-04-30')`,
        [companyId, userId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('ties a contribution status to its settlement date and forbids negative amounts', async () => {
    const { userId, companyId } = await seedCompany()
    const memberId = await insertMember(companyId, userId)
    await expect(
      getPool().query(
        `INSERT INTO public.association_member_contributions (company_id, user_id, member_id, kind, amount, paid_on, status)
         VALUES ($1, $2, $3, 'obligatory', 500, '2026-01-10', 'repaid')`,
        [companyId, userId, memberId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `INSERT INTO public.association_member_contributions (company_id, user_id, member_id, kind, amount, paid_on)
         VALUES ($1, $2, $3, 'obligatory', -1, '2026-01-10')`,
        [companyId, userId, memberId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    const ok = await getPool().query<{ id: string }>(
      `INSERT INTO public.association_member_contributions (company_id, user_id, member_id, kind, amount, paid_on)
       VALUES ($1, $2, $3, 'forlags', 10000, '2026-01-10') RETURNING id`,
      [companyId, userId, memberId],
    )
    expect(ok.rows).toHaveLength(1)
  })
})

describe('preview_company_entity_type_change', () => {
  it('reports the empty-books path for the owner of a fresh company', async () => {
    const ownerId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: ownerId, entityType: 'aktiebolag' })
    await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
    const res = await withUserContext(ownerId, (c) =>
      c.query<{ r: Record<string, unknown> }>(
        `SELECT public.preview_company_entity_type_change($1::uuid, 'ekonomisk_forening') AS r`,
        [companyId],
      ),
    )
    expect(res.rows[0].r).toMatchObject({
      ok: true,
      current_entity_type: 'aktiebolag',
      target_entity_type: 'ekonomisk_forening',
      empty_books_path_available: true,
      decision_accounts: [],
    })
  })

  it('lists posted balances on the decision accounts and closes the empty-books path once books exist', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    // A posted share-capital verifikat: 25 000 kr on 2081 against the bank.
    await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      description: 'Aktiekapital',
      lines: [
        { accountNumber: '1930', debitAmount: 25000, creditAmount: 0 },
        { accountNumber: '2081', debitAmount: 0, creditAmount: 25000 },
      ],
    })
    const res = await withUserContext(userId, (c) =>
      c.query<{ r: { empty_books_path_available: boolean; decision_accounts: Array<{ account: string; balance: string | number }>; blockers: Record<string, number> } }>(
        `SELECT public.preview_company_entity_type_change($1::uuid, 'ekonomisk_forening') AS r`,
        [companyId],
      ),
    )
    const r = res.rows[0].r
    expect(r.empty_books_path_available).toBe(false)
    expect(r.blockers.journal_entries).toBe(1)
    expect(r.decision_accounts).toEqual([{ account: '2081', balance: 25000 }])
  })

  it('refuses an outsider and an unsupported target', async () => {
    const { userId, companyId } = await seedCompany()
    const outsider = await insertAuthUser()
    const denied = await withUserContext(outsider, (c) =>
      c.query<{ r: Record<string, unknown> }>(
        `SELECT public.preview_company_entity_type_change($1::uuid, 'ekonomisk_forening') AS r`,
        [companyId],
      ),
    )
    expect(denied.rows[0].r).toMatchObject({ ok: false, code: 'ENTITY_TYPE_CHANGE_NOT_FOUND' })
    const unsupported = await withUserContext(userId, (c) =>
      c.query<{ r: Record<string, unknown> }>(
        `SELECT public.preview_company_entity_type_change($1::uuid, 'handelsbolag') AS r`,
        [companyId],
      ),
    )
    expect(unsupported.rows[0].r).toMatchObject({ ok: false, code: 'ENTITY_TYPE_CHANGE_UNSUPPORTED' })
  })
})
