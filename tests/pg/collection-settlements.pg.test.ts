import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Collected payments and payouts (20261021120000_collection_settlements.sql):
 * the three tables (shape guards, uniqueness, RLS and grants), the RESTRICT
 * references that keep a booked voucher and its archived underlag, the
 * source type collection_settlement with one live payout voucher per
 * settlement, the collections payment row unique per provider payment, the
 * disconnect obligation counts, and the sandbox teardown.
 */

interface Seed {
  companyId: string
  userId: string
  fiscalPeriodId: string
}

async function insertConnection(seed: Pick<Seed, 'companyId' | 'userId'>, route: 'connect' | 'fake' = 'connect'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_connections
       (company_id, user_id, route, provider_ref, display_name, state,
        catalogue_terms_version, consented_by, consented_at, activated_at, ladder_mode)
     VALUES ($1, $2, $3, 'acme-inkasso', 'Acme Inkasso', 'active', 'v1', $2, now(), now(), 'off')
     RETURNING id`,
    [seed.companyId, seed.userId, route],
  )
  return rows[0]!.id
}

async function insertInvoice(seed: Pick<Seed, 'companyId' | 'userId'>): Promise<string> {
  const id = randomUUID()
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
    [id, seed.userId, seed.companyId, customerId, `T-${id.slice(0, 8)}`],
  )
  return id
}

async function insertCase(params: { companyId: string; invoiceId: string; connectionId: string }): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_cases
       (company_id, invoice_id, connection_id, origin, start_step, submission_status, provider_case_ref,
        stage, claim_amount, outstanding_principal, bank_check)
     VALUES ($1, $2, $3, 'handover', 'reminder', 'registered', $4, 'reminder', 1000, 1000, '{"outcome":"pass"}'::jsonb)
     RETURNING id`,
    [params.companyId, params.invoiceId, params.connectionId, `ref-${randomUUID()}`],
  )
  return rows[0]!.id
}

