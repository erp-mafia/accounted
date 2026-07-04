import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260529120100_match_batch_allocate:
 *   - 1 bank tx → N supplier invoices: builds ONE combined verifikat with
 *     N × Dr 2440 + 1 × Cr 1930, inserts N supplier_invoice_payments rows
 *     all pointing at the same JE.
 *   - Per-invoice paid_amount/remaining_amount/status advance correctly.
 *   - Overshoot guard returns BATCH_OVERSHOOT cleanly (no partial state).
 *   - Already-booked tx rejection.
 *   - Direction mismatch rejection.
 *   - Mixed customer + supplier kinds rejection.
 *
 * These tests bypass RLS by writing through the superuser pool: they
 * exercise the RPC logic + DB constraints, not the policy layer.
 */

async function insertSupplier(params: {
  userId: string
  companyId: string
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, $4, 'swedish_business', 'SE', 30, 'SEK')`,
    [id, params.userId, params.companyId, params.name ?? 'Leverantör AB'],
  )
  return id
}

let arrivalSeq = 0

async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
  supplierId: string
  total: number
  status?: string
  invoiceDate?: string
  dueDate?: string
}): Promise<string> {
  const id = randomUUID()
  // Arrival numbers are generated per-company by get_next_arrival_number, but
  // for an isolated test we hardcode a unique value: time component for
  // cross-run uniqueness, counter for within-run uniqueness. The previous
  // Date.now()+random scheme collided in CI (same ms + overlapping random
  // ranges → duplicate key on idx_supplier_invoices_company_arrival_number).
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $9, 'SEK',
             $10, 0, $10, 0, $10, 'standard_25', false, false)`,
    [
      id,
      params.userId,
      params.companyId,
      params.supplierId,
      arrivalNumber,
      `LF-${arrivalNumber}`,
      params.invoiceDate ?? '2026-06-01',
      params.dueDate ?? '2026-07-01',
      params.status ?? 'approved',
      params.total,
    ],
  )
  return id
}

