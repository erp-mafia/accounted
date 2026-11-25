import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Migration 20261022130100_counterparty_setoffs (crm#1367),
 * 20261104100600 (crm#1644, öresavrundning) and 20261125160100 (crm#2283,
 * öresavrundning the issue verifikat booked): kvittning of a
 * customer invoice against a supplier invoice of the same counterparty.
 *  - book_counterparty_setoff books Dr 244x / Cr 151x, lowers both invoices,
 *    writes a payment row on each side and the set-off row, in one
 *    transaction, and refuses everything else before writing
 *  - one live voucher per set-off id, so a double booking fails
 *  - the voucher is never corrected in place and the set-off row never
 *    deleted
 *  - reverse_counterparty_setoff restores both invoices exactly after the
 *    voucher's storno
 *
 * The July case: a customer invoice of 1 388 kr and a self-billed supplier
 * invoice of 4 504 kr to Exempel Energi AB, set off for 1 388 kr, leaving
 * 3 116 kr to pay.
 */

type Seeded = Awaited<ReturnType<typeof seedCompany>>

interface Pair {
  partyId: string
  customerId: string
  supplierId: string
  invoiceId: string
  supplierInvoiceId: string
}

const ORG = '5599887766'

/** The party, one customer card and one supplier card of it. */
async function insertCounterparty(s: Seeded, org = ORG): Promise<{ partyId: string; customerId: string; supplierId: string }> {
  const partyId = randomUUID()
  await getPool().query(
    `INSERT INTO public.parties (id, company_id, user_id, display_name, org_number, kind, status)
     VALUES ($1, $2, $3, 'Exempel Energi AB', $4, 'company', 'confirmed')`,
    [partyId, s.companyId, s.userId, org],
  )
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, org_number, party_id)
     VALUES ($1, $2, $3, 'Exempel Energi AB (Anläggning Norr)', 'swedish_business', $4, $5)`,
    [customerId, s.userId, s.companyId, `${org.slice(0, 6)}-${org.slice(6)}`, partyId],
  )
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, supplier_type, org_number, party_id)
     VALUES ($1, $2, $3, 'Exempel Energi AB (Anläggning)', 'swedish_business', $4, $5)`,
    [supplierId, s.userId, s.companyId, org, partyId],
  )
  return { partyId, customerId, supplierId }
}

/**
 * A sent customer invoice with its invoice_created voucher (Dr 1510 / Cr 3001 +
 * 2611). `issueRounding` books the öresavrundning on the issue verifikat
 * itself: 1510 at the rounded Att betala and the öre on 3740 (crm#2283).
 */
