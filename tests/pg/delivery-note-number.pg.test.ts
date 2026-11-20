import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany, withSwedishToday } from '@/tests/pg/fixtures'

// 20261015030100_delivery_note_number_no_truncate.sql (accounted#33):
// generate_delivery_note_number padded with LPAD(n, 3, '0'), and LPAD cuts a
// longer string, so counter 1000 came out as FS-<year>100 and collided with
// delivery note 100 of the same year.

async function companyAtCounter(nextDeliveryNoteNumber: number): Promise<{ userId: string; companyId: string }> {
  const { userId, companyId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, next_delivery_note_number)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id) DO UPDATE
       SET next_delivery_note_number = EXCLUDED.next_delivery_note_number`,
    [userId, companyId, nextDeliveryNoteNumber],
  )
  return { userId, companyId }
}

async function generate(companyId: string): Promise<string> {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT public.generate_delivery_note_number($1) AS n',
    [companyId],
  )
  return rows[0]!.n
}

async function currentYear(): Promise<string> {
  const { rows } = await getPool().query<{ y: string }>(
    'SELECT EXTRACT(YEAR FROM public.stockholm_today())::text AS y',
  )
  return rows[0]!.y
}

async function insertDeliveryNote(userId: string, companyId: string, invoiceNumber: string): Promise<void> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Test Customer')`,
    [customerId, userId, companyId],
  )
  await getPool().query(
    `INSERT INTO public.invoices
       (user_id, company_id, customer_id, invoice_number, document_type,
        invoice_date, due_date, currency, subtotal, vat_amount, total,
        vat_treatment, vat_rate, moms_ruta, status)
     VALUES ($1, $2, $3, $4, 'delivery_note',
             CURRENT_DATE, CURRENT_DATE, 'SEK', 1000, 250, 1250,
             'standard_25', 25, '10', 'draft')`,
    [userId, companyId, customerId, invoiceNumber],
  )
}

describe('generate_delivery_note_number: the Swedish year', () => {
  it("numbers a note of New Year's night with the new year", async () => {
    const { companyId } = await companyAtCounter(1)
    await withSwedishToday('2031-01-01', async () => {
      expect(await generate(companyId)).toBe('FS-2031001')
    })
  })
})

describe('generate_delivery_note_number: never truncates (#33).pg', () => {
  it('gives counters 999, 1000 and 1001 all their digits', async () => {
    const year = await currentYear()
    const { companyId } = await companyAtCounter(999)

    expect(await generate(companyId)).toBe(`FS-${year}999`)
    expect(await generate(companyId)).toBe(`FS-${year}1000`)
    expect(await generate(companyId)).toBe(`FS-${year}1001`)

    const { rows } = await getPool().query<{ next_delivery_note_number: number }>(
      'SELECT next_delivery_note_number FROM public.company_settings WHERE company_id = $1',
      [companyId],
    )
    expect(rows[0]!.next_delivery_note_number).toBe(1002)
  })

  it('keeps three digits below 1000, as before', async () => {
    const year = await currentYear()
    const { companyId } = await companyAtCounter(1)

    expect(await generate(companyId)).toBe(`FS-${year}001`)
    expect(await generate(companyId)).toBe(`FS-${year}002`)
  })

  it('numbers note 1000 next to an existing note 100 of the same year', async () => {
    const year = await currentYear()
    const { userId, companyId } = await companyAtCounter(1000)
    await insertDeliveryNote(userId, companyId, `FS-${year}100`)

    const number = await generate(companyId)
    expect(number).toBe(`FS-${year}1000`)
    // Before the fix this number was FS-<year>100 and the insert failed on
    // idx_invoices_company_invoice_number.
    await expect(insertDeliveryNote(userId, companyId, number)).resolves.toBeUndefined()
  })
})
