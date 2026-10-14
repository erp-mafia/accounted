import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Migration 20261015001000_migrated_invoice_deduction:
 *  - journal_entries.source_type accepts 'rot_rut_reclassification', one live
 *    voucher per invoice (partial unique index);
 *  - apply_migrated_invoice_deduction writes a migrated invoice's household
 *    deduction once, only for the state the preview saw, only after a voucher
 *    that moved exactly the deduction from 1510 to 1513, and derives
 *    remaining_amount and status itself; its status-only mode repairs a
 *    part-paid import left at sent;
 *  - revert_migrated_invoice_deduction undoes it after the voucher is
 *    reversed, and refuses while a begäran holds the invoice.
 */

interface Case {
  userId: string
  companyId: string
  fiscalPeriodId: string
  invoiceId: string
  workItemId: string
  materialItemId: string
  textItemId: string
}

// 8 000 net + 2 000 moms = 10 000. The work row is 6 000 + 1 500 moms, so a
// 50 % RUT deduction is 3 750 and the buyer's share 6 250.
async function seedCase(opts: { paid?: number; status?: string; currency?: string } = {}): Promise<Case> {
  const seeded = await seedCompany()
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Privatkund', 'individual')`,
    [customerId, seeded.userId, seeded.companyId],
  )
  const paid = opts.paid ?? 0
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-08-28', '2026-09-27', $6,
             8000, 2000, 10000, 'standard_25', 25, $7, $8, $9)`,
    [
      invoiceId,
      seeded.userId,
      seeded.companyId,
      customerId,
      `M-${invoiceId.slice(0, 8)}`,
      opts.currency ?? 'SEK',
      opts.status ?? 'sent',
      paid,
      10000 - paid,
    ],
  )
  const workItemId = randomUUID()
  const materialItemId = randomUUID()
  const textItemId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_items
       (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, line_type)
     VALUES ($1, $4, 1, 'Städning', 12, 'tim', 500, 6000, 25, 1500, 'product'),
            ($2, $4, 2, 'Material', 1, 'st', 2000, 2000, 25, 500, 'product'),
            ($3, $4, 3, 'Tack för uppdraget', 0, 'st', 0, 0, 0, 0, 'text')`,
    [workItemId, materialItemId, textItemId, invoiceId],
  )
  return { ...seeded, invoiceId, workItemId, materialItemId, textItemId }
}

async function insertVoucher(c: Case, amount = 3750, sourceId: string = c.invoiceId, voucherNumber = 1): Promise<string> {
  return insertPostedJournalEntry({
    userId: c.userId,
    companyId: c.companyId,
    fiscalPeriodId: c.fiscalPeriodId,
    entryDate: '2026-10-14',
    description: 'Omföring av RUT-avdrag, migrerad faktura',
    sourceType: 'rot_rut_reclassification',
    sourceId,
    voucherSeries: 'C',
    voucherNumber,
    lines: [
      { accountNumber: '1513', debitAmount: amount, creditAmount: 0 },
      { accountNumber: '1510', debitAmount: 0, creditAmount: amount },
    ],
  })
}

function expected(c: Case, overrides: Record<string, unknown> = {}) {
  return { status: 'sent', total: 10000, paid_amount: 0, payment_count: 0, item_count: 3, ...overrides }
}

function deduction(c: Case, overrides: Record<string, unknown> = {}) {
  return {
    deduction_type: 'rut',
    deduction_total: 3750,
    personnummer_encrypted: 'aabbccddeeff',
    personnummer_last4: '1234',
    paid_on: '2026-09-01',
    items: [
      { id: c.workItemId, line_total: 6000, vat_amount: 1500, deduction_amount: 3750, labor_hours: 12, work_type: 'STAD' },
    ],
    ...overrides,
  }
}

type Result = { ok: boolean; code?: string; applied?: boolean; reverted?: boolean; status?: string; remaining_amount?: number }

async function apply(
  client: PoolClient,
  c: Case,
  args: { expected?: unknown; deduction?: unknown | null; journalEntryId?: string | null; dryRun?: boolean },
): Promise<Result> {
  const { rows } = await client.query<{ r: Result }>(
    `SELECT public.apply_migrated_invoice_deduction($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::jsonb) AS r`,
    [
      c.companyId,
      c.invoiceId,
      JSON.stringify(args.expected ?? expected(c)),
      args.deduction === null ? null : JSON.stringify(args.deduction ?? deduction(c)),
      args.journalEntryId ?? null,
      args.dryRun ?? false,
      JSON.stringify({ provider: 'visma', correlation_id: randomUUID() }),
    ],
  )
  return rows[0].r
}

async function asService<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runAsServiceRole(fn)
}