async function insertBookedInvoice(
  s: Seeded,
  customerId: string,
  cols: { total?: number; currency?: string; booked?: boolean; status?: string; deduction?: number; issueRounding?: number } = {},
): Promise<string> {
  const total = cols.total ?? 1388
  const net = Math.round((total / 1.25) * 100) / 100
  const vat = Math.round((total - net) * 100) / 100
  const rounding = cols.issueRounding ?? 0
  const id = randomUUID()
  const voucherId =
    cols.booked === false
      ? null
      : await insertPostedJournalEntry({
          userId: s.userId,
          companyId: s.companyId,
          fiscalPeriodId: s.fiscalPeriodId,
          entryDate: '2026-08-31',
          description: 'Kundfaktura',
          sourceType: 'invoice_created',
          sourceId: id,
          lines: [
            { accountNumber: '1510', debitAmount: Math.round((total + rounding) * 100) / 100, creditAmount: 0 },
            { accountNumber: '3001', debitAmount: 0, creditAmount: net },
            { accountNumber: '2611', debitAmount: 0, creditAmount: vat },
            ...(rounding !== 0
              ? [{ accountNumber: '3740', debitAmount: Math.max(-rounding, 0), creditAmount: Math.max(rounding, 0) }]
              : []),
          ],
        })
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount, deduction_total, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, '2026-08-31', '2026-09-10', $6, $7, $8, $9, 'standard_25', 25, $10,
             0, $9, $11, $12)`,
    [id, s.userId, s.companyId, customerId, `F-${id.slice(0, 8)}`, cols.currency ?? 'SEK', net, vat, total, cols.status ?? 'sent', cols.deduction ?? 0, voucherId],
  )
  return id
}

/** A registered supplier invoice with its registration voucher (Dr 4010 + 2641 / Cr 2440). */
async function insertRegisteredSupplierInvoice(
  s: Seeded,
  supplierId: string,
  cols: { total?: number; bankEntered?: boolean } = {},
): Promise<string> {
  const total = cols.total ?? 4504
  const net = Math.round((total / 1.25) * 100) / 100
  const vat = Math.round((total - net) * 100) / 100
  const id = randomUUID()
  const voucherId = await insertPostedJournalEntry({
    userId: s.userId,
    companyId: s.companyId,
    fiscalPeriodId: s.fiscalPeriodId,
    entryDate: '2026-09-11',
    description: 'Leverantörsfaktura',
    sourceType: 'supplier_invoice_registered',
    sourceId: id,
    lines: [
      { accountNumber: '4010', debitAmount: net, creditAmount: 0 },
      { accountNumber: '2641', debitAmount: vat, creditAmount: 0 },
      { accountNumber: '2440', debitAmount: 0, creditAmount: total },
    ],
  })
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
        status, currency, subtotal, vat_amount, total, remaining_amount, registration_journal_entry_id, bank_entered_at)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-09-11', '2026-10-11', 'registered', 'SEK', $7, $8, $9, $9, $10, $11)`,
    [
      id,
      s.userId,
      s.companyId,
      supplierId,
      Math.floor(Math.random() * 1_000_000) + 1,
      `SF-CE-${id.slice(0, 6)}`,
      net,
      vat,
      total,
      voucherId,
      cols.bankEntered ? new Date() : null,
    ],
  )
  return id
}

async function insertPair(s: Seeded): Promise<Pair> {
  const counterparty = await insertCounterparty(s)
  const invoiceId = await insertBookedInvoice(s, counterparty.customerId)
  const supplierInvoiceId = await insertRegisteredSupplierInvoice(s, counterparty.supplierId)
  return { ...counterparty, invoiceId, supplierInvoiceId }
}

const BOOK_SQL = `SELECT public.book_counterparty_setoff(
  $1, $2, $3, $4, $5::numeric, $6::date, $7, $8, NULL, NULL, NULL, NULL
) AS result`

interface BookArgs {
  setoffId?: string
  amount?: number
  date?: string
  note?: string | null
  userId?: string | null
}

function bookParams(s: Seeded, pair: Pick<Pair, 'invoiceId' | 'supplierInvoiceId'>, a: BookArgs = {}): unknown[] {
  return [
    s.companyId,
    a.setoffId ?? randomUUID(),
    pair.invoiceId,
    pair.supplierInvoiceId,
    a.amount ?? 1388,
    a.date ?? '2026-09-30',
    a.note ?? null,
    a.userId === undefined ? s.userId : a.userId,
  ]
}

type BookResult = {
  ok: boolean
  code?: string
  setoff_id?: string
  journal_entry_id?: string
  voucher_series?: string
  party_id?: string
  receivable_account?: string
  payable_account?: string
  invoice?: { status: string; remaining_amount: number }
  supplier_invoice?: { status: string; remaining_amount: number }
}

/** As the v1 and MCP doors call it: the service role, naming the person. Committed. */
async function bookAsService(s: Seeded, pair: Pick<Pair, 'invoiceId' | 'supplierInvoiceId'>, a: BookArgs = {}): Promise<BookResult> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: BookResult }>(BOOK_SQL, bookParams(s, pair, a))
    return rows[0]!.result
  })
}

async function setoffVoucherCount(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    "SELECT count(*) AS n FROM public.journal_entries WHERE company_id = $1 AND source_type = 'counterparty_setoff'",
    [companyId],
  )
  return Number(rows[0]!.n)
}

async function invoiceState(id: string): Promise<{ status: string; paid_amount: string; remaining_amount: string }> {
  const { rows } = await getPool().query('SELECT status, paid_amount, remaining_amount FROM public.invoices WHERE id = $1', [id])
  return rows[0]
}

