import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260928150100_supplier_invoice_items_not_payable_account and
 * 20260928150200_repair_supplier_invoice_counter_items.
 *
 * The provider migration stored a Visma or Fortnox supplier invoice's
 * registration voucher rows as its rows, the 2440 payable among them. Every
 * booking path debits each row and writes the payable leg itself, so a
 * kontantmetod payment booked the payable twice. The constraint keeps any
 * writer from storing a 244x row again; the repair takes the ones already
 * stored out, one company per call, without touching a journal entry.
 */

interface PgError extends Error {
  code?: string
  constraint?: string
}

const CONSTRAINT = 'supplier_invoice_items_not_payable_account'
const SIGNATURE = 'public.repair_supplier_invoice_counter_items(uuid, boolean, boolean, jsonb, uuid)'
const ACTOR = { type: 'user', id: randomUUID(), label: 'pg-real' }

/** [account, line_total, vat_rate] as the old importer stored them. */
type Row = [string, number, number?]

interface RepairRow {
  supplier_invoice_id: string
  invoice_status: string
  currency: string
  total: string
  payable_rows: number
  other_rows_total: string
  outcome: string
  selected: boolean
  repaired: boolean
}

let arrival = 1

async function supplierInvoice(params: {
  companyId: string
  userId: string
  total: number
  subtotal?: number
  vatAmount?: number
  status?: string
  creditedInvoiceId?: string
  isCreditNote?: boolean
}): Promise<string> {
  const supplierId = randomUUID()
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Leverantör AB')`,
    [supplierId, params.userId, params.companyId],
  )
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, status, subtotal, vat_amount, total, remaining_amount,
        is_credit_note, credited_invoice_id)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-06-01', '2026-06-30', $7, $8, $9, $10, $10, $11, $12)`,
    [
      invoiceId, params.userId, params.companyId, supplierId, arrival++, `F-${invoiceId.slice(0, 8)}`,
      params.status ?? 'registered', params.subtotal ?? params.total, params.vatAmount ?? 0, params.total,
      params.isCreditNote ?? false, params.creditedInvoiceId ?? null,
    ],
  )
  return invoiceId
}

