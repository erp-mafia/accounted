import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * `booking_template_library.pack_slug` (migration 20260803230000).
 *
 * The column is the stable upsert key that lets system templates be synced from
 * packs/*.yaml instead of living as rows frozen inside migration 20260413160000.
 * Its three guards each stop a specific way the sync could corrupt the
 * catalogue, so each is asserted here rather than trusted.
 */
describe('booking_template_library.pack_slug', () => {
  it('backfilled every seeded system template', async () => {
    const { rows } = await getPool().query(
      `SELECT count(*) FILTER (WHERE pack_slug IS NULL) AS missing, count(*) AS total
         FROM public.booking_template_library WHERE is_system`,
    )
    // A system template without a slug would be invisible to the sync and would
    // silently persist as a duplicate of whatever pack replaced it.
    expect(Number(rows[0].missing)).toBe(0)
    expect(Number(rows[0].total)).toBeGreaterThan(0)
  })

  it('holds a unique slug per system template', async () => {
    const { rows } = await getPool().query(
      `SELECT pack_slug, count(*) AS n FROM public.booking_template_library
        WHERE pack_slug IS NOT NULL GROUP BY pack_slug HAVING count(*) > 1`,
    )
    expect(rows).toEqual([])
  })

  it('rejects a second row claiming an existing slug', async () => {
    const existing = await getPool().query(
      `SELECT pack_slug FROM public.booking_template_library WHERE pack_slug IS NOT NULL LIMIT 1`,
    )
    const slug = existing.rows[0].pack_slug as string

    await expect(
      getPool().query(
        `INSERT INTO public.booking_template_library
           (name, description, category, entity_type, is_system, lines, pack_slug)
         VALUES ('Dubblett', '', 'other', 'all', TRUE, '[]'::jsonb, $1)`,
        [slug],
      ),
    ).rejects.toThrow(/btl_pack_slug_unique/)
  })

  it('rejects a slug that the pack loader would refuse', async () => {
    for (const bad of ['Bad_Slug', 'trailing-', '-leading', 'double--dash', 'ÅÄÖ']) {
      await expect(
        getPool().query(
          `INSERT INTO public.booking_template_library
             (name, description, category, entity_type, is_system, lines, pack_slug)
           VALUES ('Ogiltig', '', 'other', 'all', TRUE, '[]'::jsonb, $1)`,
          [bad],
        ),
        bad,
      ).rejects.toThrow(/btl_pack_slug_format/)
    }
  })

  it('refuses a pack_slug on a COMPANY template, which would shadow the pack', async () => {
    // Scoped to a real company so the pre-existing "company or team or system"
    // CHECK is satisfied and pack_slug is genuinely the constraint under test.
    const { companyId, userId } = await seedCompany()

    await expect(
      getPool().query(
        `INSERT INTO public.booking_template_library
           (id, company_id, created_by, name, description, category, entity_type,
            is_system, lines, pack_slug)
         VALUES ($1, $2, $3, 'Kapad mall', '', 'other', 'all', FALSE, '[]'::jsonb, 'kapad-mall')`,
        [randomUUID(), companyId, userId],
      ),
    ).rejects.toThrow(/btl_pack_slug_system_only/)
  })

  it('still allows a company template with no slug', async () => {
    const { companyId, userId } = await seedCompany()
    const id = randomUUID()

    await getPool().query(
      `INSERT INTO public.booking_template_library
         (id, company_id, created_by, name, description, category, entity_type, is_system, lines)
       VALUES ($1, $2, $3, 'Egen mall', '', 'other', 'all', FALSE, '[]'::jsonb)`,
      [id, companyId, userId],
    )

    const { rows } = await getPool().query(
      `SELECT pack_slug FROM public.booking_template_library WHERE id = $1`,
      [id],
    )
    expect(rows[0].pack_slug).toBeNull()
  })
})
