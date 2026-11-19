import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool } from './setup'

/**
 * customers_individual_no_org_number (20261118131500, validated by
 * 20261118131600): a private person's customer card holds no org number.
 *
 * The personnummer of a privatperson lives encrypted in personal_number;
 * org_number is plain text. The application refuses the combination on its
 * own write paths; these tests pin what the database refuses for any writer.
 *
 * All numbers below are synthetic.
 */

const CONSTRAINT = 'customers_individual_no_org_number'
const REFUSED = new RegExp(CONSTRAINT)
// Luhn-valid, as normalize_org_number requires for the party behind a card.
const PERSONNUMMER = '900101-1239'
const ORG_NUMBER = '556430-0142'
const SEALED = 'ab'.repeat(40)

type Seeded = { userId: string; companyId: string }

async function insertCustomer(
  c: Seeded,
  customerType: string,
  orgNumber: string | null,
  name = 'Testkund',
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.customers (user_id, company_id, name, customer_type, org_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [c.userId, c.companyId, name, customerType, orgNumber],
  )
  return rows[0]!.id
}

async function isValidated(query: (sql: string) => Promise<{ rows: Array<{ convalidated: boolean }> }>): Promise<boolean> {
  const { rows } = await query(
    `SELECT convalidated FROM pg_constraint
     WHERE conname = '${CONSTRAINT}' AND conrelid = 'public.customers'::regclass`,
  )
  expect(rows).toHaveLength(1)
  return rows[0]!.convalidated
}

/** The validating migration's own SQL, found by name so a re-timestamp keeps the test. */
function validateMigrationSql(): string {
  const dir = join(process.cwd(), 'supabase/migrations')
  const file = readdirSync(dir).filter((f) => f.endsWith(`_validate_${CONSTRAINT}.sql`))
  expect(file).toHaveLength(1)
  return readFileSync(join(dir, file[0]!), 'utf8')
}

describe('customers_individual_no_org_number (pg)', () => {
  it('is validated after a full replay: no row violates, so the validating migration ran its VALIDATE', async () => {
    expect(await isValidated((sql) => getPool().query(sql))).toBe(true)
  })

  it('refuses an org number on an individual, a personnummer and a company number alike', async () => {
    const c = await seedCompany()
    for (const number of [PERSONNUMMER, '9001011239', '199001011239', ORG_NUMBER]) {
      await expect(insertCustomer(c, 'individual', number)).rejects.toThrow(REFUSED)
    }
  })

  it('refuses an org number when the type is left to its default, which is individual', async () => {
    const c = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.customers (user_id, company_id, name, org_number) VALUES ($1, $2, 'Kund AB', $3)`,
        [c.userId, c.companyId, ORG_NUMBER],
      ),
    ).rejects.toThrow(REFUSED)
  })

  it('accepts an individual with no org number: NULL, empty and whitespace all count as none', async () => {
    // The write paths trim before they judge the value and can store a blank
    // as it came, so spaces, tabs and line breaks are none here too.
    const c = await seedCompany()
    for (const none of [null, '', '   ', '\t', ' \r\n ']) {
      await expect(insertCustomer(c, 'individual', none)).resolves.toBeTruthy()
    }
    // The personnummer itself is welcome where it belongs, sealed.
    await expect(
      getPool().query(
        `INSERT INTO public.customers (user_id, company_id, name, customer_type, personal_number)
         VALUES ($1, $2, 'Anna Andersson', 'individual', $3)`,
        [c.userId, c.companyId, SEALED],
      ),
    ).resolves.toBeTruthy()
  })

  it('leaves every business type alone, a sole trader with a personnummer as org number included', async () => {
    const c = await seedCompany()
    await expect(insertCustomer(c, 'swedish_business', ORG_NUMBER, 'Exempel AB')).resolves.toBeTruthy()
    await expect(insertCustomer(c, 'swedish_business', PERSONNUMMER, 'Exempel Enskild Firma')).resolves.toBeTruthy()
    await expect(insertCustomer(c, 'eu_business', 'DE123456789', 'Muster GmbH')).resolves.toBeTruthy()
    await expect(insertCustomer(c, 'non_eu_business', 'US-12-3456789', 'Example Inc')).resolves.toBeTruthy()
  })

  it('refuses an UPDATE that puts an org number on an individual', async () => {
    const c = await seedCompany()
    const id = await insertCustomer(c, 'individual', null)
    await expect(
      getPool().query(`UPDATE public.customers SET org_number = $2 WHERE id = $1`, [id, PERSONNUMMER]),
    ).rejects.toThrow(REFUSED)
  })

  it('refuses turning a business into an individual unless the same write clears its org number', async () => {
    const c = await seedCompany()
    const id = await insertCustomer(c, 'swedish_business', PERSONNUMMER, 'Exempel Enskild Firma')

    await expect(
      getPool().query(`UPDATE public.customers SET customer_type = 'individual' WHERE id = $1`, [id]),
    ).rejects.toThrow(REFUSED)

    // What the register repair and the customer commands write: the type,
    // the cleared number and the sealed personnummer in one statement.
    await getPool().query(
      `UPDATE public.customers SET customer_type = 'individual', org_number = NULL, personal_number = $2 WHERE id = $1`,
      [id, SEALED],
    )
    const { rows } = await getPool().query<{ customer_type: string; org_number: string | null }>(
      `SELECT customer_type, org_number FROM public.customers WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ customer_type: 'individual', org_number: null })
  })

  it('on a database that still holds such a card: only clearing the number writes it, and validation waits for that', async () => {
    // A self-hosted database can reach the migration with these rows in it.
    // The state cannot be built with the constraint on, so it is taken off
    // and put back NOT VALID from its own definition, inside one transaction
    // that is rolled back: nothing of this reaches the next test.
    const c = await seedCompany()
    const validate = validateMigrationSql()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: def } = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = '${CONSTRAINT}' AND conrelid = 'public.customers'::regclass`,
      )
      const check = def[0]!.def.replace(/\s+NOT VALID$/, '')
      await client.query(`ALTER TABLE public.customers DROP CONSTRAINT ${CONSTRAINT}`)
      const { rows: legacy } = await client.query<{ id: string }>(
        `INSERT INTO public.customers (user_id, company_id, name, customer_type, org_number)
         VALUES ($1, $2, 'Anna Andersson', 'individual', $3) RETURNING id`,
        [c.userId, c.companyId, PERSONNUMMER],
      )
      const id = legacy[0]!.id
      await client.query(`ALTER TABLE public.customers ADD CONSTRAINT ${CONSTRAINT} ${check} NOT VALID`)

      // Any write that keeps the number is refused, even one to another column.
      await client.query('SAVEPOINT untouched')
      await expect(
        client.query(`UPDATE public.customers SET email = 'anna@example.invalid' WHERE id = $1`, [id]),
      ).rejects.toThrow(REFUSED)
      await client.query('ROLLBACK TO SAVEPOINT untouched')

      // The validating migration neither fails nor validates while the row is there.
      await client.query(validate)
      expect(await isValidated((sql) => client.query(sql))).toBe(false)

      // The repair's write: the number moves out, and the card is writable again.
      await client.query(
        `UPDATE public.customers SET org_number = NULL, personal_number = $2 WHERE id = $1`,
        [id, SEALED],
      )
      await client.query(`UPDATE public.customers SET email = 'anna@example.invalid' WHERE id = $1`, [id])

      // With no such row left, the same migration validates.
      await client.query(validate)
      expect(await isValidated((sql) => client.query(sql))).toBe(true)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect(await isValidated((sql) => getPool().query(sql))).toBe(true)
  })
})
