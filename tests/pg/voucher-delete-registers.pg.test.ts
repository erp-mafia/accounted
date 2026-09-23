import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompanyMember,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'

// delete_last_voucher (migration 20260920190000): a register row whose state
// asserts that a verifikat exists must not outlive that verifikat.
//
// expense_claims.journal_entry_id, supplier_invoice_payments.journal_entry_id
// and supplier_invoices.payment_journal_entry_id are all ON DELETE SET NULL.
// Deleting the voucher therefore used to "forget" the link and leave the row
// standing: a paid invoice that was never booked, a payment row with nothing
// behind it, an utlägg debt to the owner with no verifikat. The registers are
// found by those FK columns, never by the entry's source_type, because one
// verifikat can back several registers while source_type names only one.

type Seed = Awaited<ReturnType<typeof seedCompany>>

async function insertSupplier(seed: Seed): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Kiosken AB')`,
    [id, seed.userId, seed.companyId],
  )
  return id
}

/**
 * Due dates are relative to the database clock: the revert picks 'overdue'
 * from CURRENT_DATE, so a literal date would flip the expected status the day
 * it passes.
 */
async function insertSupplierInvoice(
  seed: Seed,
  supplierId: string,
  params: {
    total: number
    paidAmount: number
    status: string
    paidPrivately?: boolean
    approved?: boolean
    dueInDays?: number
    paymentEntryId?: string | null
  },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, subtotal, vat_amount, total,
        paid_amount, remaining_amount, status, paid_at, paid_with_private_funds,
        approved_at, payment_journal_entry_id)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5,
             CURRENT_DATE - 10, CURRENT_DATE + $6::int, $7, 0, $7,
             $8::numeric, $9, $10, CASE WHEN $8::numeric > 0 THEN now() ELSE NULL END, $11,
             CASE WHEN $12 THEN now() ELSE NULL END, $13)`,
    [
      id,
      seed.userId,
      seed.companyId,
      supplierId,
      `F-${id.slice(0, 8)}`,
      params.dueInDays ?? 30,
      params.total,
      params.paidAmount,
      Math.round((params.total - params.paidAmount) * 100) / 100,
      params.status,
      params.paidPrivately ?? false,
      params.approved ?? false,
      params.paymentEntryId ?? null,
    ],
  )
  return id
}

async function insertSupplierPayment(
  seed: Seed,
  invoiceId: string,
  entryId: string,
  amount: number,
  transactionId: string | null = null,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoice_payments
       (id, user_id, company_id, supplier_invoice_id, payment_date, amount, journal_entry_id, transaction_id)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7)`,
    [id, seed.userId, seed.companyId, invoiceId, amount, entryId, transactionId],
  )
  return id
}

