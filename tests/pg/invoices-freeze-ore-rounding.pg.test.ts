import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, setActiveCompany } from './fixtures'

/**
 * invoices.ore_rounding freezes at issue (migration
 * 20261027050117_invoices_freeze_ore_rounding.sql, crm#1487): a draft without
 * its own choice follows the company setting; the invoice takes the company's
 * setting when it is issued (or inserted already issued) without one, and an
 * issued invoice keeps the choice it was issued with whatever the company
 * setting or a later write says.
 */

async function insertSettings(companyId: string, userId: string, oreRounding: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, ore_rounding) VALUES ($1, $2, $3)`,
    [userId, companyId, oreRounding],
  )
}

async function setCompanyRounding(companyId: string, oreRounding: boolean): Promise<void> {
  await getPool().query(`UPDATE public.company_settings SET ore_rounding = $2 WHERE company_id = $1`, [
    companyId,
    oreRounding,
  ])
}

async function insertInvoice(params: {
  companyId: string
  userId: string
  status?: string
  total?: number
  oreRounding?: boolean | null
  creditedInvoiceId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, invoice_number, invoice_date, due_date, total, currency, status, ore_rounding, credited_invoice_id, creation_complete)
     VALUES ($1, $2, $3, $4, '2026-10-27', '2026-11-26', $5, 'SEK', $6, $7, $8, true)`,
    [
      id,
      params.userId,
      params.companyId,
      `F-${id.slice(0, 8)}`,
      params.total ?? 4.38,
      params.status ?? 'draft',
      params.oreRounding ?? null,
      params.creditedInvoiceId ?? null,
    ],
  )
  return id
}

async function roundingOf(invoiceId: string): Promise<boolean | null> {
  const { rows } = await getPool().query<{ ore_rounding: boolean | null }>(
    `SELECT ore_rounding FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]!.ore_rounding
}

describe('invoices.ore_rounding freezes at issue (pg)', () => {
  it('a draft follows the company; issued, it keeps the setting of that day', async () => {
    const a = await seedCompany()
    await insertSettings(a.companyId, a.userId, false)
    const draft = await insertInvoice({ companyId: a.companyId, userId: a.userId })
    expect(await roundingOf(draft)).toBeNull()

    await getPool().query(`UPDATE public.invoices SET status = 'sent' WHERE id = $1`, [draft])
    expect(await roundingOf(draft)).toBe(false)

    // The company turns rounding on: the issued invoice stays as issued, a
    // draft still inherits.
    await setCompanyRounding(a.companyId, true)
    const later = await insertInvoice({ companyId: a.companyId, userId: a.userId })
    expect(await roundingOf(draft)).toBe(false)
    expect(await roundingOf(later)).toBeNull()
  })

  it('keeps an explicit choice made on the draft', async () => {
    const a = await seedCompany()
    await insertSettings(a.companyId, a.userId, false)
    const draft = await insertInvoice({ companyId: a.companyId, userId: a.userId, oreRounding: true })
    await getPool().query(`UPDATE public.invoices SET status = 'sent' WHERE id = $1`, [draft])
    expect(await roundingOf(draft)).toBe(true)
  })

  it('nobody rewrites the choice on an issued invoice', async () => {
    const a = await seedCompany()
    await insertSettings(a.companyId, a.userId, true)
    const issued = await insertInvoice({ companyId: a.companyId, userId: a.userId, status: 'sent', oreRounding: false })

    await getPool().query(`UPDATE public.invoices SET ore_rounding = NULL WHERE id = $1`, [issued])
    expect(await roundingOf(issued)).toBe(false)
    await getPool().query(`UPDATE public.invoices SET ore_rounding = true, status = 'paid' WHERE id = $1`, [issued])
    expect(await roundingOf(issued)).toBe(false)
  })

  it("an invoice inserted already issued takes the company's setting, default on without settings", async () => {
    const a = await seedCompany()
    await insertSettings(a.companyId, a.userId, false)
    const imported = await insertInvoice({ companyId: a.companyId, userId: a.userId, status: 'paid' })
    expect(await roundingOf(imported)).toBe(false)

    const b = await seedCompany()
    const noSettings = await insertInvoice({ companyId: b.companyId, userId: b.userId, status: 'sent' })
    expect(await roundingOf(noSettings)).toBe(true)
  })

  it('a credit note put back to draft for a retry is free again, and freezes on re-issue', async () => {
    const a = await seedCompany()
    await insertSettings(a.companyId, a.userId, true)
    const original = await insertInvoice({ companyId: a.companyId, userId: a.userId, status: 'sent', oreRounding: false })
    const credit = await insertInvoice({
      companyId: a.companyId,
      userId: a.userId,
      status: 'sent',
      total: -4.38,
      oreRounding: null,
      creditedInvoiceId: original,
    })
    expect(await roundingOf(credit)).toBe(true)

    await getPool().query(`UPDATE public.invoices SET status = 'draft', ore_rounding = false WHERE id = $1`, [credit])
    expect(await roundingOf(credit)).toBe(false)
    await getPool().query(`UPDATE public.invoices SET status = 'sent' WHERE id = $1`, [credit])
    expect(await roundingOf(credit)).toBe(false)
  })

  it('freezes when a member issues the invoice through RLS', async () => {
    const a = await seedCompany()
    await insertSettings(a.companyId, a.userId, false)
    await setActiveCompany(a.userId, a.companyId)
    const draft = await insertInvoice({ companyId: a.companyId, userId: a.userId })

    await withUserContext(a.userId, async (client) => {
      await client.query(`UPDATE public.invoices SET status = 'sent' WHERE id = $1`, [draft])
      const { rows } = await client.query<{ ore_rounding: boolean | null }>(
        `SELECT ore_rounding FROM public.invoices WHERE id = $1`,
        [draft],
      )
      expect(rows[0]!.ore_rounding).toBe(false)
    })
  })
})