async function readInvoice(invoiceId: string) {
  const { rows } = await getPool().query<{
    status: string
    remaining_amount: string
    deduction_total: string
    deduction_personnummer_last4: string | null
    paid_at: Date | null
  }>(
    `SELECT status, remaining_amount, deduction_total, deduction_personnummer_last4, paid_at
       FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]
}

async function readItems(invoiceId: string) {
  const { rows } = await getPool().query<{
    id: string
    deduction_type: string | null
    deduction_amount: string
    labor_hours: string | null
    work_type: string | null
  }>(
    `SELECT id, deduction_type, deduction_amount, labor_hours, work_type
       FROM public.invoice_items WHERE invoice_id = $1 ORDER BY sort_order`,
    [invoiceId],
  )
  return rows
}

async function readEvents(invoiceId: string) {
  const { rows } = await getPool().query<{ payload: Record<string, unknown>; actor: Record<string, unknown> }>(
    `SELECT payload, actor FROM public.processing_history
      WHERE aggregate_id = $1 AND event_type = 'InvoiceDeductionMigrated' ORDER BY seq`,
    [invoiceId],
  )
  return rows
}

async function storno(c: Case, originalId: string, voucherNumber: number): Promise<void> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, source_id, status, reverses_id)
       VALUES ($1, $2, $3, $4, $5, 'C', '2026-10-14', 'Makulering: omföring', 'storno', $6, 'draft', $7)`,
      [id, c.userId, c.companyId, c.fiscalPeriodId, voucherNumber, c.invoiceId, originalId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT $1, account_number, credit_amount, debit_amount
         FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [id, originalId],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
    [originalId, id],
  )
}

async function holdInRequest(c: Case, status = 'generated'): Promise<string> {
  const requestId = randomUUID()
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_requests
       (id, company_id, user_id, deduction_type, name, status, requested_total, file_name)
     VALUES ($1, $2, $3, 'rut', 'RUT 2026-10', $4, 3750, 'rut.xml')`,
    [requestId, c.companyId, c.userId, status],
  )
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_request_items (request_id, invoice_id, requested_amount)
     VALUES ($1, $2, 3750)`,
    [requestId, c.invoiceId],
  )
  return requestId
}