async function insertClaim(seed: Seed, amount: number): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.expense_claims
       (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account)
     VALUES ($1, $2, $3, 'Ägare', 'Kvitto kiosken', CURRENT_DATE - 10, $4, 0, '5410')`,
    [id, seed.companyId, seed.userId, amount],
  )
  return id
}

async function insertDocument(seed: Seed, entryId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, journal_entry_id, file_name, mime_type,
        file_size_bytes, storage_path, sha256_hash, upload_source, is_current_version)
     VALUES ($1, $2, $3, $4, 'kvitto.pdf', 'application/pdf', 1024, $5, $6, 'file_upload', true)`,
    [id, seed.userId, seed.companyId, entryId, `docs/${id}.pdf`, id.replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

function deleteVoucher(client: PoolClient, seed: Seed, entryId: string) {
  return client.query<{ result: Record<string, unknown> }>(
    `SELECT public.delete_last_voucher($1, $2) AS result`,
    [seed.companyId, entryId],
  )
}

async function invoiceState(client: PoolClient, invoiceId: string) {
  const { rows } = await client.query(
    `SELECT status, paid_amount::float8 AS paid_amount, remaining_amount::float8 AS remaining_amount,
            paid_at IS NOT NULL AS has_paid_at, payment_journal_entry_id, paid_with_private_funds
       FROM public.supplier_invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]
}

async function count(client: PoolClient, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`, params)
  return Number(rows[0].n)
}

const UNPAID = {
  paid_amount: 0,
  has_paid_at: false,
  payment_journal_entry_id: null,
  paid_with_private_funds: false,
}

/**
 * The state POST /api/supplier-invoices leaves behind for
 * paid_with_private_funds: ONE verifikat (source_type 'expense_claim') backing
 * THREE registers: the utlägg, the invoice's payment row, and the invoice's own
 * paid state. Plus the inbox item it was created from and its receipt.
 */
async function seedPrivatelyPaidSupplierInvoice(opts: { dueInDays?: number } = {}) {
  const seed = await seedCompany()
  const supplierId = await insertSupplier(seed)
  const claimId = await insertClaim(seed, 40)
  const entryId = await insertPostedJournalEntry({
    ...seed,
    voucherSeries: 'A',
    voucherNumber: 1,
    sourceType: 'expense_claim',
    sourceId: claimId,
  })
  await getPool().query(`UPDATE public.expense_claims SET journal_entry_id = $1 WHERE id = $2`, [entryId, claimId])

  const invoiceId = await insertSupplierInvoice(seed, supplierId, {
    total: 40,
    paidAmount: 40,
    status: 'paid',
    paidPrivately: true,
    paymentEntryId: entryId,
    dueInDays: opts.dueInDays,
  })
  const paymentId = await insertSupplierPayment(seed, invoiceId, entryId, 40)
  const documentId = await insertDocument(seed, entryId)
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.invoice_inbox_items
       (company_id, user_id, source, status, document_id, created_journal_entry_id, created_supplier_invoice_id)
     VALUES ($1, $2, 'upload', 'received', $3, $4, $5)
     RETURNING id`,
    [seed.companyId, seed.userId, documentId, entryId, invoiceId],
  )
  return { seed, claimId, entryId, invoiceId, paymentId, documentId, inboxItemId: rows[0].id }
}

describe('delete_last_voucher: a privately paid supplier invoice (one verifikat, three registers)', () => {
  // The support case of 2026-09-20: register a receipt as a privately paid
  // supplier invoice, then delete its verifikat. Before this migration the
  // invoice stayed 'paid', the payment row and the utlägg both survived with a
  // NULL journal_entry_id, and none of the three could be removed by the user.
  it('leaves no phantom paid invoice, payment row or utlägg behind', async () => {
    const s = await seedPrivatelyPaidSupplierInvoice()

    const state = await withUserContext(s.seed.userId, async (client) => {
      await deleteVoucher(client, s.seed, s.entryId)
      return {
        invoice: await invoiceState(client, s.invoiceId),
        entries: await count(client, `public.journal_entries WHERE id = $1`, [s.entryId]),
        payments: await count(client, `public.supplier_invoice_payments WHERE supplier_invoice_id = $1`, [s.invoiceId]),
        claims: await count(client, `public.expense_claims WHERE id = $1`, [s.claimId]),
      }
    })

    expect(state.entries).toBe(0)
    // An ordinary unpaid, unbooked invoice again: the one shape the
    // supplier-invoice DELETE route and its "Ta bort" menu item accept.
    // 'registered', not 'approved': nobody ever attested this invoice.
    expect(state.invoice).toEqual({ ...UNPAID, status: 'registered', remaining_amount: 40 })
    expect(state.payments).toBe(0)
    expect(state.claims).toBe(0)
  })

  // What the customer actually wants: "this registration was a mistake, make
  // it go away", and then book the receipt the right way. Nothing here is new
  // code: once the invoice is unpaid with no payment row it is deletable, and
  // the FKs release the inbox item. The receipt is never deleted.
  it('lets the invoice be deleted afterwards, releasing the inbox item and keeping the receipt', async () => {
    const s = await seedPrivatelyPaidSupplierInvoice()

    const state = await withUserContext(s.seed.userId, async (client) => {
      await deleteVoucher(client, s.seed, s.entryId)
      const afterVoucher = await client.query(
        `SELECT created_journal_entry_id, created_supplier_invoice_id FROM public.invoice_inbox_items WHERE id = $1`,
        [s.inboxItemId],
      )
      await client.query(`DELETE FROM public.supplier_invoices WHERE id = $1 AND company_id = $2`, [
        s.invoiceId,
        s.seed.companyId,
      ])
      const afterInvoice = await client.query(
        `SELECT created_journal_entry_id, created_supplier_invoice_id, document_id
           FROM public.invoice_inbox_items WHERE id = $1`,
        [s.inboxItemId],
      )
      const document = await client.query(
        `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
        [s.documentId],
      )
      return { afterVoucher: afterVoucher.rows[0], afterInvoice: afterInvoice.rows[0], document: document.rows }
    })

    // While the invoice exists the item stays tied to it, so a second invoice
    // cannot be created from the same item.
    expect(state.afterVoucher).toEqual({
      created_journal_entry_id: null,
      created_supplier_invoice_id: s.invoiceId,
    })
    // Both links NULL is "unprocessed": bookable again, as a kvitto this time.
    expect(state.afterInvoice).toEqual({
      created_journal_entry_id: null,
      created_supplier_invoice_id: null,
      document_id: s.documentId,
    })
    expect(state.document).toEqual([{ journal_entry_id: null }])
  })

  it('reverts a past-due invoice to overdue, as the daily cron would', async () => {
    const s = await seedPrivatelyPaidSupplierInvoice({ dueInDays: -5 })

    const invoice = await withUserContext(s.seed.userId, async (client) => {
      await deleteVoucher(client, s.seed, s.entryId)
      return invoiceState(client, s.invoiceId)
    })

    expect(invoice).toEqual({ ...UNPAID, status: 'overdue', remaining_amount: 40 })
  })
})

