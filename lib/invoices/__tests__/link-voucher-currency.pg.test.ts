/**
 * pg-real test for migration
 * 20260726140000_link_voucher_rpcs_resolve_amount_in_invoice_currency.sql,
 * whose final RPC bodies (NULL-safe tenant guard) are restated by
 * 20260727130000_link_voucher_rpcs_null_safe_tenant_guard.sql.
 *
 * `journal_entry_lines.debit_amount` / `credit_amount` are ALWAYS SEK;
 * `currency` + `amount_in_currency` describe the underlying DOCUMENT. Both
 * commit RPCs summed the SEK column and compared it against
 * `remaining_amount`, which is quoted in the invoice's own currency, while the
 * guard meant to make that safe (`COALESCE(v_line_currency, ...) IS DISTINCT
 * FROM v_invoice.currency`) passes on precisely the FX rows it exists to catch.
 *
 * These are the RPCs' own guards, so they cannot be tested with mocks: the
 * TypeScript matchers do not gate this path at all
 * (`linkInvoiceToVoucher` / `linkSupplierInvoiceToVoucher` call the RPC
 * directly from the web routes and from bulk reconcile).
 *
 * The SEK cases are here for the same reason as the FX ones: the 95% path must
 * be provably unchanged by the migration.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getClient, getPool } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

let seq = 0
function nextSeq(): number {
  return (Date.now() % 1_000_000) * 1000 + seq++
}

async function seedCustomer(params: { userId: string; companyId: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Utländsk Kund AB', 'swedish_business')`,
    [id, params.userId, params.companyId],
  )
  return id
}

/**
 * A customer invoice quoted in `currency`. `total` / `remaining_amount` are in
 * that currency; `total_sek` carries the kronor equivalent, exactly as the
 * columns are defined.
 */
async function seedInvoice(params: {
  userId: string
  companyId: string
  customerId: string
  // invoices.currency is `text default 'SEK'` and NULLABLE; explicit null
  // seeds the legacy row shape that has always meant kronor.
  currency: string | null
  total: number
  totalSek?: number | null
  exchangeRate?: number | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, exchange_rate, subtotal, vat_amount, total, total_sek,
        vat_treatment, vat_rate, status, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01',
             $6, $7, $8, 0, $8, $9, 'standard_25', 25, 'sent', 0, $8)`,
    [
      id,
      params.userId,
      params.companyId,
      params.customerId,
      `F-${nextSeq()}`,
      params.currency,
      params.exchangeRate ?? null,
      params.total,
      params.totalSek ?? null,
    ],
  )
  return id
}

async function seedSupplierInvoice(params: {
  userId: string
  companyId: string
  currency: string
  total: number
}): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Utlandsleverantör AB', 'swedish_business', 'SE', 30, $4)`,
    [supplierId, params.userId, params.companyId, params.currency],
  )
  const id = randomUUID()
  const arrivalNumber = nextSeq()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'approved', $7,
             $8, 0, $8, 0, $8, 'standard_25', false, false)`,
    [
      id,
      params.userId,
      params.companyId,
      supplierId,
      arrivalNumber,
      `LF-${arrivalNumber}`,
      params.currency,
      params.total,
    ],
  )
  return id
}

/**
 * A posted, balanced voucher. `sekAmount` goes in the debit/credit columns (the
 * ledger is always kronor); `lineCurrency` + `amountInCurrency` are the document
 * metadata that the fix reads on a foreign invoice. Pass `amountInCurrency:
 * null` to model an FX row that carries no rate.
 */
async function seedVoucher(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  debitAccount: string
  creditAccount: string
  sekAmount: number
  lineCurrency?: string | null
  amountInCurrency?: number | null
}): Promise<string> {
  const id = randomUUID()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-05-05', 'Betalning', 'manual', 'posted')`,
      [id, params.userId, params.companyId, params.fiscalPeriodId, nextSeq() % 2_000_000_000],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, amount_in_currency)
       VALUES ($1, $2, $3, 0, $5, $6),
              ($1, $4, 0, $3, $5, $6)`,
      [
        id,
        params.debitAccount,
        params.sekAmount,
        params.creditAccount,
        params.lineCurrency ?? 'SEK',
        params.amountInCurrency ?? null,
      ],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return id
}

type RpcResult = {
  ok: boolean
  code?: string
  invoice_status?: string
  paid_amount?: number
  remaining_amount?: number
  payment_amount?: number
  details?: Record<string, unknown>
}

async function callLinkInvoice(args: {
  invoiceId: string
  voucherId: string
  userId: string
  companyId: string
}): Promise<RpcResult> {
  const { rows } = await getPool().query<{ result: RpcResult }>(
    `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
    [args.invoiceId, args.voucherId, args.userId, args.companyId],
  )
  return rows[0].result
}

