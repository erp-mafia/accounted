import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * The collections rebook (20261021120200_collections_rebook.sql):
 * collections_rebook_release is the one way a payment the collections
 * provider collected leaves the books, and only for a C voucher a posted
 * storno reversed. The generic storno path stays refused at the payment row
 * (block_delete_collected_payment), with or without a storno, and the
 * function refuses every case but its own: another company's payment, a
 * payment not booked, a voucher not reversed by a posted storno, a payment a
 * booked payout settled, a payment row that is not the voucher's. It is not
 * callable by a signed-in user, and the window it opens closes again inside
 * the same transaction.
 */

async function world() {
  const seed = await seedCompany()
  const { rows: connection } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_connections
       (company_id, user_id, route, provider_ref, display_name, state,
        catalogue_terms_version, consented_by, consented_at, activated_at, ladder_mode)
     VALUES ($1, $2, 'connect', 'acme-inkasso', 'Acme Inkasso', 'active', 'v1', $2, now(), now(), 'off')
     RETURNING id`,
    [seed.companyId, seed.userId],
  )
  const invoiceId = randomUUID()
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, seed.userId, seed.companyId],
  )
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_date, due_date, currency, vat_treatment, vat_rate,
        subtotal, vat_amount, total, status, invoice_number)
     VALUES ($1, $2, $3, $4, '2026-06-01', '2026-06-30', 'SEK', 'standard_25', 25, 800, 200, 1000, 'sent', $5)`,
    [invoiceId, seed.userId, seed.companyId, customerId, `T-${invoiceId.slice(0, 8)}`],
  )
  const { rows: caseRows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_cases
       (company_id, invoice_id, connection_id, origin, start_step, submission_status, provider_case_ref,
        stage, claim_amount, outstanding_principal, bank_check)
     VALUES ($1, $2, $3, 'handover', 'reminder', 'registered', $4, 'reminder', 1000, 1000, '{"outcome":"pass"}'::jsonb)
     RETURNING id`,
    [seed.companyId, invoiceId, connection[0]!.id, `ref-${randomUUID()}`],
  )
  return { ...seed, connectionId: connection[0]!.id, invoiceId, caseId: caseRows[0]!.id }
}

type World = Awaited<ReturnType<typeof world>>

/** A booked collected payment: its C voucher (Dr 1689 / Cr 1510) and its collections payment row. */
async function bookedPayment(w: World) {
  const ref = `pay-${randomUUID()}`
  const entryId = await insertPostedJournalEntry({
    userId: w.userId,
    companyId: w.companyId,
    fiscalPeriodId: w.fiscalPeriodId,
    entryDate: '2026-07-02',
    sourceType: 'invoice_paid',
    sourceId: w.invoiceId,
    lines: [
      { accountNumber: '1689', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '1510', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  const { rows: payment } = await getPool().query<{ id: string }>(
    `INSERT INTO public.invoice_payments
       (user_id, company_id, invoice_id, payment_date, amount, currency, source, external_ref, journal_entry_id)
     VALUES ($1, $2, $3, '2026-07-02', 1000, 'SEK', 'collections', $4, $5)
     RETURNING id`,
    [w.userId, w.companyId, w.invoiceId, ref, entryId],
  )
  const { rows: collected } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_collected_payments
       (company_id, case_id, invoice_id, provider_payment_ref, paid_at, total, capital_paid, to_agency,
        status, booked_at, invoice_payment_id, journal_entry_id)
     VALUES ($1, $2, $3, $4, '2026-07-02', 1100, 1000, 100, 'booked', now(), $5, $6)
     RETURNING id`,
    [w.companyId, w.caseId, w.invoiceId, ref, payment[0]!.id, entryId],
  )
  return { ref, entryId, paymentId: payment[0]!.id, collectedId: collected[0]!.id }
}

/** What reverseEntry writes: a balanced storno with reverses_id, posted (or left a draft), then the original flipped to reversed. */
async function storno(w: World, originalId: string, options: { stornoStatus?: 'posted' | 'draft' } = {}): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-07-02', 'Makulering: inbetalning', 'storno', 'draft', $6)`,
      [id, w.userId, w.companyId, w.fiscalPeriodId, 9000 + Math.floor(Math.random() * 900), originalId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT $1, account_number, credit_amount, debit_amount FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [id, originalId],
    )
    if ((options.stornoStatus ?? 'posted') === 'posted') {
      await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  await getPool().query(`UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`, [originalId, id])
  return id
}