async function supplierInvoiceState(
  id: string,
): Promise<{ status: string; paid_amount: string; remaining_amount: string; payment_journal_entry_id: string | null }> {
  const { rows } = await getPool().query(
    'SELECT status, paid_amount, remaining_amount, payment_journal_entry_id FROM public.supplier_invoices WHERE id = $1',
    [id],
  )
  return rows[0]
}

/** The storno of a posted voucher, as reverseEntry() leaves it. */
async function insertStorno(s: Seeded, originalId: string, entryDate = '2026-10-05'): Promise<string> {
  const client = await getPool().connect()
  const id = randomUUID()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, reverses_id, status)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Storno', 'storno', $6, 'draft')`,
      [id, s.userId, s.companyId, s.fiscalPeriodId, entryDate, originalId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       SELECT $1, account_number, credit_amount, debit_amount, currency, sort_order
         FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [id, originalId],
    )
    await client.query("UPDATE public.journal_entries SET status = 'posted' WHERE id = $1", [id])
    await client.query(
      "UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1",
      [originalId, id],
    )
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function reverseAsService(s: Seeded, setoffId: string, stornoId: string): Promise<{ ok: boolean; code?: string }> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: { ok: boolean; code?: string } }>(
      'SELECT public.reverse_counterparty_setoff($1, $2, $3, $4) AS result',
      [s.companyId, setoffId, stornoId, s.userId],
    )
    return rows[0]!.result
  })
}

