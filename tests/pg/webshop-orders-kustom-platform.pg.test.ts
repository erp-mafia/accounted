import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * Covers 20261123173800_webshop_orders_kustom_platform: both platform CHECK
 * constraints take 'kustom', the platform a Kustom settlement file's rows
 * carry, and still refuse a platform nobody writes. Unit tests mock Supabase
 * and never meet the constraint (the Zettle feed was refused at the database
 * for that reason, 20260909100400).
 */

async function insertKustomRow(companyId: string, userId: string, platform = 'kustom') {
  const merchant = `M-${randomUUID()}`
  return getPool().query(
    `INSERT INTO public.webshop_orders
       (company_id, user_id, platform, store_scope, store_label, row_type, external_id,
        platform_order_id, order_number, status, is_paid, order_date, paid_date,
        currency, total, total_tax, total_sek, exchange_rate, vat_breakdown,
        payment_method, payment_method_title, gateway_reference)
     VALUES ($1, $2, $3, $4, $5, 'order', $6,
             'order-1', 'REFA', 'paid', true, '2026-11-17', '2026-11-18',
             'SEK', 1250.00, 250.00, 1250.00, 1, '[{"rate":25,"net":1000,"tax":250}]'::jsonb,
             'kustom', 'Kustom', 'PAY123')
     RETURNING platform`,
    [companyId, userId, platform, merchant, `Kustom ${merchant}`, `kustom_${merchant}_capture_cap-1`],
  )
}

describe('webshop platform kustom', () => {
  it('webshop_orders takes a Kustom row, which a member then reads', async () => {
    const { userId, companyId } = await seedCompany()
    const inserted = await insertKustomRow(companyId, userId)
    expect(inserted.rows).toEqual([{ platform: 'kustom' }])

    await withUserContext(userId, async (client) => {
      const read = await client.query(
        `SELECT platform, paid_date::text AS paid_date FROM public.webshop_orders WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toEqual([{ platform: 'kustom', paid_date: '2026-11-18' }])
    })
  })

  it('webshop_orders still refuses a platform nobody writes', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(insertKustomRow(companyId, userId, 'amazon')).rejects.toMatchObject({ code: '23514' })
  })

  it('webshop_store_settings takes a Kustom store, so its payment account can be mapped', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.webshop_store_settings
           (company_id, user_id, platform, store_scope, payment_method_account_map)
         VALUES ($1, $2, 'kustom', $3, '{"kustom":{"mode":"book","account":"1686"}}'::jsonb)
         RETURNING platform`,
        [companyId, userId, `M-${randomUUID()}`],
      )
      expect(inserted.rows).toEqual([{ platform: 'kustom' }])
    })
  })
})
