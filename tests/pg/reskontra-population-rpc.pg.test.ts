/**
 * pg-real test for the reskontra reads:
 *   get_ar_ledger_invoices, get_supplier_ledger_invoices
 *   (20261023093950, 20261023094010), get_invoice_register_coverage
 *   (20261023094000), get_paid_invoice_days and get_kpi_supplier_invoices
 *   (20261023094020).
 *
 * Each function returns facts that TypeScript rules turn into figures. The
 * ledger functions also leave out rows the rules would drop (settled credit
 * notes, invoices written off by the date, paid invoices provably settled by
 * it) and order the rest so the rules' first-seen order is kept. That is an
 * optimisation the reports must not see, so the core of this suite runs the
 * real report generators twice on the same books: once over the SQL, once
 * over the plain ports in tests/reskontra-rpc-port.ts (the documented
 * population with nothing dropped early, in id order). The books are built
 * to make the shortcuts matter: a settled invoice that is a customer's first
 * row and decides a tie, an amount in thousandths, a paid_at on the as-of
 * date and one after it, write-offs before, after and annulled, a ROT/RUT
 * invoice, a credit note set off against another invoice, an invoice
 * without a customer, a foreign invoice without a rate.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertPostedJournalEntry, seedCompany } from './fixtures'
import { generateARLedger, AR_LEDGER_STATUSES } from '@/lib/reports/ar-ledger'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { fetchInvoiceRegisterCoverage, hasPreRegisterArInPeriod } from '@/lib/reports/invoice-register-coverage'
import { aggregateTopSuppliers, fetchPaymentDaysInRange, fetchTopSupplierInvoices } from '@/lib/reports/kpi'
import {
  portArLedgerInvoices,
  portKpiSupplierInvoices,
  portPaidInvoiceDays,
  portSupplierLedgerInvoices,
  reskontraRpcPorts,
  type ReskontraTables,
} from '@/tests/reskontra-rpc-port'

type Seeded = Awaited<ReturnType<typeof seedCompany>>

/** supabase.rpc over the real functions, as the user, under RLS. */
function sqlClient(userId: string): SupabaseClient {
  return {
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      try {
        const data = await withUserContext(userId, async (client) => {
          const keys = Object.keys(args)
          const { rows } = await client.query(
            `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS data`,
            keys.map((k) => args[k]),
          )
          return rows[0].data
        })
        return { data, error: null }
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } }
      }
    },
  } as unknown as SupabaseClient
}

/** supabase.rpc over the ports, on the same rows. */
function portClient(tables: ReskontraTables): SupabaseClient {
  const ports = reskontraRpcPorts(tables)
  return {
    rpc: async (name: string, args: Record<string, unknown> = {}) => ({ data: ports[name](args), error: null }),
  } as unknown as SupabaseClient
}

/** The company's rows as PostgREST would print them, in id order. */
async function loadTables(companyId: string): Promise<ReskontraTables> {
  const load = async (sql: string) =>
    (await getPool().query(`SELECT coalesce(json_agg(t ORDER BY t.id), '[]'::json) AS rows FROM (${sql}) t`, [companyId]))
      .rows[0].rows
  return {
    invoices: await load('SELECT * FROM public.invoices WHERE company_id = $1'),
    customers: await load('SELECT * FROM public.customers WHERE company_id = $1'),
    invoice_items: await load(
      'SELECT it.* FROM public.invoice_items it JOIN public.invoices i ON i.id = it.invoice_id WHERE i.company_id = $1',
    ),
    invoice_payments: await load('SELECT * FROM public.invoice_payments WHERE company_id = $1'),
    invoice_write_offs: await load('SELECT * FROM public.invoice_write_offs WHERE company_id = $1'),
    rot_rut_payout_requests: await load('SELECT * FROM public.rot_rut_payout_requests WHERE company_id = $1'),
    rot_rut_payout_request_items: await load(
      `SELECT it.* FROM public.rot_rut_payout_request_items it
         JOIN public.rot_rut_payout_requests r ON r.id = it.request_id WHERE r.company_id = $1`,
    ),
    journal_entries: await load('SELECT * FROM public.journal_entries WHERE company_id = $1'),
    journal_entry_lines: await load(
      `SELECT l.* FROM public.journal_entry_lines l
         JOIN public.journal_entries e ON e.id = l.journal_entry_id WHERE e.company_id = $1`,
    ),
    supplier_invoices: await load('SELECT * FROM public.supplier_invoices WHERE company_id = $1'),
    suppliers: await load('SELECT * FROM public.suppliers WHERE company_id = $1'),
    supplier_invoice_payments: await load('SELECT * FROM public.supplier_invoice_payments WHERE company_id = $1'),
  }
}

