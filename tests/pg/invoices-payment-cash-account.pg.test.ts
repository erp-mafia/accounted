import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCashAccount, insertCompany } from './fixtures'
import { getPool } from './setup'

/**
 * Migration 20260903183000: invoices.payment_cash_account_id (FK, SET NULL)
 * and invoices.payment_details (object snapshot).
 */

async function insertCustomer(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, company_id, user_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [id, companyId, userId],
  )
  return id
}

async function insertInvoice(companyId: string, userId: string, customerId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const cols = ['id', 'company_id', 'user_id', 'customer_id', 'invoice_date', 'due_date', 'status', 'currency', 'subtotal', 'vat_amount', 'total', 'vat_treatment', 'vat_rate', 'paid_amount', 'remaining_amount', ...Object.keys(extra)]
  const vals = [id, companyId, userId, customerId, '2026-09-01', '2026-10-01', 'draft', 'SEK', 100, 25, 125, 'standard_25', 25, 0, 125, ...Object.values(extra)]
  await getPool().query(
    `INSERT INTO public.invoices (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  )
  return id
}

describe('invoice payee columns (20260903183000)', () => {
  it('stores the choice and the snapshot; deleting the account nulls the reference but keeps the snapshot', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const customerId = await insertCustomer(companyId, userId)
    const account = await insertCashAccount({ companyId, ledgerAccount: '1931' })
    const invoiceId = await insertInvoice(companyId, userId, customerId, {
      payment_cash_account_id: account,
      payment_details: JSON.stringify({ bankgiro: '5050-1055' }),
    })

    await getPool().query(`DELETE FROM public.cash_accounts WHERE id = $1`, [account])
    const row = await getPool().query<{ payment_cash_account_id: string | null; payment_details: { bankgiro: string } }>(
      `SELECT payment_cash_account_id, payment_details FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(row.rows[0].payment_cash_account_id).toBeNull()
    expect(row.rows[0].payment_details).toEqual({ bankgiro: '5050-1055' })
  })

  it('rejects a non-object snapshot and an account id that does not exist', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const customerId = await insertCustomer(companyId, userId)
    await expect(
      insertInvoice(companyId, userId, customerId, { payment_details: JSON.stringify(['not', 'an', 'object']) }),
    ).rejects.toThrow(/payment_details/)
    await expect(
      insertInvoice(companyId, userId, customerId, { payment_cash_account_id: randomUUID() }),
    ).rejects.toThrow(/foreign key/)
  })

  it('rejects another company\'s cash account (composite same-company FK)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const otherCompanyId = await insertCompany({ createdBy: userId, name: 'Annat AB' })
    const customerId = await insertCustomer(companyId, userId)
    const foreign = await insertCashAccount({ companyId: otherCompanyId, ledgerAccount: '1930' })
    await expect(
      insertInvoice(companyId, userId, customerId, { payment_cash_account_id: foreign }),
    ).rejects.toThrow(/invoices_payment_cash_account_same_company/)
  })
})