async function callLinkSupplierInvoice(args: {
  supplierInvoiceId: string
  voucherId: string
  userId: string
  companyId: string
}): Promise<RpcResult> {
  const { rows } = await getPool().query<{ result: RpcResult }>(
    `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
    [args.supplierInvoiceId, args.voucherId, args.userId, args.companyId],
  )
  return rows[0].result
}

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  return { userId, companyId, fiscalPeriodId }
}

// ============================================================
// link_invoice_to_voucher
// ============================================================

describe('link_invoice_to_voucher: amount resolved in the invoice currency', () => {
  it('links a 1000 EUR invoice to its 11 500 kr voucher instead of EXCEEDS_REMAINING', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await seedCustomer({ userId, companyId })
    // 1000 EUR outstanding, booked at 11.50 SEK/EUR.
    const invoiceId = await seedInvoice({
      userId,
      companyId,
      customerId,
      currency: 'EUR',
      total: 1000,
      totalSek: 11500,
      exchangeRate: 11.5,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '1930',
      creditAccount: '1510',
      sekAmount: 11500,
      lineCurrency: 'EUR',
      amountInCurrency: 1000,
    })

    const result = await callLinkInvoice({ invoiceId, voucherId, userId, companyId })

    // Before the fix: 11 500 > 1 000 → LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING.
    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1000)
    expect(Number(result.remaining_amount)).toBe(0)
  })

  it('writes the payment row in the invoice currency, not in kronor', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({
      userId,
      companyId,
      customerId,
      currency: 'EUR',
      total: 1000,
      totalSek: 11500,
      exchangeRate: 11.5,
    })
    // 400 EUR of the 1000: 4600 kr in the ledger.
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '1930',
      creditAccount: '1510',
      sekAmount: 4600,
      lineCurrency: 'EUR',
      amountInCurrency: 400,
    })

    const result = await callLinkInvoice({ invoiceId, voucherId, userId, companyId })

    expect(result).toMatchObject({ ok: true, invoice_status: 'partially_paid' })
    expect(Number(result.payment_amount)).toBe(400)
    expect(Number(result.remaining_amount)).toBe(600)

    const { rows } = await getPool().query(
      `SELECT amount, currency FROM public.invoice_payments
       WHERE invoice_id = $1 AND journal_entry_id = $2`,
      [invoiceId, voucherId],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(400)
    expect(rows[0].currency).toBe('EUR')
  })

  it('still rejects a voucher that genuinely exceeds the remainder', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({
      userId,
      companyId,
      customerId,
      currency: 'EUR',
      total: 1000,
      totalSek: 11500,
      exchangeRate: 11.5,
    })
    // 1500 EUR against a 1000 EUR remainder.
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '1930',
      creditAccount: '1510',
      sekAmount: 17250,
      lineCurrency: 'EUR',
      amountInCurrency: 1500,
    })

    const result = await callLinkInvoice({ invoiceId, voucherId, userId, companyId })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING')
    expect(Number(result.details?.ar_credit)).toBe(1500)
    expect(Number(result.details?.remaining)).toBe(1000)
  })

  it('refuses an AR credit that carries no amount in the invoice currency', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({
      userId,
      companyId,
      customerId,
      currency: 'EUR',
      total: 1000,
      totalSek: 11500,
      exchangeRate: 11.5,
    })
    // Labelled EUR but with no rate: nothing to convert with. Reading the
    // 11 500 as euro would advance the invoice by eleven times its value.
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '1930',
      creditAccount: '1510',
      sekAmount: 11500,
      lineCurrency: 'EUR',
      amountInCurrency: null,
    })

    const result = await callLinkInvoice({ invoiceId, voucherId, userId, companyId })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')

    const { rows } = await getPool().query(
      `SELECT status, paid_amount, remaining_amount FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(rows[0].status).toBe('sent')
    expect(Number(rows[0].paid_amount)).toBe(0)
    expect(Number(rows[0].remaining_amount)).toBe(1000)
  })

  it('refuses a domestic SEK credit as settlement of a EUR invoice', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({
      userId,
      companyId,
      customerId,
      currency: 'EUR',
      total: 1000,
      totalSek: 11500,
      exchangeRate: 11.5,
    })
    // Same magnitude, wrong unit: 1000 kr is not 1000 EUR.
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '1930',
      creditAccount: '1510',
      sekAmount: 1000,
      lineCurrency: 'SEK',
    })

    const result = await callLinkInvoice({ invoiceId, voucherId, userId, companyId })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
  })

  it('SEK: a plain domestic link is unchanged', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({
      userId,
      companyId,
      customerId,
      currency: 'SEK',
      total: 1000,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '1930',
      creditAccount: '1510',
      sekAmount: 1000,
      lineCurrency: 'SEK',
    })

    const result = await callLinkInvoice({ invoiceId, voucherId, userId, companyId })

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1000)
  })

  it('SEK: a partial domestic link is unchanged', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({
      userId,
      companyId,
      customerId,
      currency: 'SEK',
      total: 1000,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '1930',
      creditAccount: '1510',
      sekAmount: 400,
      lineCurrency: 'SEK',
    })

    const result = await callLinkInvoice({ invoiceId, voucherId, userId, companyId })

    expect(result).toMatchObject({ ok: true, invoice_status: 'partially_paid' })
    expect(Number(result.payment_amount)).toBe(400)
    expect(Number(result.remaining_amount)).toBe(600)
  })

  it('links a legacy NULL-currency invoice (meaning SEK) with a SEK payment line', async () => {
    // The label guard used to compare against the RAW nullable column:
    // COALESCE('SEK', NULL) IS DISTINCT FROM NULL is true, so an ordinary
    // domestic payment against a NULL-currency invoice raised
    // LINK_VOUCHER_CURRENCY_MISMATCH forever, and the payment row would have
    // inherited the NULL. Both now use the resolved currency.
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({
      userId,
      companyId,
      customerId,
      currency: null,
      total: 1000,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '1930',
      creditAccount: '1510',
      sekAmount: 1000,
      lineCurrency: 'SEK',
    })

    const result = await callLinkInvoice({ invoiceId, voucherId, userId, companyId })

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1000)

    // The payment row carries the resolved unit, not the raw NULL.
    const { rows } = await getPool().query(
      `SELECT amount, currency FROM public.invoice_payments
       WHERE invoice_id = $1 AND journal_entry_id = $2`,
      [invoiceId, voucherId],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(1000)
    expect(rows[0].currency).toBe('SEK')
  })

  it('SEK: the ledger column wins even when the line carries FX metadata', async () => {
    // A SEK invoice paid by a voucher whose lines happen to carry a rate: the
    // debit/credit columns are kronor regardless, so the SEK branch must ignore
    // amount_in_currency entirely.
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const customerId = await seedCustomer({ userId, companyId })
    const invoiceId = await seedInvoice({
      userId,
      companyId,
      customerId,
      currency: 'SEK',
      total: 1000,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '1930',
      creditAccount: '1510',
      sekAmount: 1000,
      lineCurrency: 'SEK',
      amountInCurrency: 87,
    })

    const result = await callLinkInvoice({ invoiceId, voucherId, userId, companyId })

    expect(result).toMatchObject({ ok: true })
    expect(Number(result.payment_amount)).toBe(1000)
  })
})