/** Ids that sort in creation order within one run: <run>-0000-4000-8000-<n>. */
function idFactory() {
  const run = randomUUID().slice(0, 8)
  return (n: number) => `${run}-0000-4000-8000-${String(n).padStart(12, '0')}`
}

async function insertCustomer(s: Seeded, id: string, name: string): Promise<string> {
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, $4, 'swedish_business')`,
    [id, s.userId, s.companyId, name],
  )
  return id
}

interface InvoiceSeed {
  id: string
  customerId: string | null
  number: string
  status: string
  total: number | string
  paid?: number | string | null
  invoiceDate?: string
  dueDate?: string
  paidAt?: string | null
  deduction?: number
  journalEntryId?: string | null
  documentType?: string
  currency?: string
  exchangeRate?: number | null
}

async function insertInvoice(s: Seeded, inv: InvoiceSeed): Promise<string> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // A written-off status is only reachable through record_invoice_write_off;
    // the write-off rows below are seeded directly, so the status is too.
    if (inv.status === 'written_off') {
      await client.query('ALTER TABLE public.invoices DISABLE TRIGGER guard_invoice_written_off_status')
    }
    await client.query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, currency,
          exchange_rate, subtotal, vat_amount, total, vat_treatment, vat_rate, status, paid_amount,
          paid_at, deduction_total, journal_entry_id, document_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $10, 'standard_25', 25, $11, $12, $13, $14, $15, $16)`,
      [
        inv.id, s.userId, s.companyId, inv.customerId, inv.number,
        inv.invoiceDate ?? '2026-01-15', inv.dueDate ?? '2026-02-14', inv.currency ?? 'SEK',
        inv.exchangeRate ?? null, inv.total, inv.status, inv.paid ?? 0, inv.paidAt ?? null,
        inv.deduction ?? 0, inv.journalEntryId ?? null, inv.documentType ?? 'invoice',
      ],
    )
    if (inv.status === 'written_off') {
      await client.query('ALTER TABLE public.invoices ENABLE TRIGGER guard_invoice_written_off_status')
    }
    await client.query('COMMIT')
    return inv.id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function insertPayment(
  s: Seeded,
  p: { id: string; invoiceId: string; date: string; amount: number | string; journalEntryId?: string | null },
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.invoice_payments
       (id, user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'SEK', $7)`,
    [p.id, s.userId, s.companyId, p.invoiceId, p.date, p.amount, p.journalEntryId ?? null],
  )
}

async function insertDocument(s: Seeded): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'konkursbesked.pdf', 'application/pdf', 1024, $4, $5, 'file_upload')`,
    [id, s.userId, s.companyId, `documents/${s.companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

/** A konstaterad decision, and optionally its annulment, dated as given. */
async function insertWriteOff(
  s: Seeded,
  invoiceId: string,
  confirmedOn: string,
  annulledOn: string | null = null,
): Promise<void> {
  const confirmedId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_write_offs
       (id, company_id, invoice_id, kind, entry_date, amount, net_amount, vat_amount, vat_by_rate, reason, evidence_document_id)
     VALUES ($1, $2, $3, 'confirmed', $4, 100, 100, 0, '[]', 'Konkurs', $5)`,
    [confirmedId, s.companyId, invoiceId, confirmedOn, await insertDocument(s)],
  )
  if (!annulledOn) return
  const voucher = await insertPostedJournalEntry({
    userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: annulledOn,
  })
  await getPool().query(
    `INSERT INTO public.invoice_write_offs
       (id, company_id, invoice_id, kind, entry_date, amount, net_amount, vat_amount, vat_by_rate, reason,
        reverses_id, journal_entry_id)
     VALUES ($1, $2, $3, 'annulled', $4, 100, 100, 0, '[]', 'Annullerad', $5, $6)`,
    [randomUUID(), s.companyId, invoiceId, annulledOn, confirmedId, voucher],
  )
}

