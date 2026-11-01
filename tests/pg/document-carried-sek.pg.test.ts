import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * public.document_carried_sek: what a foreign document still carries on the
 * ledger, read off the vouchers linked to it. The rule moved here from the
 * manual supplier door so the SQL door can read it too; every shape that door
 * pinned on a mocked client stands on real vouchers now, on both ledgers.
 */

type Company = Awaited<ReturnType<typeof seedCompany>>
type Side = 'customer' | 'supplier'

let company: Company

beforeEach(async () => {
  company = await seedCompany()
})

const LEDGER: Record<Side, string> = { customer: '1510', supplier: '2440' }

/** A verifikat that puts `sek` on the ledger of the side (registration) or takes it off (payment). */
function voucher(side: Side, sek: number, kind: 'registration' | 'payment', extra: Record<string, unknown> = {}) {
  const onLedger =
    (side === 'customer') === (kind === 'registration')
      ? { accountNumber: LEDGER[side], debitAmount: sek, creditAmount: 0 }
      : { accountNumber: LEDGER[side], debitAmount: 0, creditAmount: sek }
  const against =
    onLedger.debitAmount > 0
      ? { accountNumber: '1930', debitAmount: 0, creditAmount: sek }
      : { accountNumber: '1930', debitAmount: sek, creditAmount: 0 }
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    entryDate: '2026-06-01',
    lines: [onLedger, against],
    ...extra,
  })
}

let seq = 900_000

