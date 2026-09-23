import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for migration 20260914123000: text rows on recurring
// schedule items (description-only, may be empty) while product rows keep
// the non-empty description + positive quantity rule, and period_start.

async function seedSchedule(): Promise<{ scheduleId: string; companyId: string; userId: string }> {
  const { companyId, userId } = await seedCompany()
  const { rows: customers } = await getPool().query(
    `INSERT INTO public.customers (company_id, user_id, name, customer_type)
     VALUES ($1, $2, 'Kund AB', 'swedish_business') RETURNING id`,
    [companyId, userId],
  )
  const { rows } = await getPool().query(
    `INSERT INTO public.recurring_invoice_schedules
       (company_id, user_id, customer_id, name, day_of_month, next_run_date, period_start)
     VALUES ($1, $2, $3, 'Retainer', 1, '2026-10-01', '2026-10-01') RETURNING id, period_start::text AS period_start`,
    [companyId, userId, customers[0].id],
  )
  expect(rows[0].period_start).toBe('2026-10-01')
  return { scheduleId: rows[0].id, companyId, userId }
}

describe('recurring_invoice_schedule_items.line_type', () => {
  it('accepts a text row with an empty description and zero quantity', async () => {
    const { scheduleId } = await seedSchedule()
    await getPool().query(
      `INSERT INTO public.recurring_invoice_schedule_items
         (schedule_id, sort_order, line_type, description, quantity, unit, unit_price)
       VALUES ($1, 0, 'text', '', 0, '', 0)`,
      [scheduleId],
    )
    const { rows } = await getPool().query(
      `SELECT line_type FROM public.recurring_invoice_schedule_items WHERE schedule_id = $1`,
      [scheduleId],
    )
    expect(rows[0].line_type).toBe('text')
  })

  it('still requires a description and a positive quantity on a product row', async () => {
    const { scheduleId } = await seedSchedule()
    await expect(
      getPool().query(
        `INSERT INTO public.recurring_invoice_schedule_items
           (schedule_id, sort_order, description, quantity, unit, unit_price)
         VALUES ($1, 0, 'Licens', 0, 'st', 100)`,
        [scheduleId],
      ),
    ).rejects.toThrow(/recurring_invoice_schedule_items_product_line_shape/)
    await expect(
      getPool().query(
        `INSERT INTO public.recurring_invoice_schedule_items
           (schedule_id, sort_order, description, quantity, unit, unit_price)
         VALUES ($1, 0, '', 1, 'st', 100)`,
        [scheduleId],
      ),
    ).rejects.toThrow(/recurring_invoice_schedule_items_product_line_shape/)
  })

  it('defaults existing-style inserts to product and rejects unknown line types', async () => {
    const { scheduleId } = await seedSchedule()
    const { rows } = await getPool().query(
      `INSERT INTO public.recurring_invoice_schedule_items
         (schedule_id, sort_order, description, quantity, unit, unit_price)
       VALUES ($1, 0, 'Licens', 1, 'st', 100) RETURNING line_type`,
      [scheduleId],
    )
    expect(rows[0].line_type).toBe('product')
    await expect(
      getPool().query(
        `INSERT INTO public.recurring_invoice_schedule_items
           (schedule_id, sort_order, line_type, description, quantity, unit, unit_price)
         VALUES ($1, 1, 'header', 'x', 1, 'st', 1)`,
        [scheduleId],
      ),
    ).rejects.toThrow(/line_type/)
  })
})