/** A begäran settled by a payout voucher dated `settledOn`, with one item for the invoice. */
async function insertSettledPayout(
  s: Seeded,
  invoiceId: string,
  p: { status: string; decided: number; settledOn: string },
): Promise<void> {
  const settlement = await insertPostedJournalEntry({
    userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: p.settledOn,
    sourceType: 'rot_rut_payout',
    lines: [
      { accountNumber: '1930', debitAmount: p.decided, creditAmount: 0 },
      { accountNumber: '1513', debitAmount: 0, creditAmount: p.decided },
    ],
  })
  const requestId = randomUUID()
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_requests
       (id, company_id, user_id, deduction_type, name, status, requested_total, decided_total, file_name,
        settlement_journal_entry_id)
     VALUES ($1, $2, $3, 'rut', 'Begaran 1', $4, $5, $5, 'begaran.xml', $6)`,
    [requestId, s.companyId, s.userId, p.status, p.decided, settlement],
  )
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_request_items (request_id, invoice_id, requested_amount, decided_amount)
     VALUES ($1, $2, $3, $3)`,
    [requestId, invoiceId, p.decided],
  )
}

/**
 * The kundreskontra books. The as-of date that matters is 2026-06-30.
 * Ids sort in seed order, so customer B is met first (by a settled
 * invoice), then A, and on that date B and A owe the same 1 000.
 */
async function seedReceivables() {
  const s = await seedCompany()
  const id = idFactory()
  const custA = await insertCustomer(s, randomUUID(), 'Kund A AB')
  const custB = await insertCustomer(s, randomUUID(), 'Kund B AB')
  const custC = await insertCustomer(s, randomUUID(), 'Kund C AB')
  const custD = await insertCustomer(s, randomUUID(), 'Kund D AB')
  const custE = await insertCustomer(s, randomUUID(), 'Kund E AB')

  // B: paid in full on 2026-03-01 (dropped as of 2026-06-30), then 1 000 open.
  await insertInvoice(s, { id: id(1), customerId: custB, number: '1', status: 'paid', total: 1000, paid: 1000, paidAt: '2026-03-01T10:00:00Z' })
  await insertPayment(s, { id: id(101), invoiceId: id(1), date: '2026-03-01', amount: 1000 })
  // A: 500 open here, and 200 + 300 written off below.
  await insertInvoice(s, { id: id(2), customerId: custA, number: '2', status: 'sent', total: 500, dueDate: '2026-06-15' })
  await insertInvoice(s, { id: id(3), customerId: custB, number: '3', status: 'overdue', total: 1000, dueDate: '2026-06-15' })
  // C: paid in two parts, the second after the date: 200 open on 2026-06-30.
  await insertInvoice(s, { id: id(4), customerId: custC, number: '4', status: 'paid', total: 300, paid: 300, paidAt: '2026-07-15T08:00:00Z' })
  await insertPayment(s, { id: id(102), invoiceId: id(4), date: '2026-05-01', amount: 100 })
  await insertPayment(s, { id: id(103), invoiceId: id(4), date: '2026-07-15', amount: 200 })
  // C: thousandths that the öre walk leaves 0.01 open on (never dropped).
  await insertInvoice(s, { id: id(5), customerId: custC, number: '5', status: 'paid', total: '99.999', paid: '99.999', paidAt: '2026-03-03T10:00:00Z' })
  for (const [n, day] of [[104, '01'], [105, '02'], [106, '03']] as const) {
    await insertPayment(s, { id: id(n), invoiceId: id(5), date: `2026-03-${day}`, amount: '33.333' })
  }
  // D: paid without payment rows, paid_at on the date itself (dropped), and after it (open).
  await insertInvoice(s, { id: id(6), customerId: custD, number: '6', status: 'paid', total: 750, paid: 750, paidAt: '2026-06-30T23:30:00Z' })
  await insertInvoice(s, { id: id(7), customerId: custD, number: '7', status: 'paid', total: 400, paid: 400, paidAt: '2026-07-02T09:00:00Z' })
  // A: written off before the date, annulled before it, written off after it.
  await insertInvoice(s, { id: id(8), customerId: custA, number: '8', status: 'written_off', total: 100 })
  await insertWriteOff(s, id(8), '2026-06-01')
  await insertInvoice(s, { id: id(9), customerId: custA, number: '9', status: 'written_off', total: 200 })
  await insertWriteOff(s, id(9), '2026-05-01', '2026-06-15')
  await insertInvoice(s, { id: id(10), customerId: custA, number: '10', status: 'written_off', total: 300 })
  await insertWriteOff(s, id(10), '2026-07-10')
  // B: a migrated, settled credit note (never in the reskontra).
  await insertInvoice(s, { id: id(11), customerId: custB, number: '11', status: 'credited', total: -500 })
  // No customer: 100 open.
  await insertInvoice(s, { id: id(12), customerId: null, number: '12', status: 'sent', total: 100 })
  // E: a RUT invoice, the buyer's 7 000 paid, Skatteverket's 3 000 paid out on 2026-05-10.
  await insertInvoice(s, {
    id: id(13), customerId: custE, number: '13', status: 'paid', total: 10000, paid: 7000,
    paidAt: '2026-03-01T12:00:00Z', deduction: 3000,
  })
  await insertPayment(s, { id: id(107), invoiceId: id(13), date: '2026-03-01', amount: 7000 })
  await insertSettledPayout(s, id(13), { status: 'paid', decided: 3000, settledOn: '2026-05-10' })
  // E: a credit note whose verifikat paid 2 000 of a later invoice.
  const creditVoucher = await insertPostedJournalEntry({
    userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: '2026-04-01',
    sourceType: 'credit_note',
    lines: [
      { accountNumber: '3001', debitAmount: 2000, creditAmount: 0 },
      { accountNumber: '1510', debitAmount: 0, creditAmount: 2000 },
    ],
  })
  await insertInvoice(s, { id: id(14), customerId: custE, number: '14', status: 'sent', total: -2000, invoiceDate: '2026-04-01', journalEntryId: creditVoucher })
  await insertInvoice(s, { id: id(15), customerId: custE, number: '15', status: 'partially_paid', total: 5000, paid: 2000, invoiceDate: '2026-04-05' })
  await insertPayment(s, { id: id(108), invoiceId: id(15), date: '2026-04-01', amount: 2000, journalEntryId: creditVoucher })
  // Never receivables: a proforma and a draft.
  await insertInvoice(s, { id: id(16), customerId: custA, number: '16', status: 'sent', total: 900, documentType: 'proforma' })
  await insertInvoice(s, { id: id(17), customerId: custA, number: '17', status: 'draft', total: 800 })
  // C: a foreign invoice without a rate (listed, kept out of the SEK totals).
  await insertInvoice(s, { id: id(18), customerId: custC, number: '18', status: 'sent', total: 250, currency: 'EUR' })
  // D: a credited original, kept so it nets against its credit note.
  await insertInvoice(s, { id: id(19), customerId: custD, number: '19', status: 'credited', total: 300, paid: 0 })
  // E: two more paid RUT invoices: 2 000 of the 3 000 paid out (1 000 still
  // owed by Skatteverket), and nothing paid out yet.
  await insertInvoice(s, {
    id: id(20), customerId: custE, number: '20', status: 'paid', total: 10000, paid: 7000,
    paidAt: '2026-03-01T12:00:00Z', deduction: 3000,
  })
  await insertPayment(s, { id: id(109), invoiceId: id(20), date: '2026-03-01', amount: 7000 })
  await insertSettledPayout(s, id(20), { status: 'partially_paid', decided: 2000, settledOn: '2026-05-10' })
  await insertInvoice(s, {
    id: id(21), customerId: custE, number: '21', status: 'paid', total: 10000, paid: 7000,
    paidAt: '2026-03-01T12:00:00Z', deduction: 3000,
  })

  return { s, id, custA, custB, creditVoucher }
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-23T12:00:00Z'))
})