describe('delete_last_voucher: refuses before deleting when the utlägg carries payout state', () => {
  // The route could only log this after the RPC had committed, leaving a PAID
  // claim with no verifikat. Refusing here keeps all three registers and the
  // verifikat exactly as they were.
  it('refuses when the utlägg is on a payout batch, and changes nothing', async () => {
    const s = await seedPrivatelyPaidSupplierInvoice()
    const batchId = randomUUID()
    await getPool().query(
      `INSERT INTO public.expense_payout_batches
         (id, company_id, user_id, claimant_name, payout_date, cash_account, liability_account, total_sek)
       VALUES ($1, $2, $3, 'Ägare', CURRENT_DATE, '1930', '2018', 40)`,
      [batchId, s.seed.companyId, s.seed.userId],
    )
    await getPool().query(
      `UPDATE public.expense_claims SET payout_batch_id = $1, status = 'paid' WHERE id = $2`,
      [batchId, s.claimId],
    )

    await expect(
      withUserContext(s.seed.userId, (client) => deleteVoucher(client, s.seed, s.entryId)),
    ).rejects.toThrow(/utlägget är redan utbetalt/)

    const pool = getPool()
    const entry = await pool.query(`SELECT status FROM public.journal_entries WHERE id = $1`, [s.entryId])
    const invoice = await pool.query(`SELECT status, payment_journal_entry_id FROM public.supplier_invoices WHERE id = $1`, [s.invoiceId])
    const payment = await pool.query(`SELECT journal_entry_id FROM public.supplier_invoice_payments WHERE id = $1`, [s.paymentId])
    const claim = await pool.query(`SELECT status, journal_entry_id FROM public.expense_claims WHERE id = $1`, [s.claimId])
    expect(entry.rows).toEqual([{ status: 'posted' }])
    expect(invoice.rows).toEqual([{ status: 'paid', payment_journal_entry_id: s.entryId }])
    expect(payment.rows).toEqual([{ journal_entry_id: s.entryId }])
    expect(claim.rows).toEqual([{ status: 'paid', journal_entry_id: s.entryId }])
  })

  it('refuses when the utlägg is on a payslip line, draft included', async () => {
    const s = await seedPrivatelyPaidSupplierInvoice()
    const pool = getPool()
    const employee = await pool.query<{ id: string }>(
      `INSERT INTO public.employees
         (company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
          employment_type, employment_start, employment_degree, salary_type)
       VALUES ($1, $2, 'Anna', 'Anställd', $3, '1234', 'employee', '2026-01-01', 100, 'monthly')
       RETURNING id`,
      [s.seed.companyId, s.seed.userId, `19900101${String(Math.floor(1000 + Math.random() * 9000))}`],
    )
    const runId = randomUUID()
    await pool.query(
      `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
       VALUES ($1, $2, $3, 2026, 6, '2026-06-25', 'draft')`,
      [runId, s.seed.companyId, s.seed.userId],
    )
    const sre = await pool.query<{ id: string }>(
      `INSERT INTO public.salary_run_employees
         (salary_run_id, employee_id, company_id, employment_degree, monthly_salary, salary_type)
       VALUES ($1, $2, $3, 100, 30000, 'monthly')
       RETURNING id`,
      [runId, employee.rows[0].id, s.seed.companyId],
    )
    await pool.query(
      `INSERT INTO public.salary_line_items
         (salary_run_employee_id, company_id, item_type, description, amount,
          is_taxable, is_avgift_basis, is_vacation_basis, account_number, source_expense_claim_id)
       VALUES ($1, $2, 'expense_reimbursement', 'Utlägg: Kvitto', 40, false, false, false, '2820', $3)`,
      [sre.rows[0].id, s.seed.companyId, s.claimId],
    )

    await expect(
      withUserContext(s.seed.userId, (client) => deleteVoucher(client, s.seed, s.entryId)),
    ).rejects.toThrow(/utlägget ligger på ett lönebesked/)

    const entry = await pool.query(`SELECT status FROM public.journal_entries WHERE id = $1`, [s.entryId])
    expect(entry.rows).toEqual([{ status: 'posted' }])
  })
})

