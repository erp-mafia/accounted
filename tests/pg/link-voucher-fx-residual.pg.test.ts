/**
 * pg-real tests for migration
 * 20260830120000_link_voucher_rpcs_fx_residual_settlement.sql: a foreign
 * invoice whose receivable/payable was booked in plain SEK can be settled by
 * a SEK payment voucher, with the FX residual booked to 7960/3960 as its own
 * balanced verifikat (the linked voucher is posted and immutable), mirroring
 * match_batch_allocate's cross-currency sign conventions.
 *
 * Harness note: every test runs inside ONE transaction on ONE client. The
 * migration file is executed first (CREATE OR REPLACE FUNCTION is
 * transactional in Postgres), then the fixtures are seeded, the RPC is
 * called, the assertions read from the same client, and everything is rolled
 * back. This lets the suite run against a database that has NOT had the
 * migration applied yet (the migration ships as a file only), while still
 * exercising the real triggers, commit_journal_entry and voucher numbering.
 * In CI the migration is already replayed, and re-executing it in the
 * transaction is a no-op.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PoolClient } from 'pg'
import { getClient } from '@/tests/pg/setup'

const MIGRATION_SQL = readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260830120000_link_voucher_rpcs_fx_residual_settlement.sql',
  ),
  'utf8',
)

let seq = 0
function nextSeq(): number {
  return (Date.now() % 1_000_000) * 1000 + seq++
}

/** Run `fn` in a transaction that first applies the migration under test and
 *  always rolls back: nothing persists, in the DB functions included. */
async function withFxMigration(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(MIGRATION_SQL)
    await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function seedTenant(client: PoolClient): Promise<{
  userId: string
  companyId: string
  fiscalPeriodId: string
}> {
  const userId = randomUUID()
  await client.query(
    `INSERT INTO auth.users (id, email, instance_id)
     VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [userId, `pg-real-${userId}@test.invalid`],
  )
  const companyId = randomUUID()
  await client.query(
    `INSERT INTO public.companies (id, name, entity_type, created_by)
     VALUES ($1, 'FX Test AB', 'aktiebolag', $2)`,
    [companyId, userId],
  )
  await client.query(
    `INSERT INTO public.company_members (company_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [companyId, userId],
  )
  const fiscalPeriodId = randomUUID()
  await client.query(
    `INSERT INTO public.fiscal_periods
       (id, user_id, company_id, name, period_start, period_end, is_closed)
     VALUES ($1, $2, $3, '2026', '2026-01-01', '2026-12-31', false)`,
    [fiscalPeriodId, userId, companyId],
  )
  return { userId, companyId, fiscalPeriodId }
}

async function seedCustomerInvoice(
  client: PoolClient,
  params: {
    userId: string
    companyId: string
    currency: string
    total: number
    totalSek?: number | null
    exchangeRate?: number | null
  },
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const customerId = randomUUID()
  await client.query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Utländsk Kund AB', 'swedish_business')`,
    [customerId, params.userId, params.companyId],
  )
  const invoiceId = randomUUID()
  const invoiceNumber = `F-${nextSeq()}`
  await client.query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, exchange_rate, subtotal, vat_amount, total, total_sek,
        vat_treatment, vat_rate, status, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01',
             $6, $7, $8, 0, $8, $9, 'standard_25', 25, 'sent', 0, $8)`,
    [
      invoiceId,
      params.userId,
      params.companyId,
      customerId,
      invoiceNumber,
      params.currency,
      params.exchangeRate ?? null,
      params.total,
      params.totalSek ?? null,
    ],
  )
  return { invoiceId, invoiceNumber }
}

async function seedSupplierInvoice(
  client: PoolClient,
  params: {
    userId: string
    companyId: string
    currency: string
    total: number
    exchangeRate?: number | null
  },
): Promise<string> {
  const supplierId = randomUUID()
  await client.query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Utlandsleverantör AB', 'swedish_business', 'SE', 30, $4)`,
    [supplierId, params.userId, params.companyId, params.currency],
  )
  const id = randomUUID()
  const arrivalNumber = nextSeq()
  await client.query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'approved', $7, $8,
             $9, 0, $9, 0, $9, 'standard_25', false, false)`,
    [
      id,
      params.userId,
      params.companyId,
      supplierId,
      arrivalNumber,
      `LF-${arrivalNumber}`,
      params.currency,
      params.exchangeRate ?? null,
      params.total,
    ],
  )
  return id
}

/** A posted, balanced two-line voucher. `sekAmount` goes in the debit/credit
 *  columns (the ledger is always kronor); `lineCurrency` + `amountInCurrency`
 *  are the document metadata. Defaults model the plain-SEK voucher this
 *  migration unblocks. */
async function seedVoucher(
  client: PoolClient,
  params: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    debitAccount: string
    creditAccount: string
    sekAmount: number
    lineCurrency?: string | null
    amountInCurrency?: number | null
    entryDate?: string
  },
): Promise<string> {
  const id = randomUUID()
  // A prior seed's SET CONSTRAINTS ... IMMEDIATE persists for the rest of the
  // transaction; re-defer so the entry-before-lines insert below is legal.
  await client.query('SET CONSTRAINTS check_balance_on_posted_insert DEFERRED')
  await client.query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Betalning', 'manual', 'posted')`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      nextSeq() % 2_000_000_000,
      params.entryDate ?? '2026-05-05',
    ],
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
  // Force the deferred posted-insert balance check to run now: the harness
  // rolls back instead of committing, so without this the seed would never be
  // validated at all.
  await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
  return id
}