afterAll(() => {
  vi.useRealTimers()
})

describe('get_ar_ledger_invoices: the kundreskontra reads the same as its plain port', () => {
  it('builds the same ledger live and as of every date that moves a row', async () => {
    const { s } = await seedReceivables()
    const tables = await loadTables(s.companyId)
    for (const asOf of [undefined, '2026-01-31', '2026-03-02', '2026-06-30', '2026-07-12', '2026-09-30']) {
      const viaSql = await generateARLedger(sqlClient(s.userId), s.companyId, asOf, { strict: true })
      const viaPort = await generateARLedger(portClient(tables), s.companyId, asOf, { strict: true })
      expect({ asOf, ledger: viaSql }).toEqual({ asOf, ledger: viaPort })
    }
  })

  it('leaves out what the walk would drop, and keeps the first-seen customer order', async () => {
    const { s, id, custA, custB } = await seedReceivables()
    const rows = (await sqlClient(s.userId).rpc('get_ar_ledger_invoices', {
      p_company_id: s.companyId,
      p_as_of_date: '2026-06-30',
    })).data as Array<{ id: string; customer_id: string | null; payment_amounts: number[] | null }>
    // Dropped: the settled 1 and 6, the written-off 8, the settled credit
    // note 11, the proforma and the draft.
    expect(rows.map((r) => r.id).sort()).toEqual(
      [2, 3, 4, 5, 7, 9, 10, 12, 13, 14, 15, 18, 19, 20, 21].map(id).sort(),
    )
    // B is met first (by the dropped 1), so its rows come before A's.
    const customers = rows.map((r) => r.customer_id).filter((c, i, all) => all.indexOf(c) === i)
    expect(customers.indexOf(custB)).toBeLessThan(customers.indexOf(custA))
    // Payment amounts as of the date, in id order.
    expect(rows.find((r) => r.id === id(4))?.payment_amounts).toEqual([100])
    expect(rows.find((r) => r.id === id(5))?.payment_amounts).toEqual([33.333, 33.333, 33.333])

    // In the report B (met first) comes before A at the same 1 000.
    const ledger = await generateARLedger(sqlClient(s.userId), s.companyId, '2026-06-30', { strict: true })
    const tied = ledger.entries.filter((e) => e.customer_id === custA || e.customer_id === custB)
    expect(tied.map((e) => [e.customer_id, e.total_outstanding])).toEqual([[custB, 1000], [custA, 1000]])
  })

  it('reads the live statuses, plus paid ROT/RUT invoices', async () => {
    const { s, id } = await seedReceivables()
    const rows = (await sqlClient(s.userId).rpc('get_ar_ledger_invoices', { p_company_id: s.companyId })).data as Array<{
      id: string
      status: string
    }>
    expect([...new Set(rows.map((r) => r.status))].sort()).toEqual([...AR_LEDGER_STATUSES, 'paid'].sort())
    // Paid invoices are read live only for a deduction Skatteverket still
    // owes on: not 13, whose share is paid out in full.
    expect(rows.filter((r) => r.status === 'paid').map((r) => r.id).sort()).toEqual([id(20), id(21)].sort())
  })

  it('names the drill-down rows with their registration verifikat', async () => {
    const { s, id } = await seedReceivables()
    const custE = (await getPool().query(`SELECT customer_id FROM public.invoices WHERE id = $1`, [id(15)])).rows[0].customer_id
    const engine = await insertPostedJournalEntry({
      userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: '2026-04-05',
      description: 'Faktura 15', sourceType: 'invoice_created', sourceId: id(15), voucherNumber: 7,
      lines: [
        { accountNumber: '1510', debitAmount: 5000, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 5000 },
      ],
    })
    const sql = (await sqlClient(s.userId).rpc('get_ar_ledger_invoices', {
      p_company_id: s.companyId,
      p_customer_id: custE,
    })).data as Array<{ id: string; voucher: { id: string; voucher_number: number } | null }>
    // The engine's own verifikat; the credit note is found by the one it is linked to.
    expect(sql.find((r) => r.id === id(15))?.voucher).toMatchObject({ id: engine, voucher_number: 7 })
    expect(sql.find((r) => r.id === id(14))?.voucher?.id).toBeTruthy()
    // The port's rows, but for 13: its Skatteverket share is paid out in
    // full, a row the live read leaves out.
    const tables = await loadTables(s.companyId)
    const port = portArLedgerInvoices(tables, { p_company_id: s.companyId, p_customer_id: custE })
    expect(port.map((r) => r.id)).toContain(id(13))
    expect(sql).toEqual(port.filter((r) => r.id !== id(13)))
  })

  it('reads what the posted verifikat put on 1510, so an öre booked at issue is owed', async () => {
    const s = await seedCompany()
    const id = idFactory()
    const cust = await insertCustomer(s, id(1), 'Öre AB')
    const line = (accountNumber: string, debitAmount: number, creditAmount: number) => ({ accountNumber, debitAmount, creditAmount })
    // 999,75 issued as Att betala 1 000: Dr 1510 1 000, Cr 3740 0,25.
    const rounded = await insertPostedJournalEntry({
      userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: '2026-03-01',
      sourceType: 'invoice_created', sourceId: id(10), voucherNumber: 1,
      lines: [line('1510', 1000, 0), line('3001', 0, 799.8), line('2611', 0, 199.95), line('3740', 0, 0.25)],
    })
    // Issued before the change: 1510 at the exact total.
    const exact = await insertPostedJournalEntry({
      userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: '2026-03-02',
      sourceType: 'invoice_created', sourceId: id(11), voucherNumber: 2,
      lines: [line('1510', 999.75, 0), line('3001', 0, 799.8), line('2611', 0, 199.95)],
    })
    await insertInvoice(s, { id: id(10), customerId: cust, number: 'R-1', status: 'sent', total: 999.75, journalEntryId: rounded })
    await insertInvoice(s, { id: id(11), customerId: cust, number: 'R-2', status: 'sent', total: 999.75, journalEntryId: exact })
    // A foreign invoice reads no 1510 figure, whatever its verifikat says.
    const foreign = await insertPostedJournalEntry({
      userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: '2026-03-03',
      sourceType: 'invoice_created', sourceId: id(12), voucherNumber: 3,
      lines: [line('1510', 1100.25, 0), line('3001', 0, 1100.25)],
    })
    await insertInvoice(s, {
      id: id(12), customerId: cust, number: 'R-3', status: 'sent', total: 100, currency: 'EUR', exchangeRate: 11, journalEntryId: foreign,
    })
    // No verifikat at all.
    await insertInvoice(s, { id: id(13), customerId: cust, number: 'R-4', status: 'sent', total: 10.5 })

    const rows = (await sqlClient(s.userId).rpc('get_ar_ledger_invoices', { p_company_id: s.companyId })).data as Array<{
      id: string
      registered_receivable_sek: number | null
    }>
    const registered = Object.fromEntries(rows.map((r) => [r.id, r.registered_receivable_sek]))
    expect(registered).toEqual({ [id(10)]: 1000, [id(11)]: 999.75, [id(12)]: null, [id(13)]: null })

    // The report over the SQL reads as over the port, and owes 1 000 on the rounded one.
    const tables = await loadTables(s.companyId)
    const viaSql = await generateARLedger(sqlClient(s.userId), s.companyId, undefined, { strict: true })
    const viaPort = await generateARLedger(portClient(tables), s.companyId, undefined, { strict: true })
    expect(viaSql).toEqual(viaPort)
    const outstanding = Object.fromEntries(viaSql.entries[0].invoices.map((i) => [i.invoice_id, i.outstanding]))
    expect(outstanding[id(10)]).toBe(1000)
    expect(outstanding[id(11)]).toBe(999.75)
    expect(outstanding[id(13)]).toBe(10.5)
  })

  it('answers nothing for another company under RLS', async () => {
    const { s } = await seedReceivables()
    const stranger = await insertAuthUser()
    const rows = (await sqlClient(stranger).rpc('get_ar_ledger_invoices', { p_company_id: s.companyId })).data
    expect(rows).toEqual([])
  })
})

