import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool, withUserContext } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

/**
 * Covers 20261016005100_sql_posting_paths_actor: the four RPCs that post a
 * verifikat themselves forward p_actor_type / p_actor_label to
 * commit_journal_entry, so the verifikat records committed_actor_* and the
 * audit_log COMMIT row names the same actor instead of falling back to 'user'.
 *   - match_batch_allocate (samlingsverifikat)
 *   - create_expense_payout_batch (reimbursement verifikat)
 *   - link_invoice_to_voucher / link_supplier_invoice_to_voucher (the
 *     kursdifferens verifikat of a SEK-booked foreign invoice)
 * A caller that passes no actor (an older deploy, the positional SQL caller)
 * still works and records NULL, as before. One signature each, grants and
 * comments as before.
 */

let seq = 0
const nextSeq = () => (Date.now() % 1_000_000) * 1000 + seq++

async function committed(client: PoolClient, entryId: string) {
  const { rows } = await client.query(
    `SELECT status, commit_method, committed_actor_type, committed_actor_label
       FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  const { rows: audit } = await client.query(
    `SELECT actor_type, actor_label FROM public.audit_log WHERE record_id = $1 AND action = 'COMMIT'`,
    [entryId],
  )
  return { entry: rows[0], audit }
}

/** BEGIN, fn, ROLLBACK on one superuser connection: nothing persists. */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function postedVoucher(
  client: PoolClient,
  p: { userId: string; companyId: string; fiscalPeriodId: string; debit: string; credit: string; amount: number },
): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', '2026-05-05', 'Betalning', 'manual', 'draft')`,
    [id, p.userId, p.companyId, p.fiscalPeriodId],
  )
  await client.query(
    `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency)
     VALUES ($1, $2, $4, 0, 'SEK'), ($1, $3, 0, $4, 'SEK')`,
    [id, p.debit, p.credit, p.amount],
  )
  await client.query('SELECT * FROM public.commit_journal_entry($1, $2)', [p.companyId, id])
  return id
}