// ============================================================
// link_supplier_invoice_to_voucher
// ============================================================

describe('link_supplier_invoice_to_voucher: amount resolved in the invoice currency', () => {
  it('links a 1000 EUR supplier invoice to its 11 500 kr 2440 debit', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const supplierInvoiceId = await seedSupplierInvoice({
      userId,
      companyId,
      currency: 'EUR',
      total: 1000,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '2440',
      creditAccount: '1930',
      sekAmount: 11500,
      lineCurrency: 'EUR',
      amountInCurrency: 1000,
    })

    const result = await callLinkSupplierInvoice({
      supplierInvoiceId,
      voucherId,
      userId,
      companyId,
    })

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1000)

    const { rows } = await getPool().query(
      `SELECT amount, currency FROM public.supplier_invoice_payments
       WHERE supplier_invoice_id = $1 AND journal_entry_id = $2`,
      [supplierInvoiceId, voucherId],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(1000)
    expect(rows[0].currency).toBe('EUR')
  })

  it('sums a 244x debit across accounts in the invoice currency', async () => {
    // BAS reserves 2440-2449; a samlingsverifikat can debit 2440 and 2441 in the
    // same voucher. 600 + 400 EUR must settle a 1000 EUR invoice exactly.
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const supplierInvoiceId = await seedSupplierInvoice({
      userId,
      companyId,
      currency: 'EUR',
      total: 1000,
    })
    const voucherId = randomUUID()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status)
         VALUES ($1, $2, $3, $4, $5, 'A', '2026-05-05', 'Betalning', 'manual', 'posted')`,
        [voucherId, userId, companyId, fiscalPeriodId, nextSeq() % 2_000_000_000],
      )
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, currency, amount_in_currency)
         VALUES ($1, '2440', 6900, 0, 'EUR', 600),
                ($1, '2441', 4600, 0, 'EUR', 400),
                ($1, '1930', 0, 11500, 'EUR', 1000)`,
        [voucherId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    const result = await callLinkSupplierInvoice({
      supplierInvoiceId,
      voucherId,
      userId,
      companyId,
    })

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1000)
  })

  it('refuses a 244x debit that carries no amount in the invoice currency', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const supplierInvoiceId = await seedSupplierInvoice({
      userId,
      companyId,
      currency: 'EUR',
      total: 1000,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '2440',
      creditAccount: '1930',
      sekAmount: 11500,
      lineCurrency: 'EUR',
      amountInCurrency: null,
    })

    const result = await callLinkSupplierInvoice({
      supplierInvoiceId,
      voucherId,
      userId,
      companyId,
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')

    const { rows } = await getPool().query(
      `SELECT status, paid_amount, remaining_amount FROM public.supplier_invoices WHERE id = $1`,
      [supplierInvoiceId],
    )
    expect(rows[0].status).toBe('approved')
    expect(Number(rows[0].paid_amount)).toBe(0)
    expect(Number(rows[0].remaining_amount)).toBe(1000)
  })

  it('still rejects a 244x debit that genuinely exceeds the remainder', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const supplierInvoiceId = await seedSupplierInvoice({
      userId,
      companyId,
      currency: 'EUR',
      total: 1000,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '2440',
      creditAccount: '1930',
      sekAmount: 17250,
      lineCurrency: 'EUR',
      amountInCurrency: 1500,
    })

    const result = await callLinkSupplierInvoice({
      supplierInvoiceId,
      voucherId,
      userId,
      companyId,
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING')
    expect(Number(result.details?.ap_debit)).toBe(1500)
    expect(Number(result.details?.remaining)).toBe(1000)
  })

  it('SEK: a plain domestic supplier link is unchanged', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const supplierInvoiceId = await seedSupplierInvoice({
      userId,
      companyId,
      currency: 'SEK',
      total: 1000,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '2440',
      creditAccount: '1930',
      sekAmount: 1000,
      lineCurrency: 'SEK',
    })

    const result = await callLinkSupplierInvoice({
      supplierInvoiceId,
      voucherId,
      userId,
      companyId,
    })

    expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
    expect(Number(result.payment_amount)).toBe(1000)
  })

  it('SEK: a partial domestic supplier link is unchanged', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const supplierInvoiceId = await seedSupplierInvoice({
      userId,
      companyId,
      currency: 'SEK',
      total: 1000,
    })
    const voucherId = await seedVoucher({
      userId,
      companyId,
      fiscalPeriodId,
      debitAccount: '2440',
      creditAccount: '1930',
      sekAmount: 400,
      lineCurrency: 'SEK',
    })

    const result = await callLinkSupplierInvoice({
      supplierInvoiceId,
      voucherId,
      userId,
      companyId,
    })

    expect(result).toMatchObject({ ok: true, invoice_status: 'partially_paid' })
    expect(Number(result.payment_amount)).toBe(400)
    expect(Number(result.remaining_amount)).toBe(600)
  })
})
