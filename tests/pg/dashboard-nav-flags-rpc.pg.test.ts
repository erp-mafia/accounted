import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from './fixtures'

// Validates migration 20260826120000_get_dashboard_nav_flags:
//   1. has_webshop flips on an ACTIVE WooCommerce or Shopify connection
//      (a pending/revoked one does not count) and has_mileage_trips on any
//      mileage_trips row.
//   2. SECURITY INVOKER: a member of ANOTHER company sees (false, false)
//      for this company, RLS applies inside the function.
//   3. EXECUTE is granted to authenticated only, not anon.
//
// webshop_orders is the third has_webshop source; its row shape carries many
// NOT NULL platform columns and the existing connection paths already prove
// the OR, so it is covered by the EXISTS shape, not a fixture here.

const FLAGS = `SELECT has_webshop, has_mileage_trips FROM public.get_dashboard_nav_flags($1::uuid)`
type Row = { has_webshop: boolean; has_mileage_trips: boolean }

async function flagsAs(userId: string, companyId: string): Promise<Row> {
  return withUserContext(userId, async (client) => {
    const res = await client.query<Row>(FLAGS, [companyId])
    expect(res.rows).toHaveLength(1)
    return res.rows[0]
  })
}

describe('get_dashboard_nav_flags()', () => {
  it('is (false, false) for a fresh company', async () => {
    const { userId, companyId } = await seedCompany()
    expect(await flagsAs(userId, companyId)).toEqual({ has_webshop: false, has_mileage_trips: false })
  })

  it('flips has_webshop on an active WooCommerce connection, not on a pending one', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'pending')`,
      // Unique per run: the active-connection unique index is on the store URL.
      [companyId, userId, `https://nav-flags-${companyId.slice(0, 8)}.example.se`],
    )
    expect((await flagsAs(userId, companyId)).has_webshop).toBe(false)

    await getPool().query(
      `UPDATE public.woocommerce_connections SET status = 'active' WHERE company_id = $1`,
      [companyId],
    )
    expect((await flagsAs(userId, companyId)).has_webshop).toBe(true)
  })

  it('flips has_webshop on an active Shopify connection', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.shopify_connections (company_id, user_id, shop_domain, status)
       VALUES ($1, $2, $3, 'active')`,
      // Unique per run: shopify_connections_shop_active_uniq is on the domain.
      [companyId, userId, `nav-flags-${companyId.slice(0, 8)}.myshopify.com`],
    )
    expect((await flagsAs(userId, companyId)).has_webshop).toBe(true)
  })

  it('flips has_mileage_trips on any mileage trip', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.mileage_trips (company_id, user_id, trip_date, distance_km, from_location, to_location, purpose)
       VALUES ($1, $2, '2026-08-01', 12.5, 'Kontoret', 'Kund AB', 'Kundbesök')`,
      [companyId, userId],
    )
    expect(await flagsAs(userId, companyId)).toEqual({ has_webshop: false, has_mileage_trips: true })
  })

  it('applies RLS: a member of another company sees (false, false) for this one', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.mileage_trips (company_id, user_id, trip_date, distance_km, from_location, to_location, purpose)
       VALUES ($1, $2, '2026-08-01', 3, 'A', 'B', 'Test')`,
      [companyId, userId],
    )
    const outsider = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: otherCompany, userId: outsider })

    expect(await flagsAs(userId, companyId)).toEqual({ has_webshop: false, has_mileage_trips: true })
    expect(await flagsAs(outsider, companyId)).toEqual({ has_webshop: false, has_mileage_trips: false })
  })

  it('grants EXECUTE to authenticated but not anon', async () => {
    const res = await getPool().query<{ anon_can: boolean; authenticated_can: boolean }>(
      `SELECT
         has_function_privilege('anon', 'public.get_dashboard_nav_flags(uuid)', 'EXECUTE') AS anon_can,
         has_function_privilege('authenticated', 'public.get_dashboard_nav_flags(uuid)', 'EXECUTE') AS authenticated_can`,
    )
    expect(res.rows[0].anon_can).toBe(false)
    expect(res.rows[0].authenticated_can).toBe(true)
  })
})
