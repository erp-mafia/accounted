import { describe, expect, it } from 'vitest'
import { PROFILE_IDS } from '@/lib/modules/profiles'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Covers 20261016190000_companies_profile and
 * 20261016190100_validate_companies_profile_checks.
 *
 * companies gains a nullable profile (id + version) and a recorded
 * suggestion (id + version). NULL is "Standard (allt på)", so a company
 * written without them, as every existing company is, stays unchanged. The
 * id CHECKs hold exactly the ids of src/lib/modules/profiles.ts, id and
 * version travel together, and the company admins the companies_update
 * policy admits are the ones who can set a profile from a user session.
 */

const PROFILE_COLUMNS = ['profile_id', 'profile_version', 'suggested_profile_id', 'suggested_profile_version']

async function profileOf(companyId: string) {
  const { rows } = await getPool().query(
    `SELECT profile_id, profile_version, suggested_profile_id, suggested_profile_version
       FROM public.companies WHERE id = $1`,
    [companyId],
  )
  return rows[0]
}

describe('companies profile columns', () => {
  it('are nullable, typed text and integer, and NULL for a company written without them', async () => {
    const { rows } = await getPool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = ANY($1)
        ORDER BY column_name`,
      [PROFILE_COLUMNS],
    )
    expect(rows.map((r) => r.column_name)).toEqual([...PROFILE_COLUMNS].sort())
    for (const r of rows) {
      expect(r.is_nullable, r.column_name).toBe('YES')
      expect(r.column_default, r.column_name).toBeNull()
      expect(r.data_type, r.column_name).toBe(r.column_name.endsWith('_version') ? 'integer' : 'text')
    }

    const { companyId } = await seedCompany()
    expect(await profileOf(companyId)).toEqual({
      profile_id: null,
      profile_version: null,
      suggested_profile_id: null,
      suggested_profile_version: null,
    })
  })

  it('validates its CHECKs, and the id CHECKs hold exactly the profile ids in code', async () => {
    const { rows } = await getPool().query<{ conname: string; convalidated: boolean; def: string }>(
      `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.companies'::regclass AND conname = ANY($1)`,
      [[
        'companies_profile_id_check',
        'companies_profile_version_check',
        'companies_suggested_profile_id_check',
        'companies_suggested_profile_version_check',
      ]],
    )
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(r.convalidated, r.conname).toBe(true)
    for (const name of ['companies_profile_id_check', 'companies_suggested_profile_id_check']) {
      const def = rows.find((r) => r.conname === name)!.def
      const ids = [...def.matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1])
      expect(ids, name).toEqual([...PROFILE_IDS])
    }
  })

  it('accepts every profile id at a version, and refuses an unknown id', async () => {
    const { companyId } = await seedCompany()
    for (const id of PROFILE_IDS) {
      await getPool().query(
        `UPDATE public.companies
            SET profile_id = $2, profile_version = 1, suggested_profile_id = $2, suggested_profile_version = 1
          WHERE id = $1`,
        [companyId, id],
      )
      expect((await profileOf(companyId)).profile_id).toBe(id)
    }
    await expect(
      getPool().query(`UPDATE public.companies SET profile_id = 'freelancer', profile_version = 1 WHERE id = $1`, [companyId]),
    ).rejects.toThrow(/companies_profile_id_check/)
    await expect(
      getPool().query(
        `UPDATE public.companies SET suggested_profile_id = 'Standard', suggested_profile_version = 1 WHERE id = $1`,
        [companyId],
      ),
    ).rejects.toThrow(/companies_suggested_profile_id_check/)
  })

  it('stores id and version together, with versions from 1', async () => {
    const { companyId } = await seedCompany()
    await expect(
      getPool().query(`UPDATE public.companies SET profile_id = 'retail' WHERE id = $1`, [companyId]),
    ).rejects.toThrow(/companies_profile_version_check/)
    await expect(
      getPool().query(`UPDATE public.companies SET profile_version = 1 WHERE id = $1`, [companyId]),
    ).rejects.toThrow(/companies_profile_version_check/)
    await expect(
      getPool().query(`UPDATE public.companies SET profile_id = 'retail', profile_version = 0 WHERE id = $1`, [companyId]),
    ).rejects.toThrow(/companies_profile_version_check/)
    await expect(
      getPool().query(`UPDATE public.companies SET suggested_profile_id = 'retail' WHERE id = $1`, [companyId]),
    ).rejects.toThrow(/companies_suggested_profile_version_check/)

    // Back to no profile: both NULL again is Standard.
    await getPool().query(`UPDATE public.companies SET profile_id = 'retail', profile_version = 1 WHERE id = $1`, [companyId])
    await getPool().query(`UPDATE public.companies SET profile_id = NULL, profile_version = NULL WHERE id = $1`, [companyId])
    expect((await profileOf(companyId)).profile_id).toBeNull()
  })

  it('lets a company admin set the profile from a user session, and not a plain member', async () => {
    const { companyId, userId: ownerId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const byOwner = await withUserContext(ownerId, async (client) => {
      const res = await client.query(
        `UPDATE public.companies SET profile_id = 'association', profile_version = 1 WHERE id = $1 RETURNING profile_id`,
        [companyId],
      )
      return res.rows
    })
    expect(byOwner).toEqual([{ profile_id: 'association' }])

    const byMember = await withUserContext(memberId, async (client) => {
      const res = await client.query(
        `UPDATE public.companies SET profile_id = 'association', profile_version = 1 WHERE id = $1 RETURNING profile_id`,
        [companyId],
      )
      return res.rows
    })
    expect(byMember).toEqual([])
  })
})