describe('get_supplier_ledger_invoices: the leverantörsreskontra reads the same as its plain port', () => {
  async function insertSupplierInvoice(
    s: Seeded,
    supplierId: string,
    si: { id: string; arrival: number; status: string; total: number; remaining: number; paidAt?: string | null; currency?: string; rate?: number | null },
  ) {
    await getPool().query(
      `INSERT INTO public.supplier_invoices
         (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
          status, currency, exchange_rate, subtotal, vat_amount, total, paid_amount, remaining_amount, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-02-01', '2026-03-01', $7, $8, $9, $10, 0, $10, $11, $12, $13)`,
      [
        si.id, s.userId, s.companyId, supplierId, si.arrival, `L-${si.arrival}`, si.status, si.currency ?? 'SEK',
        si.rate ?? null, si.total, si.total - si.remaining, si.remaining, si.paidAt ?? null,
      ],
    )
  }

  it('builds the same ledger, with and without the invoice rows', async () => {
    const s = await seedCompany()
    const id = idFactory()
    const supplier = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Leverantör AB')`,
      [supplier, s.userId, s.companyId],
    )
    // Paid with payment rows before the date (dropped as of 2026-06-30).
    await insertSupplierInvoice(s, supplier, { id: id(1), arrival: 1, status: 'paid', total: 1000, remaining: 0, paidAt: '2026-03-01T10:00:00Z' })
    await getPool().query(
      `INSERT INTO public.supplier_invoice_payments (user_id, company_id, supplier_invoice_id, payment_date, amount)
       VALUES ($1, $2, $3, '2026-03-01', 1000)`,
      [s.userId, s.companyId, id(1)],
    )
    // Paid, no payment rows, paid after the date (open on it).
    await insertSupplierInvoice(s, supplier, { id: id(2), arrival: 2, status: 'paid', total: 400, remaining: 0, paidAt: '2026-07-02T10:00:00Z' })
    // Paid in a foreign currency without a rate: counted as unconverted, never dropped.
    await insertSupplierInvoice(s, supplier, { id: id(3), arrival: 3, status: 'paid', total: 50, remaining: 0, paidAt: '2026-03-01T10:00:00Z', currency: 'EUR' })
    // Open.
    await insertSupplierInvoice(s, supplier, { id: id(4), arrival: 4, status: 'approved', total: 600, remaining: 600 })

    const tables = await loadTables(s.companyId)
    for (const asOf of [undefined, '2026-02-15', '2026-06-30']) {
      for (const includeInvoices of [false, true]) {
        const viaSql = await generateSupplierLedger(sqlClient(s.userId), s.companyId, asOf, { strict: true, includeInvoices })
        const viaPort = await generateSupplierLedger(portClient(tables), s.companyId, asOf, { strict: true, includeInvoices })
        expect({ asOf, includeInvoices, ledger: viaSql }).toEqual({ asOf, includeInvoices, ledger: viaPort })
      }
    }
    const rows = (await sqlClient(s.userId).rpc('get_supplier_ledger_invoices', {
      p_company_id: s.companyId,
      p_as_of_date: '2026-06-30',
    })).data as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual([id(2), id(3), id(4)])
    expect(
      portSupplierLedgerInvoices(tables, { p_company_id: s.companyId, p_as_of_date: '2026-06-30' }).map((r) => r.id),
    ).toEqual([id(1), id(2), id(3), id(4)])
  })
})

