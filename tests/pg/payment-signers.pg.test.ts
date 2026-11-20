import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getClient } from '@/tests/pg/setup'

describe('payment_signers.pg: service-role only', () => {
  it('is readable and writable by the service role, and never by anon or authenticated', async () => {
    const { userId } = await seedCompany()
    const client = await getClient()
    try {
      await client.query(`INSERT INTO public.payment_signers (user_id, personal_number_enc) VALUES ($1, 'enc:v1:test')`, [userId])
      const own = await client.query<{ personal_number_enc: string }>(
        `SELECT personal_number_enc FROM public.payment_signers WHERE user_id = $1`,
        [userId],
      )
      expect(own.rows[0]?.personal_number_enc).toBe('enc:v1:test')

      for (const role of ['anon', 'authenticated']) {
        await client.query('BEGIN')
        try {
          await client.query(`SET LOCAL ROLE ${role}`)
          await expect(client.query(`SELECT user_id FROM public.payment_signers`)).rejects.toThrow(/permission denied/i)
        } finally {
          await client.query('ROLLBACK').catch(() => {})
        }
      }
    } finally {
      await client.query(`DELETE FROM public.payment_signers WHERE user_id = $1`, [userId]).catch(() => {})
      client.release()
    }
  })
})
