import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Migration 20260907140000_rot_rut_reclaim:
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

describe('rot/rut reclaim (migration 20260907140000)', () => {
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
