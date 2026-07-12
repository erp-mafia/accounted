import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260709130000_supplier_invoice_start_number:
 *   - next_arrival_number acts as a start FLOOR for the supplier-invoice
 *     (ankomstnummer) series: get_next_arrival_number returns
 *     GREATEST(MAX(arrival_number)+1, next_arrival_number).
 *   - Default 1 preserves the old MAX+1 behavior.
 *   - The floor never moves the series backwards once real invoices pass it.
 *   - The hardened RPC rejects callers who are not company members
 *     (auth.uid() not null), and lets members through.
 */

async function ensureSettings(
  userId: string,
  companyId: string,
  nextArrivalNumber: number,
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, next_arrival_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id)
       DO UPDATE SET next_arrival_number = EXCLUDED.next_arrival_number`,
    [userId, companyId, nextArrivalNumber],
  )
}

async function insertSupplier(userId: string, companyId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name)
     VALUES ($1, $2, 'Test Supplier') RETURNING id`,
    [userId, companyId],
  )
  return rows[0]!.id
}

async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
  supplierId: string
  arrivalNumber: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date)
     VALUES ($1, $2, $3, $4, $5, '2026-06-01', '2026-06-30')`,
    [
      params.userId,
      params.companyId,
      params.supplierId,
      params.arrivalNumber,
      `INV-${params.arrivalNumber}`,
    ],
  )
}

async function nextArrival(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    'SELECT public.get_next_arrival_number($1) AS n',
    [companyId],
  )
  return rows[0]!.n
}

describe('get_next_arrival_number: configurable start floor', () => {
  it('returns 1 when there are no invoices and no settings row', async () => {
    const { companyId } = await seedCompany()
    expect(await nextArrival(companyId)).toBe(1)
  })

  it('returns 1 when the floor is the default and no invoices exist', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureSettings(userId, companyId, 1)
    expect(await nextArrival(companyId)).toBe(1)
  })

  it('starts the series at the configured floor when no invoices exist', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureSettings(userId, companyId, 248)
    expect(await nextArrival(companyId)).toBe(248)
  })

  it('continues MAX+1 once an invoice reaches the floor', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureSettings(userId, companyId, 248)
    const supplierId = await insertSupplier(userId, companyId)
    await insertSupplierInvoice({ userId, companyId, supplierId, arrivalNumber: 248 })
    expect(await nextArrival(companyId)).toBe(249)
  })

  it('ignores a floor set below the current MAX (never moves backwards)', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    await insertSupplierInvoice({ userId, companyId, supplierId, arrivalNumber: 300 })
    await ensureSettings(userId, companyId, 248)
    expect(await nextArrival(companyId)).toBe(301)
  })

  it('is scoped per company (one company floor does not leak into another)', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await ensureSettings(a.userId, a.companyId, 500)
    await ensureSettings(b.userId, b.companyId, 1)
    expect(await nextArrival(a.companyId)).toBe(500)
    expect(await nextArrival(b.companyId)).toBe(1)
  })
})

describe('get_next_arrival_number: membership hardening', () => {
  it('rejects a caller who is not a member of the target company', async () => {
    const intruder = await seedCompany()
    const target = await seedCompany()
    await ensureSettings(target.userId, target.companyId, 10)

    await expect(
      withUserContext(intruder.userId, async (client) => {
        await client.query('SELECT public.get_next_arrival_number($1)', [target.companyId])
      }),
    ).rejects.toThrow(/unauthorized/i)
  })

  it('allows a member of the target company', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureSettings(userId, companyId, 7)

    const result = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        'SELECT public.get_next_arrival_number($1) AS n',
        [companyId],
      )
      return rows[0]!.n
    })

    expect(result).toBe(7)
  })

  it('trusts service-role callers (auth.uid() null) through the guard', async () => {
    // Pool queries run as superuser with no JWT claims, so auth.uid() is NULL:
    // the membership check is skipped, mirroring API-key / cron paths.
    const { companyId } = await seedCompany()
    expect(typeof (await nextArrival(companyId))).toBe('number')
  })
})