async function insertDocument(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'avrakning.pdf', 'application/pdf', 1024, $4, $5, 'system')`,
    [id, userId, companyId, `documents/${companyId}/${id}.pdf`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
  )
  return id
}

async function world(options: { route?: 'connect' | 'fake' } = {}) {
  const seed = await seedCompany()
  const connectionId = await insertConnection(seed, options.route)
  const invoiceId = await insertInvoice(seed)
  const caseId = await insertCase({ companyId: seed.companyId, invoiceId, connectionId })
  return { ...seed, connectionId, invoiceId, caseId }
}

type World = Awaited<ReturnType<typeof world>>

async function insertCollected(w: World, cols: Record<string, unknown> = {}): Promise<string> {
  const base: Record<string, unknown> = {
    company_id: w.companyId,
    case_id: w.caseId,
    invoice_id: w.invoiceId,
    provider_payment_ref: `pay-${randomUUID()}`,
    paid_at: '2026-07-02',
    total: 1100,
    capital_paid: 1000,
    to_agency: 100,
    ...cols,
  }
  const keys = Object.keys(base)
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_collected_payments (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map((k) => base[k]),
  )
  return rows[0]!.id
}

async function insertSettlement(w: World, cols: Record<string, unknown> = {}): Promise<string> {
  const base: Record<string, unknown> = {
    company_id: w.companyId,
    connection_id: w.connectionId,
    provider_settlement_ref: `stl-${randomUUID()}`,
    payment_date: '2026-07-05',
    amount: 875,
    currency: 'SEK',
    provider_status_ok: true,
    ...cols,
  }
  const keys = Object.keys(base)
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_settlements (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map((k) => base[k]),
  )
  return rows[0]!.id
}

async function insertLine(w: World, settlementId: string, cols: Record<string, unknown> = {}): Promise<string> {
  const base: Record<string, unknown> = {
    company_id: w.companyId,
    settlement_id: settlementId,
    position: 0,
    kind: 'principal',
    in_payout: true,
    recipient: 'creditor',
    amount: 1000,
    provider_type: 'Capital/Creditor/CreditorMainClaim',
    case_id: w.caseId,
    invoice_id: w.invoiceId,
    account_number: '1689',
    ...cols,
  }
  const keys = Object.keys(base)
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_settlement_lines (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map((k) => base[k]),
  )
  return rows[0]!.id
}

async function postedEntry(w: World, sourceType: string, sourceId: string | null = null): Promise<string> {
  return insertPostedJournalEntry({
    userId: w.userId,
    companyId: w.companyId,
    fiscalPeriodId: w.fiscalPeriodId,
    sourceType,
    sourceId,
    lines: [
      { accountNumber: '1930', debitAmount: 875, creditAmount: 0 },
      { accountNumber: '1689', debitAmount: 0, creditAmount: 875 },
    ],
  })
}

async function obligations(companyId: string) {
  const { rows } = await getPool().query<{ open_cases: number; unbooked_collected_payments: number; unbooked_settlements: number }>(
    `SELECT * FROM public.collection_obligation_counts($1)`,
    [companyId],
  )
  return rows[0]!
}

describe('collection_collected_payments (pg)', () => {
  it('holds one row per case and provider payment, on its own case and invoice', async () => {
    const w = await world()
    const ref = `pay-${randomUUID()}`
    await insertCollected(w, { provider_payment_ref: ref })
    await expect(insertCollected(w, { provider_payment_ref: ref })).rejects.toThrow(/collection_collected_payments_once/)

    const other = await world()
    await expect(insertCollected(w, { invoice_id: other.invoiceId })).rejects.toThrow(/same company and invoice/)
    await expect(insertCollected(w, { company_id: other.companyId })).rejects.toThrow(/same company and invoice/)
    await expect(insertCollected(w, { capital_paid: -1 })).rejects.toThrow(/check/i)
  })

  it('keeps its identity and states its booking and review shapes', async () => {
    const w = await world()
    const id = await insertCollected(w)
    await expect(
      getPool().query(`UPDATE public.collection_collected_payments SET provider_payment_ref = 'other' WHERE id = $1`, [id]),
    ).rejects.toThrow(/keeps its company, case, invoice and provider reference/)
    await expect(
      getPool().query(`UPDATE public.collection_collected_payments SET status = 'booked' WHERE id = $1`, [id]),
    ).rejects.toThrow(/collection_collected_payments_booked_shape/)
    await expect(
      getPool().query(`UPDATE public.collection_collected_payments SET status = 'needs_review' WHERE id = $1`, [id]),
    ).rejects.toThrow(/collection_collected_payments_review_shape/)
    await getPool().query(
      `UPDATE public.collection_collected_payments SET status = 'needs_review', review_reason = 'INVOICE_PAID_BOOK_FAILED' WHERE id = $1`,
      [id],
    )
  })

  it('keeps the voucher and the payment record it was booked with', async () => {
    const w = await world()
    const entryId = await postedEntry(w, 'invoice_paid', w.invoiceId)
    const documentId = await insertDocument(w.userId, w.companyId)
    const id = await insertCollected(w)
    await getPool().query(
      `UPDATE public.collection_collected_payments
          SET status = 'booked', booked_at = now(), invoice_payment_id = $2, journal_entry_id = $3, payment_record_document_id = $4
        WHERE id = $1`,
      [id, randomUUID(), entryId, documentId],
    )
    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId]),
    ).rejects.toThrow(/foreign key|violates|blocked|refus/i)
  })

  it('allows one collections payment row per invoice and provider payment', async () => {
    const w = await world()
    const insert = (ref: string | null, source: string) =>
      getPool().query(
        `INSERT INTO public.invoice_payments (user_id, company_id, invoice_id, payment_date, amount, currency, source, external_ref)
         VALUES ($1, $2, $3, '2026-07-02', 100, 'SEK', $4, $5)`,
        [w.userId, w.companyId, w.invoiceId, source, ref],
      )
    await insert('pay-1', 'collections')
    await expect(insert('pay-1', 'collections')).rejects.toThrow(/invoice_payments_collections_ref_unique/)
    // Another source with the same reference, or a row without one, is not affected.
    await insert('pay-1', 'bank')
    await insert(null, 'collections')
    await insert(null, 'collections')
  })
})

describe('collection_settlements and lines (pg)', () => {
  it('holds one row per company and provider settlement, on a connection of the same company', async () => {
    const w = await world()
    const ref = `stl-${randomUUID()}`
    await insertSettlement(w, { provider_settlement_ref: ref })
    await expect(insertSettlement(w, { provider_settlement_ref: ref })).rejects.toThrow(/collection_settlements_once/)
    const other = await world()
    await expect(insertSettlement(w, { connection_id: other.connectionId })).rejects.toThrow(/same company/)
    // Another company may hold the same provider reference.
    await insertSettlement(other, { provider_settlement_ref: ref })
  })

  it('keeps what the provider said and states the booked and mapping shapes', async () => {
    const w = await world()
    const id = await insertSettlement(w)
    await expect(getPool().query(`UPDATE public.collection_settlements SET amount = 1 WHERE id = $1`, [id])).rejects.toThrow(
      /keeps its company, connection, reference, amount, date and currency/,
    )
    await expect(getPool().query(`UPDATE public.collection_settlements SET status = 'booked' WHERE id = $1`, [id])).rejects.toThrow(
      /collection_settlements_booked_shape/,
    )
    await expect(getPool().query(`UPDATE public.collection_settlements SET status = 'needs_mapping' WHERE id = $1`, [id])).rejects.toThrow(
      /collection_settlements_mapping_shape/,
    )
    await getPool().query(`UPDATE public.collection_settlements SET status = 'needs_mapping', needs_mapping_reason = 'vat_unconfirmed' WHERE id = $1`, [id])
  })

  it('keeps the payout voucher and the settlement PDF; lines go with their settlement', async () => {
    const w = await world()
    const id = await insertSettlement(w)
    await insertLine(w, id)
    await insertLine(w, id, { position: 1, kind: 'agency_commission', recipient: 'agency', amount: 125, tax_amount: 31.25, case_id: null, invoice_id: null, account_number: '6062' })
    const entryId = await postedEntry(w, 'collection_settlement', id)
    const documentId = await insertDocument(w.userId, w.companyId)
    await getPool().query(
      `UPDATE public.collection_settlements SET status = 'booked', journal_entry_id = $2, booked_at = now(), document_attachment_id = $3 WHERE id = $1`,
      [id, entryId, documentId],
    )
    await expect(getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [documentId])).rejects.toThrow(
      /foreign key|violates|blocked|refus/i,
    )
    await getPool().query(
      `UPDATE public.collection_settlements SET status = 'ignored', ignored_reason = 'x', ignored_by = $2, ignored_at = now(),
              journal_entry_id = NULL, booked_at = NULL, document_attachment_id = NULL WHERE id = $1`,
      [id, w.userId],
    )
    await getPool().query(`DELETE FROM public.collection_settlements WHERE id = $1`, [id])
    const { rows } = await getPool().query(`SELECT 1 FROM public.collection_settlement_lines WHERE settlement_id = $1`, [id])
    expect(rows).toHaveLength(0)
  })

  it('a booked payout whose voucher was reversed goes back to a person (the release after a storno)', async () => {
    const w = await world()
    const id = await insertSettlement(w)
    await insertLine(w, id, { booked: true })
    const entryId = await postedEntry(w, 'collection_settlement', id)
    const documentId = await insertDocument(w.userId, w.companyId)
    const collectedId = await insertCollected(w, { settlement_id: id })
    await getPool().query(
      `UPDATE public.collection_settlements SET status = 'booked', journal_entry_id = $2, booked_at = now(), document_attachment_id = $3,
              provider_acknowledged_at = now() WHERE id = $1`,
      [id, entryId, documentId],
    )
    // The same writes as lib/collections/settlement-reversal.ts, in its order.
    await getPool().query(`UPDATE public.collection_collected_payments SET settlement_id = NULL WHERE company_id = $1 AND settlement_id = $2`, [w.companyId, id])
    await getPool().query(`UPDATE public.collection_settlement_lines SET booked = false WHERE company_id = $1 AND settlement_id = $2`, [w.companyId, id])
    await getPool().query(
      `UPDATE public.collection_settlements SET status = 'needs_mapping', needs_mapping_reason = 'voucher_reversed', journal_entry_id = NULL,
              booked_at = NULL, booked_by = NULL, document_attachment_id = NULL, provider_acknowledged_at = NULL, booking_lease_until = NULL
        WHERE company_id = $1 AND id = $2 AND journal_entry_id = $3`,
      [w.companyId, id, entryId],
    )
    const { rows } = await getPool().query<{ status: string; journal_entry_id: string | null }>(
      `SELECT status, journal_entry_id FROM public.collection_settlements WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ status: 'needs_mapping', journal_entry_id: null })
    const { rows: collected } = await getPool().query<{ settlement_id: string | null }>(
      `SELECT settlement_id FROM public.collection_collected_payments WHERE id = $1`,
      [collectedId],
    )
    expect(collected[0]!.settlement_id).toBeNull()
    expect((await obligations(w.companyId)).unbooked_settlements).toBe(1)
  })

  it('a line names only a case and an invoice of its own company, keeps its amounts, and takes a four-digit account', async () => {
    const w = await world()
    const other = await world()
    const id = await insertSettlement(w)
    await expect(insertLine(w, id, { case_id: other.caseId, invoice_id: null })).rejects.toThrow(/case of the same company/)
    await expect(insertLine(w, id, { case_id: null, invoice_id: other.invoiceId })).rejects.toThrow(/invoice of the same company/)
    await expect(insertLine(w, id, { account_number: '19300' })).rejects.toThrow(/check/i)
    await expect(insertLine(w, id, { kind: 'bonus' })).rejects.toThrow(/check/i)
    const lineId = await insertLine(w, id)
    await expect(insertLine(w, id)).rejects.toThrow(/collection_settlement_lines_position/)
    await expect(getPool().query(`UPDATE public.collection_settlement_lines SET amount = 1 WHERE id = $1`, [lineId])).rejects.toThrow(
      /keeps its settlement, position, kind and amounts/,
    )
    // The account may be chosen by a person.
    await getPool().query(`UPDATE public.collection_settlement_lines SET account_number = '6062', account_chosen_by = $2 WHERE id = $1`, [lineId, w.userId])
  })

  it('a collected payment points at the payout that paid it out; removing the payout clears the link', async () => {
    const w = await world()
    const settlementId = await insertSettlement(w)
    const id = await insertCollected(w, { settlement_id: settlementId })
    await getPool().query(`DELETE FROM public.collection_settlements WHERE id = $1`, [settlementId])
    const { rows } = await getPool().query<{ settlement_id: string | null }>(`SELECT settlement_id FROM public.collection_collected_payments WHERE id = $1`, [id])
    expect(rows[0]!.settlement_id).toBeNull()
  })
})

