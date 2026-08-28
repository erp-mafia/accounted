import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

/**
 * `booking_template_hidden` (migration 20260828100000).
 *
 * Per-company opt-in hiding of system templates. The RLS matters here: a hide
 * row written by company A must never leak to, or be writable from, company B,
 * and viewers must not be able to hide anything. All writes go through the
 * authenticated role so the policies are what is actually under test.
 */

async function setActiveCompany(userId: string, companyId: string) {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

async function systemTemplateId(): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT id FROM public.booking_template_library WHERE is_system AND is_active LIMIT 1`,
  )
  return rows[0].id as string
}

describe('booking_template_hidden RLS', () => {
  it('lets a write-role member hide and unhide for the active company', async () => {
    const { userId, companyId } = await seedCompany()
    await setActiveCompany(userId, companyId)
    const templateId = await systemTemplateId()

    await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.booking_template_hidden (template_id, company_id, hidden_by)
         VALUES ($1, $2, $3)`,
        [templateId, companyId, userId],
      )
      const { rows } = await client.query(
        `SELECT template_id FROM public.booking_template_hidden WHERE company_id = $1`,
        [companyId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].template_id).toBe(templateId)

      const del = await client.query(
        `DELETE FROM public.booking_template_hidden
          WHERE template_id = $1 AND company_id = $2`,
        [templateId, companyId],
      )
      expect(del.rowCount).toBe(1)
    })
  })

  it('blocks hiding for a company that is not the active one', async () => {
    const { userId, companyId } = await seedCompany()
    const other = await seedCompany()
    // Member of both, but acting in their own company.
    await insertCompanyMember({ companyId: other.companyId, userId, role: 'owner' })
    await setActiveCompany(userId, companyId)
    const templateId = await systemTemplateId()

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.booking_template_hidden (template_id, company_id, hidden_by)
           VALUES ($1, $2, $3)`,
          [templateId, other.companyId, userId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  it('blocks a viewer from hiding', async () => {
    const { companyId } = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    await setActiveCompany(viewerId, companyId)
    const templateId = await systemTemplateId()

    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.booking_template_hidden (template_id, company_id, hidden_by)
           VALUES ($1, $2, $3)`,
          [templateId, companyId, viewerId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  it("does not leak another company's hide rows", async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const templateId = await systemTemplateId()
    // Seed A's hide row on the superuser connection so it persists for B's read.
    await getPool().query(
      `INSERT INTO public.booking_template_hidden (template_id, company_id, hidden_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [templateId, a.companyId, a.userId],
    )
    await setActiveCompany(b.userId, b.companyId)

    await withUserContext(b.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT template_id FROM public.booking_template_hidden`,
      )
      expect(rows).toEqual([])
    })

    // Cleanup the persisted seed row.
    await getPool().query(
      `DELETE FROM public.booking_template_hidden WHERE company_id = $1`,
      [a.companyId],
    )
  })

  it('enforces one hide row per (template, company)', async () => {
    const { userId, companyId } = await seedCompany()
    await setActiveCompany(userId, companyId)
    const templateId = await systemTemplateId()

    await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.booking_template_hidden (template_id, company_id, hidden_by)
         VALUES ($1, $2, $3)`,
        [templateId, companyId, userId],
      )
      await expect(
        client.query(
          `INSERT INTO public.booking_template_hidden (template_id, company_id, hidden_by)
           VALUES ($1, $2, $3)`,
          [templateId, companyId, userId],
        ),
      ).rejects.toThrow(/duplicate key/)
    })
  })
})