async function document(
  side: Side,
  params: { registration?: string | null; total?: number; paid?: number; remaining?: number; rate?: number | null },
): Promise<string> {
  const id = randomUUID()
  const total = params.total ?? 37.5
  const paid = params.paid ?? 0
  const remaining = params.remaining ?? total - paid
  const rate = params.rate === undefined ? 9.6414 : params.rate
  const status = paid > 0 ? 'partially_paid' : side === 'customer' ? 'sent' : 'approved'
  seq += 1
  if (side === 'customer') {
    const customer = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, country) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', 'SE')`,
      [customer, company.userId, company.companyId],
    )
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, currency, exchange_rate,
          subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment, journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, '2026-06-01', '2026-07-01', $6, 'USD', $7, $8, 0, $8, $9, $10, 'export', $11)`,
      [id, company.userId, company.companyId, customer, `F-${seq}`, status, rate, total, paid, remaining, params.registration ?? null],
    )
  } else {
    const supplier = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
       VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
      [supplier, company.userId, company.companyId],
    )
    await getPool().query(
      `INSERT INTO public.supplier_invoices
         (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
          invoice_date, due_date, received_date, status, currency, exchange_rate,
          subtotal, vat_amount, total, paid_amount, remaining_amount,
          vat_treatment, reverse_charge, is_credit_note, registration_journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-06-01', '2026-07-01', '2026-06-01', $7, 'USD', $8,
               $9, 0, $9, $10, $11, 'standard_25', false, false, $12)`,
      [id, company.userId, company.companyId, supplier, seq, `LF-${seq}`, status, rate, total, paid, remaining, params.registration ?? null],
    )
  }
  return id
}

async function paymentRow(side: Side, documentId: string, amount: number, journalEntryId: string | null) {
  const table = side === 'customer' ? 'invoice_payments' : 'supplier_invoice_payments'
  const column = side === 'customer' ? 'invoice_id' : 'supplier_invoice_id'
  await getPool().query(
    `INSERT INTO public.${table} (user_id, company_id, ${column}, payment_date, amount, currency, journal_entry_id)
     VALUES ($1, $2, $3, '2026-06-05', $4, 'USD', $5)`,
    [company.userId, company.companyId, documentId, amount, journalEntryId],
  )
}

async function carried(side: Side, documentId: string, companyId = company.companyId) {
  const { rows } = await getPool().query<{ result: Record<string, unknown> }>(
    'SELECT public.document_carried_sek($1, $2, $3) AS result',
    [companyId, side, documentId],
  )
  return rows[0].result
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

describe.each(['customer', 'supplier'] as const)('%s side', (side) => {
  it('reads the registration, not the rate: per-line rounding to the öre', async () => {
    const registration = await voucher(side, 742.12, 'registration')
    const id = await document(side, { registration, total: 76.97, rate: 9.6418 })
    expect(await carried(side, id)).toEqual({ ok: true, sek: 742.12 })
  })

  it('takes off what a payment voucher cleared, as booked', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const payment = await voucher(side, 125, 'payment')
    const id = await document(side, { registration, paid: 12.5 })
    await paymentRow(side, id, 12.5, payment)
    expect(await carried(side, id)).toEqual({ ok: true, sek: 236.55 })
  })

  it('follows a stornoed registration to its correction, whose ledger line is the debt now', async () => {
    const registration = await voucher(side, 37.5, 'registration')
    const correction = await voucher(side, 361.55, 'registration')
    await reverse(registration, correction)
    const id = await document(side, { registration })
    expect(await carried(side, id)).toEqual({ ok: true, sek: 361.55 })
  })

  it('follows a stornoed payment voucher to its correction', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const payment = await voucher(side, 130, 'payment')
    const correction = await voucher(side, 125, 'payment')
    await reverse(payment, correction)
    const id = await document(side, { registration, paid: 12.5 })
    await paymentRow(side, id, 12.5, payment)
    expect(await carried(side, id)).toEqual({ ok: true, sek: 236.55 })
  })

  it('a document with no registration answers the reason', async () => {
    const id = await document(side, { registration: null })
    expect(await carried(side, id)).toEqual({ ok: false, reason: 'no_registration_voucher' })
  })

  it('a registration stornoed with no correction is not live', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    await reverse(registration, null)
    const id = await document(side, { registration })
    expect(await carried(side, id)).toEqual({ ok: false, reason: 'registration_voucher_not_live' })
  })

  it('a registration another document names is shared', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const id = await document(side, { registration })
    await document(side, { registration })
    expect(await carried(side, id)).toEqual({ ok: false, reason: 'registration_voucher_shared' })
  })

  it('payment rows that do not add up to paid_amount are a mismatch', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const payment = await voucher(side, 125, 'payment')
    const id = await document(side, { registration, paid: 12.5 })
    await paymentRow(side, id, 10, payment)
    expect(await carried(side, id)).toEqual({ ok: false, reason: 'payment_history_mismatch' })
  })

  it('a payment row with no voucher is a mismatch', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const id = await document(side, { registration, paid: 12.5 })
    await paymentRow(side, id, 12.5, null)
    expect(await carried(side, id)).toEqual({ ok: false, reason: 'payment_history_mismatch' })
  })

  it('a payment voucher stornoed with no correction is not posted', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const payment = await voucher(side, 125, 'payment')
    await reverse(payment, null)
    const id = await document(side, { registration, paid: 12.5 })
    await paymentRow(side, id, 12.5, payment)
    expect(await carried(side, id)).toEqual({ ok: false, reason: 'payment_voucher_not_posted' })
  })

  it('a batch voucher that also settles another document is shared', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const payment = await voucher(side, 250, 'payment')
    const id = await document(side, { registration, paid: 12.5 })
    const other = await document(side, { registration: await voucher(side, 361.55, 'registration'), paid: 12.5 })
    await paymentRow(side, id, 12.5, payment)
    await paymentRow(side, other, 12.5, payment)
    expect(await carried(side, id)).toEqual({ ok: false, reason: 'payment_voucher_shared' })
  })

  it('nothing left on the ledger of an open document answers the reason', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const payment = await voucher(side, 361.55, 'payment')
    const id = await document(side, { registration, paid: 12.5 })
    await paymentRow(side, id, 12.5, payment)
    expect(await carried(side, id)).toEqual({ ok: false, reason: 'no_liability_left' })
  })

  it('a ledger past the limit from the document is a rättelse of the debt, not a rate', async () => {
    // 99.58 USD at 9.2738 owes 923.49 kr; the rättelse left 738.75 kr.
    const registration = await voucher(side, 738.75, 'registration')
    const id = await document(side, { registration, total: 99.58, rate: 9.2738 })
    expect(await carried(side, id)).toEqual({
      ok: false,
      reason: 'ledger_rate_mismatch',
      expected_sek: 923.49,
      ledger_sek: 738.75,
    })
  })

  it('a ledger inside the limit answers what it says', async () => {
    // 37.50 x 9.6414 = 361.55; the registration carries 330 kr, 8.7 % off.
    const registration = await voucher(side, 330, 'registration')
    const id = await document(side, { registration })
    expect(await carried(side, id)).toEqual({ ok: true, sek: 330 })
  })

  it('a document with no rate cannot stray from one', async () => {
    const registration = await voucher(side, 100, 'registration')
    const id = await document(side, { registration, rate: null })
    expect(await carried(side, id)).toEqual({ ok: true, sek: 100 })
  })

  it('more payment rows than any real document are refused', async () => {
    const registration = await voucher(side, 3615.5, 'registration')
    const id = await document(side, { registration, total: 375, paid: 51 })
    for (let i = 0; i < 51; i++) await paymentRow(side, id, 1, await voucher(side, 9, 'payment'))
    expect(await carried(side, id)).toEqual({ ok: false, reason: 'ledger_history_too_long' })
  })

  it('stays inside the company: another company asking finds no document', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const id = await document(side, { registration })
    const other = await seedCompany()
    expect(await carried(side, id, other.companyId)).toEqual({ ok: false, reason: 'document_not_found' })
  })

  it('reads as the caller: RLS hides another company from a member', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const id = await document(side, { registration })
    const other = await seedCompany()
    const result = await withUserContext(other.userId, async (client) => {
      const { rows } = await client.query<{ result: unknown }>('SELECT public.document_carried_sek($1, $2, $3) AS result', [
        company.companyId,
        side,
        id,
      ])
      return rows[0].result
    })
    expect(result).toEqual({ ok: false, reason: 'document_not_found' })
  })

  it('a member reads their own document', async () => {
    const registration = await voucher(side, 361.55, 'registration')
    const id = await document(side, { registration })
    const result = await withUserContext(company.userId, async (client) => {
      const { rows } = await client.query<{ result: unknown }>('SELECT public.document_carried_sek($1, $2, $3) AS result', [
        company.companyId,
        side,
        id,
      ])
      return rows[0].result
    })
    expect(result).toEqual({ ok: true, sek: 361.55 })
  })
})

describe('the supplier ledger', () => {
  it('counts two rows on one voucher once', async () => {
    const registration = await voucher('supplier', 361.55, 'registration')
    const payment = await voucher('supplier', 125, 'payment')
    const id = await document('supplier', { registration, paid: 12.5 })
    await paymentRow('supplier', id, 5, payment)
    await paymentRow('supplier', id, 7.5, payment)
    expect(await carried('supplier', id)).toEqual({ ok: true, sek: 236.55 })
  })
})

describe('the customer ledger', () => {
  it("leaves 1513 out: Skatteverket's share is never the customer's to pay", async () => {
    const registration = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      entryDate: '2026-06-01',
      lines: [
        { accountNumber: '1510', debitAmount: 300, creditAmount: 0 },
        { accountNumber: '1513', debitAmount: 61.55, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 361.55 },
      ],
    })
    const id = await document('customer', { registration, remaining: 31.12 })
    expect(await carried('customer', id)).toEqual({ ok: true, sek: 300 })
  })
})

describe('the API roles', () => {
  it('anon cannot run it', async () => {
    const { rows } = await getPool().query<{ can: boolean }>(
      `SELECT has_function_privilege('anon', 'public.document_carried_sek(uuid, text, uuid)', 'EXECUTE') AS can`,
    )
    expect(rows[0].can).toBe(false)
  })

  it('authenticated and the service role can, and need no helper they cannot reach', async () => {
    for (const role of ['authenticated', 'service_role']) {
      const { rows } = await getPool().query<{ carried: boolean; live: boolean; limit: boolean }>(
        `SELECT has_function_privilege($1, 'public.document_carried_sek(uuid, text, uuid)', 'EXECUTE') AS carried,
                has_function_privilege($1, 'public.live_journal_entry(uuid, uuid)', 'EXECUTE') AS live,
                has_function_privilege($1, 'public.fx_deviation_too_large(numeric, numeric)', 'EXECUTE') AS limit`,
        [role],
      )
      expect(rows[0]).toEqual({ carried: true, live: true, limit: true })
    }
  })

  it('the helpers only match_batch_allocate reads stay out of the API', async () => {
    const { rows } = await getPool().query<{ residual: boolean; clearing: boolean }>(
      `SELECT has_function_privilege('authenticated', 'public.ore_settlement_residual(numeric, numeric)', 'EXECUTE') AS residual,
              has_function_privilege('authenticated', 'public.document_clearing_sek(uuid, text, uuid, numeric, numeric)', 'EXECUTE') AS clearing`,
    )
    expect(rows[0]).toEqual({ residual: false, clearing: false })
  })
})