describe('journal_entries.source_type: collection_settlement (pg)', () => {
  it('accepts the source type and allows one live payout voucher per settlement', async () => {
    const w = await world()
    const settlementId = await insertSettlement(w)
    await postedEntry(w, 'collection_settlement', settlementId)
    await expect(postedEntry(w, 'collection_settlement', settlementId)).rejects.toThrow(/journal_entries_collection_settlement_live_unique/)
    // Another settlement, or a voucher without a source, is not affected.
    await postedEntry(w, 'collection_settlement', await insertSettlement(w))
    await postedEntry(w, 'collection_settlement', null)
    await expect(postedEntry(w, 'collection_settlement_x', null)).rejects.toThrow(/journal_entries_source_type_check/)
  })
})

describe('RLS and grants (pg)', () => {
  it("members read their own company's rows only and write none", async () => {
    const w = await world()
    await insertCollected(w)
    const settlementId = await insertSettlement(w)
    await insertLine(w, settlementId)
    const outsider = await insertAuthUser()
    const otherCompany = await seedCompany()
    await insertCompanyMember({ companyId: otherCompany.companyId, userId: outsider, role: 'owner' })

    for (const table of ['collection_collected_payments', 'collection_settlements', 'collection_settlement_lines']) {
      await withUserContext(w.userId, async (client) => {
        expect((await client.query(`SELECT 1 FROM public.${table} WHERE company_id = $1`, [w.companyId])).rows).toHaveLength(1)
        await expect(client.query(`DELETE FROM public.${table} WHERE company_id = $1`, [w.companyId])).rejects.toThrow(
          /permission denied|row-level security/,
        )
      })
      await withUserContext(outsider, async (client) => {
        expect((await client.query(`SELECT 1 FROM public.${table} WHERE company_id = $1`, [w.companyId])).rows).toHaveLength(0)
      })
      const { rows } = await getPool().query<Record<string, boolean>>(
        `SELECT has_table_privilege('anon', 'public.${table}', 'SELECT') AS anon_select,
                has_table_privilege('authenticated', 'public.${table}', 'UPDATE') AS auth_update,
                has_table_privilege('authenticated', 'public.${table}', 'SELECT') AS auth_select,
                has_table_privilege('service_role', 'public.${table}', 'INSERT') AS service_insert`,
      )
      expect(rows[0]).toEqual({ anon_select: false, auth_update: false, auth_select: true, service_insert: true })
    }
  })
})