describe('get_invoice_register_coverage', () => {
  const AR = ['1510', '1513']

  it('reads an empty register with no AR in the books as complete from today, nothing to disclose', async () => {
    const s = await seedCompany()
    expect(await fetchInvoiceRegisterCoverage(sqlClient(s.userId), s.companyId, { today: '2026-10-23' })).toEqual({
      covers_from: '2026-10-23',
      has_pre_register_invoices: false,
    })
  })

  // crm#1759 (20261110100000): after an SIE migration the register is empty
  // and the customer invoices are imported verifikat; the function answered
  // "no coverage" before looking at the books.
  it('probes the books for an empty register: imported AR debits are disclosed from today', async () => {
    const s = await seedCompany()
    const customer = await insertCustomer(s, randomUUID(), 'Kund AB')
    await insertPostedJournalEntry({
      userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: '2026-01-10',
      sourceType: 'import',
      lines: [
        { accountNumber: AR[0], debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    // A draft is not the register: it neither moves the boundary nor hides the disclosure.
    await insertInvoice(s, { id: randomUUID(), customerId: customer, number: 'D1', status: 'draft', total: 1250, invoiceDate: '2026-01-10' })

    const coverage = await fetchInvoiceRegisterCoverage(sqlClient(s.userId), s.companyId, { today: '2026-10-23' })
    expect(coverage).toEqual({ covers_from: '2026-10-23', has_pre_register_invoices: true })
    const tables = await loadTables(s.companyId)
    expect(coverage).toEqual(await fetchInvoiceRegisterCoverage(portClient(tables), s.companyId, { today: '2026-10-23' }))
    expect(await hasPreRegisterArInPeriod(sqlClient(s.userId), s.companyId, s.fiscalPeriodId)).toBe(true)
    expect(await hasPreRegisterArInPeriod(sqlClient(s.userId), s.companyId, randomUUID())).toBe(false)
  })

  it('starts the register at its first complete invoice and probes the books before it', async () => {
    const s = await seedCompany()
    const customer = await insertCustomer(s, randomUUID(), 'Kund AB')
    const imported = await insertPostedJournalEntry({
      userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: '2026-01-10',
      sourceType: 'import',
      lines: [
        { accountNumber: AR[0], debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    // Registered from the books (linked, no lines): not where the register is complete.
    await insertInvoice(s, { id: randomUUID(), customerId: customer, number: 'R1', status: 'sent', total: 1250, invoiceDate: '2026-01-10', journalEntryId: imported })
    // Unlinked: complete from here.
    await insertInvoice(s, { id: randomUUID(), customerId: customer, number: '2', status: 'sent', total: 500, invoiceDate: '2026-02-01' })

    const coverage = await fetchInvoiceRegisterCoverage(sqlClient(s.userId), s.companyId, { today: '2026-10-23' })
    expect(coverage).toEqual({ covers_from: '2026-02-01', has_pre_register_invoices: true })
    const tables = await loadTables(s.companyId)
    expect(coverage).toEqual(await fetchInvoiceRegisterCoverage(portClient(tables), s.companyId, { today: '2026-10-23' }))
    expect(await hasPreRegisterArInPeriod(sqlClient(s.userId), s.companyId, s.fiscalPeriodId)).toBe(true)
    expect(await hasPreRegisterArInPeriod(sqlClient(s.userId), s.companyId, randomUUID())).toBe(false)
  })

  it('reads a register of registrations only as complete from today', async () => {
    const s = await seedCompany()
    const customer = await insertCustomer(s, randomUUID(), 'Kund AB')
    const imported = await insertPostedJournalEntry({
      userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId, entryDate: '2026-01-10',
    })
    await insertInvoice(s, { id: randomUUID(), customerId: customer, number: 'R1', status: 'sent', total: 1000, journalEntryId: imported })
    const coverage = await fetchInvoiceRegisterCoverage(sqlClient(s.userId), s.companyId, { today: '2026-10-23' })
    expect(coverage.covers_from).toBe('2026-10-23')
    // The only verifikat debits no receivable: nothing before the register.
    expect(coverage.has_pre_register_invoices).toBe(false)
  })
})

describe('get_paid_invoice_days and get_kpi_supplier_invoices', () => {
  it('counts payment days as a JavaScript Date reads paid_at, in the range only', async () => {
    const s = await seedCompany()
    const customer = await insertCustomer(s, randomUUID(), 'Kund AB')
    const paid = async (number: string, invoiceDate: string, paidAt: string) =>
      insertInvoice(s, { id: randomUUID(), customerId: customer, number, status: 'paid', total: 100, paid: 100, invoiceDate, paidAt })
    await paid('1', '2026-03-01', '2026-03-31T23:59:59.9995Z') // 30 days: the sub-millisecond part is dropped
    await paid('2', '2026-03-01', '2026-03-02T00:00:00Z') // 1 day
    await paid('3', '2026-03-10', '2026-03-05T12:00:00Z') // paid before the invoice date: 0
    await paid('4', '2025-12-01', '2026-01-01T00:00:00Z') // first instant of the range
    await paid('5', '2026-12-01', '2027-01-01T00:00:00Z') // first instant after it: outside
    const viaSql = await fetchPaymentDaysInRange(sqlClient(s.userId), s.companyId, '2026-01-01', '2026-12-31')
    expect(viaSql).toEqual({ invoiceCount: 4, totalDays: 30 + 1 + 0 + 31 })
    const tables = await loadTables(s.companyId)
    expect(portPaidInvoiceDays(tables, { p_company_id: s.companyId, p_from: '2026-01-01', p_paid_before: '2027-01-01' })).toEqual({
      invoice_count: 4,
      total_days: 62,
    })
  })

  it('returns the period\'s supplier invoices in id order, credited ones left out', async () => {
    const s = await seedCompany()
    const id = idFactory()
    const supplier = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Leverantör AB')`,
      [supplier, s.userId, s.companyId],
    )
    const insert = async (n: number, status: string, invoiceDate: string, total: number) =>
      getPool().query(
        `INSERT INTO public.supplier_invoices
           (id, user_id, company_id, supplier_id, arrival_number, invoice_date, due_date, status, subtotal, vat_amount,
            total, remaining_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, 0, $8, $8)`,
        [id(n), s.userId, s.companyId, supplier, n, invoiceDate, status, total],
      )
    await insert(1, 'approved', '2026-01-01', 100)
    await insert(2, 'credited', '2026-02-01', 200)
    await insert(3, 'paid', '2026-12-31', 300)
    await insert(4, 'approved', '2027-01-01', 400)
    const viaSql = await fetchTopSupplierInvoices(sqlClient(s.userId), s.companyId, '2026-01-01', '2026-12-31')
    expect(viaSql.error).toBeNull()
    expect(viaSql.data?.map((r) => r.total)).toEqual([100, 300])
    const tables = await loadTables(s.companyId)
    const viaPort = await fetchTopSupplierInvoices(portClient(tables), s.companyId, '2026-01-01', '2026-12-31')
    expect(viaSql).toEqual(viaPort)
    expect(aggregateTopSuppliers(viaSql.data ?? [])).toEqual({
      suppliers: [{ supplier_id: supplier, supplier_name: 'Leverantör AB', total: 400 }],
      unconvertedFxCount: 0,
    })
    expect(portKpiSupplierInvoices(tables, { p_company_id: s.companyId, p_from: '2026-01-01', p_to: '2026-12-31' })).toHaveLength(2)
  })
})