function release(companyId: string, collectedId: string) {
  return runAsServiceRole((client) =>
    client.query<{ result: Record<string, string> }>(`SELECT public.collections_rebook_release($1, $2) AS result`, [companyId, collectedId]),
  )
}

async function collected(id: string) {
  const { rows } = await getPool().query(
    `SELECT status, invoice_payment_id, journal_entry_id, payment_record_document_id, booked_at, booked_by,
            booking_lease_until, rebooked_entry_ids
       FROM public.collection_collected_payments WHERE id = $1`,
    [id],
  )
  return rows[0]
}

async function paymentExists(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`SELECT 1 FROM public.invoice_payments WHERE id = $1`, [id])
  return rowCount === 1
}

describe('collections rebook: the generic storno stays refused (pg)', () => {
  it('refuses to delete the collections payment row, before and after a storno of its voucher', async () => {
    const w = await world()
    const p = await bookedPayment(w)
    const remove = () => runAsServiceRole((client) => client.query(`DELETE FROM public.invoice_payments WHERE id = $1`, [p.paymentId]))
    await expect(remove()).rejects.toThrow(/COLLECTED_PAYMENT_DELETE_BLOCKED/)
    // The generic storno's payment sync deletes the row after the voucher is reversed: still refused.
    await storno(w, p.entryId)
    await expect(remove()).rejects.toThrow(/COLLECTED_PAYMENT_DELETE_BLOCKED/)
    expect(await paymentExists(p.paymentId)).toBe(true)
  })

  it('lets a failed settlement remove its row once the voucher is cancelled as an orphan (20261021120600)', async () => {
    const w = await world()
    const p = await bookedPayment(w)
    const remove = () => runAsServiceRole((client) => client.query(`DELETE FROM public.invoice_payments WHERE id = $1`, [p.paymentId]))
    // The settlement lost its race before the collected payment was booked.
    await getPool().query(
      `UPDATE public.collection_collected_payments
          SET status = 'needs_review', review_reason = 'INVOICE_PAID_RACE', booked_at = NULL, invoice_payment_id = NULL, journal_entry_id = NULL
        WHERE id = $1`,
      [p.collectedId],
    )
    // Still posted: refused.
    await expect(remove()).rejects.toThrow(/COLLECTED_PAYMENT_DELETE_BLOCKED/)
    // What cancel_orphaned_entry writes for the fresh orphan voucher.
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_posted_cancel', 'true', true)`)
      await client.query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [p.entryId])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    await remove()
    expect(await paymentExists(p.paymentId)).toBe(false)
  })
})

