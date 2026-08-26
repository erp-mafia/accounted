import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260817150000_match_batch_allocate_service_actor:
 *   - service_role caller + p_user_id of a member: allocation commits and
 *     the journal entry / payment rows are attributed to that user. This is
 *     the pending-operations commit path (createServiceClientNoCookies),
 *     which before the migration ALWAYS got BATCH_UNAUTHORIZED because
 *     auth.uid() is NULL on the service client.
 *   - p_user_id is an assertion, honored ONLY under auth.role() =
 *     'service_role': an authenticated non-member spoofing an owner's UUID
 *     and a caller with no JWT at all both stay BATCH_UNAUTHORIZED.
 *   - Grants: PUBLIC/anon revoked, authenticated + service_role kept; the
 *     old 3-arg signature is gone (the 4th arg has a DEFAULT, so 3-arg
 *     call sites still resolve).
 */

let arrivalSeq = 0

async function insertSupplier(params: { userId: string; companyId: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [id, params.userId, params.companyId],
  )
  return id
}

async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
  supplierId: string
  total: number
}): Promise<string> {
  const id = randomUUID()
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-06-01', '2026-07-01', '2026-06-01', 'approved', 'SEK',
             $7, 0, $7, 0, $7, 'standard_25', false, false)`,
    [id, params.userId, params.companyId, params.supplierId, arrivalNumber, `LF-${arrivalNumber}`, params.total],
  )
  return id
}

async function insertTransaction(params: {
  userId: string
  companyId: string
  amount: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, '2026-06-05', 'Bank transfer', $4, 'SEK', 'uncategorized')`,
    [id, params.userId, params.companyId, params.amount],
  )
  return id
}

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  const supplierId = await insertSupplier({ userId, companyId })
  const invoiceId = await insertSupplierInvoice({ userId, companyId, supplierId, total: 2000 })
  const txId = await insertTransaction({ userId, companyId, amount: -2000 })
  return { userId, companyId, invoiceId, txId }
}

interface RpcResult {
  ok: boolean
  code?: string
  journal_entry_id?: string
}

const CALL = `SELECT match_batch_allocate($1, $2::jsonb, $3, $4) AS result`

describe('match_batch_allocate service actor', () => {
  it('commits for a service_role caller with p_user_id of a member and attributes rows to that user', async () => {
    const { userId, companyId, invoiceId, txId } = await seedTenant()
    const allocations = [{ kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 2000 }]

    const result = await runAsServiceRole(async (client) => {
      const r = await client.query<{ result: RpcResult }>(CALL, [
        txId,
        JSON.stringify(allocations),
        companyId,
        userId,
      ])
      return r.rows[0]!.result
    })

    expect(result.ok).toBe(true)
    expect(result.journal_entry_id).toBeTruthy()

    const je = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM public.journal_entries WHERE id = $1`,
      [result.journal_entry_id],
    )
    expect(je.rows[0]!.user_id).toBe(userId)

    const payment = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM public.supplier_invoice_payments WHERE journal_entry_id = $1`,
      [result.journal_entry_id],
    )
    expect(payment.rows).toHaveLength(1)
    expect(payment.rows[0]!.user_id).toBe(userId)
  })

  it('still rejects a service_role caller that passes no p_user_id', async () => {
    const { companyId, invoiceId, txId } = await seedTenant()
    const allocations = [{ kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 2000 }]

    const result = await runAsServiceRole(async (client) => {
      const r = await client.query<{ result: RpcResult }>(CALL, [
        txId,
        JSON.stringify(allocations),
        companyId,
        null,
      ])
      return r.rows[0]!.result
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('BATCH_UNAUTHORIZED')
  })

  it('ignores a spoofed p_user_id from an authenticated non-member', async () => {
    const { userId, companyId, invoiceId, txId } = await seedTenant()
    const stranger = await insertAuthUser()
    const allocations = [{ kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 2000 }]

    const result = await withUserContext(stranger, async (client) => {
      const r = await client.query<{ result: RpcResult }>(CALL, [
        txId,
        JSON.stringify(allocations),
        companyId,
        userId,
      ])
      return r.rows[0]!.result
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('BATCH_UNAUTHORIZED')
  })

  it('ignores p_user_id when there is no JWT context at all', async () => {
    const { userId, companyId, invoiceId, txId } = await seedTenant()
    const allocations = [{ kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 2000 }]

    const r = await getPool().query<{ result: RpcResult }>(CALL, [
      txId,
      JSON.stringify(allocations),
      companyId,
      userId,
    ])
    expect(r.rows[0]!.result.ok).toBe(false)
    expect(r.rows[0]!.result.code).toBe('BATCH_UNAUTHORIZED')
  })

  it('keeps least-privilege grants and drops the 3-arg overload', async () => {
    const { rows } = await getPool().query<{
      anon_can: boolean
      authenticated_can: boolean
      service_role_can: boolean
      overloads: string
    }>(
      `SELECT has_function_privilege('anon', 'public.match_batch_allocate(uuid,jsonb,uuid,uuid)', 'EXECUTE') AS anon_can,
              has_function_privilege('authenticated', 'public.match_batch_allocate(uuid,jsonb,uuid,uuid)', 'EXECUTE') AS authenticated_can,
              has_function_privilege('service_role', 'public.match_batch_allocate(uuid,jsonb,uuid,uuid)', 'EXECUTE') AS service_role_can,
              (SELECT count(*) FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'match_batch_allocate')::text AS overloads`,
    )
    expect(rows[0]!.anon_can).toBe(false)
    expect(rows[0]!.authenticated_can).toBe(true)
    expect(rows[0]!.service_role_can).toBe(true)
    expect(rows[0]!.overloads).toBe('1')
  })
})
