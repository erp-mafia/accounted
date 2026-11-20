/**
 * Migration 20261015061500_invoice_article_number (crm#1084).
 *
 * invoice_items.article_number is a frozen copy of the article's number taken
 * when the line is written: renumbering or deleting the article must never
 * change what an issued invoice prints. company_settings
 * .invoice_show_article_number decides whether it is printed, off by default,
 * and a company member writes it under RLS like the other invoice layout
 * switches.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

async function seedSettings(companyId: string, userId: string): Promise<void> {
  // seedCompany() does not create company_settings (create_company_with_owner does).
  await getPool().query(`INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2)`, [userId, companyId])
}

async function seedInvoiceLineFromArticle(companyId: string, userId: string) {
  const articleId = randomUUID()
  await getPool().query(
    `INSERT INTO public.articles (id, company_id, user_id, name, name_en, article_number)
     VALUES ($1, $2, $3, 'Konsulttimme', 'Consulting hour', 'A-100')`,
    [articleId, companyId, userId],
  )
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, language)
     VALUES ($1, $2, $3, 'Customer Ltd', 'eu_business', 'en')`,
    [customerId, userId, companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
       status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment)
     VALUES ($1, $2, $3, $4, $5, '2026-10-01', '2026-10-31', 'sent', 'SEK', 1000, 0, 1000, 0, 1000, 'reverse_charge')`,
    [invoiceId, userId, companyId, customerId, `F-${invoiceId.slice(0, 8)}`],
  )
  const itemId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price,
       line_total, vat_rate, vat_amount, article_id, article_number)
     VALUES ($1, $2, 0, 'Consulting hour', 1, 'tim', 1000, 1000, 0, 0, $3, 'A-100')`,
    [itemId, invoiceId, articleId],
  )
  return { articleId, invoiceId, itemId }
}

async function readLine(itemId: string) {
  const { rows } = await getPool().query<{ article_id: string | null; article_number: string | null; description: string }>(
    `SELECT article_id, article_number, description FROM public.invoice_items WHERE id = $1`,
    [itemId],
  )
  return rows[0]
}

describe('invoice_items.article_number', () => {
  it('is null on a line written without one (free-text rows, every line before the migration)', async () => {
    const { userId, companyId } = await seedCompany()
    const { invoiceId } = await seedInvoiceLineFromArticle(companyId, userId)
    const itemId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount)
       VALUES ($1, $2, 1, 'Fri text', 1, 'st', 10, 10, 0, 0)`,
      [itemId, invoiceId],
    )
    expect((await readLine(itemId)).article_number).toBeNull()
  })

  it('keeps the number it was written with when the article is renumbered', async () => {
    const { userId, companyId } = await seedCompany()
    const { articleId, itemId } = await seedInvoiceLineFromArticle(companyId, userId)
    await getPool().query(`UPDATE public.articles SET article_number = 'B-200' WHERE id = $1`, [articleId])
    const line = await readLine(itemId)
    expect(line.article_id).toBe(articleId)
    expect(line.article_number).toBe('A-100')
  })

  it('keeps the number and the text when the article is deleted (article_id is set null)', async () => {
    const { userId, companyId } = await seedCompany()
    const { articleId, itemId } = await seedInvoiceLineFromArticle(companyId, userId)
    await getPool().query(`DELETE FROM public.articles WHERE id = $1`, [articleId])
    expect(await readLine(itemId)).toEqual({ article_id: null, article_number: 'A-100', description: 'Consulting hour' })
  })
})

describe('company_settings.invoice_show_article_number', () => {
  it('is off for a new company', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    const { rows } = await getPool().query<{ invoice_show_article_number: boolean }>(
      `SELECT invoice_show_article_number FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(rows[0].invoice_show_article_number).toBe(false)
  })

  it('refuses null: the PDF and the e-invoice read a plain on/off', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    await expect(
      getPool().query(`UPDATE public.company_settings SET invoice_show_article_number = NULL WHERE company_id = $1`, [companyId]),
    ).rejects.toThrow(/null value/i)
  })

  it('is written by a member of the company under RLS, and not by anyone else', async () => {
    const { userId, companyId } = await seedCompany()
    await seedSettings(companyId, userId)
    const stranger = await seedCompany()

    const own = await withUserContext(userId, (client) =>
      client.query(
        `UPDATE public.company_settings SET invoice_show_article_number = true WHERE company_id = $1 RETURNING invoice_show_article_number`,
        [companyId],
      ),
    )
    expect(own.rows).toEqual([{ invoice_show_article_number: true }])

    const foreign = await withUserContext(stranger.userId, (client) =>
      client.query(`UPDATE public.company_settings SET invoice_show_article_number = true WHERE company_id = $1`, [companyId]),
    )
    expect(foreign.rowCount).toBe(0)
  })
})
