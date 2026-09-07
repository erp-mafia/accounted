import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Migration 20260907160000_rot_rut_reclaim:
 *  - journal_entries.source_type accepts 'rot_rut_reclaim'
 *  - one live reclaim voucher per begäran (partial unique index)
 *  - invoices.deduction_reclaimed_total never exceeds the deduction
 *  - the INSERT guard derives remaining_amount with the reclaimed term
 */

async function insertCustomerInvoice(
  companyId: string,
  userId: string,
  cols: { deduction_total: number; deduction_reclaimed_total: number; remaining_amount?: number | null },
): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount, deduction_total, deduction_reclaimed_total)
     VALUES ($1, $2, $3, $4, $5, '2026-01-15', '2026-02-14', 'SEK',
             20000, 5000, 25000, 'standard_25', 25, 'sent', 0, $6, $7, $8)`,
    [
      id,
      userId,
      companyId,
      customerId,
      `F-${id.slice(0, 8)}`,
      cols.remaining_amount ?? null,
      cols.deduction_total,
      cols.deduction_reclaimed_total,
    ],
  )
  return id
}

describe('rot/rut reclaim (migration 20260907160000)', () => {
  it('accepts source_type rot_rut_reclaim and allows exactly one live reclaim voucher per begäran', async () => {
    const seeded = await seedCompany()
    const requestId = randomUUID()
    const common = {
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      entryDate: '2026-08-21',
      description: 'Nekat RUT-avdrag från Skatteverket (RUT 2026-08)',
      sourceType: 'rot_rut_reclaim',
      sourceId: requestId,
      lines: [
        { accountNumber: '1510', debitAmount: 2000, creditAmount: 0 },
        { accountNumber: '1513', debitAmount: 0, creditAmount: 2000 },
      ],
    }

    const results = await Promise.allSettled([
      insertPostedJournalEntry({ ...common, voucherNumber: 51 }),
      insertPostedJournalEntry({ ...common, voucherNumber: 52 }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
      /journal_entries_rot_rut_reclaim_live_unique/,
    )

    // A second begäran is not blocked, nor is the payout voucher of the same begäran.
    await expect(
      insertPostedJournalEntry({ ...common, sourceId: randomUUID(), voucherNumber: 53 }),
    ).resolves.toBeTruthy()
    await expect(
      insertPostedJournalEntry({
        ...common,
        sourceType: 'rot_rut_payout',
        voucherNumber: 54,
        lines: [
          { accountNumber: '1930', debitAmount: 3000, creditAmount: 0 },
          { accountNumber: '1513', debitAmount: 0, creditAmount: 3000 },
        ],
      }),
    ).resolves.toBeTruthy()
  })

  it('refuses a reclaimed total above the deduction', async () => {
    const seeded = await seedCompany()
    await expect(
      insertCustomerInvoice(seeded.companyId, seeded.userId, {
        deduction_total: 7500,
        deduction_reclaimed_total: 9000,
        remaining_amount: 17500,
      }),
    ).rejects.toThrow(/invoices_deduction_reclaimed_total_check/)
    await expect(
      insertCustomerInvoice(seeded.companyId, seeded.userId, {
        deduction_total: 7500,
        deduction_reclaimed_total: 7500,
        remaining_amount: 25000,
      }),
    ).resolves.toBeTruthy()
  })

  it('derives remaining_amount with the reclaimed term when a writer omits it', async () => {
    const seeded = await seedCompany()
    const id = await insertCustomerInvoice(seeded.companyId, seeded.userId, {
      deduction_total: 7500,
      deduction_reclaimed_total: 2500,
      remaining_amount: null,
    })
    const { rows } = await getPool().query<{ remaining_amount: string }>(
      'SELECT remaining_amount FROM public.invoices WHERE id = $1',
      [id],
    )
    // 25 000 - 0 paid - 7 500 deduction + 2 500 reclaimed
    expect(Number(rows[0].remaining_amount)).toBe(20000)
  })
})

describe('apply_rot_rut_reclaim_invoice (migration 20260907160300)', () => {
  it('applies item marker and invoice reopen atomically, and is a no-op the second time', async () => {
    const seeded = await seedCompany()
    const invoiceId = await insertCustomerInvoice(seeded.companyId, seeded.userId, {
      deduction_total: 7500,
      deduction_reclaimed_total: 0,
      remaining_amount: 0,
    })
    await getPool().query(
      `UPDATE public.invoices SET status = 'paid', paid_amount = 17500 WHERE id = $1`,
      [invoiceId],
    )
    const requestId = randomUUID()
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_requests
         (id, company_id, user_id, deduction_type, name, status, requested_total, decided_total, decided_at, file_name)
       VALUES ($1, $2, $3, 'rot', 'ROT 2026-08', 'partially_paid', 7500, 5000, now(), 'rot.xml')`,
      [requestId, seeded.companyId, seeded.userId],
    )
    const itemId = randomUUID()
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_request_items (id, request_id, invoice_id, requested_amount, decided_amount)
       VALUES ($1, $2, $3, 7500, 5000)`,
      [itemId, requestId, invoiceId],
    )

    const first = await getPool().query<{ applied: boolean }>(
      `SELECT public.apply_rot_rut_reclaim_invoice($1, $2, $3, 2500, 2500, 'partially_paid') AS applied`,
      [itemId, invoiceId, seeded.companyId],
    )
    expect(first.rows[0].applied).toBe(true)

    const second = await getPool().query<{ applied: boolean }>(
      `SELECT public.apply_rot_rut_reclaim_invoice($1, $2, $3, 2500, 2500, 'partially_paid') AS applied`,
      [itemId, invoiceId, seeded.companyId],
    )
    expect(second.rows[0].applied).toBe(false)

    const { rows } = await getPool().query<{
      deduction_reclaimed_total: string
      remaining_amount: string
      status: string
      reclaimed_amount: string
    }>(
      `SELECT i.deduction_reclaimed_total, i.remaining_amount, i.status, it.reclaimed_amount
         FROM public.invoices i
         JOIN public.rot_rut_payout_request_items it ON it.invoice_id = i.id
        WHERE i.id = $1`,
      [invoiceId],
    )
    // Applied exactly once: 2 500 reclaimed, not 5 000.
    expect(Number(rows[0].deduction_reclaimed_total)).toBe(2500)
    expect(Number(rows[0].remaining_amount)).toBe(2500)
    expect(rows[0].status).toBe('partially_paid')
    expect(Number(rows[0].reclaimed_amount)).toBe(2500)
  })

  it('refuses a foreign company invoice without touching the marker', async () => {
    const seeded = await seedCompany()
    const other = await seedCompany()
    const invoiceId = await insertCustomerInvoice(seeded.companyId, seeded.userId, {
      deduction_total: 7500,
      deduction_reclaimed_total: 0,
      remaining_amount: 17500,
    })
    const requestId = randomUUID()
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_requests
         (id, company_id, user_id, deduction_type, name, status, requested_total, decided_total, decided_at, file_name)
       VALUES ($1, $2, $3, 'rot', 'ROT 2026-09', 'rejected', 7500, 0, now(), 'rot.xml')`,
      [requestId, seeded.companyId, seeded.userId],
    )
    const itemId = randomUUID()
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_request_items (id, request_id, invoice_id, requested_amount)
       VALUES ($1, $2, $3, 7500)`,
      [itemId, requestId, invoiceId],
    )
    await expect(
      getPool().query(
        `SELECT public.apply_rot_rut_reclaim_invoice($1, $2, $3, 7500, 25000, 'sent')`,
        [itemId, invoiceId, other.companyId],
      ),
    ).rejects.toThrow(/not found in company/)
    const { rows } = await getPool().query<{ reclaimed_amount: string | null }>(
      `SELECT reclaimed_amount FROM public.rot_rut_payout_request_items WHERE id = $1`,
      [itemId],
    )
    // The function raised, so the marker write rolled back with it.
    expect(rows[0].reclaimed_amount).toBeNull()
  })
})