/** A transaction with an allowed GUC set, rolled back. */
async function withSetting<T>(setting: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config($1, 'true', true)`, [setting])
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('counterparty set-off (migration 20261022130100)', () => {
  it("books the July set-off: Dr 2440 / Cr 1510, both invoices lowered, a payment row on each side", async () => {
    const s = await seedCompany()
    const pair = await insertPair(s)
    const setoffId = randomUUID()

    const result = await bookAsService(s, pair, { setoffId, note: 'Kvittning enligt flexavtal' })
    expect(result).toMatchObject({
      ok: true,
      setoff_id: setoffId,
      voucher_series: 'A',
      party_id: pair.partyId,
      receivable_account: '1510',
      payable_account: '2440',
      invoice: { status: 'paid' },
      supplier_invoice: { status: 'partially_paid' },
    })

    const { rows: entries } = await getPool().query(
      `SELECT status, source_type, source_id, entry_date::text AS entry_date, voucher_number
         FROM public.journal_entries WHERE id = $1`,
      [result.journal_entry_id],
    )
    expect(entries[0]).toMatchObject({ status: 'posted', source_type: 'counterparty_setoff', source_id: setoffId, entry_date: '2026-09-30' })
    expect(entries[0].voucher_number).toBeGreaterThan(0)
    const { rows: lines } = await getPool().query(
      `SELECT account_number, debit_amount::numeric AS debit, credit_amount::numeric AS credit
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [result.journal_entry_id],
    )
    expect(lines.map((l) => [l.account_number, Number(l.debit), Number(l.credit)])).toEqual([
      ['2440', 1388, 0],
      ['1510', 0, 1388],
    ])

    expect(await invoiceState(pair.invoiceId)).toMatchObject({ status: 'paid' })
    expect(Number((await invoiceState(pair.invoiceId)).remaining_amount)).toBe(0)
    expect(Number((await invoiceState(pair.invoiceId)).paid_amount)).toBe(1388)
    const supplier = await supplierInvoiceState(pair.supplierInvoiceId)
    expect(supplier.status).toBe('partially_paid')
    expect(Number(supplier.remaining_amount)).toBe(3116)
    expect(supplier.payment_journal_entry_id).toBe(result.journal_entry_id)

    const { rows: payments } = await getPool().query(
      `SELECT 'customer' AS side, amount::numeric AS amount, source, journal_entry_id, payment_date::text AS payment_date
         FROM public.invoice_payments WHERE invoice_id = $1
       UNION ALL
       SELECT 'supplier', amount::numeric, NULL, journal_entry_id, payment_date::text
         FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $2
       ORDER BY side`,
      [pair.invoiceId, pair.supplierInvoiceId],
    )
    expect(payments.map((p) => [p.side, Number(p.amount), p.source, p.journal_entry_id, p.payment_date])).toEqual([
      ['customer', 1388, 'setoff', result.journal_entry_id, '2026-09-30'],
      ['supplier', 1388, null, result.journal_entry_id, '2026-09-30'],
    ])

    const { rows: setoffs } = await getPool().query(
      'SELECT status, party_id, user_id, amount::numeric AS amount, note FROM public.counterparty_setoffs WHERE id = $1',
      [setoffId],
    )
    expect(setoffs[0]).toMatchObject({ status: 'booked', party_id: pair.partyId, user_id: s.userId, note: 'Kvittning enligt flexavtal' })
    expect(Number(setoffs[0].amount)).toBe(1388)
  })

  it('books for a signed-in writer, and refuses a viewer and a stranger', async () => {
    const s = await seedCompany()
    const pair = await insertPair(s)

    const booked = await withUserContext(s.userId, async (client) => {
      const { rows } = await client.query<{ result: BookResult }>(BOOK_SQL, bookParams(s, pair, { userId: null }))
      return rows[0]!.result
    })
    expect(booked).toMatchObject({ ok: true })

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: viewer, role: 'viewer' })
    const stranger = await seedCompany()
    for (const userId of [viewer, stranger.userId]) {
      const refused = await withUserContext(userId, async (client) => {
        // p_user_id names the owner: a session caller is pinned to its own auth.uid().
        const { rows } = await client.query<{ result: BookResult }>(BOOK_SQL, bookParams(s, pair))
        return rows[0]!.result
      })
      expect(refused).toEqual({ ok: false, code: 'SETOFF_FORBIDDEN' })
    }
    expect(await setoffVoucherCount(s.companyId)).toBe(0)
  })

  it('refuses before writing anything', async () => {
    const s = await seedCompany()
    const pair = await insertPair(s)
    const refusals: Array<[BookArgs, Partial<Pair>, string]> = [
      // A whole krona over what the invoice owes is no öresavrundning (crm#1644:
      // under one krona over settles in full with 3740), so it is refused.
      [{ amount: 1389.00 }, {}, 'SETOFF_AMOUNT_EXCEEDS_REMAINING'],
      [{ amount: 0 }, {}, 'SETOFF_INVALID_AMOUNT'],
      [{ amount: 10.005 }, {}, 'SETOFF_INVALID_AMOUNT'],
      [{ date: '2099-01-01' }, {}, 'SETOFF_DATE_INVALID'],
      [{ date: '2026-09-01' }, {}, 'SETOFF_DATE_INVALID'],
    ]

    // Another counterparty's supplier invoice.
    const other = await insertCounterparty(s, '5560000001')
    refusals.push([{}, { supplierInvoiceId: await insertRegisteredSupplierInvoice(s, other.supplierId) }, 'SETOFF_PARTY_MISMATCH'])
    // A foreign-currency invoice, a ROT/RUT invoice, an unbooked invoice, a paid invoice.
    refusals.push([{}, { invoiceId: await insertBookedInvoice(s, pair.customerId, { currency: 'EUR' }) }, 'SETOFF_CURRENCY_UNSUPPORTED'])
    refusals.push([{ amount: 100 }, { invoiceId: await insertBookedInvoice(s, pair.customerId, { deduction: 500 }) }, 'SETOFF_DEDUCTION_UNSUPPORTED'])
    refusals.push([{}, { invoiceId: await insertBookedInvoice(s, pair.customerId, { booked: false }) }, 'SETOFF_INVOICE_NOT_BOOKED'])
    refusals.push([{}, { invoiceId: await insertBookedInvoice(s, pair.customerId, { status: 'paid' }) }, 'SETOFF_INVOICE_NOT_OPEN'])
    // A supplier invoice entered at the bank: the bank would pay it in full.
    refusals.push([{}, { supplierInvoiceId: await insertRegisteredSupplierInvoice(s, pair.supplierId, { bankEntered: true }) }, 'SETOFF_PAYMENT_IN_FLIGHT'])
    // Unknown invoices.
    refusals.push([{}, { invoiceId: randomUUID() }, 'SETOFF_INVOICE_NOT_FOUND'])
    refusals.push([{}, { supplierInvoiceId: randomUUID() }, 'SETOFF_SUPPLIER_INVOICE_NOT_FOUND'])

    for (const [args, override, code] of refusals) {
      const result = await bookAsService(s, { ...pair, ...override }, args)
      expect(result, code).toMatchObject({ ok: false, code })
    }
    expect(await setoffVoucherCount(s.companyId)).toBe(0)
    expect(await invoiceState(pair.invoiceId)).toMatchObject({ status: 'sent' })
  })

  it('refuses a date in a closed period or on or before the lock date', async () => {
    const s = await seedCompany()
    const pair = await insertPair(s)
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, bookkeeping_locked_through) VALUES ($1, '2026-09-30')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [s.companyId],
    )
    expect(await bookAsService(s, pair, { date: '2026-09-30' })).toMatchObject({ ok: false, code: 'SETOFF_PERIOD_LOCKED' })

    const locked = await seedCompany()
    const lockedPair = await insertPair(locked)
    await getPool().query('UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1', [locked.fiscalPeriodId])
    expect(await bookAsService(locked, lockedPair)).toMatchObject({ ok: false, code: 'SETOFF_PERIOD_LOCKED' })
    expect(await setoffVoucherCount(s.companyId)).toBe(0)
    expect(await setoffVoucherCount(locked.companyId)).toBe(0)
  })

  it('books one set-off per id: a double booking fails before a second voucher', async () => {
    const s = await seedCompany()
    const pair = await insertPair(s)
    const setoffId = randomUUID()
    expect(await bookAsService(s, pair, { setoffId, amount: 500 })).toMatchObject({ ok: true })
    await expect(bookAsService(s, pair, { setoffId, amount: 500 })).rejects.toThrow(/journal_entries_counterparty_setoff_live_unique|counterparty_setoffs_pkey/)
    expect(await setoffVoucherCount(s.companyId)).toBe(1)
    expect(Number((await invoiceState(pair.invoiceId)).remaining_amount)).toBe(888)
  })

  it('never corrects a set-off voucher in place and never deletes a set-off', async () => {
    const s = await seedCompany()
    const pair = await insertPair(s)
    const setoffId = randomUUID()
    const { journal_entry_id: entryId } = await bookAsService(s, pair, { setoffId })

    await expect(
      withSetting('gnubok.allow_line_rattelse', (client) =>
        client.query(
          `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
           VALUES ($1, '1930', 1, 0, 'SEK', 9)`,
          [entryId],
        ),
      ),
    ).rejects.toThrow(/SETOFF_VOUCHER_LOCKED/)
    // correct_entry_metadata opens the posted row for a new date this way.
    await expect(
      withSetting('gnubok.allow_metadata_rattelse', (client) =>
        client.query("UPDATE public.journal_entries SET entry_date = '2026-09-29' WHERE id = $1", [entryId]),
      ),
    ).rejects.toThrow(/SETOFF_VOUCHER_LOCKED/)

    await expect(getPool().query('DELETE FROM public.counterparty_setoffs WHERE id = $1', [setoffId])).rejects.toThrow(
      /SETOFF_DELETE_BLOCKED/,
    )
    await expect(
      getPool().query('UPDATE public.counterparty_setoffs SET amount = 1 WHERE id = $1', [setoffId]),
    ).rejects.toThrow(/SETOFF_IMMUTABLE/)
    // A person cannot write a set-off row directly.
    await expect(
      withUserContext(s.userId, (client) =>
        client.query("UPDATE public.counterparty_setoffs SET note = 'x' WHERE id = $1", [setoffId]),
      ),
    ).rejects.toThrow(/permission denied/)
  })

  it('restores both invoices exactly after a storno of the set-off voucher', async () => {
    const s = await seedCompany()
    const pair = await insertPair(s)
    const setoffId = randomUUID()
    const { journal_entry_id: entryId } = await bookAsService(s, pair, { setoffId })

    // Only the storno of this set-off's voucher undoes it.
    const otherStorno = await insertStorno(s, await insertPostedJournalEntry({ userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId }))
    expect(await reverseAsService(s, setoffId, otherStorno)).toEqual({ ok: false, code: 'SETOFF_STORNO_MISMATCH' })

    const stornoId = await insertStorno(s, entryId!)
    expect(await reverseAsService(s, setoffId, stornoId)).toMatchObject({ ok: true })

    const invoice = await invoiceState(pair.invoiceId)
    expect(invoice.status).toBe('overdue') // due 2026-09-10, long past
    expect(Number(invoice.paid_amount)).toBe(0)
    expect(Number(invoice.remaining_amount)).toBe(1388)
    const supplier = await supplierInvoiceState(pair.supplierInvoiceId)
    expect(Number(supplier.paid_amount)).toBe(0)
    expect(Number(supplier.remaining_amount)).toBe(4504)
    expect(supplier.payment_journal_entry_id).toBeNull()

    const { rows: payments } = await getPool().query(
      `SELECT (SELECT count(*) FROM public.invoice_payments WHERE invoice_id = $1)::int AS customer,
              (SELECT count(*) FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $2)::int AS supplier`,
      [pair.invoiceId, pair.supplierInvoiceId],
    )
    expect(payments[0]).toEqual({ customer: 0, supplier: 0 })
    const { rows: setoffs } = await getPool().query(
      'SELECT status, reversal_journal_entry_id FROM public.counterparty_setoffs WHERE id = $1',
      [setoffId],
    )
    expect(setoffs[0]).toEqual({ status: 'reversed', reversal_journal_entry_id: stornoId })

    expect(await reverseAsService(s, setoffId, stornoId)).toEqual({ ok: false, code: 'SETOFF_ALREADY_REVERSED' })
    // A new set-off of the same pair books again.
    expect(await bookAsService(s, pair)).toMatchObject({ ok: true })
  })

  it('shows a set-off to the members of its company only', async () => {
    const s = await seedCompany()
    const pair = await insertPair(s)
    const setoffId = randomUUID()
    await bookAsService(s, pair, { setoffId })
    const stranger = await seedCompany()
    const count = (userId: string) =>
      withUserContext(userId, async (client) => {
        const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM public.counterparty_setoffs WHERE id = $1', [setoffId])
        return rows[0]!.n
      })
    expect(await count(s.userId)).toBe(1)
    expect(await count(stranger.userId)).toBe(0)
  })

  it('grants the functions to signed-in users and the service role, never to anon', async () => {
    const { rows } = await getPool().query<{ proname: string; anon_can: boolean; auth_can: boolean; service_can: boolean }>(
      `SELECT p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_can
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('book_counterparty_setoff', 'reverse_counterparty_setoff')
        ORDER BY p.proname`,
    )
    expect(rows).toEqual([
      { proname: 'book_counterparty_setoff', anon_can: false, auth_can: true, service_can: true },
      { proname: 'reverse_counterparty_setoff', anon_can: false, auth_can: true, service_can: true },
    ])
  })

  it('accepts the pending operation type book_counterparty_setoff', async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conrelid = 'public.pending_operations'::regclass AND c.conname = 'pending_operations_operation_type_check'`,
    )
    expect(rows[0]!.def).toContain("'book_counterparty_setoff'")
  })
})

// Migration 20261104100600 (crm#1644): within a krona of what the customer
// invoice owes, the set-off settles it in full and 3740 carries the gap.
describe('counterparty set-off absorbs öresavrundning (migration 20261104100600)', () => {
  async function voucherLines(entryId: string): Promise<Array<[string, number, number]>> {
    const { rows } = await getPool().query(
      `SELECT account_number, debit_amount::numeric AS debit, credit_amount::numeric AS credit
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [entryId],
    )
    return rows.map((l) => [l.account_number, Number(l.debit), Number(l.credit)])
  }

  async function paymentAmounts(pair: Pick<Pair, 'invoiceId' | 'supplierInvoiceId'>): Promise<{ customer: number[]; supplier: number[] }> {
    const customer = await getPool().query('SELECT amount::numeric AS amount FROM public.invoice_payments WHERE invoice_id = $1', [pair.invoiceId])
    const supplier = await getPool().query('SELECT amount::numeric AS amount FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $1', [
      pair.supplierInvoiceId,
    ])
    return { customer: customer.rows.map((r) => Number(r.amount)), supplier: supplier.rows.map((r) => Number(r.amount)) }
  }

  it('sets off the rounded Att betala of an invoice rounded down: Dr 3740 for the öre, the invoice paid, and a storno gives it all back', async () => {
    const s = await seedCompany()
    const counterparty = await insertCounterparty(s)
    const pair = {
      invoiceId: await insertBookedInvoice(s, counterparty.customerId, { total: 3136.18 }),
      supplierInvoiceId: await insertRegisteredSupplierInvoice(s, counterparty.supplierId, { total: 4012.13 }),
    }
    const setoffId = randomUUID()

    const result = await bookAsService(s, pair, { setoffId, amount: 3136 })
    expect(result).toMatchObject({ ok: true, invoice: { status: 'paid' }, supplier_invoice: { status: 'partially_paid' } })
    expect(await voucherLines(result.journal_entry_id!)).toEqual([
      ['2440', 3136, 0],
      ['1510', 0, 3136.18],
      ['3740', 0.18, 0],
    ])
    const invoice = await invoiceState(pair.invoiceId)
    expect(Number(invoice.remaining_amount)).toBe(0)
    expect(Number(invoice.paid_amount)).toBe(3136.18)
    expect(Number((await supplierInvoiceState(pair.supplierInvoiceId)).remaining_amount)).toBe(876.13)
    expect(await paymentAmounts(pair)).toEqual({ customer: [3136.18], supplier: [3136] })
    const { rows: setoffs } = await getPool().query('SELECT amount::numeric AS amount FROM public.counterparty_setoffs WHERE id = $1', [setoffId])
    expect(Number(setoffs[0].amount)).toBe(3136)

    const stornoId = await insertStorno(s, result.journal_entry_id!)
    expect(await reverseAsService(s, setoffId, stornoId)).toMatchObject({ ok: true })
    const restored = await invoiceState(pair.invoiceId)
    expect(Number(restored.paid_amount)).toBe(0)
    expect(Number(restored.remaining_amount)).toBe(3136.18)
    expect(Number((await supplierInvoiceState(pair.supplierInvoiceId)).remaining_amount)).toBe(4012.13)
  })

  it('sets off the rounded Att betala of an invoice rounded up: Cr 3740, and refuses a krona or more over', async () => {
    const s = await seedCompany()
    const counterparty = await insertCounterparty(s)
    const pair = {
      invoiceId: await insertBookedInvoice(s, counterparty.customerId, { total: 3135.82 }),
      supplierInvoiceId: await insertRegisteredSupplierInvoice(s, counterparty.supplierId, { total: 4012.13 }),
    }

    expect(await bookAsService(s, pair, { amount: 3136.82 })).toMatchObject({ ok: false, code: 'SETOFF_AMOUNT_EXCEEDS_REMAINING' })
    expect(await setoffVoucherCount(s.companyId)).toBe(0)

    const result = await bookAsService(s, pair, { amount: 3136 })
    expect(result).toMatchObject({ ok: true, invoice: { status: 'paid' } })
    expect(await voucherLines(result.journal_entry_id!)).toEqual([
      ['2440', 3136, 0],
      ['1510', 0, 3135.82],
      ['3740', 0, 0.18],
    ])
    expect(Number((await invoiceState(pair.invoiceId)).paid_amount)).toBe(3135.82)
    expect(Number((await supplierInvoiceState(pair.supplierInvoiceId)).remaining_amount)).toBe(876.13)
    expect(await paymentAmounts(pair)).toEqual({ customer: [3135.82], supplier: [3136] })
  })

  it('leaves a gap of a krona or more open as a part settlement', async () => {
    const s = await seedCompany()
    const pair = await insertPair(s)
    const result = await bookAsService(s, pair, { amount: 1387 })
    expect(result).toMatchObject({ ok: true, invoice: { status: 'partially_paid', remaining_amount: 1 } })
    expect(await voucherLines(result.journal_entry_id!)).toEqual([
      ['2440', 1387, 0],
      ['1510', 0, 1387],
    ])
  })
})

