import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { seedCompany, insertDraftJournalEntry } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20260622121000_invoices_journal_entry_id_backfill.sql.
 *
 * invoices.journal_entry_id means "the registration verifikat that booked the
 * invoice at issuance": payment flows route on it (set → clear 1510; NULL →
 * kontantmetoden cash entry). A wrong link silently double-books revenue +
 * VAT, so the backfill's guards are load-bearing:
 *   - only posted invoice_created entries qualify (reversed/draft excluded)
 *   - earliest entry wins deterministically on duplicates
 *   - rows with an existing link are never overwritten
 *   - payment-type links (wrong semantic from an earlier route version) are
 *     repaired: nulled, then re-linked from the registration entry if any
 *   - kontantmetoden invoices (no registration entry) stay NULL
 *   - credit-note rows link their credit_note reversal entry
 *   - cross-company isolation
 *   - idempotent (re-run is a no-op)
 */

// Run the real migration SQL so the test exercises exactly what ships.
const BACKFILL_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260622121000_invoices_journal_entry_id_backfill.sql'),
  'utf8',
)
async function runBackfill(): Promise<void> {
  await getPool().query(BACKFILL_SQL)
}

async function insertInvoice(params: {
  userId: string
  companyId: string
  status?: string
  creditedInvoiceId?: string | null
  journalEntryId?: string | null
}): Promise<string> {
  const id = randomUUID()
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Testkund AB')`,
    [customerId, params.userId, params.companyId],
  )
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number,
        invoice_date, due_date, currency, subtotal, vat_amount, total,
        vat_treatment, vat_rate, moms_ruta, status, credited_invoice_id,
        journal_entry_id)
     VALUES ($1, $2, $3, $4, $5,
             '2026-06-01', '2026-06-30', 'SEK', 10000, 2500, 12500,
             'standard_25', 25, '05', $6, $7, $8)`,
    [
      id,
      params.userId,
      params.companyId,
      customerId,
      `F-${randomUUID().slice(0, 8)}`,
      params.status ?? 'sent',
      params.creditedInvoiceId ?? null,
      params.journalEntryId ?? null,
    ],
  )
  return id
}

async function getLink(invoiceId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT journal_entry_id FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]?.journal_entry_id ?? null
}

describe('invoices.journal_entry_id backfill: Pass 1 (registration entries)', () => {
  it('links the posted invoice_created entry to its invoice', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await insertInvoice({ userId, companyId })
    const jeId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_created',
      sourceId: invoiceId,
    })

    await runBackfill()

    expect(await getLink(invoiceId)).toBe(jeId)
  })

  it('picks the earliest posted entry when duplicates exist', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await insertInvoice({ userId, companyId })
    const early = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_created',
      sourceId: invoiceId,
      createdAt: '2026-06-01T08:00:00Z',
    })
    await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_created',
      sourceId: invoiceId,
      createdAt: '2026-06-02T08:00:00Z',
    })

    await runBackfill()

    expect(await getLink(invoiceId)).toBe(early)
  })

  it('skips reversed and draft registration entries (invoice stays NULL)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await insertInvoice({ userId, companyId })
    await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'reversed',
      sourceType: 'invoice_created',
      sourceId: invoiceId,
    })
    await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'draft',
      sourceType: 'invoice_created',
      sourceId: invoiceId,
    })

    await runBackfill()

    // A stornoed registration must not mark the invoice as booked: the
    // payment flow should recognise revenue via the cash path instead.
    expect(await getLink(invoiceId)).toBeNull()
  })

  it('never overwrites an existing link', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    // Existing link points at a manual entry (e.g. user-curated): backfill
    // must leave it alone even though a registration entry also exists.
    const manual = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
    })
    const invoiceId = await insertInvoice({ userId, companyId, journalEntryId: manual })
    await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_created',
      sourceId: invoiceId,
    })

    await runBackfill()

    expect(await getLink(invoiceId)).toBe(manual)
  })

  it('leaves kontantmetoden invoices NULL (only a cash payment entry exists)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await insertInvoice({ userId, companyId, status: 'paid' })
    await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_cash_payment',
      sourceId: invoiceId,
    })

    await runBackfill()

    // NULL is the CORRECT value here: revenue was recognised at payment.
    expect(await getLink(invoiceId)).toBeNull()
  })

  it('does not cross-link between companies', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const invoiceA = await insertInvoice({ userId: a.userId, companyId: a.companyId })
    // Company B has a posted registration entry whose source_id happens to
    // reference company A's invoice (corrupt/cross-tenant data): the
    // company_id guard must refuse the link.
    await insertDraftJournalEntry({
      userId: b.userId,
      companyId: b.companyId,
      fiscalPeriodId: b.fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_created',
      sourceId: invoiceA,
    })

    await runBackfill()

    expect(await getLink(invoiceA)).toBeNull()
  })
})

describe('invoices.journal_entry_id backfill: Pass 0 (payment-link repair)', () => {
  it('nulls a payment-type link, then re-links the registration entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await insertInvoice({ userId, companyId, status: 'paid' })
    const registration = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_created',
      sourceId: invoiceId,
    })
    const payment = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_paid',
      sourceId: invoiceId,
    })
    // Simulate the old v1 mark-paid write-back: payment entry id in the column.
    await getPool().query(
      `UPDATE public.invoices SET journal_entry_id = $1 WHERE id = $2`,
      [payment, invoiceId],
    )

    await runBackfill()

    expect(await getLink(invoiceId)).toBe(registration)
  })

  it('nulls a cash-payment link with no registration entry (stays NULL)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await insertInvoice({ userId, companyId, status: 'paid' })
    const cash = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_cash_payment',
      sourceId: invoiceId,
    })
    await getPool().query(
      `UPDATE public.invoices SET journal_entry_id = $1 WHERE id = $2`,
      [cash, invoiceId],
    )

    await runBackfill()

    expect(await getLink(invoiceId)).toBeNull()
  })
})

describe('invoices.journal_entry_id backfill: Pass 2 (credit notes)', () => {
  it('links the credit_note reversal entry to the credit-note row', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const original = await insertInvoice({ userId, companyId })
    const creditNote = await insertInvoice({
      userId,
      companyId,
      creditedInvoiceId: original,
    })
    const reversal = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'credit_note',
      sourceId: creditNote,
    })

    await runBackfill()

    expect(await getLink(creditNote)).toBe(reversal)
    expect(await getLink(original)).toBeNull()
  })

  it('ignores credit_note entries pointing at non-credit-note rows', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await insertInvoice({ userId, companyId })
    await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'credit_note',
      sourceId: invoiceId,
    })

    await runBackfill()

    // credited_invoice_id IS NULL → Pass 2 must not touch the row.
    expect(await getLink(invoiceId)).toBeNull()
  })
})

describe('invoices.journal_entry_id backfill: idempotency', () => {
  it('re-running the backfill changes nothing', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const invoiceId = await insertInvoice({ userId, companyId })
    const jeId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      sourceType: 'invoice_created',
      sourceId: invoiceId,
    })

    await runBackfill()
    expect(await getLink(invoiceId)).toBe(jeId)

    await runBackfill()
    expect(await getLink(invoiceId)).toBe(jeId)
  })
})