describe('collection_obligation_counts (pg)', () => {
  it('counts unbooked collected payments and settlements, and lets booked or ignored ones go', async () => {
    const w = await world()
    await getPool().query(`UPDATE public.collection_cases SET is_open = false, stage = 'closed_paid', close_reason = 'paid', closed_at = now() WHERE id = $1`, [w.caseId])
    expect(await obligations(w.companyId)).toEqual({ open_cases: 0, unbooked_collected_payments: 0, unbooked_settlements: 0 })

    const collectedId = await insertCollected(w)
    const settlementId = await insertSettlement(w)
    expect(await obligations(w.companyId)).toEqual({ open_cases: 0, unbooked_collected_payments: 1, unbooked_settlements: 1 })

    await getPool().query(`UPDATE public.collection_collected_payments SET status = 'needs_review', review_reason = 'x' WHERE id = $1`, [collectedId])
    await getPool().query(`UPDATE public.collection_settlements SET status = 'needs_mapping', needs_mapping_reason = 'x' WHERE id = $1`, [settlementId])
    expect(await obligations(w.companyId)).toEqual({ open_cases: 0, unbooked_collected_payments: 1, unbooked_settlements: 1 })

    await getPool().query(`UPDATE public.collection_collected_payments SET status = 'ignored' WHERE id = $1`, [collectedId])
    await getPool().query(
      `UPDATE public.collection_settlements SET status = 'ignored', ignored_reason = 'x', ignored_by = $2, ignored_at = now() WHERE id = $1`,
      [settlementId, w.userId],
    )
    expect(await obligations(w.companyId)).toEqual({ open_cases: 0, unbooked_collected_payments: 0, unbooked_settlements: 0 })
  })

  it('an unbooked settlement holds the connection against disconnect', async () => {
    const w = await world()
    await getPool().query(`UPDATE public.collection_cases SET is_open = false, stage = 'closed_paid', close_reason = 'paid', closed_at = now() WHERE id = $1`, [w.caseId])
    await insertSettlement(w)
    await expect(
      getPool().query(`UPDATE public.collection_connections SET state = 'disconnected', ended_at = now(), ended_by = $2 WHERE id = $1`, [
        w.connectionId,
        w.userId,
      ]),
    ).rejects.toThrow(/COLLECTIONS_DISCONNECT_BLOCKED: 0 open cases, 0 unbooked collected payments, 1 unbooked settlements/)
  })
})