type RpcResult = {
  ok: boolean
  code?: string
  invoice_status?: string
  paid_amount?: number
  remaining_amount?: number
  payment_amount?: number
  fx_settled_sek?: number | null
  fx_residual_sek?: number | null
  fx_journal_entry_id?: string | null
  fx_voucher_number?: number | null
  details?: Record<string, unknown>
}

async function callLinkInvoice(
  client: PoolClient,
  args: { invoiceId: string; voucherId: string; userId: string; companyId: string },
): Promise<RpcResult> {
  const { rows } = await client.query<{ result: RpcResult }>(
    `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
    [args.invoiceId, args.voucherId, args.userId, args.companyId],
  )
  return rows[0].result
}

async function callLinkSupplierInvoice(
  client: PoolClient,
  args: { supplierInvoiceId: string; voucherId: string; userId: string; companyId: string },
): Promise<RpcResult> {
  const { rows } = await client.query<{ result: RpcResult }>(
    `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
    [args.supplierInvoiceId, args.voucherId, args.userId, args.companyId],
  )
  return rows[0].result
}

/** Assert the FX residual verifikat exists, is posted with a real voucher
 *  number, balances exactly, and carries the expected two lines. */
async function assertFxEntry(
  client: PoolClient,
  fxEntryId: string,
  expected: { account: string; debit: number; credit: number }[],
): Promise<void> {
  const { rows: entryRows } = await client.query<{
    status: string
    voucher_number: number
  }>(
    `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
    [fxEntryId],
  )
  expect(entryRows).toHaveLength(1)
  expect(entryRows[0].status).toBe('posted')
  expect(Number(entryRows[0].voucher_number)).toBeGreaterThan(0)

  const { rows: lines } = await client.query<{
    account_number: string
    debit_amount: string
    credit_amount: string
  }>(
    `SELECT account_number, debit_amount, credit_amount
     FROM public.journal_entry_lines WHERE journal_entry_id = $1
     ORDER BY sort_order`,
    [fxEntryId],
  )
  expect(lines).toHaveLength(expected.length)
  for (const [i, exp] of expected.entries()) {
    expect(lines[i].account_number).toBe(exp.account)
    expect(Number(lines[i].debit_amount)).toBe(exp.debit)
    expect(Number(lines[i].credit_amount)).toBe(exp.credit)
  }
  const debitTotal = lines.reduce((s, l) => s + Number(l.debit_amount), 0)
  const creditTotal = lines.reduce((s, l) => s + Number(l.credit_amount), 0)
  expect(debitTotal).toBe(creditTotal)
  expect(debitTotal).toBeGreaterThan(0)
}

// ============================================================
// link_invoice_to_voucher: FX residual settlement
// ============================================================

describe('link_invoice_to_voucher: SEK-booked voucher settles a foreign invoice', () => {
  it('books the shortfall to 7960 (loss) and marks the invoice paid', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      // 1000 EUR booked at 11.50: receivable carries 11 500 kr.
      const { invoiceId } = await seedCustomerInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        totalSek: 11500,
        exchangeRate: 11.5,
      })
      // The bank received 11 200 kr, booked plain SEK with no FX metadata.
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '1930',
        creditAccount: '1510',
        sekAmount: 11200,
      })

      const result = await callLinkInvoice(client, { invoiceId, voucherId, userId, companyId })

      // Before the migration this was LINK_VOUCHER_CURRENCY_MISMATCH.
      expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
      expect(Number(result.payment_amount)).toBe(1000)
      expect(Number(result.remaining_amount)).toBe(0)
      expect(Number(result.fx_settled_sek)).toBe(11200)
      expect(Number(result.fx_residual_sek)).toBe(300)
      expect(result.fx_journal_entry_id).toBeTruthy()

      // Residual verifikat: Dr 7960 300 / Cr 1510 300, balanced and posted.
      await assertFxEntry(client, result.fx_journal_entry_id as string, [
        { account: '7960', debit: 300, credit: 0 },
        { account: '1510', debit: 0, credit: 300 },
      ])

      // Payment row: full remaining in EUR, effective rate 11.2.
      const { rows: payments } = await client.query(
        `SELECT amount, currency, payment_exchange_rate FROM public.invoice_payments
         WHERE invoice_id = $1 AND journal_entry_id = $2`,
        [invoiceId, voucherId],
      )
      expect(payments).toHaveLength(1)
      expect(Number(payments[0].amount)).toBe(1000)
      expect(payments[0].currency).toBe('EUR')
      expect(Number(payments[0].payment_exchange_rate)).toBe(11.2)
    })
  })

  it('books the excess to 3960 (gain)', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const { invoiceId } = await seedCustomerInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        totalSek: 11500,
        exchangeRate: 11.5,
      })
      // The bank received 11 800 kr: 300 kr above the booked receivable.
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '1930',
        creditAccount: '1510',
        sekAmount: 11800,
      })

      const result = await callLinkInvoice(client, { invoiceId, voucherId, userId, companyId })

      expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
      expect(Number(result.fx_residual_sek)).toBe(-300)
      await assertFxEntry(client, result.fx_journal_entry_id as string, [
        { account: '1510', debit: 300, credit: 0 },
        { account: '3960', debit: 0, credit: 300 },
      ])
    })
  })

  it('books no residual verifikat when the SEK amounts agree exactly', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const { invoiceId } = await seedCustomerInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        totalSek: 11500,
        exchangeRate: 11.5,
      })
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '1930',
        creditAccount: '1510',
        sekAmount: 11500,
      })

      const result = await callLinkInvoice(client, { invoiceId, voucherId, userId, companyId })

      expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
      expect(Number(result.payment_amount)).toBe(1000)
      expect(Number(result.fx_residual_sek)).toBe(0)
      expect(result.fx_journal_entry_id).toBeNull()

      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM public.journal_entries
         WHERE company_id = $1 AND id <> $2`,
        [companyId, voucherId],
      )
      expect(rows[0].n).toBe(0)
    })
  })

  it('still refuses a SEK voucher far off the booked value (wrong voucher, not FX)', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const { invoiceId } = await seedCustomerInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        totalSek: 11500,
        exchangeRate: 11.5,
      })
      // Same magnitude, wrong unit: 1 000 kr is not 1 000 EUR. 10% band trips.
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '1930',
        creditAccount: '1510',
        sekAmount: 1000,
      })

      const result = await callLinkInvoice(client, { invoiceId, voucherId, userId, companyId })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
      expect(result.details?.reason).toBe('fx_deviation_too_large')

      const { rows } = await client.query(
        `SELECT status, paid_amount, remaining_amount FROM public.invoices WHERE id = $1`,
        [invoiceId],
      )
      expect(rows[0].status).toBe('sent')
      expect(Number(rows[0].paid_amount)).toBe(0)
      expect(Number(rows[0].remaining_amount)).toBe(1000)
    })
  })

  it('still refuses when the invoice has no usable exchange rate', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const { invoiceId } = await seedCustomerInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        totalSek: null,
        exchangeRate: null,
      })
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '1930',
        creditAccount: '1510',
        sekAmount: 11500,
      })

      const result = await callLinkInvoice(client, { invoiceId, voucherId, userId, companyId })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
    })
  })

  it('still refuses an invoice-labelled line that carries no foreign figure', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const { invoiceId } = await seedCustomerInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        totalSek: 11500,
        exchangeRate: 11.5,
      })
      // Labelled EUR but amount_in_currency NULL: malformed metadata, not a
      // SEK-booked line. The pre-migration refusal must survive.
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '1930',
        creditAccount: '1510',
        sekAmount: 11500,
        lineCurrency: 'EUR',
        amountInCurrency: null,
      })

      const result = await callLinkInvoice(client, { invoiceId, voucherId, userId, companyId })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
    })
  })

  it('refuses the SEK fallback on kontantmetoden (no receivable to true up)', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      await client.query(
        `INSERT INTO public.company_settings (user_id, company_id, accounting_method)
         VALUES ($1, $2, 'cash')`,
        [userId, companyId],
      )
      const { invoiceId } = await seedCustomerInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        totalSek: 11500,
        exchangeRate: 11.5,
      })
      // Cash method matches the 19xx debit.
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '1930',
        creditAccount: '3001',
        sekAmount: 11500,
      })

      const result = await callLinkInvoice(client, { invoiceId, voucherId, userId, companyId })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
    })
  })

  it('refuses when the residual would land in a locked period, without writing anything', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const { invoiceId } = await seedCustomerInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        totalSek: 11500,
        exchangeRate: 11.5,
      })
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '1930',
        creditAccount: '1510',
        sekAmount: 11200,
      })
      // Lock the period AFTER the voucher exists: the residual verifikat may
      // not be booked there, so the whole link must be refused.
      await client.query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [
        fiscalPeriodId,
      ])

      const result = await callLinkInvoice(client, { invoiceId, voucherId, userId, companyId })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
      expect(result.details?.reason).toBe('fx_residual_period_locked')

      const { rows } = await client.query(
        `SELECT status, paid_amount FROM public.invoices WHERE id = $1`,
        [invoiceId],
      )
      expect(rows[0].status).toBe('sent')
      expect(Number(rows[0].paid_amount)).toBe(0)
    })
  })

  it('regression: a voucher readable in the invoice currency links exactly as before', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const { invoiceId } = await seedCustomerInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        totalSek: 11500,
        exchangeRate: 11.5,
      })
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '1930',
        creditAccount: '1510',
        sekAmount: 11500,
        lineCurrency: 'EUR',
        amountInCurrency: 1000,
      })

      const result = await callLinkInvoice(client, { invoiceId, voucherId, userId, companyId })

      expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
      expect(Number(result.payment_amount)).toBe(1000)
      // The readable path never engages the fallback: no residual verifikat.
      expect(result.fx_journal_entry_id).toBeNull()
    })
  })
})

