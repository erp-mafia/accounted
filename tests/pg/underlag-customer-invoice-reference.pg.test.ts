import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany, insertPostedJournalEntry, insertTransaction } from './fixtures'

/**
 * Customer-invoice hänvisning in the missing-underlag predicate (#2298,
 * migration 20260906135702).
 *
 * BFL 5 kap 7 §: a verifikation may satisfy the underlag requirement by
 * hänvisning till underlag. An entry that a register invoice points at is
 * backed by that invoice: the invoice Accounted issued IS the verifikation
 * for the sale, and the payment row identifies the inbetalning. Both links
 * are written on the invoice side only (invoices.journal_entry_id,
 * invoice_payments.journal_entry_id), so a SIE-imported or manual verifikat
 * that an invoice was matched to afterwards keeps its own source_type and must
 * be resolved from the link, never by rewriting the posted entry.
 *
 * Pins, on real Postgres:
 *   - an 'import' entry linked through invoice_payments is NOT missing underlag;
 *   - the same shape without a link IS (the needs-doc list still applies);
 *   - a 'manual' entry referenced by invoices.journal_entry_id is NOT missing;
 *   - a bank-driven entry linked through invoice_payments leaves BOTH surfaces,
 *     so transactions_without_documents stays a strict subset;
 *   - the link row is tenant-scoped: another company's invoice pointing at the
 *     entry does not silence it.
 */

type VerifikatResult = {
  ok: boolean
  total_count?: number
  verifikat?: Array<{ journal_entry_id: string; source_type: string }>
}
type TransactionsResult = {
  ok: boolean
  total_count?: number
  transactions?: Array<{ id: string; journal_entry_id: string }>
}

async function verifikatSurface(companyId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ r: VerifikatResult }>(
    `SELECT public.verifikat_without_documents($1, NULL, 0, 100, 0) AS r`,
    [companyId],
  )
  expect(rows[0].r.ok).toBe(true)
  return (rows[0].r.verifikat ?? []).map((v) => v.journal_entry_id)
}

async function transactionsSurface(companyId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ r: TransactionsResult }>(
    `SELECT public.transactions_without_documents($1, NULL, 100, 0) AS r`,
    [companyId],
  )
  expect(rows[0].r.ok).toBe(true)
  return (rows[0].r.transactions ?? []).map((t) => t.journal_entry_id)
}

async function insertCustomerInvoice(params: {
  userId: string
  companyId: string
  journalEntryId?: string | null
  /** Defaults to 'sent' (issued). 'draft' / 'cancelled' are no document. */
  status?: string
}): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'EU Kund GmbH', 'eu_business')`,
    [customerId, params.userId, params.companyId],
  )
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, '2026-06-01', '2026-06-30', 'SEK',
             10000, 0, 10000, 'reverse_charge', 0, $7, 0, 10000, $6)`,
    [
      id,
      params.userId,
      params.companyId,
      customerId,
      `F-${id.slice(0, 8)}`,
      params.journalEntryId ?? null,
      params.status ?? 'sent',
    ],
  )
  return id
}

