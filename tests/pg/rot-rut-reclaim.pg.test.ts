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

describe('apply / revert rot_rut_reclaim RPCs (migration 20260907160400)', () => {
  async function seedReclaimCase(opts: { decidedTotal: number; itemDecided: number | null; status: string }) {
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
    const reclaimEntryId = await insertPostedJournalEntry({
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      entryDate: '2026-08-21',
      description: 'Nekat ROT-avdrag från Skatteverket',
      sourceType: 'rot_rut_reclaim',
      sourceId: requestId,
      voucherNumber: 61,
      lines: [
        { accountNumber: '1510', debitAmount: 2500, creditAmount: 0 },
        { accountNumber: '1513', debitAmount: 0, creditAmount: 2500 },
      ],
    })
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_requests
         (id, company_id, user_id, deduction_type, name, status, requested_total, decided_total, decided_at, file_name, reclaim_journal_entry_id)
       VALUES ($1, $2, $3, 'rot', 'ROT 2026-08', $4, 7500, $5, now(), 'rot.xml', $6)`,
      [requestId, seeded.companyId, seeded.userId, opts.status, opts.decidedTotal, reclaimEntryId],
    )
    const itemId = randomUUID()
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_request_items (id, request_id, invoice_id, requested_amount, decided_amount)
       VALUES ($1, $2, $3, 7500, $4)`,
      [itemId, requestId, invoiceId, opts.itemDecided],
    )
    return { ...seeded, invoiceId, requestId, itemId }
  }

  async function readInvoice(invoiceId: string) {
    const { rows } = await getPool().query<{
      deduction_reclaimed_total: string
      remaining_amount: string
      status: string
      reclaimed_amount: string | null
    }>(
      `SELECT i.deduction_reclaimed_total, i.remaining_amount, i.status, it.reclaimed_amount
         FROM public.invoices i
         JOIN public.rot_rut_payout_request_items it ON it.invoice_id = i.id
        WHERE i.id = $1`,
      [invoiceId],
    )
    return rows[0]
  }

  it('applies once (marker + invoice, derived remaining/status) and is a no-op the second time', async () => {
    const c = await seedReclaimCase({ decidedTotal: 5000, itemDecided: 5000, status: 'partially_paid' })

    const first = await getPool().query<{ r: { applied: boolean; remaining_amount: number; status: string } }>(
      `SELECT public.apply_rot_rut_reclaim_invoice($1, $2, $3, 2500) AS r`,
      [c.itemId, c.invoiceId, c.companyId],
    )
    expect(first.rows[0].r).toMatchObject({ applied: true, remaining_amount: 2500, status: 'partially_paid' })

    const second = await getPool().query<{ r: { applied: boolean } }>(
      `SELECT public.apply_rot_rut_reclaim_invoice($1, $2, $3, 2500) AS r`,
      [c.itemId, c.invoiceId, c.companyId],
    )
    expect(second.rows[0].r).toEqual({ applied: false })

    const row = await readInvoice(c.invoiceId)
    // 25 000 - 17 500 paid - 7 500 deduction + 2 500 reclaimed = 2 500, once.
    expect(Number(row.deduction_reclaimed_total)).toBe(2500)
    expect(Number(row.remaining_amount)).toBe(2500)
    expect(row.status).toBe('partially_paid')
    expect(Number(row.reclaimed_amount)).toBe(2500)
  })

  it('refuses an amount above the refused share and above the 1513 headroom', async () => {
    const c = await seedReclaimCase({ decidedTotal: 5000, itemDecided: 5000, status: 'partially_paid' })
    await expect(
      getPool().query(`SELECT public.apply_rot_rut_reclaim_invoice($1, $2, $3, 4000)`, [
        c.itemId, c.invoiceId, c.companyId,
      ]),
    ).rejects.toThrow(/exceeds the refused share/)
    const row = await readInvoice(c.invoiceId)
    expect(row.reclaimed_amount).toBeNull()
    expect(Number(row.deduction_reclaimed_total)).toBe(0)
  })

  it('refuses a foreign company without touching the marker', async () => {
    const c = await seedReclaimCase({ decidedTotal: 0, itemDecided: null, status: 'rejected' })
    const other = await seedCompany()
    await expect(
      getPool().query(`SELECT public.apply_rot_rut_reclaim_invoice($1, $2, $3, 7500)`, [
        c.itemId, c.invoiceId, other.companyId,
      ]),
    ).rejects.toThrow(/not found in company/)
    const row = await readInvoice(c.invoiceId)
    expect(row.reclaimed_amount).toBeNull()
  })

  it('revert hands the share back, closes the invoice, and is a no-op the second time', async () => {
    const c = await seedReclaimCase({ decidedTotal: 5000, itemDecided: 5000, status: 'partially_paid' })
    await getPool().query(`SELECT public.apply_rot_rut_reclaim_invoice($1, $2, $3, 2500)`, [
      c.itemId, c.invoiceId, c.companyId,
    ])

    const first = await getPool().query<{ r: { reverted: boolean; remaining_amount: number; status: string } }>(
      `SELECT public.revert_rot_rut_reclaim_invoice($1, $2, $3) AS r`,
      [c.itemId, c.invoiceId, c.companyId],
    )
    expect(first.rows[0].r).toMatchObject({ reverted: true, remaining_amount: 0, status: 'paid' })

    const second = await getPool().query<{ r: { reverted: boolean } }>(
      `SELECT public.revert_rot_rut_reclaim_invoice($1, $2, $3) AS r`,
      [c.itemId, c.invoiceId, c.companyId],
    )
    expect(second.rows[0].r).toEqual({ reverted: false })

    const row = await readInvoice(c.invoiceId)
    expect(Number(row.deduction_reclaimed_total)).toBe(0)
    expect(Number(row.remaining_amount)).toBe(0)
    expect(row.status).toBe('paid')
    expect(row.reclaimed_amount).toBeNull()
  })
})
