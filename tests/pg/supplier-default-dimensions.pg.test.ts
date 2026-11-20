import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

// pg-real coverage for 20261031203517: suppliers.default_dimensions, the bag
// a new supplier invoice takes when it names none (accounted#144). Every
// existing and new supplier reads {}; the object CHECK and the bag contract
// of jel_dimensions_well_formed refuse a bag no journal line could carry,
// from the service role and from a member alike; RLS keeps another
// company's member from reading or setting it.

async function insertSupplier(companyId: string, userId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name) VALUES ($1, $2, 'Elnät AB') RETURNING id::text`,
    [userId, companyId],
  )
  return rows[0]!.id
}

describe('suppliers.default_dimensions (20261031203517)', () => {
  it('reads {} on a supplier inserted without it', async () => {
    const { companyId, userId } = await seedCompany()
    const supplierId = await insertSupplier(companyId, userId)
    const { rows } = await getPool().query<{ default_dimensions: unknown }>(
      `SELECT default_dimensions FROM public.suppliers WHERE id = $1`,
      [supplierId],
    )
    expect(rows[0]!.default_dimensions).toEqual({})
  })

  it.each([
    ['an array', `'["1","FAST01"]'`, /suppliers_default_dimensions_is_object/],
    ['a string', `'"FAST01"'`, /suppliers_default_dimensions_is_object/],
    ['a key that is no SIE dimension number', `'{"x":"FAST01"}'`, /suppliers_default_dimensions_well_formed/],
    ['a zero-padded key', `'{"01":"FAST01"}'`, /suppliers_default_dimensions_well_formed/],
    ['a number for a code', `'{"1":5}'`, /suppliers_default_dimensions_well_formed/],
    ['an empty code', `'{"1":""}'`, /suppliers_default_dimensions_well_formed/],
    ['a code over 40 characters', `jsonb_build_object('1', repeat('A', 41))`, /suppliers_default_dimensions_well_formed/],
    ['a code with a brace', `'{"1":"FAST{01}"}'`, /suppliers_default_dimensions_well_formed/],
    ['NULL', 'NULL', /default_dimensions/],
  ])('refuses %s', async (_label, value, message) => {
    const { companyId, userId } = await seedCompany()
    const supplierId = await insertSupplier(companyId, userId)
    await expect(
      getPool().query(`UPDATE public.suppliers SET default_dimensions = ${value} WHERE id = $1`, [supplierId]),
    ).rejects.toThrow(message)
  })

  it('stores a well-formed bag set by a member of the company, and another company cannot touch it', async () => {
    const { companyId, userId } = await seedCompany()
    const supplierId = await insertSupplier(companyId, userId)

    await withUserContext(userId, async (client) => {
      const updated = await client.query(
        `UPDATE public.suppliers SET default_dimensions = '{"1":"FAST01","6":"P 2026/7"}'::jsonb WHERE id = $1`,
        [supplierId],
      )
      expect(updated.rowCount).toBe(1)
      const { rows } = await client.query<{ default_dimensions: unknown }>(
        `SELECT default_dimensions FROM public.suppliers WHERE id = $1`,
        [supplierId],
      )
      expect(rows[0]!.default_dimensions).toEqual({ '1': 'FAST01', '6': 'P 2026/7' })
    })

    // A member of another company sees no row and changes none.
    const outsider = await insertAuthUser()
    const other = await seedCompany()
    await insertCompanyMember({ companyId: other.companyId, userId: outsider })
    await withUserContext(outsider, async (client) => {
      const updated = await client.query(
        `UPDATE public.suppliers SET default_dimensions = '{"1":"X"}'::jsonb WHERE id = $1`,
        [supplierId],
      )
      expect(updated.rowCount).toBe(0)
    })
  })
})