// Rows stored before the constraint existed. The constraint refuses a 244x
// row on INSERT, so the seed drops it for exactly this statement and re-adds
// it NOT VALID from its own catalog definition, comment included, inside one
// transaction (the journal-entry-lines-single-side suite does the same).
async function legacyRows(invoiceId: string, rows: Row[]): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const def = await client.query<{ def: string; comment: string | null }>(
      `SELECT pg_get_constraintdef(oid) AS def, obj_description(oid, 'pg_constraint') AS comment
         FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'public.supplier_invoice_items'::regclass`,
      [CONSTRAINT],
    )
    const definition = def.rows[0]?.def
    if (!definition) throw new Error(`${CONSTRAINT} is missing: did the migration apply?`)
    await client.query(`ALTER TABLE public.supplier_invoice_items DROP CONSTRAINT ${CONSTRAINT}`)
    for (const [index, [account, lineTotal, vatRate]] of rows.entries()) {
      await client.query(
        `INSERT INTO public.supplier_invoice_items
           (supplier_invoice_id, sort_order, description, quantity, unit, unit_price,
            line_total, account_number, vat_rate, vat_amount)
         VALUES ($1, $2, $3, 1, 'st', $4, $4, $5, $6, 0)`,
        [invoiceId, index + 1, `Rad ${index + 1}`, lineTotal, account, vatRate ?? 0],
      )
    }
    await client.query(
      `ALTER TABLE public.supplier_invoice_items ADD CONSTRAINT ${CONSTRAINT} ${
        definition.includes('NOT VALID') ? definition : `${definition} NOT VALID`
      }`,
    )
    const comment = def.rows[0]?.comment
    if (comment) {
      await client.query(`SELECT set_config('pgtest.counter_rows_comment', $1, true)`, [comment])
      await client.query(
        `DO $do$
         BEGIN
           EXECUTE format(
             'COMMENT ON CONSTRAINT ${CONSTRAINT} ON public.supplier_invoice_items IS %L',
             current_setting('pgtest.counter_rows_comment')
           );
         END
         $do$`,
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function rowsOf(invoiceId: string): Promise<Row[]> {
  const { rows } = await getPool().query<{ account_number: string; line_total: string; vat_rate: string }>(
    `SELECT account_number, line_total, vat_rate FROM public.supplier_invoice_items
      WHERE supplier_invoice_id = $1 ORDER BY sort_order, id`,
    [invoiceId],
  )
  return rows.map((r) => [r.account_number, Number(r.line_total), Number(r.vat_rate)])
}

function repair(
  client: PoolClient,
  params: { companyId: string | null; dryRun?: boolean; clear?: boolean; actor?: object | null; correlationId?: string },
): Promise<RepairRow[]> {
  return client
    .query<RepairRow>(
      `SELECT * FROM public.repair_supplier_invoice_counter_items($1, $2, $3, $4::jsonb, $5)`,
      [
        params.companyId,
        params.dryRun ?? true,
        params.clear ?? false,
        params.actor === undefined ? JSON.stringify(ACTOR) : params.actor === null ? null : JSON.stringify(params.actor),
        params.correlationId ?? null,
      ],
    )
    .then((r) => r.rows)
}

async function ledgerFingerprint(companyId: string): Promise<string> {
  const { rows } = await getPool().query<{ fp: string | null }>(
    `SELECT md5(string_agg(je.id::text || je.status || l.account_number || l.debit_amount::text || l.credit_amount::text,
                           ',' ORDER BY je.id, l.id)) AS fp
       FROM public.journal_entries je JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
      WHERE je.company_id = $1`,
    [companyId],
  )
  return rows[0]?.fp ?? ''
}

async function captureError(promise: Promise<unknown>): Promise<PgError | null> {
  return promise.then(
    () => null,
    (e: PgError) => e,
  )
}

describe('supplier_invoice_items_not_payable_account', () => {
  it('is a CHECK on supplier_invoice_items, added NOT VALID, commented', async () => {
    const { rows } = await getPool().query<{ def: string; convalidated: boolean; comment: string | null }>(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated, obj_description(oid, 'pg_constraint') AS comment
         FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'public.supplier_invoice_items'::regclass`,
      [CONSTRAINT],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].def).toContain('^244')
    expect(rows[0].convalidated).toBe(false)
    expect(rows[0].comment).toContain('leverantörsskulder')
  })

  it('refuses a payable row from any writer, on insert and on update, and keeps VAT rows legal', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await supplierInvoice({ companyId, userId, total: 1250 })
    const insert = (account: string, amount: number) =>
      getPool().query(
        `INSERT INTO public.supplier_invoice_items (supplier_invoice_id, description, account_number, line_total, vat_rate)
         VALUES ($1, 'Rad', $2, $3, 0) RETURNING id`,
        [invoiceId, account, amount],
      )

    for (const account of ['2440', '2441', '2448']) {
      const err = await captureError(insert(account, 1250))
      expect(err?.code, account).toBe('23514')
      expect(err?.constraint, account).toBe(CONSTRAINT)
    }
    // The kontering and a VAT row of its own stay writable: an agent puts
    // its VAT on a 2641 line, and imported rows keep the source's VAT there.
    const cost = await insert('6530', 1000)
    await insert('2641', 250)
    const moved = await captureError(
      getPool().query(`UPDATE public.supplier_invoice_items SET account_number = '2440' WHERE id = $1`, [cost.rows[0].id]),
    )
    expect(moved?.code).toBe('23514')
  })
})

describe('repair_supplier_invoice_counter_items', () => {
  it('lists by default, then removes the payable row and the stale rates with a reversible record, and never touches the ledger', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    // A ledger entry of the company's own, to prove the repair leaves it be.
    await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    // Visma rows as imported: no sides, the old 25 % default on every row.
    const visma = await supplierInvoice({ companyId, userId, total: 1250 })
    await legacyRows(visma, [['6530', 1000, 0.25], ['2641', 250, 0.25], ['2440', 1250, 0.25]])
    // Fortnox rows as imported: signed, the payable as a credit.
    const fortnox = await supplierInvoice({ companyId, userId, total: 500 })
    await legacyRows(fortnox, [['2440', -500], ['2641', 100], ['5420', 400]])
    const before = await ledgerFingerprint(companyId)

    const dry = await runAsServiceRole((c) => repair(c, { companyId }))
    expect(dry.map((r) => [r.supplier_invoice_id, r.outcome, r.payable_rows, Number(r.other_rows_total), r.selected, r.repaired]))
      .toEqual(expect.arrayContaining([
        [visma, 'exact', 1, 1250, true, false],
        [fortnox, 'exact', 1, 500, true, false],
      ]))
    expect(dry).toHaveLength(2)
    expect(await rowsOf(visma)).toHaveLength(3)

    const correlationId = randomUUID()
    const written = await runAsServiceRole((c) => repair(c, { companyId, dryRun: false, correlationId }))
    expect(written.every((r) => r.repaired)).toBe(true)
    expect(await rowsOf(visma)).toEqual([['6530', 1000, 0], ['2641', 250, 0]])
    expect(await rowsOf(fortnox)).toEqual([['2641', 100, 0], ['5420', 400, 0]])
    expect(await ledgerFingerprint(companyId)).toBe(before)

    const { rows: history } = await getPool().query<{
      aggregate_type: string
      correlation_id: string
      payload: { rule: string; total: number; before: Record<string, unknown>[]; after: Record<string, unknown>[] }
      actor: { type: string }
    }>(
      `SELECT aggregate_type, correlation_id, payload, actor FROM public.processing_history
        WHERE event_type = 'SupplierInvoiceCounterRowsRepaired' AND aggregate_id = $1`,
      [visma],
    )
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ aggregate_type: 'SupplierInvoice', correlation_id: correlationId, actor: { type: 'user' } })
    expect(history[0].payload.rule).toBe('exact')
    expect(history[0].payload.before.map((r) => [r.account_number, r.line_total, r.vat_rate]))
      .toEqual([['6530', 1000, 0.25], ['2641', 250, 0.25], ['2440', 1250, 0.25]])
    expect(history[0].payload.after.map((r) => [r.account_number, r.line_total, r.vat_rate]))
      .toEqual([['6530', 1000, 0], ['2641', 250, 0]])
    // Free text never reaches processing_history.
    expect(history[0].payload.before[0]).not.toHaveProperty('description')

    // Idempotent: nothing left to find.
    expect(await runAsServiceRole((c) => repair(c, { companyId, dryRun: false }))).toEqual([])
  })

  it('turns an öresavrundning credit imported without its side back into a credit', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await supplierInvoice({ companyId, userId, total: 899 })
    // 719.52 + 179.88 - 0.40 = 899; the 3740 row was stored as +0.40.
    await legacyRows(invoiceId, [['2440', 899], ['3740', 0.40], ['4000', 719.52], ['2641', 179.88]])

    const [row] = await runAsServiceRole((c) => repair(c, { companyId, dryRun: false }))
    expect(row).toMatchObject({ outcome: 'rounding_flipped', repaired: true })
    expect(await rowsOf(invoiceId)).toEqual([['3740', -0.40, 0], ['4000', 719.52, 0], ['2641', 179.88, 0]])
  })

  it('reports rows that cannot be trusted, and removes them only when asked to', async () => {
    const { userId, companyId } = await seedCompany()
    // A reverse-charge pair imported without its sides: 2614 reads as a debit.
    const invoiceId = await supplierInvoice({ companyId, userId, total: 1840 })
    await legacyRows(invoiceId, [['2440', 1840], ['5420', 1840], ['2645', 460], ['2614', 460]])

    const listed = await runAsServiceRole((c) => repair(c, { companyId, dryRun: false }))
    expect(listed).toEqual([expect.objectContaining({ outcome: 'unreconciled', selected: false, repaired: false })])
    expect(await rowsOf(invoiceId)).toHaveLength(4)

    const cleared = await runAsServiceRole((c) => repair(c, { companyId, dryRun: false, clear: true }))
    expect(cleared).toEqual([expect.objectContaining({ outcome: 'unreconciled', selected: true, repaired: true })])
    expect(await rowsOf(invoiceId)).toEqual([])
    const { rows } = await getPool().query<{ payload: { rule: string; after: unknown[]; before: unknown[] } }>(
      `SELECT payload FROM public.processing_history
        WHERE event_type = 'SupplierInvoiceCounterRowsRepaired' AND aggregate_id = $1`,
      [invoiceId],
    )
    expect(rows.map((r) => [r.payload.rule, r.payload.before.length, r.payload.after.length])).toEqual([['unreconciled', 4, 0]])
  })

  it('never writes the rows of an invoice a verifikat was built from, nor of one that states VAT', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    // Paid under kontantmetoden from its rows: the damaged entry is a human's
    // decision (storno), and the rows it was built from stay as they are.
    const paid = await supplierInvoice({ companyId, userId, total: 1250, status: 'paid' })
    await legacyRows(paid, [['6530', 1000], ['2641', 250], ['2440', 1250]])
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, sourceType: 'supplier_invoice_cash_payment', sourceId: paid,
      lines: [
        { accountNumber: '6530', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '2641', debitAmount: 250, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 2500 },
      ],
    })
    // Credited in-app: the credit note's verifikat was built from the
    // original's rows.
    const credited = await supplierInvoice({ companyId, userId, total: 500, status: 'credited' })
    await legacyRows(credited, [['2440', -500], ['5420', 500]])
    const creditNote = await supplierInvoice({
      companyId, userId, total: 500, status: 'credited', isCreditNote: true, creditedInvoiceId: credited,
    })
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 2, sourceType: 'supplier_credit_note', sourceId: creditNote,
      lines: [
        { accountNumber: '2440', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '5420', debitAmount: 0, creditAmount: 500 },
      ],
    })
    // VAT on the header: not the shape the migration wrote.
    const stated = await supplierInvoice({ companyId, userId, total: 1250, subtotal: 1000, vatAmount: 250 })
    await legacyRows(stated, [['6530', 1000, 0.25], ['2440', 1250]])
    const before = await ledgerFingerprint(companyId)

    const rows = await runAsServiceRole((c) => repair(c, { companyId, dryRun: false, clear: true }))
    expect(Object.fromEntries(rows.map((r) => [r.supplier_invoice_id, [r.outcome, r.selected, r.repaired]]))).toEqual({
      [paid]: ['skipped_voucher', false, false],
      [credited]: ['skipped_voucher', false, false],
      [stated]: ['skipped_vat', false, false],
    })
    expect(await rowsOf(paid)).toHaveLength(3)
    expect(await rowsOf(credited)).toHaveLength(2)
    expect(await rowsOf(stated)).toHaveLength(2)
    expect(await ledgerFingerprint(companyId)).toBe(before)
  })

  it('only ever sees the named company', async () => {
    const own = await seedCompany()
    const other = await seedCompany()
    const theirs = await supplierInvoice({ companyId: other.companyId, userId: other.userId, total: 100 })
    await legacyRows(theirs, [['2440', 100], ['5420', 100]])

    expect(await runAsServiceRole((c) => repair(c, { companyId: own.companyId, dryRun: false }))).toEqual([])
    expect(await rowsOf(theirs)).toHaveLength(2)
  })

  it('refuses a call without a company and a write without an actor', async () => {
    const { companyId } = await seedCompany()
    const noCompany = await runAsServiceRole((c) => captureError(repair(c, { companyId: null })))
    expect(noCompany?.code).toBe('22023')
    const noActor = await runAsServiceRole((c) => captureError(repair(c, { companyId, dryRun: false, actor: null })))
    expect(noActor?.code).toBe('22023')
  })

  it('is executable by service_role only', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query<{ role: string; can: boolean }>(
      `SELECT r AS role, has_function_privilege(r, '${SIGNATURE}', 'EXECUTE') AS can
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`,
    )
    expect(Object.fromEntries(rows.map((r) => [r.role, r.can]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    })
    const denied = await withUserContext(userId, (c) => captureError(repair(c, { companyId })))
    expect(denied?.code).toBe('42501')
  })
})