describe('rot_rut_reclassification voucher (migration 20261015001000)', () => {
  it('accepts the source type and allows exactly one live voucher per invoice', async () => {
    const c = await seedCase()
    const results = await Promise.allSettled([insertVoucher(c, 3750, c.invoiceId, 11), insertVoucher(c, 3750, c.invoiceId, 12)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(rejected.reason)).toMatch(/journal_entries_rot_rut_reclassification_live_unique/)
    // Another invoice is not blocked.
    await expect(insertVoucher(c, 3750, randomUUID(), 13)).resolves.toBeTruthy()
  })
})

describe('apply_migrated_invoice_deduction', () => {
  it('writes the deduction once; a buyer who paid their whole share makes the invoice paid on that day', async () => {
    const c = await seedCase({ paid: 6250 })
    const voucherId = await insertVoucher(c)

    const first = await asService((client) =>
      apply(client, c, { expected: expected(c, { paid_amount: 6250 }), journalEntryId: voucherId }),
    )
    expect(first).toMatchObject({ ok: true, applied: true, status: 'paid', remaining_amount: 0 })

    const invoice = await readInvoice(c.invoiceId)
    expect(invoice.status).toBe('paid')
    expect(Number(invoice.remaining_amount)).toBe(0)
    expect(Number(invoice.deduction_total)).toBe(3750)
    expect(invoice.deduction_personnummer_last4).toBe('1234')
    expect(invoice.paid_at?.toISOString()).toBe('2026-09-01T12:00:00.000Z')

    const items = await readItems(c.invoiceId)
    expect(items[0]).toMatchObject({ deduction_type: 'rut', work_type: 'STAD' })
    expect(Number(items[0].deduction_amount)).toBe(3750)
    expect(Number(items[0].labor_hours)).toBe(12)
    // The material and text rows carry no deduction.
    expect(items[1].deduction_type).toBeNull()
    expect(items[2].deduction_type).toBeNull()

    const events = await readEvents(c.invoiceId)
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      action: 'applied',
      provider: 'visma',
      journal_entry_id: voucherId,
      deduction_type: 'rut',
      status_before: 'sent',
      status_after: 'paid',
    })
    expect(JSON.stringify(events[0].payload)).not.toMatch(/aabbccddeeff|1234/)
    expect(events[0].actor).toEqual({ type: 'system', id: 'migrated-deduction' })

    // Idempotent: the same voucher again is a no-op, not a second write.
    const second = await asService((client) =>
      apply(client, c, { expected: expected(c, { paid_amount: 6250 }), journalEntryId: voucherId }),
    )
    expect(second).toMatchObject({ ok: true, applied: false })
    expect(await readEvents(c.invoiceId)).toHaveLength(1)
  })

  it('a part payment becomes partially_paid; nothing paid keeps the status', async () => {
    const part = await seedCase({ paid: 1000 })
    const partVoucher = await insertVoucher(part)
    expect(
      await asService((client) =>
        apply(client, part, { expected: expected(part, { paid_amount: 1000 }), journalEntryId: partVoucher }),
      ),
    ).toMatchObject({ ok: true, applied: true, status: 'partially_paid', remaining_amount: 5250 })
    expect((await readInvoice(part.invoiceId)).paid_at).toBeNull()

    const unpaid = await seedCase({ status: 'overdue' })
    const unpaidVoucher = await insertVoucher(unpaid)
    expect(
      await asService((client) =>
        apply(client, unpaid, { expected: expected(unpaid, { status: 'overdue' }), journalEntryId: unpaidVoucher }),
      ),
    ).toMatchObject({ ok: true, applied: true, status: 'overdue', remaining_amount: 6250 })
  })

  it('a dry run checks everything but the voucher and writes nothing', async () => {
    const c = await seedCase()
    expect(await asService((client) => apply(client, c, { dryRun: true }))).toMatchObject({
      ok: true,
      applied: false,
      status: 'sent',
      remaining_amount: 6250,
    })
    expect(Number((await readInvoice(c.invoiceId)).deduction_total)).toBe(0)
    expect(await readEvents(c.invoiceId)).toHaveLength(0)
  })

  it('refuses any drift from the state the preview saw', async () => {
    const c = await seedCase({ paid: 1000 })
    const voucherId = await insertVoucher(c)
    const base = expected(c, { paid_amount: 1000 })
    for (const drift of [
      { paid_amount: 0 },
      { status: 'overdue' },
      { total: 9000 },
      { payment_count: 1 },
      { item_count: 2 },
    ]) {
      expect(
        await asService((client) => apply(client, c, { expected: { ...base, ...drift }, journalEntryId: voucherId })),
      ).toEqual({ ok: false, code: 'DRIFT' })
    }
    expect(Number((await readInvoice(c.invoiceId)).deduction_total)).toBe(0)
  })

  it('refuses a voucher that did not move exactly this deduction', async () => {
    const c = await seedCase()
    const wrongAmount = await insertVoucher(c, 3000)
    expect(await asService((client) => apply(client, c, { journalEntryId: wrongAmount }))).toEqual({
      ok: false,
      code: 'VOUCHER_INVALID',
    })
    const other = await seedCase()
    const othersVoucher = await insertVoucher(other)
    expect(await asService((client) => apply(client, c, { journalEntryId: othersVoucher }))).toEqual({
      ok: false,
      code: 'VOUCHER_INVALID',
    })
    expect(await asService((client) => apply(client, c, { journalEntryId: null }))).toEqual({
      ok: false,
      code: 'VOUCHER_INVALID',
    })
  })

  it('refuses rows that are not this invoice\'s unchanged work rows', async () => {
    const c = await seedCase()
    const other = await seedCase()
    const row = deduction(c).items[0]
    for (const items of [
      [{ ...row, id: other.workItemId }],
      [{ ...row, id: c.textItemId, line_total: 0, vat_amount: 0, deduction_amount: 0 }],
      [{ ...row, line_total: 5000 }],
      [row, row],
    ]) {
      expect(await asService((client) => apply(client, c, { deduction: deduction(c, { items }), dryRun: true }))).toEqual({
        ok: false,
        code: 'ITEMS_MISMATCH',
      })
    }
  })

  it('refuses a deduction that is not whole kronor, does not add up, or exceeds what is still open', async () => {
    const c = await seedCase({ paid: 7000 })
    const row = deduction(c).items[0]
    const base = expected(c, { paid_amount: 7000 })
    expect(
      await asService((client) =>
        apply(client, c, {
          expected: base,
          deduction: deduction(c, { deduction_total: 3750.5, items: [{ ...row, deduction_amount: 3750.5 }] }),
          dryRun: true,
        }),
      ),
    ).toEqual({ ok: false, code: 'DEDUCTION_INVALID' })
    expect(
      await asService((client) =>
        apply(client, c, { expected: base, deduction: deduction(c, { deduction_total: 3000 }), dryRun: true }),
      ),
    ).toEqual({ ok: false, code: 'DEDUCTION_INVALID' })
    // 10 000 - 7 000 paid leaves 3 000 open: a 3 750 deduction cannot fit.
    expect(await asService((client) => apply(client, c, { expected: base, dryRun: true }))).toEqual({
      ok: false,
      code: 'DEDUCTION_EXCEEDS_REMAINING',
    })
  })

  it('refuses a held invoice, a foreign currency, a missing personnummer and a missing payment date', async () => {
    const held = await seedCase()
    await holdInRequest(held)
    expect(await asService((client) => apply(client, held, { dryRun: true }))).toEqual({
      ok: false,
      code: 'HELD_BY_REQUEST',
    })

    const eur = await seedCase({ currency: 'EUR' })
    expect(await asService((client) => apply(client, eur, { dryRun: true }))).toEqual({ ok: false, code: 'CURRENCY' })

    const c = await seedCase()
    expect(
      await asService((client) => apply(client, c, { deduction: deduction(c, { personnummer_last4: '' }), dryRun: true })),
    ).toEqual({ ok: false, code: 'PERSONNUMMER_MISSING' })

    const fullyPaid = await seedCase({ paid: 6250 })
    expect(
      await asService((client) =>
        apply(client, fullyPaid, {
          expected: expected(fullyPaid, { paid_amount: 6250 }),
          deduction: deduction(fullyPaid, { paid_on: null }),
          dryRun: true,
        }),
      ),
    ).toEqual({ ok: false, code: 'PAYMENT_DATE_MISSING' })
  })

  it('answers FORBIDDEN to a user outside the company and runs for a member', async () => {
    const c = await seedCase()
    const outsider = await insertAuthUser()
    expect(await withUserContext(outsider, (client) => apply(client, c, { dryRun: true }))).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await withUserContext(c.userId, (client) => apply(client, c, { dryRun: true }))).toMatchObject({ ok: true })
  })

  it('status-only mode moves a part-paid import from sent to partially_paid, once', async () => {
    const c = await seedCase({ paid: 1000 })
    const base = expected(c, { paid_amount: 1000 })
    expect(await asService((client) => apply(client, c, { expected: base, deduction: null }))).toMatchObject({
      ok: true,
      applied: true,
      status: 'partially_paid',
      remaining_amount: 9000,
    })
    const invoice = await readInvoice(c.invoiceId)
    expect(invoice.status).toBe('partially_paid')
    expect(Number(invoice.deduction_total)).toBe(0)
    expect((await readEvents(c.invoiceId))[0].payload).toMatchObject({ action: 'status_repaired' })

    expect(
      await asService((client) =>
        apply(client, c, { expected: { ...base, status: 'partially_paid' }, deduction: null }),
      ),
    ).toMatchObject({ ok: true, applied: false })

    const unpaid = await seedCase()
    expect(await asService((client) => apply(client, unpaid, { deduction: null }))).toEqual({
      ok: false,
      code: 'STATUS_NOT_REPAIRABLE',
    })
  })
})

