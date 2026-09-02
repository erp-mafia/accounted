import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertPostedJournalEntry,
  seedCompany,
} from './fixtures'

/**
 * Migration 20260902093000: the high items of the 2026-09-01 security audit.
 *
 *  A. viewer role cannot write, including through membership-only
 *     SECURITY DEFINER RPCs (table-level guard).
 *  B. admin cannot seize the owner seat (company_members.user_id, invitation
 *     role owner, team_members self-promotion); companies.team_id/archived_at
 *     are owner-only and team attachment needs team membership.
 *  C. direct statements cannot insert posted headers, add lines under posted
 *     headers, or post a draft with a voucher number the sequence never
 *     issued; the engine's own direct shapes still work.
 *  D. create_document_version refuses viewers and foreign storage paths;
 *     validate_version_chain needs membership; leftover grants tightened.
 */

async function seedWithRoles() {
  const seeded = await seedCompany()
  const admin = await insertAuthUser()
  await insertCompanyMember({ companyId: seeded.companyId, userId: admin, role: 'admin' })
  const member = await insertAuthUser()
  await insertCompanyMember({ companyId: seeded.companyId, userId: member, role: 'member' })
  const viewer = await insertAuthUser()
  await insertCompanyMember({ companyId: seeded.companyId, userId: viewer, role: 'viewer' })
  return { ...seeded, owner: seeded.userId, admin, member, viewer }
}

