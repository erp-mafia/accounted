import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'

/**
 * customers_personal_number_check after 20260726110000.
 *
 * The column stores AES-256-GCM ciphertext, not a personnummer. The original
 * constraint (20260522130000) demanded the personnummer format, which no
 * encrypted value can ever satisfy, so every write failed silently in
 * production. These tests lock in the corrected contract:
 *
 *   - ciphertext is accepted and round-trips (persist, read back, decrypt)
 *   - a bare personnummer is rejected, so a write path that forgets to
 *     encrypt fails loudly instead of persisting PII
 *   - the masked display form ('********-1234') is rejected
 *
 * All personnummer values below are synthetic.
 */

async function insertCustomer(params: {
  userId: string
  companyId: string
  personalNumber: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers
       (id, user_id, company_id, name, customer_type, personal_number)
     VALUES ($1, $2, $3, 'Testkund', 'individual', $4)`,
    [id, params.userId, params.companyId, params.personalNumber],
  )
  return id
}

describe('customers.personal_number ciphertext check.pg', () => {
  it('is validated after full replay (NOT VALID in 20260726110000, VALIDATE in 20260726110001)', async () => {
    // The constraint is added NOT VALID so a fork database holding a legacy
    // plaintext row cannot stall the whole migration batch, then validated in
    // its own migration. After replaying both, it must be fully validated:
    // convalidated=false here means the VALIDATE migration was dropped.
    const res = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conname = 'customers_personal_number_check'
          AND conrelid = 'public.customers'::regclass`,
    )
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.convalidated).toBe(true)
  })

  it('accepts NULL', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertCustomer({ userId, companyId, personalNumber: null })

    const res = await getPool().query<{ personal_number: string | null }>(
      `SELECT personal_number FROM public.customers WHERE id = $1`,
      [id],
    )
    expect(res.rows[0]!.personal_number).toBeNull()
  })

  it('persists encrypted personnummer and reads it back decryptable', async () => {
    const { userId, companyId } = await seedCompany()
    const plaintext = '19900101-1234'
    const ciphertext = encryptPersonnummer(plaintext)

    const id = await insertCustomer({ userId, companyId, personalNumber: ciphertext })

    const res = await getPool().query<{ personal_number: string }>(
      `SELECT personal_number FROM public.customers WHERE id = $1`,
      [id],
    )
    const stored = res.rows[0]!.personal_number
    expect(stored).toBe(ciphertext)
    expect(decryptPersonnummer(stored)).toBe(plaintext)
  })

  it('accepts every ciphertext length the accepted plaintext formats produce', async () => {
    const { userId, companyId } = await seedCompany()

    // 10, 11, 12 and 13 characters of plaintext -> 76, 78, 80 and 82 hex chars.
    for (const plaintext of ['9001011234', '900101-1234', '199001011234', '19900101-1234']) {
      const ciphertext = encryptPersonnummer(plaintext)
      const id = await insertCustomer({ userId, companyId, personalNumber: ciphertext })

      const res = await getPool().query<{ personal_number: string }>(
        `SELECT personal_number FROM public.customers WHERE id = $1`,
        [id],
      )
      expect(decryptPersonnummer(res.rows[0]!.personal_number)).toBe(plaintext)
    }
  })

  it('rejects a bare personnummer (a write path that forgot to encrypt)', async () => {
    const { userId, companyId } = await seedCompany()

    for (const plaintext of ['9001011234', '900101-1234', '199001011234', '19900101-1234']) {
      await expect(
        insertCustomer({ userId, companyId, personalNumber: plaintext }),
      ).rejects.toThrow(/customers_personal_number_check/)
    }
  })

  it('rejects both masked display forms', async () => {
    // The last of the three guards that keep a mask from ever being stored:
    // CustomerForm strips it, the PATCH route reads it as "unchanged", and
    // Postgres refuses it outright. '********-????' is what an undecryptable
    // row renders as; the write paths now accept it as a no-op sentinel, so
    // the DB backstop has to cover it too.
    const { userId, companyId } = await seedCompany()

    for (const mask of ['********-1234', '********-????']) {
      await expect(
        insertCustomer({ userId, companyId, personalNumber: mask }),
      ).rejects.toThrow(/customers_personal_number_check/)
    }
  })

  it('rejects hex that is too short to be ciphertext', async () => {
    const { userId, companyId } = await seedCompany()

    await expect(
      insertCustomer({ userId, companyId, personalNumber: 'a'.repeat(75) }),
    ).rejects.toThrow(/customers_personal_number_check/)
  })

  it('rejects uppercase hex (Buffer.toString(hex) emits lowercase)', async () => {
    const { userId, companyId } = await seedCompany()

    await expect(
      insertCustomer({ userId, companyId, personalNumber: 'A'.repeat(80) }),
    ).rejects.toThrow(/customers_personal_number_check/)
  })

  it('rejects an UPDATE that replaces ciphertext with plaintext', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertCustomer({
      userId,
      companyId,
      personalNumber: encryptPersonnummer('19900101-1234'),
    })

    await expect(
      getPool().query(`UPDATE public.customers SET personal_number = $1 WHERE id = $2`, [
        '19900101-1234',
        id,
      ]),
    ).rejects.toThrow(/customers_personal_number_check/)
  })
})