describe('revert_migrated_invoice_deduction', () => {
  async function revert(c: Case, voucherId: string, checkOnly = false): Promise<Result> {
    return asService(async (client) => {
      const { rows } = await client.query<{ r: Result }>(
        `SELECT public.revert_migrated_invoice_deduction($1, $2, $3, $4) AS r`,
        [c.companyId, c.invoiceId, voucherId, checkOnly],
      )
      return rows[0].r
    })
  }

  it('refuses while a begäran holds the invoice, then reverts once the voucher is reversed', async () => {
    const c = await seedCase({ paid: 6250 })
    const voucherId = await insertVoucher(c)
    await asService((client) => apply(client, c, { expected: expected(c, { paid_amount: 6250 }), journalEntryId: voucherId }))

    expect(await revert(c, voucherId, true)).toMatchObject({ ok: true, reverted: false })
    const requestId = await holdInRequest(c)
    expect(await revert(c, voucherId, true)).toEqual({ ok: false, code: 'HELD_BY_REQUEST' })
    await getPool().query(`UPDATE public.rot_rut_payout_requests SET status = 'cancelled' WHERE id = $1`, [requestId])

    // Not reversed yet: the write mode needs the storno to stand.
    expect(await revert(c, voucherId)).toEqual({ ok: false, code: 'VOUCHER_INVALID' })

    await storno(c, voucherId, 2)
    expect(await revert(c, voucherId)).toMatchObject({
      ok: true,
      reverted: true,
      status: 'partially_paid',
      remaining_amount: 3750,
    })
    const invoice = await readInvoice(c.invoiceId)
    expect(Number(invoice.deduction_total)).toBe(0)
    expect(invoice.deduction_personnummer_last4).toBeNull()
    expect(invoice.paid_at).toBeNull()
    expect((await readItems(c.invoiceId)).every((item) => item.deduction_type === null)).toBe(true)
    expect((await readEvents(c.invoiceId)).map((e) => e.payload.action)).toEqual(['applied', 'reverted'])

    expect(await revert(c, voucherId)).toMatchObject({ ok: true, reverted: false })
  })
})