describe('A. viewer role cannot write (pg)', () => {
  it('blocks a viewer inserting into a membership-only table and lets a member through', async () => {
    const { companyId, member, viewer } = await seedWithRoles()
    await expect(
      withUserContext(viewer, (c) =>
        c.query(
          `INSERT INTO public.employees (company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_type, employment_start, employment_degree, salary_type)
           VALUES ($1, $2, 'Eva', 'Viewer', '199001011234', '1234', 'employee', '2026-01-01', 100, 'monthly')`,
          [companyId, viewer],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    await withUserContext(member, async (c) => {
      const res = await c.query(
        `INSERT INTO public.employees (company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_type, employment_start, employment_degree, salary_type)
         VALUES ($1, $2, 'Max', 'Member', '199001011235', '1235', 'employee', '2026-01-01', 100, 'monthly') RETURNING id`,
        [companyId, member],
      )
      expect(res.rows).toHaveLength(1)
    })
  })

  it('blocks a viewer burning voucher numbers through next_voucher_number (SECURITY DEFINER)', async () => {
    const { companyId, fiscalPeriodId, member, viewer } = await seedWithRoles()
    await expect(
      withUserContext(viewer, (c) =>
        c.query(`SELECT public.next_voucher_number($1, $2, 'A')`, [companyId, fiscalPeriodId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    await withUserContext(member, async (c) => {
      const res = await c.query<{ n: number }>(
        `SELECT public.next_voucher_number($1, $2, 'A') AS n`,
        [companyId, fiscalPeriodId],
      )
      expect(res.rows[0]!.n).toBe(1)
    })
  })

  it('blocks a viewer posting through import_sie_journal_entries', async () => {
    const { companyId, fiscalPeriodId, viewer } = await seedWithRoles()
    await expect(
      withUserContext(viewer, (c) =>
        c.query(`SELECT public.import_sie_journal_entries($1, $2, $3, $4::jsonb)`, [
          companyId,
          viewer,
          fiscalPeriodId,
          JSON.stringify([
            {
              date: '2026-06-01',
              description: 'viewer',
              sourceType: 'import',
              series: 'A',
              lines: [
                { account_number: '1930', debit_amount: 100, credit_amount: 0 },
                { account_number: '3001', debit_amount: 0, credit_amount: 100 },
              ],
            },
          ]),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('B. admin cannot seize ownership (pg)', () => {
  it('refuses re-pointing a membership row to another user', async () => {
    const { companyId, owner, admin } = await seedWithRoles()
    const accomplice = await insertAuthUser()
    await expect(
      withUserContext(admin, (c) =>
        c.query(`UPDATE public.company_members SET user_id = $1 WHERE company_id = $2 AND user_id = $3`, [
          accomplice,
          companyId,
          owner,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('still lets the owner change a member role', async () => {
    const { companyId, owner, member } = await seedWithRoles()
    await withUserContext(owner, async (c) => {
      const res = await c.query(
        `UPDATE public.company_members SET role = 'admin' WHERE company_id = $1 AND user_id = $2 RETURNING role`,
        [companyId, member],
      )
      expect(res.rows[0]).toMatchObject({ role: 'admin' })
    })
  })

  it('refuses invitations that grant owner, allows member', async () => {
    const { companyId, admin } = await seedWithRoles()
    const tokenHash = randomUUID().replace(/-/g, '')
    await expect(
      withUserContext(admin, (c) =>
        c.query(
          `INSERT INTO public.company_invitations (company_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, 'x@example.com', 'owner', $2, $3, now() + interval '7 days')`,
          [companyId, tokenHash, admin],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await withUserContext(admin, async (c) => {
      const res = await c.query(
        `INSERT INTO public.company_invitations (company_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, 'y@example.com', 'member', $2, $3, now() + interval '7 days') RETURNING id`,
        [companyId, tokenHash + 'b', admin],
      )
      expect(res.rows).toHaveLength(1)
    })
  })

  it('team admin cannot promote themselves; owner can; first owner self-insert still works', async () => {
    const founder = await insertAuthUser()
    const team = await getPool().query<{ id: string }>(
      `INSERT INTO public.teams (name, created_by) VALUES ('Byrå', $1) RETURNING id`,
      [founder],
    )
    const teamId = team.rows[0]!.id
    await getPool().query(`INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      teamId,
      founder,
    ])
    const teamAdmin = await insertAuthUser()
    await getPool().query(`INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      teamId,
      teamAdmin,
    ])

    await expect(
      withUserContext(teamAdmin, (c) =>
        c.query(`UPDATE public.team_members SET role = 'owner' WHERE team_id = $1 AND user_id = $2`, [
          teamId,
          teamAdmin,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    await withUserContext(founder, async (c) => {
      const res = await c.query(
        `UPDATE public.team_members SET role = 'owner' WHERE team_id = $1 AND user_id = $2 RETURNING role`,
        [teamId, teamAdmin],
      )
      expect(res.rows[0]).toMatchObject({ role: 'owner' })
    })

    // The very first owner of a fresh team is self-inserted by the definer RPC.
    const newcomer = await insertAuthUser()
    await withUserContext(newcomer, async (c) => {
      const res = await c.query<{ id: string }>(`SELECT public.create_team_with_owner('Ny byrå') AS id`)
      const mine = await c.query<{ role: string }>(
        `SELECT role FROM public.team_members WHERE team_id = $1 AND user_id = $2`,
        [res.rows[0]!.id, newcomer],
      )
      expect(mine.rows[0]).toMatchObject({ role: 'owner' })
    })
  })

  it('companies: admin cannot archive or re-team; owner can only attach own team', async () => {
    const { companyId, owner, admin } = await seedWithRoles()
    const foreignTeam = await getPool().query<{ id: string }>(
      `INSERT INTO public.teams (name, created_by) VALUES ('Other byrå', $1) RETURNING id`,
      [await insertAuthUser()],
    )
    await expect(
      withUserContext(admin, (c) =>
        c.query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [companyId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(admin, (c) =>
        c.query(`UPDATE public.companies SET team_id = $1 WHERE id = $2`, [foreignTeam.rows[0]!.id, companyId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(owner, (c) =>
        c.query(`UPDATE public.companies SET team_id = $1 WHERE id = $2`, [foreignTeam.rows[0]!.id, companyId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    const own = await getPool().query<{ id: string }>(
      `INSERT INTO public.teams (name, created_by) VALUES ('Egen', $1) RETURNING id`,
      [owner],
    )
    const ownTeam = own.rows[0]!.id
    await getPool().query(`INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      ownTeam,
      owner,
    ])
    await withUserContext(owner, async (c) => {
      const res = await c.query(`UPDATE public.companies SET team_id = $1 WHERE id = $2 RETURNING team_id`, [
        ownTeam,
        companyId,
      ])
      expect(res.rows[0]).toMatchObject({ team_id: ownTeam })
    })
  })

  it('companies_insert refuses attaching a new company to a foreign team', async () => {
    const user = await insertAuthUser()
    const foreignTeam = await getPool().query<{ id: string }>(
      `INSERT INTO public.teams (name, created_by) VALUES ('Victim byrå', $1) RETURNING id`,
      [await insertAuthUser()],
    )
    await expect(
      withUserContext(user, (c) =>
        c.query(
          `INSERT INTO public.companies (name, entity_type, created_by, team_id) VALUES ('Bogus AB', 'aktiebolag', $1, $2)`,
          [user, foreignTeam.rows[0]!.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('C. posting integrity for direct statements (pg)', () => {
  it('refuses a direct posted header insert, accepts a draft', async () => {
    const { companyId, fiscalPeriodId, member } = await seedWithRoles()
    await expect(
      withUserContext(member, (c) =>
        c.query(
          `INSERT INTO public.journal_entries (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
           VALUES ($1, $2, $3, 4711, 'A', '2026-06-01', 'direct', 'manual', 'posted')`,
          [member, companyId, fiscalPeriodId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    await withUserContext(member, async (c) => {
      const res = await c.query(
        `INSERT INTO public.journal_entries (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
         VALUES ($1, $2, $3, 0, 'A', '2026-06-01', 'draft', 'manual', 'draft') RETURNING id`,
        [member, companyId, fiscalPeriodId],
      )
      expect(res.rows).toHaveLength(1)
    })
  })

  it('refuses adding lines to a posted verifikat from a user session', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const posted = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    await expect(
      withUserContext(userId, (c) =>
        c.query(
          `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
           VALUES ($1, '1930', 500, 0)`,
          [posted],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses posting a draft with a voucher number the sequence never issued', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const draft = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 999 })
    await insertBalancedLines(draft)
    await expect(
      withUserContext(userId, (c) =>
        c.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [draft]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('keeps the engine reversal shape: sequence-issued number, lines while draft, then post', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await withUserContext(userId, async (c) => {
      const n = await c.query<{ n: number }>(`SELECT public.next_voucher_number($1, $2, 'A') AS n`, [
        companyId,
        fiscalPeriodId,
      ])
      const header = await c.query<{ id: string }>(
        `INSERT INTO public.journal_entries (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
         VALUES ($1, $2, $3, $4, 'A', '2026-06-01', 'reversal', 'manual', 'draft') RETURNING id`,
        [userId, companyId, fiscalPeriodId, n.rows[0]!.n],
      )
      const id = header.rows[0]!.id
      await c.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, '1930', 100, 0), ($1, '3001', 0, 100)`,
        [id],
      )
      const posted = await c.query(
        `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1 RETURNING status`,
        [id],
      )
      expect(posted.rows[0]).toMatchObject({ status: 'posted' })
    })
  })

  it('commit_journal_entry (SECURITY DEFINER) still posts drafts for members', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const draft = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertBalancedLines(draft)
    await withUserContext(userId, async (c) => {
      const res = await c.query<{ n: number }>(`SELECT public.commit_journal_entry($1, $2) AS n`, [
        companyId,
        draft,
      ])
      expect(res.rows[0]!.n).toBeGreaterThan(0)
    })
  })
})

describe('D. document RPCs and leftover grants (pg)', () => {
  async function seedDocument() {
    const { companyId, owner, viewer, member } = await seedWithRoles()
    const doc = await getPool().query<{ id: string }>(
      `INSERT INTO public.document_attachments
         (user_id, company_id, storage_path, file_name, file_size_bytes, mime_type, sha256_hash, version, is_current_version, uploaded_by)
       VALUES ($1, $2, $3, 'faktura.pdf', 10, 'application/pdf', repeat('a', 64), 1, true, $1)
       RETURNING id`,
      [owner, companyId, `documents/${companyId}/${owner}/1.pdf`],
    )
    return { companyId, owner, viewer, member, docId: doc.rows[0]!.id }
  }

  it('create_document_version refuses viewers and foreign storage paths', async () => {
    const { companyId, viewer, member, docId } = await seedDocument()
    await expect(
      withUserContext(viewer, (c) =>
        c.query(`SELECT public.create_document_version($1, $2, $3, 'v2.pdf', 11, 'application/pdf', repeat('b', 64))`, [
          viewer,
          docId,
          `documents/${companyId}/${viewer}/2.pdf`,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    await expect(
      withUserContext(member, (c) =>
        c.query(`SELECT public.create_document_version($1, $2, $3, 'v2.pdf', 11, 'application/pdf', repeat('c', 64))`, [
          member,
          docId,
          `documents/${randomUUID()}/x/2.pdf`,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    await withUserContext(member, async (c) => {
      const res = await c.query<{ id: string }>(
        `SELECT public.create_document_version($1, $2, $3, 'v2.pdf', 11, 'application/pdf', repeat('d', 64)) AS id`,
        [member, docId, `documents/${companyId}/${member}/2.pdf`],
      )
      expect(res.rows[0]!.id).toBeTruthy()
    })
  })

  it('validate_version_chain answers not found to non-members and is not anon-callable', async () => {
    const { docId, owner } = await seedDocument()
    const outsider = await insertAuthUser()
    await expect(
      withUserContext(outsider, (c) => c.query(`SELECT * FROM public.validate_version_chain($1)`, [docId])),
    ).rejects.toMatchObject({ code: 'P0001' })
    await withUserContext(owner, async (c) => {
      const res = await c.query(`SELECT * FROM public.validate_version_chain($1)`, [docId])
      expect(res.rows).toHaveLength(1)
    })
    const { rows } = await getPool().query<{ anon: boolean }>(
      `SELECT has_function_privilege('anon', 'public.validate_version_chain(uuid)', 'execute') AS anon`,
    )
    expect(rows[0]!.anon).toBe(false)
  })

  it('tightens the leftover grants', async () => {
    const { rows } = await getPool().query<{ fn: string; anon: boolean; auth: boolean }>(
      `SELECT p.proname AS fn,
              has_function_privilege('anon', p.oid, 'execute') AS anon,
              has_function_privilege('authenticated', p.oid, 'execute') AS auth
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('match_documents', 'match_booking_templates',
                           'update_overdue_supplier_invoices', 'redact_expired_invoice_delivery_pii')`,
    )
    const byName = Object.fromEntries(rows.map((r) => [r.fn, r]))
    expect(byName.match_documents!.anon).toBe(false)
    expect(byName.match_booking_templates!.anon).toBe(false)
    expect(byName.update_overdue_supplier_invoices!.auth).toBe(false)
    expect(byName.redact_expired_invoice_delivery_pii!.auth).toBe(false)
    const dropped = await getPool().query(
      `SELECT 1 FROM pg_proc WHERE proname = 'seed_asset_categories'`,
    )
    expect(dropped.rows).toHaveLength(0)
  })
})