// ============================================================
// link_supplier_invoice_to_voucher: FX residual settlement
// ============================================================

describe('link_supplier_invoice_to_voucher: SEK-booked voucher settles a foreign invoice', () => {
  it('books the underpayment to 3960 (gain) and marks the invoice paid', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const supplierInvoiceId = await seedSupplierInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        exchangeRate: 11.5,
      })
      // Paid 11 200 kr against an 11 500 kr booked liability: 300 kr gain.
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '2440',
        creditAccount: '1930',
        sekAmount: 11200,
      })

      const result = await callLinkSupplierInvoice(client, {
        supplierInvoiceId,
        voucherId,
        userId,
        companyId,
      })

      expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
      expect(Number(result.payment_amount)).toBe(1000)
      expect(Number(result.fx_residual_sek)).toBe(300)
      await assertFxEntry(client, result.fx_journal_entry_id as string, [
        { account: '2440', debit: 300, credit: 0 },
        { account: '3960', debit: 0, credit: 300 },
      ])

      const { rows: payments } = await client.query(
        `SELECT amount, currency, payment_exchange_rate FROM public.supplier_invoice_payments
         WHERE supplier_invoice_id = $1 AND journal_entry_id = $2`,
        [supplierInvoiceId, voucherId],
      )
      expect(payments).toHaveLength(1)
      expect(Number(payments[0].amount)).toBe(1000)
      expect(payments[0].currency).toBe('EUR')
      expect(Number(payments[0].payment_exchange_rate)).toBe(11.2)
    })
  })

  it('books the overpayment to 7960 (loss)', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const supplierInvoiceId = await seedSupplierInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        exchangeRate: 11.5,
      })
      // Paid 11 800 kr against the 11 500 kr booked liability: 300 kr loss.
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '2440',
        creditAccount: '1930',
        sekAmount: 11800,
      })

      const result = await callLinkSupplierInvoice(client, {
        supplierInvoiceId,
        voucherId,
        userId,
        companyId,
      })

      expect(result).toMatchObject({ ok: true, invoice_status: 'paid' })
      expect(Number(result.fx_residual_sek)).toBe(-300)
      await assertFxEntry(client, result.fx_journal_entry_id as string, [
        { account: '7960', debit: 300, credit: 0 },
        { account: '2440', debit: 0, credit: 300 },
      ])
    })
  })

  it('still refuses a SEK voucher far off the booked value', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const supplierInvoiceId = await seedSupplierInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        exchangeRate: 11.5,
      })
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '2440',
        creditAccount: '1930',
        sekAmount: 1000,
      })

      const result = await callLinkSupplierInvoice(client, {
        supplierInvoiceId,
        voucherId,
        userId,
        companyId,
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
      expect(result.details?.reason).toBe('fx_deviation_too_large')

      const { rows } = await client.query(
        `SELECT status, paid_amount, remaining_amount FROM public.supplier_invoices WHERE id = $1`,
        [supplierInvoiceId],
      )
      expect(rows[0].status).toBe('approved')
      expect(Number(rows[0].paid_amount)).toBe(0)
      expect(Number(rows[0].remaining_amount)).toBe(1000)
    })
  })

  it('still refuses a 244x debit labelled with the invoice currency but no figure', async () => {
    await withFxMigration(async (client) => {
      const { userId, companyId, fiscalPeriodId } = await seedTenant(client)
      const supplierInvoiceId = await seedSupplierInvoice(client, {
        userId,
        companyId,
        currency: 'EUR',
        total: 1000,
        exchangeRate: 11.5,
      })
      const voucherId = await seedVoucher(client, {
        userId,
        companyId,
        fiscalPeriodId,
        debitAccount: '2440',
        creditAccount: '1930',
        sekAmount: 11500,
        lineCurrency: 'EUR',
        amountInCurrency: null,
      })

      const result = await callLinkSupplierInvoice(client, {
        supplierInvoiceId,
        voucherId,
        userId,
        companyId,
      })

      expect(result.ok).toBe(false)
      expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
    })
  })
})
