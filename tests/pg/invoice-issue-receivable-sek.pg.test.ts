import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany, setActiveCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { roundOre } from '@/lib/money'

/**
 * public.invoice_issue_receivable_sek (20261125162347, crm#2283): what each
 * invoice's own issue verifikat put on 151x, 1513 left out, the verifikat
 * followed through a storno to its correction. The kundreskontra and the
 * kreditfaktura read the öresavrundning an issue booked off it.
 */

type Company = Awaited<ReturnType<typeof seedCompany>>

let company: Company

beforeEach(async () => {
  company = await seedCompany()
})

let seq = 700_000

/** An issue verifikat of a 999,75 kr invoice with 1510 at `receivable` (the öre on 3740). */
function issue(receivable: number, extra: Array<{ accountNumber: string; debitAmount: number; creditAmount: number }> = []) {
  const ore = roundOre(receivable - 999.75)
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    entryDate: '2026-06-01',
    sourceType: 'invoice_created',
    lines: [
      { accountNumber: '1510', debitAmount: receivable, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 799.8 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 199.95 },
      ...(ore > 0 ? [{ accountNumber: '3740', debitAmount: 0, creditAmount: ore }] : []),
      ...(ore < 0 ? [{ accountNumber: '3740', debitAmount: -ore, creditAmount: 0 }] : []),
      ...extra,
    ],
  })
}

async function invoice(journalEntryId: string | null, companyId = company.companyId, userId = company.userId): Promise<string> {
  const id = randomUUID()
  const customer = randomUUID()
  seq += 1
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, country) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', 'SE')`,
    [customer, userId, companyId],
  )
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, '2026-06-01', '2026-07-01', 'sent', 'SEK', 799.8, 199.95, 999.75, 0, 999.75, 'standard_25', $6)`,
    [id, userId, companyId, customer, `F-${seq}`, journalEntryId],
  )
  return id
}

async function read(ids: string[], companyId = company.companyId) {
  const { rows } = await getPool().query<{ invoice_id: string; sek: string }>(
    'SELECT invoice_id, sek FROM public.invoice_issue_receivable_sek($1, $2)',
    [companyId, ids],
  )
  return new Map(rows.map((r) => [r.invoice_id, Number(r.sek)]))
}

/** A posted verifikat stornoed, with or without a correction, by the real status columns. */
async function reverse(entryId: string, correctionId: string | null) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL session_replication_role = replica`)
    await client.query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [entryId])
    if (correctionId) await client.query(`UPDATE public.journal_entries SET correction_of_id = $1 WHERE id = $2`, [entryId, correctionId])
    await client.query('COMMIT')
  } finally {
    client.release()
  }
}

describe('invoice_issue_receivable_sek (pg)', () => {
  it('answers what each issue put on 1510: the rounded claim or the exact total', async () => {
    const rounded = await invoice(await issue(1000))
    const exact = await invoice(await issue(999.75))

    const out = await read([rounded, exact])

    expect(out.get(rounded)).toBe(1000)
    expect(out.get(exact)).toBe(999.75)
  })

  it('leaves out 1513, Skatteverket’s ROT/RUT share', async () => {
    const id = await invoice(
      await issue(1000, [
        { accountNumber: '1513', debitAmount: 300, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 300 },
      ]),
    )

    expect((await read([id])).get(id)).toBe(1000)
  })

  it('leaves out an invoice without an issue verifikat, and one whose verifikat is stornoed without a correction', async () => {
    const unbooked = await invoice(null)
    const stornoed = await issue(1000)
    const reversed = await invoice(stornoed)
    await reverse(stornoed, null)

    const out = await read([unbooked, reversed])

    expect(out.has(unbooked)).toBe(false)
    expect(out.has(reversed)).toBe(false)
  })

  it('follows a stornoed issue to its one correction', async () => {
    const original = await issue(999.75)
    const correction = await issue(1000)
    const id = await invoice(original)
    await reverse(original, correction)

    expect((await read([id])).get(id)).toBe(1000)
  })

  it('answers only the company asked for', async () => {
    const id = await invoice(await issue(1000))
    const other = await seedCompany()

    expect((await read([id], other.companyId)).size).toBe(0)
  })

  it('runs as the caller: another company’s member reads nothing through RLS', async () => {
    const id = await invoice(await issue(1000))
    const stranger = await seedCompany()
    await setActiveCompany(company.userId, company.companyId)
    await setActiveCompany(stranger.userId, stranger.companyId)

    const own = await withUserContext(company.userId, (client) =>
      client.query('SELECT invoice_id, sek FROM public.invoice_issue_receivable_sek($1, $2)', [company.companyId, [id]]),
    )
    const theirs = await withUserContext(stranger.userId, (client) =>
      client.query('SELECT invoice_id, sek FROM public.invoice_issue_receivable_sek($1, $2)', [company.companyId, [id]]),
    )

    expect(own.rows.map((r) => Number(r.sek))).toEqual([1000])
    expect(theirs.rows).toEqual([])
  })
})