describe('collections_rebook_release (pg)', () => {
  it('deletes the payment row of a reversed C voucher and puts the payment back to pending', async () => {
    const w = await world()
    const p = await bookedPayment(w)
    const stornoId = await storno(w, p.entryId)
    const { rows } = await release(w.companyId, p.collectedId)
    expect(rows[0]!.result).toEqual({ reversed_entry_id: p.entryId, storno_entry_id: stornoId, invoice_id: w.invoiceId })
    expect(await paymentExists(p.paymentId)).toBe(false)
    expect(await collected(p.collectedId)).toMatchObject({
      status: 'pending',
      invoice_payment_id: null,
      journal_entry_id: null,
      payment_record_document_id: null,
      booked_at: null,
      booked_by: null,
      booking_lease_until: null,
      rebooked_entry_ids: [p.entryId],
    })
    // Once released there is nothing left to release.
    await expect(release(w.companyId, p.collectedId)).rejects.toThrow(/COLLECTIONS_REBOOK_NOT_BOOKED/)
  })

  it('closes the window again inside the same transaction', async () => {
    const w = await world()
    const p = await bookedPayment(w)
    const other = await bookedPayment(w)
    await storno(w, p.entryId)
    await expect(
      runAsServiceRole(async (client) => {
        await client.query(`SELECT public.collections_rebook_release($1, $2)`, [w.companyId, p.collectedId])
        await client.query(`DELETE FROM public.invoice_payments WHERE id = $1`, [other.paymentId])
      }),
    ).rejects.toThrow(/COLLECTED_PAYMENT_DELETE_BLOCKED/)
    // The whole transaction rolled back: the released payment is booked again.
    expect(await paymentExists(p.paymentId)).toBe(true)
    expect(await collected(p.collectedId)).toMatchObject({ status: 'booked', journal_entry_id: p.entryId })
  })

  it('refuses a voucher that no posted storno reversed', async () => {
    const w = await world()
    const posted = await bookedPayment(w)
    await expect(release(w.companyId, posted.collectedId)).rejects.toThrow(/COLLECTIONS_REBOOK_NOT_REVERSED/)
    const draft = await bookedPayment(w)
    await storno(w, draft.entryId, { stornoStatus: 'draft' })
    await expect(release(w.companyId, draft.collectedId)).rejects.toThrow(/COLLECTIONS_REBOOK_NOT_REVERSED/)
    expect(await paymentExists(posted.paymentId)).toBe(true)
    expect(await paymentExists(draft.paymentId)).toBe(true)
  })

  it('refuses another company, a payment not booked, a payment a payout settled and a payment row that is not the voucher\'s', async () => {
    const w = await world()
    const other = await world()
    const p = await bookedPayment(w)
    await storno(w, p.entryId)
    await expect(release(other.companyId, p.collectedId)).rejects.toThrow(/COLLECTIONS_REBOOK_NOT_FOUND/)

    const { rows: pending } = await getPool().query<{ id: string }>(
      `INSERT INTO public.collection_collected_payments (company_id, case_id, invoice_id, provider_payment_ref, paid_at, capital_paid)
       VALUES ($1, $2, $3, $4, '2026-07-02', 500) RETURNING id`,
      [w.companyId, w.caseId, w.invoiceId, `pay-${randomUUID()}`],
    )
    await expect(release(w.companyId, pending[0]!.id)).rejects.toThrow(/COLLECTIONS_REBOOK_NOT_BOOKED/)

    const { rows: settlement } = await getPool().query<{ id: string }>(
      `INSERT INTO public.collection_settlements (company_id, connection_id, provider_settlement_ref, payment_date, amount, currency, provider_status_ok)
       VALUES ($1, $2, $3, '2026-07-05', 875, 'SEK', true) RETURNING id`,
      [w.companyId, w.connectionId, `stl-${randomUUID()}`],
    )
    await getPool().query(`UPDATE public.collection_collected_payments SET settlement_id = $2 WHERE id = $1`, [p.collectedId, settlement[0]!.id])
    await expect(release(w.companyId, p.collectedId)).rejects.toThrow(/COLLECTIONS_REBOOK_SETTLED/)
    await getPool().query(`UPDATE public.collection_collected_payments SET settlement_id = NULL WHERE id = $1`, [p.collectedId])

    // The payment row named on the collected payment must be the collections row on its voucher.
    const { rows: bank } = await getPool().query<{ id: string }>(
      `INSERT INTO public.invoice_payments (user_id, company_id, invoice_id, payment_date, amount, currency, source, external_ref)
       VALUES ($1, $2, $3, '2026-07-02', 1000, 'SEK', 'bank', $4) RETURNING id`,
      [w.userId, w.companyId, w.invoiceId, p.ref],
    )
    await getPool().query(`UPDATE public.collection_collected_payments SET invoice_payment_id = $2 WHERE id = $1`, [p.collectedId, bank[0]!.id])
    await expect(release(w.companyId, p.collectedId)).rejects.toThrow(/COLLECTIONS_REBOOK_PAYMENT_MISMATCH/)
    expect(await paymentExists(p.paymentId)).toBe(true)
    expect(await paymentExists(bank[0]!.id)).toBe(true)
  })

  it('is not callable by a signed-in member', async () => {
    const w = await world()
    const p = await bookedPayment(w)
    await storno(w, p.entryId)
    await expect(
      withUserContext(w.userId, (client) => client.query(`SELECT public.collections_rebook_release($1, $2)`, [w.companyId, p.collectedId])),
    ).rejects.toThrow(/permission denied/)
    expect(await paymentExists(p.paymentId)).toBe(true)
  })
})