describe('delete_last_voucher: ordinary supplier payment vouchers', () => {
  it('reverts an approved invoice to approved and releases its bank line', async () => {
    const seed = await seedCompany()
    const supplierId = await insertSupplier(seed)
    const invoiceId = await insertSupplierInvoice(seed, supplierId, {
      total: 1500,
      paidAmount: 1500,
      status: 'paid',
      approved: true,
    })
    const entryId = await insertPostedJournalEntry({
      ...seed,
      voucherSeries: 'A',
      voucherNumber: 1,
      sourceType: 'supplier_invoice_paid',
      sourceId: invoiceId,
    })
    await getPool().query(`UPDATE public.supplier_invoices SET payment_journal_entry_id = $1 WHERE id = $2`, [entryId, invoiceId])
    const transactionId = await insertTransaction({ ...seed, amount: -1500, journalEntryId: entryId })
    await getPool().query(
      `UPDATE public.transactions SET supplier_invoice_id = $1, is_business = true, category = 'expense_other' WHERE id = $2`,
      [invoiceId, transactionId],
    )
    await insertSupplierPayment(seed, invoiceId, entryId, 1500, transactionId)

    const state = await withUserContext(seed.userId, async (client) => {
      await deleteVoucher(client, seed, entryId)
      const tx = await client.query(
        `SELECT journal_entry_id, supplier_invoice_id, is_business, category FROM public.transactions WHERE id = $1`,
        [transactionId],
      )
      return { invoice: await invoiceState(client, invoiceId), tx: tx.rows[0] }
    })

    expect(state.invoice).toEqual({ ...UNPAID, status: 'approved', remaining_amount: 1500 })
    // Back in the inbox: the pointer clears by FK, the rest had to be released.
    expect(state.tx).toEqual({ journal_entry_id: null, supplier_invoice_id: null, is_business: null, category: null })
  })

  it('reverts only the deleted payment: an earlier part payment stands', async () => {
    const seed = await seedCompany()
    const supplierId = await insertSupplier(seed)
    const invoiceId = await insertSupplierInvoice(seed, supplierId, {
      total: 1000,
      paidAmount: 1000,
      status: 'paid',
      approved: true,
    })
    const first = await insertPostedJournalEntry({
      ...seed, voucherSeries: 'A', voucherNumber: 1, sourceType: 'supplier_invoice_paid', sourceId: invoiceId,
    })
    const second = await insertPostedJournalEntry({
      ...seed, voucherSeries: 'A', voucherNumber: 2, sourceType: 'supplier_invoice_paid', sourceId: invoiceId,
    })
    await getPool().query(`UPDATE public.supplier_invoices SET payment_journal_entry_id = $1 WHERE id = $2`, [second, invoiceId])
    const firstPayment = await insertSupplierPayment(seed, invoiceId, first, 400)
    await insertSupplierPayment(seed, invoiceId, second, 600)

    const state = await withUserContext(seed.userId, async (client) => {
      await deleteVoucher(client, seed, second)
      const left = await client.query(`SELECT id FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $1`, [invoiceId])
      return { invoice: await invoiceState(client, invoiceId), left: left.rows }
    })

    expect(state.invoice).toMatchObject({ status: 'partially_paid', paid_amount: 400, remaining_amount: 600, has_paid_at: true })
    expect(state.left).toEqual([{ id: firstPayment }])
  })

  // The open finding on PR #2688: match_batch_allocate books ONE entry with
  // source_id NULL and one payment row per invoice. A source_id-keyed sync
  // returned early, so neither invoice was ever restored. Found by FK, both are.
  it('reverts every invoice on a batch voucher', async () => {
    const seed = await seedCompany()
    const supplierId = await insertSupplier(seed)
    const a = await insertSupplierInvoice(seed, supplierId, { total: 300, paidAmount: 300, status: 'paid', approved: true })
    const b = await insertSupplierInvoice(seed, supplierId, { total: 700, paidAmount: 700, status: 'paid', approved: true })
    const entryId = await insertPostedJournalEntry({
      ...seed, voucherSeries: 'A', voucherNumber: 1, sourceType: 'supplier_invoice_paid', sourceId: null,
    })
    await getPool().query(`UPDATE public.supplier_invoices SET payment_journal_entry_id = $1 WHERE id = ANY($2)`, [entryId, [a, b]])
    await insertSupplierPayment(seed, a, entryId, 300)
    await insertSupplierPayment(seed, b, entryId, 700)

    const state = await withUserContext(seed.userId, async (client) => {
      await deleteVoucher(client, seed, entryId)
      return { a: await invoiceState(client, a), b: await invoiceState(client, b) }
    })

    expect(state.a).toEqual({ ...UNPAID, status: 'approved', remaining_amount: 300 })
    expect(state.b).toEqual({ ...UNPAID, status: 'approved', remaining_amount: 700 })
  })

  it('reverts a cash payment in full: it books no payment row', async () => {
    const seed = await seedCompany()
    const supplierId = await insertSupplier(seed)
    const invoiceId = await insertSupplierInvoice(seed, supplierId, { total: 250, paidAmount: 250, status: 'paid' })
    const entryId = await insertPostedJournalEntry({
      ...seed, voucherSeries: 'A', voucherNumber: 1, sourceType: 'supplier_invoice_cash_payment', sourceId: invoiceId,
    })
    await getPool().query(`UPDATE public.supplier_invoices SET payment_journal_entry_id = $1 WHERE id = $2`, [entryId, invoiceId])

    const invoice = await withUserContext(seed.userId, async (client) => {
      await deleteVoucher(client, seed, entryId)
      return invoiceState(client, invoiceId)
    })

    expect(invoice).toEqual({ ...UNPAID, status: 'registered', remaining_amount: 250 })
  })

  it('leaves an unrelated paid invoice alone', async () => {
    const seed = await seedCompany()
    const supplierId = await insertSupplier(seed)
    const other = await insertSupplierInvoice(seed, supplierId, { total: 90, paidAmount: 90, status: 'paid', approved: true })
    const entryId = await insertPostedJournalEntry({ ...seed, voucherSeries: 'A', voucherNumber: 1 })

    const invoice = await withUserContext(seed.userId, async (client) => {
      await deleteVoucher(client, seed, entryId)
      return invoiceState(client, other)
    })

    expect(invoice).toMatchObject({ status: 'paid', paid_amount: 90, remaining_amount: 0 })
  })
})