async function foreignCustomerInvoice(client: PoolClient, p: { userId: string; companyId: string }): Promise<string> {
  const customerId = randomUUID()
  await client.query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Utländsk Kund AB', 'swedish_business')`,
    [customerId, p.userId, p.companyId],
  )
  const invoiceId = randomUUID()
  // 1000 EUR booked at 11.50: the receivable carries 11 500 kr.
  await client.query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, exchange_rate, subtotal, vat_amount, total, total_sek,
        vat_treatment, vat_rate, status, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01',
             'EUR', 11.5, 1000, 0, 1000, 11500, 'standard_25', 25, 'sent', 0, 1000)`,
    [invoiceId, p.userId, p.companyId, customerId, `F-${nextSeq()}`],
  )
  return invoiceId
}

async function supplierInvoice(
  client: PoolClient,
  p: { userId: string; companyId: string; currency: string; total: number; exchangeRate: number | null },
): Promise<string> {
  const supplierId = randomUUID()
  await client.query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, $4)`,
    [supplierId, p.userId, p.companyId, p.currency],
  )
  const id = randomUUID()
  const arrival = nextSeq()
  await client.query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'approved', $7, $8,
             $9, 0, $9, 0, $9, 'standard_25', false, false)`,
    [id, p.userId, p.companyId, supplierId, arrival, `LF-${arrival}`, p.currency, p.exchangeRate, p.total],
  )
  return id
}

describe('link_invoice_to_voucher: the kursdifferens verifikat records the actor', () => {
  it('stamps committed_actor_* and the COMMIT audit row from p_actor_type / p_actor_label', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedCompany()
      const invoiceId = await foreignCustomerInvoice(client, { userId, companyId })
      // 11 200 kr received against 11 500 kr booked: 300 kr to 7960.
      const voucherId = await postedVoucher(client, { userId, companyId, fiscalPeriodId, debit: '1930', credit: '1510', amount: 11200 })

      const { rows } = await client.query<{ r: { ok: boolean; fx_journal_entry_id: string } }>(
        `SELECT public.link_invoice_to_voucher(
           p_invoice_id => $1, p_journal_entry_id => $2, p_user_id => $3, p_company_id => $4,
           p_actor_type => 'api_key', p_actor_label => 'Bokföringsagent') AS r`,
        [invoiceId, voucherId, userId, companyId],
      )
      expect(rows[0].r.ok).toBe(true)
      expect(await committed(client, rows[0].r.fx_journal_entry_id)).toEqual({
        entry: { status: 'posted', commit_method: null, committed_actor_type: 'api_key', committed_actor_label: 'Bokföringsagent' },
        audit: [{ actor_type: 'api_key', actor_label: 'Bokföringsagent' }],
      })
    })
  })

  it('records no actor for the five-argument call an older deploy sends', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedCompany()
      const invoiceId = await foreignCustomerInvoice(client, { userId, companyId })
      const voucherId = await postedVoucher(client, { userId, companyId, fiscalPeriodId, debit: '1930', credit: '1510', amount: 11200 })

      const { rows } = await client.query<{ r: { ok: boolean; fx_journal_entry_id: string } }>(
        `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS r`,
        [invoiceId, voucherId, userId, companyId],
      )
      expect(rows[0].r.ok).toBe(true)
      expect(await committed(client, rows[0].r.fx_journal_entry_id)).toEqual({
        entry: { status: 'posted', commit_method: null, committed_actor_type: null, committed_actor_label: null },
        audit: [{ actor_type: 'user', actor_label: null }],
      })
    })
  })
})

describe('link_supplier_invoice_to_voucher: the kursdifferens verifikat records the actor', () => {
  it('stamps committed_actor_* from p_actor_type / p_actor_label', async () => {
    await inRolledBackTransaction(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedCompany()
      const supplierInvoiceId = await supplierInvoice(client, { userId, companyId, currency: 'EUR', total: 1000, exchangeRate: 11.5 })
      // Paid 11 200 kr against an 11 500 kr booked liability: 300 kr to 3960.
      const voucherId = await postedVoucher(client, { userId, companyId, fiscalPeriodId, debit: '2440', credit: '1930', amount: 11200 })

      const { rows } = await client.query<{ r: { ok: boolean; fx_journal_entry_id: string } }>(
        `SELECT public.link_supplier_invoice_to_voucher(
           p_supplier_invoice_id => $1, p_journal_entry_id => $2, p_user_id => $3, p_company_id => $4,
           p_actor_type => 'mcp_oauth', p_actor_label => 'Claude') AS r`,
        [supplierInvoiceId, voucherId, userId, companyId],
      )
      expect(rows[0].r.ok).toBe(true)
      expect(await committed(client, rows[0].r.fx_journal_entry_id)).toEqual({
        entry: { status: 'posted', commit_method: null, committed_actor_type: 'mcp_oauth', committed_actor_label: 'Claude' },
        audit: [{ actor_type: 'mcp_oauth', actor_label: 'Claude' }],
      })
    })
  })
})

describe('match_batch_allocate: the samlingsverifikat records the actor', () => {
  it('stamps committed_actor_* and the COMMIT audit row', async () => {
    const { userId, companyId } = await seedCompany()
    const pool = getPool()
    const supplierInvoiceId = await (async () => {
      const client = await getClient()
      try {
        return await supplierInvoice(client, { userId, companyId, currency: 'SEK', total: 2000, exchangeRate: null })
      } finally {
        client.release()
      }
    })()
    const txId = randomUUID()
    await pool.query(
      `INSERT INTO public.transactions (id, user_id, company_id, date, description, amount, currency, category)
       VALUES ($1, $2, $3, '2026-06-05', 'Bank transfer', -2000, 'SEK', 'uncategorized')`,
      [txId, userId, companyId],
    )
    const allocations = JSON.stringify([{ kind: 'supplier_invoice', supplier_invoice_id: supplierInvoiceId, amount: 2000 }])

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ r: { ok: boolean; journal_entry_id: string } }>(
        `SELECT public.match_batch_allocate(
           p_tx_id => $1, p_allocations => $2::jsonb, p_company_id => $3,
           p_actor_type => 'user', p_actor_label => 'anna@example.se') AS r`,
        [txId, allocations, companyId],
      )
      expect(rows[0].r.ok).toBe(true)
      await client.query('RESET ROLE')
      expect(await committed(client, rows[0].r.journal_entry_id)).toEqual({
        entry: { status: 'posted', commit_method: null, committed_actor_type: 'user', committed_actor_label: 'anna@example.se' },
        audit: [{ actor_type: 'user', actor_label: 'anna@example.se' }],
      })
    })
  })
})

describe('create_expense_payout_batch: the reimbursement verifikat records the actor', () => {
  it('stamps committed_actor_* and the COMMIT audit row', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
       VALUES ($1, $2, '1930', 'Företagskonto', 1, 'asset', 'debit', true),
              ($1, $2, '2893', 'Skuld till aktieägare', 2, 'liability', 'credit', true)`,
      [userId, companyId],
    )
    const claimId = randomUUID()
    await getPool().query(
      `INSERT INTO public.expense_claims
         (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account, liability_account, status)
       VALUES ($1, $2, $3, 'Ägare', 'Kvitto', '2026-08-25', 500, 0, '5410', '2893', 'registered')`,
      [claimId, companyId, userId],
    )

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ r: { ok: boolean; journal_entry_id: string } }>(
        `SELECT public.create_expense_payout_batch(
           p_company_id => $1, p_claim_ids => ARRAY[$2::uuid], p_payout_date => '2026-08-31'::date,
           p_cash_account => '1930', p_actor_type => 'cron', p_actor_label => 'cron.test') AS r`,
        [companyId, claimId],
      )
      expect(rows[0].r.ok).toBe(true)
      await client.query('RESET ROLE')
      expect(await committed(client, rows[0].r.journal_entry_id)).toEqual({
        entry: { status: 'posted', commit_method: null, committed_actor_type: 'cron', committed_actor_label: 'cron.test' },
        audit: [{ actor_type: 'cron', actor_label: 'cron.test' }],
      })
    })
  })
})

describe('signatures, grants and comments', () => {
  it.each([
    ['match_batch_allocate', 'match_batch_allocate(uuid,jsonb,uuid,uuid,text,text,uuid[],text)', 'samlingsverifikat'],
    ['create_expense_payout_batch', 'create_expense_payout_batch(uuid,uuid[],date,text,text,uuid,uuid,text,text,uuid[],text)', 'reimbursement transfer'],
    ['link_invoice_to_voucher', 'link_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric,text,text,uuid[],text)', 'customer invoice as its payment'],
    ['link_supplier_invoice_to_voucher', 'link_supplier_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric,text,text,uuid[],text)', 'OPEN supplier invoice'],
  ])('%s has one signature, executable by authenticated and service_role only, comment kept', async (name, signature, phrase) => {
    const { rows } = await getPool().query(
      `SELECT p.oid::regprocedure::text AS sig,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec,
              p.prosecdef AS definer,
              obj_description(p.oid, 'pg_proc') AS comment
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
      [name],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sig: signature,
      anon: false,
      authenticated: true,
      service_role: true,
      public_exec: false,
      definer: true,
    })
    expect(rows[0].comment).toContain(phrase)
  })
})