/** The row link_invoice_to_voucher writes: the voucher becomes the invoice's payment. */
async function linkAsPayment(params: {
  userId: string
  companyId: string
  invoiceId: string
  journalEntryId: string
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.invoice_payments
       (user_id, company_id, invoice_id, payment_date, amount, currency, journal_entry_id)
     VALUES ($1, $2, $3, '2026-06-10', 10000, 'SEK', $4)`,
    [params.userId, params.companyId, params.invoiceId, params.journalEntryId],
  )
}

describe('customer-invoice hänvisning silences "Underlag saknas" (#2298)', () => {
  let companyId: string
  let jeImportLinked: string // SIE-imported sale, invoice matched to it → covered
  let jeImportLoose: string // SIE-imported sale, nothing points at it → missing
  let jeManualRegistered: string // manual booking the invoice register links directly → covered
  let jeBankLinked: string // bank-driven entry, invoice matched to it → covered on BOTH surfaces
  let jeImportForeignLink: string // linked only from ANOTHER company's invoice → still missing
  let jeManualDraftLink: string // a DRAFT invoice points at it: no document yet → still missing
  let jeImportCancelledPayment: string // payment row of a CANCELLED invoice → still missing

  beforeAll(async () => {
    const s = await seedCompany()
    companyId = s.companyId
    const { userId, fiscalPeriodId } = s

    // The importer's shape for an EU service sale under kontantmetoden:
    // debit bank, credit 3308. Source type 'import' is in the needs-doc list.
    const mkJe = (n: number, sourceType: string) =>
      insertPostedJournalEntry({
        userId,
        companyId,
        fiscalPeriodId,
        voucherNumber: n,
        entryDate: `2026-06-${String(n).padStart(2, '0')}`,
        description: `${sourceType} ${n}`,
        sourceType,
        lines: [
          { accountNumber: '1930', debitAmount: 10000, creditAmount: 0 },
          { accountNumber: '3308', debitAmount: 0, creditAmount: 10000 },
        ],
      })

    jeImportLinked = await mkJe(1, 'import')
    jeImportLoose = await mkJe(2, 'import')
    jeManualRegistered = await mkJe(3, 'manual')
    jeBankLinked = await mkJe(4, 'bank_transaction')
    jeImportForeignLink = await mkJe(5, 'import')
    jeManualDraftLink = await mkJe(6, 'manual')
    jeImportCancelledPayment = await mkJe(7, 'import')

    const linkedInvoice = await insertCustomerInvoice({ userId, companyId })
    await linkAsPayment({ userId, companyId, invoiceId: linkedInvoice, journalEntryId: jeImportLinked })

    await insertCustomerInvoice({ userId, companyId, journalEntryId: jeManualRegistered })

    // Non-issued invoices: the link row exists but no document does, the
    // counterpart of an unanchored supplier document.
    await insertCustomerInvoice({ userId, companyId, journalEntryId: jeManualDraftLink, status: 'draft' })
    const cancelledInvoice = await insertCustomerInvoice({ userId, companyId, status: 'cancelled' })
    await linkAsPayment({
      userId,
      companyId,
      invoiceId: cancelledInvoice,
      journalEntryId: jeImportCancelledPayment,
    })

    await insertTransaction({ userId, companyId, journalEntryId: jeBankLinked, date: '2026-06-04' })
    const bankInvoice = await insertCustomerInvoice({ userId, companyId })
    await linkAsPayment({ userId, companyId, invoiceId: bankInvoice, journalEntryId: jeBankLinked })

    // Another tenant's invoice pointing at this company's entry: the FK
    // allows it, the predicate must not honour it.
    const other = await seedCompany()
    const foreignInvoice = await insertCustomerInvoice({ userId: other.userId, companyId: other.companyId })
    await linkAsPayment({
      userId: other.userId,
      companyId: other.companyId,
      invoiceId: foreignInvoice,
      journalEntryId: jeImportForeignLink,
    })
  })

  it('an imported verifikat matched to a register invoice through invoice_payments is not missing underlag', async () => {
    const ids = await verifikatSurface(companyId)
    expect(ids).not.toContain(jeImportLinked)
  })

  it('the same imported shape without a link still is (needs-doc source type, no hänvisning)', async () => {
    const ids = await verifikatSurface(companyId)
    expect(ids).toContain(jeImportLoose)
  })

  it('a manual verifikat the register points at through invoices.journal_entry_id is not missing underlag', async () => {
    const ids = await verifikatSurface(companyId)
    expect(ids).not.toContain(jeManualRegistered)
  })

  it('a link from another company does not silence the entry', async () => {
    const ids = await verifikatSurface(companyId)
    expect(ids).toContain(jeImportForeignLink)
  })

  it('a bank-driven entry matched to an invoice leaves both surfaces, so the subset invariant holds', async () => {
    const [ver, tx] = await Promise.all([verifikatSurface(companyId), transactionsSurface(companyId)])
    expect(ver).not.toContain(jeBankLinked)
    expect(tx).not.toContain(jeBankLinked)
    for (const id of tx) expect(ver).toContain(id)
  })

  it('a DRAFT invoice pointing at the entry is no underlag: still missing', async () => {
    const ids = await verifikatSurface(companyId)
    expect(ids).toContain(jeManualDraftLink)
  })

  it('a payment row of a CANCELLED invoice is no underlag: still missing', async () => {
    const ids = await verifikatSurface(companyId)
    expect(ids).toContain(jeImportCancelledPayment)
  })

  it('the full verdict: exactly the unlinked, foreign-linked and non-issued-linked entries remain', async () => {
    const ids = await verifikatSurface(companyId)
    expect(ids.sort()).toEqual(
      [jeImportLoose, jeImportForeignLink, jeManualDraftLink, jeImportCancelledPayment].sort(),
    )
  })
})
