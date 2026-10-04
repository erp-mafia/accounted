import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool } from '@/tests/pg/setup'

/**
 * customers_individual_no_org_number (20261003181500).
 *
 * A privatperson has no org number: its personnummer is stored encrypted in
 * personal_number. The CHECK refuses any non-blank org_number on
 * customer_type='individual'; a blank value counts as none, because the
 * customer form writes '' for every new individual.
 *
 * All identifiers below are synthetic.
 */

async function insertCustomer(params: {
  userId: string
  companyId: string
  customerType?: string
  orgNumber: string | null
}): Promise<string> {
  const id = randomUUID()
  if (params.customerType === undefined) {
    // The column default is 'individual'.
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, org_number)
       VALUES ($1, $2, $3, 'Testkund', $4)`,
      [id, params.userId, params.companyId, params.orgNumber],
    )
  } else {
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, org_number)
       VALUES ($1, $2, $3, 'Testkund', $4, $5)`,
      [id, params.userId, params.companyId, params.customerType, params.orgNumber],
    )
  }
  return id
}

describe('customers_individual_no_org_number.pg', () => {
  it('is added NOT VALID: VALIDATE waits for the repair of existing rows', async () => {
    const res = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conname = 'customers_individual_no_org_number'
          AND conrelid = 'public.customers'::regclass`,
    )
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.convalidated).toBe(false)
  })

  it('refuses an org number on an individual, a personnummer included', async () => {
    const { userId, companyId } = await seedCompany()

    for (const orgNumber of ['556677-8899', '19900101-1234']) {
      await expect(
        insertCustomer({ userId, companyId, customerType: 'individual', orgNumber }),
      ).rejects.toThrow(/customers_individual_no_org_number/)
    }
  })

  it('refuses it on a row that takes the individual column default', async () => {
    const { userId, companyId } = await seedCompany()

    await expect(insertCustomer({ userId, companyId, orgNumber: '556677-8899' })).rejects.toThrow(
      /customers_individual_no_org_number/,
    )
  })

  it('accepts an individual with no org number, NULL or blank', async () => {
    const { userId, companyId } = await seedCompany()

    for (const orgNumber of [null, '', '   ']) {
      await expect(
        insertCustomer({ userId, companyId, customerType: 'individual', orgNumber }),
      ).resolves.toEqual(expect.any(String))
    }
  })

  it('leaves business customers alone, an enskild firma personnummer included', async () => {
    const { userId, companyId } = await seedCompany()

    await expect(
      insertCustomer({ userId, companyId, customerType: 'swedish_business', orgNumber: '556677-8899' }),
    ).resolves.toEqual(expect.any(String))
    await expect(
      insertCustomer({ userId, companyId, customerType: 'swedish_business', orgNumber: '19900101-1234' }),
    ).resolves.toEqual(expect.any(String))
  })

  it('refuses a type change to individual that keeps the org number, and allows it when cleared', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertCustomer({ userId, companyId, customerType: 'swedish_business', orgNumber: '556677-8899' })

    await expect(
      getPool().query(`UPDATE public.customers SET customer_type = 'individual' WHERE id = $1`, [id]),
    ).rejects.toThrow(/customers_individual_no_org_number/)

    await getPool().query(
      `UPDATE public.customers SET customer_type = 'individual', org_number = NULL WHERE id = $1`,
      [id],
    )
    const res = await getPool().query<{ customer_type: string; org_number: string | null }>(
      `SELECT customer_type, org_number FROM public.customers WHERE id = $1`,
      [id],
    )
    expect(res.rows[0]).toEqual({ customer_type: 'individual', org_number: null })
  })

  it('refuses any UPDATE of a legacy row that violates it, which is why the repair runs first', async () => {
    // Recreate the pre-migration state inside a rolled-back transaction: drop
    // the constraint, write a legacy row, re-add the constraint exactly as
    // defined (NOT VALID), then touch an unrelated column.
    const { userId, companyId } = await seedCompany()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const def = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conname = 'customers_individual_no_org_number'
            AND conrelid = 'public.customers'::regclass`,
      )
      await client.query('ALTER TABLE public.customers DROP CONSTRAINT customers_individual_no_org_number')
      const id = randomUUID()
      await client.query(
        `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, org_number)
         VALUES ($1, $2, $3, 'Legacy', 'individual', '19900101-1234')`,
        [id, userId, companyId],
      )
      await client.query(
        `ALTER TABLE public.customers ADD CONSTRAINT customers_individual_no_org_number ${def.rows[0]!.def}`,
      )
      await client.query('SAVEPOINT touch')
      await expect(
        client.query(`UPDATE public.customers SET email = 'new@example.test' WHERE id = $1`, [id]),
      ).rejects.toThrow(/customers_individual_no_org_number/)
      await client.query('ROLLBACK TO SAVEPOINT touch')

      // The repair's write (clear org_number) is the one UPDATE that passes.
      await client.query(`UPDATE public.customers SET org_number = NULL WHERE id = $1`, [id])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
