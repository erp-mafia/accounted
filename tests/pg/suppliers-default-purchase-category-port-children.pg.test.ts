import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { PURCHASE_CATEGORY_CODES } from '@/lib/categories/purchase-categories'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * suppliers.default_purchase_category holds a purchase-category code, which
 * since 2026-10-17 is a child of a posting-port key ('<port key>.<item>',
 * expense.software.saas). Migration 20261017123100 replaces the two-segment
 * shape CHECK of 20261017000000 with one that takes three segments or more,
 * in the shape business_events_category_check enforces, and 20261017123200
 * validates it. Every code of the taxonomy must be storable; a port key on
 * its own, the old two-segment codes and anything off the shape are refused.
 */
describe('suppliers.default_purchase_category: codes under port keys', () => {
  let userId: string
  let companyId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  async function insertWith(code: string | null): Promise<void> {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.suppliers (id, user_id, company_id, name, default_purchase_category)
         VALUES ($1, $2, $3, 'Programvaru AB', $4)`,
        [randomUUID(), userId, companyId, code],
      )
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  it('stores every code of the taxonomy, and no instruction at all', async () => {
    for (const code of PURCHASE_CATEGORY_CODES) {
      await expect(insertWith(code), code).resolves.toBeUndefined()
    }
    await expect(insertWith(null)).resolves.toBeUndefined()
  })

  it.each([
    ['a port key on its own', 'expense.software'],
    ['an old two-segment code', 'software.saas'],
    ['upper case', 'Expense.Software.Saas'],
    ['an empty segment', 'expense.software.'],
    ['a leading digit in a segment', 'expense.software.9saas'],
    ['more than 64 characters', `expense.software.${'a'.repeat(48)}`],
  ])('refuses %s', async (_label, code) => {
    await expect(insertWith(code)).rejects.toMatchObject({ code: '23514' })
  })

  it('leaves the constraint validated', async () => {
    const { rows } = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'public.suppliers'::regclass
          AND conname = 'suppliers_default_purchase_category_check'`,
    )
    expect(rows).toEqual([{ convalidated: true }])
  })
})