// Migration 20261125160100 (crm#2283): an issue verifikat that booked the
// invoice's öresavrundning put 1510 at the rounded Att betala (999,75 issued
// as Dr 1510 1 000 / Cr 3740 0,25). A set-off that settles the invoice in full
// clears all 1510 carries and books on 3740 only its own gap less that öre, so
// 1510 ends at zero and the öre is not booked twice.
describe('counterparty set-off clears the öre the issue verifikat booked (migration 20261125160100)', () => {
  async function voucherLines(entryId: string): Promise<Array<[string, number, number]>> {
    const { rows } = await getPool().query(
      `SELECT account_number, debit_amount::numeric AS debit, credit_amount::numeric AS credit
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [entryId],
    )
    return rows.map((l) => [l.account_number, Number(l.debit), Number(l.credit)])
  }

  /** The balance of an account over the given vouchers, debit positive. */
  async function balance(account: string, entryIds: string[]): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COALESCE(SUM(debit_amount - credit_amount), 0)::numeric AS b
         FROM public.journal_entry_lines WHERE account_number = $1 AND journal_entry_id = ANY($2::uuid[])`,
      [account, entryIds],
    )
    return Number(rows[0].b)
  }

  async function issuedRounded(s: Seeded) {
    const counterparty = await insertCounterparty(s)
    const invoiceId = await insertBookedInvoice(s, counterparty.customerId, { total: 999.75, issueRounding: 0.25 })
    const supplierInvoiceId = await insertRegisteredSupplierInvoice(s, counterparty.supplierId, { total: 4012.13 })
    const { rows } = await getPool().query('SELECT journal_entry_id FROM public.invoices WHERE id = $1', [invoiceId])
    return { pair: { invoiceId, supplierInvoiceId }, issueEntryId: rows[0].journal_entry_id as string }
  }

  it('set off for the rounded Att betala: 1510 credited all it carries, nothing on 3740, and a storno gives it back', async () => {
    const s = await seedCompany()
    const { pair, issueEntryId } = await issuedRounded(s)
    const setoffId = randomUUID()

    const result = await bookAsService(s, pair, { setoffId, amount: 1000 })
    expect(result).toMatchObject({ ok: true, ore_rounding: 0, invoice: { status: 'paid', remaining_amount: 0 } })
    expect(await voucherLines(result.journal_entry_id!)).toEqual([
      ['2440', 1000, 0],
      ['1510', 0, 1000],
    ])
    expect(await balance('1510', [issueEntryId, result.journal_entry_id!])).toBe(0)
    expect(await balance('3740', [issueEntryId, result.journal_entry_id!])).toBe(-0.25)
    // The debt settled, as before: the invoice's own amounts.
    expect(Number((await invoiceState(pair.invoiceId)).paid_amount)).toBe(999.75)
    expect(Number((await supplierInvoiceState(pair.supplierInvoiceId)).remaining_amount)).toBe(3012.13)

    const stornoId = await insertStorno(s, result.journal_entry_id!)
    expect(await reverseAsService(s, setoffId, stornoId)).toMatchObject({ ok: true })
    const restored = await invoiceState(pair.invoiceId)
    expect(Number(restored.paid_amount)).toBe(0)
    expect(Number(restored.remaining_amount)).toBe(999.75)
    expect(await balance('1510', [issueEntryId, result.journal_entry_id!, stornoId])).toBe(1000)
  })

  it('set off for the exact remaining amount: Dr 3740 takes the issue öre back and 1510 ends at zero', async () => {
    const s = await seedCompany()
    const { pair, issueEntryId } = await issuedRounded(s)

    const result = await bookAsService(s, pair, { amount: 999.75 })
    expect(result).toMatchObject({ ok: true, ore_rounding: 0.25, invoice: { status: 'paid' } })
    expect(await voucherLines(result.journal_entry_id!)).toEqual([
      ['2440', 999.75, 0],
      ['1510', 0, 1000],
      ['3740', 0.25, 0],
    ])
    expect(await balance('1510', [issueEntryId, result.journal_entry_id!])).toBe(0)
    expect(await balance('3740', [issueEntryId, result.journal_entry_id!])).toBe(0)
  })

  it('a part set-off clears its own kronor and leaves the öre on 1510 for the settlement', async () => {
    const s = await seedCompany()
    const { pair, issueEntryId } = await issuedRounded(s)

    const result = await bookAsService(s, pair, { amount: 500 })
    expect(result).toMatchObject({ ok: true, invoice: { status: 'partially_paid', remaining_amount: 499.75 } })
    expect(await voucherLines(result.journal_entry_id!)).toEqual([
      ['2440', 500, 0],
      ['1510', 0, 500],
    ])
    expect(await balance('1510', [issueEntryId, result.journal_entry_id!])).toBe(500)
  })
})
