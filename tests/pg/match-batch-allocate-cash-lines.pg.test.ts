import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261031100700_match_batch_allocate_cash_lines (crm#1539): a
 * kontantmetoden company's bank row that pays several customer invoices with
 * no verifikat yet books each invoice's sale in the samlingsverifikat from
 * p_cash_lines (lib/invoices/batch-cash-method-guard.ts), never a 1510 clearing.
 *
 *   - the ticket's case: two RUT invoices (customer shares 500,00 and
 *     562,50), one row of 1 063, the second paid 0,50 over: revenue + moms
 *     per invoice, 0,50 on 3740, one bank leg, source_type
 *     invoice_cash_payment, both invoices paid at their remaining;
 *   - an unbooked invoice without lines is refused
 *     (BATCH_CASH_METHOD_UNBOOKED_INVOICE), as the application refuses it;
 *   - lines that do not net to the allocation, lines for an accrual company,
 *     an inactive account and a key outside the batch are refused, with
 *     nothing written.
 */

interface RpcResult {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  journal_entry_id?: string
  cash_method?: boolean
  allocations?: Array<{ invoice_id?: string; status: string; paid_amount: number; remaining_amount: number }>
}

async function seedTenant(method: 'cash' | 'accrual') {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertFiscalPeriod({ userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31' })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, accounting_method) VALUES ($1, $2, $3)`,
    [userId, companyId, method],
  )
  await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, 'aktiebolag')`, [companyId])
  // The application seeds 3740 the first time it is needed (account-backfill,
  // as the engine does); the RPC requires it active.
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class,
        account_group, account_type, normal_balance, plan_type, is_system_account)
     VALUES ($1, $2, '3740', 'Öres- och kronutjämning', 3, '37', 'revenue', 'credit', 'full_bas', false)
     ON CONFLICT DO NOTHING`,
    [userId, companyId],
  )
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, country)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', 'SE')`,
    [customerId, userId, companyId],
  )
  return { userId, companyId, customerId }
}

/** An unbooked RUT invoice: labour + 25 % moms, the customer owes total - deduction. */
async function insertRutInvoice(
  t: { userId: string; companyId: string; customerId: string },
  labour: number,
  vat: number,
  deduction: number,
): Promise<string> {
  const id = randomUUID()
  const total = Math.round((labour + vat) * 100) / 100
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        status, currency, subtotal, vat_amount, total, deduction_total, paid_amount, remaining_amount,
        vat_treatment)
     VALUES ($1, $2, $3, $4, $5, '2026-10-01', '2026-10-31', 'sent', 'SEK',
             $6, $7, $8, $9, 0, $10, 'standard_25')`,
    [id, t.userId, t.companyId, t.customerId, `F-${id.slice(0, 8)}`, labour, vat, total, deduction,
      Math.round((total - deduction) * 100) / 100],
  )
  return id
}

async function insertIncome(t: { userId: string; companyId: string }, amount: number): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, '2026-10-28', 'Bankgiro', $4, 'SEK', 'uncategorized')`,
    [id, t.userId, t.companyId, amount],
  )
  return id
}

function call(
  client: PoolClient,
  txId: string,
  allocations: unknown[],
  companyId: string,
  cashLines: unknown,
): Promise<RpcResult> {
  return client
    .query<{ r: RpcResult }>(
      `SELECT public.match_batch_allocate(p_tx_id => $1, p_allocations => $2::jsonb,
         p_company_id => $3, p_cash_lines => $4::jsonb) AS r`,
      [txId, JSON.stringify(allocations), companyId, cashLines === null ? null : JSON.stringify(cashLines)],
    )
    .then((res) => res.rows[0]!.r)
}

function ticketLines(a: string, b: string) {
  return {
    [a]: [
      { account_number: '3001', debit_amount: 0, credit_amount: 400, line_description: 'Försäljning A' },
      { account_number: '2611', debit_amount: 0, credit_amount: 100 },
    ],
    [b]: [
      { account_number: '3001', debit_amount: 0, credit_amount: 450 },
      { account_number: '2611', debit_amount: 0, credit_amount: 112.5 },
      { account_number: '3740', debit_amount: 0, credit_amount: 0.5 },
    ],
  }
}