async function insertTransaction(params: {
  userId: string
  companyId: string
  amount: number
  date?: string
  currency?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'uncategorized')`,
    [
      id,
      params.userId,
      params.companyId,
      params.date ?? '2026-06-05',
      'Bank transfer',
      params.amount,
      params.currency ?? 'SEK',
    ],
  )
  return id
}

async function seedTenant(opts: { isClosed?: boolean } = {}) {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    isClosed: opts.isClosed,
  })
  return { userId, companyId, fiscalPeriodId }
}

interface RpcResult {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  journal_entry_id?: string
  voucher_number?: number
  allocations?: Array<{
    kind: string
    supplier_invoice_id?: string
    invoice_id?: string
    payment_id: string
    status: string
    paid_amount: number
    remaining_amount: number
    amount: number
  }>
  total_allocated?: number
  leftover?: number
}

describe('match_batch_allocate', () => {
  it('builds a single combined verifikat for 1 tx → 3 supplier invoices', async () => {
    const { userId, companyId } = await seedTenant()
    const supplier = await insertSupplier({ userId, companyId })

    const si1 = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 2000,
    })
    const si2 = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 3000,
    })
    const si3 = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 1500,
    })

    const txId = await insertTransaction({
      userId, companyId, amount: -6500, date: '2026-06-05',
    })

    const allocations = [
      { kind: 'supplier_invoice', supplier_invoice_id: si1, amount: 2000 },
      { kind: 'supplier_invoice', supplier_invoice_id: si2, amount: 3000 },
      { kind: 'supplier_invoice', supplier_invoice_id: si3, amount: 1500 },
    ]

    // withUserContext sets request.jwt.claim.sub so the RPC's auth.uid()
    // membership check (PR #603 round 2) resolves the seeded owner.
    // ALL assertions about post-RPC state must run inside this block since
    // it rolls back at the end.
    await withUserContext(userId, async (client) => {
      const r = await client.query<{ match_batch_allocate: RpcResult }>(
        `SELECT match_batch_allocate($1, $2::jsonb, $3)`,
        [txId, JSON.stringify(allocations), companyId],
      )
      const result = r.rows[0]!.match_batch_allocate

      expect(result.ok).toBe(true)
      expect(result.journal_entry_id).toBeTruthy()
      expect(result.voucher_number).toBeGreaterThan(0)
      expect(result.total_allocated).toBe(6500)
      expect(result.leftover).toBe(0)
      expect(result.allocations).toHaveLength(3)

      // Verify one verifikat with N+1 lines (3 × Dr 2440 + 1 × Cr 1930).
      const lines = await client.query<{
        account_number: string
        debit_amount: string
        credit_amount: string
      }>(
        `SELECT account_number, debit_amount, credit_amount
           FROM public.journal_entry_lines
          WHERE journal_entry_id = $1
          ORDER BY sort_order`,
        [result.journal_entry_id],
      )
      expect(lines.rows).toHaveLength(4)
      const apLines = lines.rows.filter((l) => l.account_number === '2440')
      const bankLines = lines.rows.filter((l) => l.account_number === '1930')
      expect(apLines).toHaveLength(3)
      expect(bankLines).toHaveLength(1)
      expect(Number(bankLines[0]!.credit_amount)).toBe(6500)
      const apSum = apLines.reduce((s, l) => s + Number(l.debit_amount), 0)
      expect(apSum).toBe(6500)

      // Verify all 3 supplier invoices flipped to 'paid'.
      const inv1 = await client.query<{ status: string; paid_amount: string; remaining_amount: string }>(
        `SELECT status, paid_amount, remaining_amount FROM public.supplier_invoices WHERE id = $1`,
        [si1],
      )
      expect(inv1.rows[0]!.status).toBe('paid')
      expect(Number(inv1.rows[0]!.paid_amount)).toBe(2000)
      expect(Number(inv1.rows[0]!.remaining_amount)).toBe(0)

      // Verify 3 supplier_invoice_payments rows all reference the same JE.
      const payments = await client.query<{ journal_entry_id: string; supplier_invoice_id: string }>(
        `SELECT journal_entry_id, supplier_invoice_id
           FROM public.supplier_invoice_payments WHERE transaction_id = $1`,
        [txId],
      )
      expect(payments.rows).toHaveLength(3)
      const jeIds = new Set(payments.rows.map((p) => p.journal_entry_id))
      expect(jeIds.size).toBe(1)
      expect(jeIds.has(result.journal_entry_id!)).toBe(true)

      // Verify tx.journal_entry_id is set + supplier_invoice_id left NULL (multi).
      const txRow = await client.query<{
        journal_entry_id: string | null
        supplier_invoice_id: string | null
        is_business: boolean
      }>(
        `SELECT journal_entry_id, supplier_invoice_id, is_business
           FROM public.transactions WHERE id = $1`,
        [txId],
      )
      expect(txRow.rows[0]!.journal_entry_id).toBe(result.journal_entry_id)
      expect(txRow.rows[0]!.supplier_invoice_id).toBeNull()
      expect(txRow.rows[0]!.is_business).toBe(true)

      // Verify samlingsverifikat carries the supplier-side source_type
      // (PR #603 compliance fix: was previously 'invoice_paid' for both
      // directions which mis-routed behandlingshistorik filters).
      const je = await client.query<{ source_type: string }>(
        `SELECT source_type FROM public.journal_entries WHERE id = $1`,
        [result.journal_entry_id],
      )
      expect(je.rows[0]!.source_type).toBe('supplier_invoice_paid')
    })
  })

  it('rejects with BATCH_OVERSHOOT when allocation exceeds invoice remaining', async () => {
    const { userId, companyId } = await seedTenant()
    const supplier = await insertSupplier({ userId, companyId })
    const si = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 1000,
    })
    const txId = await insertTransaction({ userId, companyId, amount: -5000 })

    const allocations = [
      { kind: 'supplier_invoice', supplier_invoice_id: si, amount: 5000 },
    ]

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ match_batch_allocate: RpcResult }>(
        `SELECT match_batch_allocate($1, $2::jsonb, $3)`,
        [txId, JSON.stringify(allocations), companyId],
      )
      const result = r.rows[0]!.match_batch_allocate

      expect(result.ok).toBe(false)
      expect(result.code).toBe('BATCH_OVERSHOOT')
      expect(result.details).toMatchObject({ supplier_invoice_id: si, requested: 5000 })

      // No journal entry should have been created.
      const txRow = await client.query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
        [txId],
      )
      expect(txRow.rows[0]!.journal_entry_id).toBeNull()

      const inv = await client.query<{ paid_amount: string; remaining_amount: string }>(
        `SELECT paid_amount, remaining_amount FROM public.supplier_invoices WHERE id = $1`,
        [si],
      )
      expect(Number(inv.rows[0]!.paid_amount)).toBe(0)
      expect(Number(inv.rows[0]!.remaining_amount)).toBe(1000)
    })
  })

  it('rejects with BATCH_UNAUTHORIZED when caller is not a member of the company', async () => {
    const { userId, companyId } = await seedTenant()
    const supplier = await insertSupplier({ userId, companyId })
    const si = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 1000,
    })
    const txId = await insertTransaction({ userId, companyId, amount: -1000 })

    // Different user: never added to company_members for companyId. The
    // SECURITY DEFINER check (PR #603 compliance) refuses any access.
    const outsiderId = await insertAuthUser()

    await withUserContext(outsiderId, async (client) => {
      const r = await client.query<{ match_batch_allocate: RpcResult }>(
        `SELECT match_batch_allocate($1, $2::jsonb, $3)`,
        [
          txId,
          JSON.stringify([{ kind: 'supplier_invoice', supplier_invoice_id: si, amount: 1000 }]),
          companyId,
        ],
      )
      const result = r.rows[0]!.match_batch_allocate
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BATCH_UNAUTHORIZED')
    })
  })

  it('rejects with BATCH_TX_ALREADY_BOOKED when tx already has a JE', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const supplier = await insertSupplier({ userId, companyId })
    const si = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 1000,
    })

    // Pre-book the tx by linking it to a manual posted JE.
    const existingJeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-05', 'Manual', 'manual', 'draft')`,
      [existingJeId, userId, companyId, fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 0, 1000), ($1, '4010', 1000, 0)`,
      [existingJeId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [existingJeId])

    const txId = await insertTransaction({ userId, companyId, amount: -1000 })
    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $1 WHERE id = $2`,
      [existingJeId, txId],
    )

    const allocations = [
      { kind: 'supplier_invoice', supplier_invoice_id: si, amount: 1000 },
    ]

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ match_batch_allocate: RpcResult }>(
        `SELECT match_batch_allocate($1, $2::jsonb, $3)`,
        [txId, JSON.stringify(allocations), companyId],
      )
      const result = r.rows[0]!.match_batch_allocate
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BATCH_TX_ALREADY_BOOKED')
    })
  })

  it('rejects with BATCH_DIRECTION_MISMATCH for supplier allocation against income tx', async () => {
    const { userId, companyId } = await seedTenant()
    const supplier = await insertSupplier({ userId, companyId })
    const si = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 1000,
    })

    // Positive tx (income): wrong direction for supplier_invoice allocation.
    const txId = await insertTransaction({ userId, companyId, amount: 1000 })

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ match_batch_allocate: RpcResult }>(
        `SELECT match_batch_allocate($1, $2::jsonb, $3)`,
        [
          txId,
          JSON.stringify([{ kind: 'supplier_invoice', supplier_invoice_id: si, amount: 1000 }]),
          companyId,
        ],
      )
      const result = r.rows[0]!.match_batch_allocate
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BATCH_DIRECTION_MISMATCH')
    })
  })

  it('rejects BATCH_DUPLICATE_ALLOCATION when the same supplier invoice appears twice', async () => {
    const { userId, companyId } = await seedTenant()
    const supplier = await insertSupplier({ userId, companyId })
    const si = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 1000,
    })
    const txId = await insertTransaction({ userId, companyId, amount: -800 })

    // Same supplier_invoice_id listed twice. Per-allocation amounts (400 each)
    // do not individually overshoot the 1 000 remaining, but their sum would
    // insert two payment rows for one invoice. The dedupe guard catches
    // this in the validation loop before any write.
    const allocations = [
      { kind: 'supplier_invoice', supplier_invoice_id: si, amount: 400 },
      { kind: 'supplier_invoice', supplier_invoice_id: si, amount: 400 },
    ]

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ match_batch_allocate: RpcResult }>(
        `SELECT match_batch_allocate($1, $2::jsonb, $3)`,
        [txId, JSON.stringify(allocations), companyId],
      )
      const result = r.rows[0]!.match_batch_allocate
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BATCH_DUPLICATE_ALLOCATION')
      expect(result.details?.id).toBe(si)
    })
  })

  it('rejects BATCH_MIXED_KINDS_UNSUPPORTED on customer + supplier in same batch', async () => {
    const { userId, companyId } = await seedTenant()
    const supplier = await insertSupplier({ userId, companyId })
    const si = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 1000,
    })

    // Insert a customer + invoice for the customer-side allocation.
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers
         (id, user_id, company_id, name, customer_type, country)
       VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', 'SE')`,
      [customerId, userId, companyId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status,
          currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment)
       VALUES ($1, $2, $3, $4, 'F-001', '2026-06-01', '2026-07-01', 'sent', 'SEK',
               1000, 0, 1000, 0, 1000, 'standard_25')`,
      [invoiceId, userId, companyId, customerId],
    )

    // Negative tx: direction makes both sides individually plausible, but
    // we reject mixed kinds outright. Actually negative=supplier and we need
    // either income or expense; the mixed check fires before the direction
    // check, so the result code is MIXED_KINDS regardless.
    const txId = await insertTransaction({ userId, companyId, amount: -2000 })

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ match_batch_allocate: RpcResult }>(
        `SELECT match_batch_allocate($1, $2::jsonb, $3)`,
        [
          txId,
          JSON.stringify([
            { kind: 'supplier_invoice', supplier_invoice_id: si, amount: 1000 },
            { kind: 'customer_invoice', invoice_id: invoiceId, amount: 1000 },
          ]),
          companyId,
        ],
      )
      const result = r.rows[0]!.match_batch_allocate
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BATCH_MIXED_KINDS_UNSUPPORTED')
    })
  })

  // PR #607: cross-currency happy path. One USD supplier invoice paid by
  // a single SEK bank transaction. The RPC must book the AP line at the
  // invoice's original SEK value (booked_sek = remaining × exchange_rate)
  // and post the difference between booked_sek and the actual bank
  // withdrawal to 7960 (loss) or 3960 (gain). Bank line is the full tx_abs.
  it('books cross-currency supplier invoice with FX diff line and tx_abs bank line', async () => {
    const { userId, companyId } = await seedTenant()
    const supplier = await insertSupplier({ userId, companyId })

    // USD invoice for $100, booked at 10.0 SEK/USD = 1000 SEK on 2440 at
    // creation time. (We use the standard insertSupplierInvoice and patch
    // the currency/exchange_rate after so we don't have to thread params
    // through the helper.)
    const si = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 100,
    })
    await getPool().query(
      `UPDATE public.supplier_invoices
       SET currency = 'USD', exchange_rate = 10.0, remaining_amount = 100
       WHERE id = $1`,
      [si],
    )

    // Bank actually withdrew 1050 SEK: rate moved to ~10.5 SEK/USD on
    // payment day. Loss of 50 SEK lands on 7960.
    const txId = await insertTransaction({
      userId, companyId, amount: -1050, date: '2026-06-05', currency: 'SEK',
    })

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ match_batch_allocate: RpcResult }>(
        `SELECT match_batch_allocate($1, $2::jsonb, $3)`,
        [
          txId,
          JSON.stringify([
            { kind: 'supplier_invoice', supplier_invoice_id: si, amount: 1050 },
          ]),
          companyId,
        ],
      )
      const result = r.rows[0]!.match_batch_allocate
      expect(result.ok).toBe(true)
      expect(result.allocations).toHaveLength(1)
      expect(result.allocations![0]!.cross_currency).toBe(true)
      expect(result.allocations![0]!.status).toBe('paid')

      const lines = await client.query<{
        account_number: string
        debit_amount: string
        credit_amount: string
      }>(
        `SELECT account_number, debit_amount, credit_amount
         FROM public.journal_entry_lines
         WHERE journal_entry_id = $1
         ORDER BY sort_order`,
        [result.journal_entry_id],
      )

      // Expected lines:
      //   Dr 2440 1000  (booked SEK at original rate)
      //   Dr 7960   50  (FX loss = bank tx: booked SEK)
      //   Cr 1930 1050  (actual bank withdrawal)
      expect(lines.rows).toHaveLength(3)

      const ap = lines.rows.find((l) => l.account_number === '2440')!
      expect(Number(ap.debit_amount)).toBe(1000)
      expect(Number(ap.credit_amount)).toBe(0)

      const fxLoss = lines.rows.find((l) => l.account_number === '7960')!
      expect(Number(fxLoss.debit_amount)).toBe(50)
      expect(Number(fxLoss.credit_amount)).toBe(0)

      const bank = lines.rows.find((l) => l.account_number === '1930')!
      expect(Number(bank.debit_amount)).toBe(0)
      expect(Number(bank.credit_amount)).toBe(1050)

      // Round-1 fix: bank line credit must equal tx_abs, not the AR/AP
      // total. With FX diff lines this distinction matters: verify it.
      expect(Number(bank.credit_amount)).toBe(1050)

      // Supplier invoice settled in full and stored in invoice currency.
      const inv = await client.query<{
        status: string; paid_amount: string; remaining_amount: string
      }>(
        `SELECT status, paid_amount, remaining_amount FROM public.supplier_invoices WHERE id = $1`,
        [si],
      )
      expect(inv.rows[0]!.status).toBe('paid')
      expect(Number(inv.rows[0]!.paid_amount)).toBe(100) // USD value, not SEK
      expect(Number(inv.rows[0]!.remaining_amount)).toBe(0)

      // Round-3: payment row stores the effective payment-day rate
      // (v_alloc_amount / v_inv_remaining = 1050/100 = 10.5) alongside
      // the invoicing rate (10.0). swedish-compliance traceability fix.
      const pay = await client.query<{
        exchange_rate: string | null; payment_exchange_rate: string | null
      }>(
        `SELECT exchange_rate, payment_exchange_rate
         FROM public.supplier_invoice_payments
         WHERE supplier_invoice_id = $1`,
        [si],
      )
      expect(Number(pay.rows[0]!.exchange_rate)).toBe(10) // invoicing rate
      expect(Number(pay.rows[0]!.payment_exchange_rate)).toBe(10.5) // payment-day rate

      // Sum of debits = sum of credits (balanced verifikat).
      const balance = await client.query<{ debits: string; credits: string }>(
        `SELECT
           COALESCE(SUM(debit_amount), 0) AS debits,
           COALESCE(SUM(credit_amount), 0) AS credits
         FROM public.journal_entry_lines
         WHERE journal_entry_id = $1`,
        [result.journal_entry_id],
      )
      expect(Number(balance.rows[0]!.debits)).toBe(Number(balance.rows[0]!.credits))
    })
  })

  // PR #607 round-1: strict undershoot rejection. The RPC previously
  // accepted sum(allocations) < tx_abs and silently underbooked the bank
  // line, breaking reconciliation. Now it must reject with
  // BATCH_AMOUNT_BELOW_TX.
  it('rejects BATCH_AMOUNT_BELOW_TX when allocations sum below tx_abs', async () => {
    const { userId, companyId } = await seedTenant()
    const supplier = await insertSupplier({ userId, companyId })
    const si = await insertSupplierInvoice({
      userId, companyId, supplierId: supplier, total: 1000,
    })
    const txId = await insertTransaction({ userId, companyId, amount: -1500 })

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ match_batch_allocate: RpcResult }>(
        `SELECT match_batch_allocate($1, $2::jsonb, $3)`,
        [
          txId,
          JSON.stringify([
            { kind: 'supplier_invoice', supplier_invoice_id: si, amount: 1000 },
          ]),
          companyId,
        ],
      )
      const result = r.rows[0]!.match_batch_allocate
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BATCH_AMOUNT_BELOW_TX')
      expect(result.details).toMatchObject({ allocated: 1000, tx_amount_abs: 1500 })

      const txRow = await client.query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
        [txId],
      )
      expect(txRow.rows[0]!.journal_entry_id).toBeNull()
    })
  })
})