describe('delete_last_voucher: the legal protections are not weakened', () => {
  // BFNAR 2013:2 p. 9.16: the deletion and what it took with it stay traceable.
  // supplier_invoice_payments has no audit trigger of its own, so the removed
  // row is kept whole in the delete's snapshot.
  it('records the register effects in the audit snapshot', async () => {
    const s = await seedPrivatelyPaidSupplierInvoice()

    const oldState = await withUserContext(s.seed.userId, async (client) => {
      await deleteVoucher(client, s.seed, s.entryId)
      // journal_entries also has a generic audit trigger that logs the bare
      // row. The RPC's own row is the snapshot with lines and effects.
      const { rows } = await client.query<{ old_state: Record<string, unknown> }>(
        `SELECT old_state FROM public.audit_log
          WHERE table_name = 'journal_entries' AND record_id = $1 AND action = 'DELETE'
            AND description LIKE '%delete_last_voucher RPC%'`,
        [s.entryId],
      )
      expect(rows).toHaveLength(1)
      return rows[0].old_state
    })

    expect(oldState).toMatchObject({
      id: s.entryId,
      voucher_series: 'A',
      voucher_number: 1,
      register_effects: {
        removed_expense_claim_ids: [s.claimId],
        reverted_supplier_invoice_ids: [s.invoiceId],
        removed_supplier_payments: [{ id: s.paymentId, supplier_invoice_id: s.invoiceId }],
      },
    })
    expect(Array.isArray(oldState.lines)).toBe(true)
  })

  it('still refuses a voucher that is not the last in its series', async () => {
    const s = await seedPrivatelyPaidSupplierInvoice()
    await insertPostedJournalEntry({ ...s.seed, voucherSeries: 'A', voucherNumber: 2 })

    await expect(
      withUserContext(s.seed.userId, (client) => deleteVoucher(client, s.seed, s.entryId)),
    ).rejects.toThrow(/Kan bara radera det sista verifikatet/)
  })

  it('still refuses a member who is not owner or admin', async () => {
    const s = await seedPrivatelyPaidSupplierInvoice()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: s.seed.companyId, userId: member, role: 'member' })

    await expect(
      withUserContext(member, (client) => deleteVoucher(client, s.seed, s.entryId)),
    ).rejects.toThrow(/Only company owners and admins/)
  })
})