describe('match_batch_allocate p_cash_lines (kontantmetoden)', () => {
  it('books two unbooked RUT invoices and the 0,50 overpayment in one samlingsverifikat', async () => {
    const t = await seedTenant('cash')
    const a = await insertRutInvoice(t, 800, 200, 500)
    const b = await insertRutInvoice(t, 900, 225, 562.5)
    const txId = await insertIncome(t, 1063)
    const allocations = [
      { kind: 'customer_invoice', invoice_id: a, amount: 500 },
      { kind: 'customer_invoice', invoice_id: b, amount: 563 },
    ]

    await withUserContext(t.userId, async (client) => {
      const result = await call(client, txId, allocations, t.companyId, ticketLines(a, b))
      expect(result).toMatchObject({ ok: true, cash_method: true })

      const entry = await client.query<{ source_type: string; status: string }>(
        `SELECT source_type, status FROM public.journal_entries WHERE id = $1`,
        [result.journal_entry_id],
      )
      expect(entry.rows[0]).toEqual({ source_type: 'invoice_cash_payment', status: 'posted' })

      const lines = await client.query<{ account_number: string; debit: string; credit: string }>(
        `SELECT account_number, debit_amount::text AS debit, credit_amount::text AS credit
           FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
        [result.journal_entry_id],
      )
      const net = new Map<string, number>()
      for (const line of lines.rows) {
        net.set(line.account_number, Math.round(((net.get(line.account_number) ?? 0) + Number(line.credit) - Number(line.debit)) * 100) / 100)
      }
      expect(Object.fromEntries(net)).toEqual({ '3001': 850, '2611': 212.5, '3740': 0.5, '1930': -1063 })
      expect(lines.rows.some((line) => line.account_number === '1510' || line.account_number === '1513')).toBe(false)

      const invoices = await client.query<{ id: string; status: string; paid: string; remaining: string }>(
        `SELECT id, status, paid_amount::text AS paid, remaining_amount::text AS remaining
           FROM public.invoices WHERE id = ANY($1::uuid[])`,
        [[a, b]],
      )
      const byId = new Map(invoices.rows.map((row) => [row.id, row]))
      expect(byId.get(a)).toMatchObject({ status: 'paid' })
      expect(Number(byId.get(a)!.paid)).toBe(500)
      expect(byId.get(b)).toMatchObject({ status: 'paid' })
      expect(Number(byId.get(b)!.paid)).toBe(562.5)
      expect(Number(byId.get(b)!.remaining)).toBe(0)

      const payments = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.invoice_payments WHERE journal_entry_id = $1`,
        [result.journal_entry_id],
      )
      expect(payments.rows[0]!.n).toBe('2')

      const tx = await client.query<{ journal_entry_id: string }>(
        `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
        [txId],
      )
      expect(tx.rows[0]!.journal_entry_id).toBe(result.journal_entry_id)
    })
  })

  it('refuses an unbooked invoice of a kontantmetoden company without lines', async () => {
    const t = await seedTenant('cash')
    const a = await insertRutInvoice(t, 800, 200, 500)
    const txId = await insertIncome(t, 500)
    await withUserContext(t.userId, async (client) => {
      const result = await call(client, txId, [{ kind: 'customer_invoice', invoice_id: a, amount: 500 }], t.companyId, null)
      expect(result).toMatchObject({ ok: false, code: 'BATCH_CASH_METHOD_UNBOOKED_INVOICE' })
    })
  })

  it('refuses lines that do not net to the allocation, for an accrual company, on an inactive account or outside the batch', async () => {
    const cash = await seedTenant('cash')
    const a = await insertRutInvoice(cash, 800, 200, 500)
    const txId = await insertIncome(cash, 500)
    const one = [{ kind: 'customer_invoice', invoice_id: a, amount: 500 }]

    await withUserContext(cash.userId, async (client) => {
      const unbalanced = await call(client, txId, one, cash.companyId, {
        [a]: [{ account_number: '3001', debit_amount: 0, credit_amount: 600 }],
      })
      expect(unbalanced).toMatchObject({ ok: false, code: 'BATCH_CASH_LINES_INVALID', details: { reason: 'unbalanced' } })

      const bothSides = await call(client, txId, one, cash.companyId, {
        [a]: [{ account_number: '3001', debit_amount: 1, credit_amount: 636 }],
      })
      expect(bothSides).toMatchObject({ ok: false, code: 'BATCH_CASH_LINES_INVALID', details: { reason: 'amount' } })

      const unknownAccount = await call(client, txId, one, cash.companyId, {
        [a]: [{ account_number: '3999', debit_amount: 0, credit_amount: 500 }],
      })
      expect(unknownAccount).toMatchObject({ ok: false, code: 'BATCH_CASH_LINES_INVALID', details: { reason: 'account' } })

      const extraKey = await call(client, txId, one, cash.companyId, {
        [a]: [{ account_number: '3001', debit_amount: 0, credit_amount: 500 }],
        [randomUUID()]: [{ account_number: '3001', debit_amount: 0, credit_amount: 1 }],
      })
      expect(extraKey).toMatchObject({ ok: false, code: 'BATCH_CASH_LINES_MIXED' })

      const written = await client.query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
        [txId],
      )
      expect(written.rows[0]!.journal_entry_id).toBeNull()
    })

    const accrual = await seedTenant('accrual')
    const c = await insertRutInvoice(accrual, 800, 200, 500)
    const accrualTx = await insertIncome(accrual, 500)
    await withUserContext(accrual.userId, async (client) => {
      const result = await call(client, accrualTx, [{ kind: 'customer_invoice', invoice_id: c, amount: 500 }], accrual.companyId, {
        [c]: [{ account_number: '3001', debit_amount: 0, credit_amount: 500 }],
      })
      expect(result).toMatchObject({
        ok: false,
        code: 'BATCH_CASH_LINES_INVALID',
        details: { reason: 'not_an_unbooked_cash_invoice_paid_in_full' },
      })
    })
  })
})