describe('sandbox teardown (pg)', () => {
  it("removes a sandbox company's booked collected payments and settlements with their vouchers and documents", async () => {
    const sandbox = await seedCompany()
    await getPool().query(`INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)`, [sandbox.userId, sandbox.companyId])
    const connectionId = await insertConnection(sandbox, 'fake')
    const invoiceId = await insertInvoice(sandbox)
    const caseId = await insertCase({ companyId: sandbox.companyId, invoiceId, connectionId })
    const w: World = { ...sandbox, connectionId, invoiceId, caseId }

    const paymentEntry = await postedEntry(w, 'invoice_paid', invoiceId)
    const record = await insertDocument(sandbox.userId, sandbox.companyId)
    const collectedId = await insertCollected(w)
    const settlementId = await insertSettlement(w)
    await insertLine(w, settlementId)
    const payoutEntry = await postedEntry(w, 'collection_settlement', settlementId)
    const pdf = await insertDocument(sandbox.userId, sandbox.companyId)
    await getPool().query(
      `UPDATE public.collection_collected_payments
          SET status = 'booked', booked_at = now(), booked_by = $5, invoice_payment_id = $2, journal_entry_id = $3,
              payment_record_document_id = $4, settlement_id = $6
        WHERE id = $1`,
      [collectedId, randomUUID(), paymentEntry, record, sandbox.userId, settlementId],
    )
    await getPool().query(
      `UPDATE public.collection_settlements
          SET status = 'booked', booked_at = now(), booked_by = $4, journal_entry_id = $2, document_attachment_id = $3
        WHERE id = $1`,
      [settlementId, payoutEntry, pdf, sandbox.userId],
    )

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId])
    for (const table of ['collection_collected_payments', 'collection_settlements', 'collection_settlement_lines']) {
      const left = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM public.${table} WHERE company_id = $1`, [sandbox.companyId])
      expect(Number(left.rows[0]!.n)).toBe(0)
    }
  })
})

describe('collection_collected_payments booked as a recovered loss (pg, 20261021120700)', () => {
  it('books a payment on a recovery decision instead of a payment row, never on both and never on neither', async () => {
    const w = await world()
    const entryId = await postedEntry(w, 'customer_loss', randomUUID())
    const id = await insertCollected(w)
    const book = (cols: string) =>
      getPool().query(`UPDATE public.collection_collected_payments SET status = 'booked', booked_at = now(), journal_entry_id = $2, ${cols} WHERE id = $1`, [
        id,
        entryId,
      ])
    await expect(book('write_off_id = NULL, invoice_payment_id = NULL')).rejects.toThrow(/collection_collected_payments_booked_shape/)
    await expect(book(`write_off_id = '${randomUUID()}', invoice_payment_id = '${randomUUID()}'`)).rejects.toThrow(
      /collection_collected_payments_one_booking/,
    )
    const writeOffId = randomUUID()
    await book(`write_off_id = '${writeOffId}', invoice_payment_id = NULL`)
    const { rows } = await getPool().query<{ status: string; write_off_id: string | null }>(
      `SELECT status, write_off_id FROM public.collection_collected_payments WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ status: 'booked', write_off_id: writeOffId })
  })
})
