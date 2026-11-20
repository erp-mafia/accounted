import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany, withSwedishToday } from './fixtures'

/**
 * Migration 20261021120700_invoice_write_offs:
 *  - invoices.status accepts 'written_off', entered and left only through
 *    record_invoice_write_off (or its storno annulment)
 *  - journal_entries.source_type accepts 'customer_loss', one live voucher
 *    per decision id
 *  - invoice_write_offs is append-only and written by the RPC, which checks
 *    the voucher against the decision
 *  - pending_operations accepts 'record_customer_loss'
 */

type Seeded = Awaited<ReturnType<typeof seedCompany>>

async function insertInvoice(
  s: Seeded,
  cols: { status?: string; dueDate?: string; paidAmount?: number; currency?: string } = {},
): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, s.userId, s.companyId],
  )
  const id = randomUUID()
  const paid = cols.paidAmount ?? 0
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-01-15', $6, $7,
             1000, 250, 1250, 'standard_25', 25, $8, $9, $10)`,
    [
      id,
      s.userId,
      s.companyId,
      customerId,
      `F-${id.slice(0, 8)}`,
      cols.dueDate ?? '2026-02-14',
      cols.currency ?? 'SEK',
      cols.status ?? 'overdue',
      paid,
      1250 - paid,
    ],
  )
  return id
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

/** A konstaterad voucher: 6351 net + 2611 VAT / 1510 amount (1000 + 250 / 1250 by default). */
async function insertConfirmedVoucher(
  s: Seeded,
  decisionId: string,
  entryDate = '2026-06-01',
  amounts: { net: number; vat: number } = { net: 1000, vat: 250 },
): Promise<string> {
  return insertPostedJournalEntry({
    userId: s.userId,
    companyId: s.companyId,
    fiscalPeriodId: s.fiscalPeriodId,
    entryDate,
    description: 'Konstaterad kundförlust',
    sourceType: 'customer_loss',
    sourceId: decisionId,
    lines: [
      { accountNumber: '6351', debitAmount: amounts.net, creditAmount: 0 },
      { accountNumber: '2611', debitAmount: amounts.vat, creditAmount: 0 },
      { accountNumber: '1510', debitAmount: 0, creditAmount: amounts.net + amounts.vat },
    ],
  })
}

/** The storno of a posted voucher, as reverseEntry() leaves it. */
async function insertStorno(s: Seeded, originalId: string, entryDate = '2026-06-10'): Promise<string> {
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

interface RecordArgs {
  id: string
  invoiceId: string
  kind: string
  entryDate?: string
  amount?: number
  net?: number
  vat?: number
  journalEntryId?: string | null
  evidenceId?: string | null
  reversesId?: string | null
  decidedBy?: string | null
  shares?: Array<{ account: string; rate: number; vat: number; base: number }>
}

const RECORD_SQL = `SELECT public.record_invoice_write_off(
  $1, $2, $3, $4, $5::date, $6, $7, $8, $9::jsonb, 0, $10, $11, 'Konkurs', NULL, $12, $13
) AS result`

function recordParams(s: Seeded, a: RecordArgs): unknown[] {
  return [
    a.id,
    s.companyId,
    a.invoiceId,
    a.kind,
    a.entryDate ?? '2026-06-01',
    a.amount ?? 1250,
    a.net ?? 1000,
    a.vat ?? 250,
    JSON.stringify(a.shares ?? ((a.vat ?? 250) > 0 ? [{ account: '2611', rate: 25, vat: a.vat ?? 250, base: a.net ?? 1000 }] : [])),
    a.journalEntryId ?? null,
    a.evidenceId ?? null,
    a.reversesId ?? null,
    a.decidedBy ?? null,
  ]
}

async function recordAsService(s: Seeded, a: RecordArgs): Promise<{ id: string; invoice_status: string }> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: { id: string; invoice_status: string } }>(
      RECORD_SQL,
      recordParams(s, { decidedBy: s.userId, ...a }),
    )
    return rows[0]!.result
  })
}

/**
 * A signed-in person's claims on a connection that keeps its own (superuser)
 * privileges: reaches the function's body past the grant, so the in-body
 * check is what is tested. Rolled back.
 */
async function withClaimsOnly<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function invoiceStatus(id: string): Promise<string> {
  const { rows } = await getPool().query<{ status: string }>('SELECT status FROM public.invoices WHERE id = $1', [id])
  return rows[0]!.status
}

describe('invoice write-offs (migration 20261021120700)', () => {
  it('lets only a recorded konstaterad decision write an invoice off', async () => {
    const s = await seedCompany()
    const invoiceId = await insertInvoice(s)

    await expect(
      getPool().query("UPDATE public.invoices SET status = 'written_off' WHERE id = $1", [invoiceId]),
    ).rejects.toThrow(/INVOICE_WRITTEN_OFF_STATUS_LOCKED/)

    const decisionId = randomUUID()
    const voucherId = await insertConfirmedVoucher(s, decisionId)
    const evidenceId = await insertDocument(s)
    // Not even the company's own writer calls it from a session: lib/customer-loss
    // calls it as the service role and names the person.
    await expect(
      withUserContext(s.userId, (client) =>
        client.query(RECORD_SQL, recordParams(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: voucherId, evidenceId })),
      ),
    ).rejects.toThrow(/permission denied for function record_invoice_write_off/)
    expect(await invoiceStatus(invoiceId)).toBe('overdue')

    const result = await recordAsService(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: voucherId, evidenceId })
    expect(result.invoice_status).toBe('written_off')
    expect(await invoiceStatus(invoiceId)).toBe('written_off')
    const { rows } = await getPool().query<{ decided_by: string; kind: string }>(
      'SELECT decided_by, kind FROM public.invoice_write_offs WHERE id = $1',
      [decisionId],
    )
    expect(rows[0]).toEqual({ decided_by: s.userId, kind: 'confirmed' })
  })

  it('is executable by the service role only', async () => {
    const { rows } = await getPool().query<{ anon_can: boolean; auth_can: boolean; service_can: boolean }>(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_can
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'record_invoice_write_off'`,
    )
    expect(rows).toEqual([{ anon_can: false, auth_can: false, service_can: true }])
  })

  it('keeps a written-off invoice out of every other status change and the rows append-only', async () => {
    const s = await seedCompany()
    const invoiceId = await insertInvoice(s)
    const decisionId = randomUUID()
    const voucherId = await insertConfirmedVoucher(s, decisionId)
    const evidenceId = await insertDocument(s)
    await recordAsService(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: voucherId, evidenceId })
    expect(await invoiceStatus(invoiceId)).toBe('written_off')

    await expect(
      getPool().query("UPDATE public.invoices SET status = 'paid' WHERE id = $1", [invoiceId]),
    ).rejects.toThrow(/INVOICE_WRITTEN_OFF_STATUS_LOCKED/)
    await expect(
      getPool().query("UPDATE public.invoice_write_offs SET reason = 'x' WHERE id = $1", [decisionId]),
    ).rejects.toThrow(/append-only/)
    await expect(
      getPool().query('DELETE FROM public.invoice_write_offs WHERE id = $1', [decisionId]),
    ).rejects.toThrow(/append-only/)
    // A second konstaterad decision on the same invoice is refused.
    const second = randomUUID()
    const secondVoucher = await insertConfirmedVoucher(s, second)
    await expect(
      recordAsService(s, { id: second, invoiceId, kind: 'confirmed', journalEntryId: secondVoucher, evidenceId }),
    ).rejects.toThrow(/CUSTOMER_LOSS_INVOICE_NOT_OPEN/)
  })

  it('accepts source_type customer_loss and one live voucher per decision id', async () => {
    const s = await seedCompany()
    const decisionId = randomUUID()
    await insertConfirmedVoucher(s, decisionId)
    await expect(insertConfirmedVoucher(s, decisionId)).rejects.toThrow(/journal_entries_customer_loss_live_unique/)
  })

  it('checks the voucher, the evidence and the caller', async () => {
    const s = await seedCompany()
    const invoiceId = await insertInvoice(s)
    const evidenceId = await insertDocument(s)
    const decisionId = randomUUID()
    // A voucher booked for another decision.
    const otherVoucher = await insertConfirmedVoucher(s, randomUUID())
    await expect(
      recordAsService(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: otherVoucher, evidenceId }),
    ).rejects.toThrow(/CUSTOMER_LOSS_VOUCHER_MISMATCH/)
    // Konstaterad without evidence.
    const voucherId = await insertConfirmedVoucher(s, decisionId)
    await expect(
      recordAsService(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: voucherId }),
    ).rejects.toThrow(/invoice_write_offs_evidence/)
    // The amount must be what the voucher took off 1510.
    await expect(
      recordAsService(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: voucherId, evidenceId, amount: 1300 }),
    ).rejects.toThrow(/CUSTOMER_LOSS_VOUCHER_MISMATCH/)
    // ...and net plus VAT.
    await expect(
      recordAsService(s, {
        id: decisionId,
        invoiceId,
        kind: 'confirmed',
        journalEntryId: voucherId,
        evidenceId,
        net: 900,
        shares: [{ account: '2611', rate: 25, vat: 250, base: 1000 }],
      }),
    ).rejects.toThrow(/invoice_write_offs_amount_split/)
    // No session reaches it: a viewer, a member of another company, or the
    // company's own writer.
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: viewer, role: 'viewer' })
    const stranger = await seedCompany()
    for (const userId of [viewer, stranger.userId, s.userId]) {
      await expect(
        withUserContext(userId, (client) =>
          client.query(RECORD_SQL, recordParams(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: voucherId, evidenceId })),
        ),
      ).rejects.toThrow(/permission denied for function record_invoice_write_off/)
    }
    // Behind the grant, the in-body check still refuses a signed-in viewer or
    // stranger (claims set, privileges not dropped: only the guard is tested).
    for (const userId of [viewer, stranger.userId]) {
      await expect(
        withClaimsOnly(userId, (client) =>
          client.query(RECORD_SQL, recordParams(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: voucherId, evidenceId })),
        ),
      ).rejects.toThrow(/CUSTOMER_LOSS_FORBIDDEN/)
    }
    // A person cannot insert a row directly.
    await expect(
      withUserContext(s.userId, (client) =>
        client.query(
          `INSERT INTO public.invoice_write_offs (id, company_id, invoice_id, kind, entry_date, amount, net_amount, reason, journal_entry_id)
           VALUES ($1, $2, $3, 'doubtful', '2026-06-01', 0, 0, 'x', $4)`,
          [randomUUID(), s.companyId, invoiceId, voucherId],
        ),
      ),
    ).rejects.toThrow(/permission denied/)
    expect(await invoiceStatus(invoiceId)).toBe('overdue')
  })

  it('records a konstaterad decision without a voucher for a never-booked invoice', async () => {
    const s = await seedCompany()
    const invoiceId = await insertInvoice(s, { status: 'sent', dueDate: '2099-01-01' })
    const evidenceId = await insertDocument(s)
    const result = await recordAsService(s, {
      id: randomUUID(),
      invoiceId,
      kind: 'confirmed',
      net: 1250,
      vat: 0,
      evidenceId,
    })
    expect(result.invoice_status).toBe('written_off')
    // A befarad reserve always has a voucher.
    const other = await insertInvoice(s)
    await expect(
      recordAsService(s, { id: randomUUID(), invoiceId: other, kind: 'doubtful', net: 1000, vat: 250 }),
    ).rejects.toThrow(/invoice_write_offs_voucher/)
  })

  it('makes the row say what its voucher booked, whoever calls', async () => {
    const s = await seedCompany()
    const evidenceId = await insertDocument(s)

    // A claim on the ledger (its own voucher put it on 1510) is never written
    // off without a voucher, not even by a direct call as the service role.
    const bookedInvoice = await insertInvoice(s)
    const invoiceVoucher = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      entryDate: '2026-01-15',
      sourceType: 'invoice_created',
      sourceId: bookedInvoice,
      lines: [
        { accountNumber: '1510', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
        { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
      ],
    })
    await getPool().query('UPDATE public.invoices SET journal_entry_id = $2 WHERE id = $1', [bookedInvoice, invoiceVoucher])
    await expect(
      recordAsService(s, { id: randomUUID(), invoiceId: bookedInvoice, kind: 'confirmed', net: 1250, vat: 0, evidenceId }),
    ).rejects.toThrow(/CUSTOMER_LOSS_VOUCHER_MISMATCH/)
    expect(await invoiceStatus(bookedInvoice)).toBe('overdue')

    // The output VAT recorded must be the voucher's, account by account.
    const invoiceId = await insertInvoice(s)
    const decisionId = randomUUID()
    const voucherId = await insertConfirmedVoucher(s, decisionId)
    await expect(
      recordAsService(s, {
        id: decisionId,
        invoiceId,
        kind: 'confirmed',
        journalEntryId: voucherId,
        evidenceId,
        shares: [{ account: '2621', rate: 12, vat: 250, base: 2083.33 }],
      }),
    ).rejects.toThrow(/CUSTOMER_LOSS_VAT_MISMATCH/)
    // ...with a base that matches its VAT at its rate (ruta 05 reads it).
    await expect(
      recordAsService(s, {
        id: decisionId,
        invoiceId,
        kind: 'confirmed',
        journalEntryId: voucherId,
        evidenceId,
        shares: [{ account: '2611', rate: 25, vat: 250, base: 5000 }],
      }),
    ).rejects.toThrow(/CUSTOMER_LOSS_VAT_MISMATCH/)

    // A befarad row carries the reserve its voucher put on 1519.
    const doubtfulId = randomUUID()
    const doubtfulVoucher = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      entryDate: '2026-06-01',
      sourceType: 'customer_loss',
      sourceId: doubtfulId,
      lines: [
        { accountNumber: '6352', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '1519', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    await expect(
      recordAsService(s, { id: doubtfulId, invoiceId, kind: 'doubtful', amount: 625, net: 500, vat: 125, journalEntryId: doubtfulVoucher }),
    ).rejects.toThrow(/CUSTOMER_LOSS_VOUCHER_MISMATCH/)
    await recordAsService(s, { id: doubtfulId, invoiceId, kind: 'doubtful', journalEntryId: doubtfulVoucher })

    // An annulment records what the decision it annuls recorded, whatever it is told.
    const storno = await insertStorno(s, doubtfulVoucher)
    const annulId = randomUUID()
    await recordAsService(s, {
      id: annulId,
      invoiceId,
      kind: 'annulled',
      entryDate: '2026-06-10',
      amount: 1,
      net: 1,
      vat: 0,
      journalEntryId: storno,
      reversesId: doubtfulId,
    })
    const { rows } = await getPool().query<{ amount: string; net_amount: string; vat_amount: string; vat_by_rate: unknown }>(
      'SELECT amount, net_amount, vat_amount, vat_by_rate FROM public.invoice_write_offs WHERE id = $1',
      [annulId],
    )
    expect(rows[0]).toEqual({
      amount: '1250.00',
      net_amount: '1000.00',
      vat_amount: '250.00',
      vat_by_rate: [{ account: '2611', rate: 25, vat: 250, base: 1000 }],
    })
  })

  it('refuses a foreign-currency invoice', async () => {
    const s = await seedCompany()
    const invoiceId = await insertInvoice(s, { currency: 'EUR' })
    const decisionId = randomUUID()
    const voucherId = await insertConfirmedVoucher(s, decisionId)
    const evidenceId = await insertDocument(s)
    await expect(
      recordAsService(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: voucherId, evidenceId }),
    ).rejects.toThrow(/CUSTOMER_LOSS_CURRENCY_UNSUPPORTED/)
  })

  it.each([
    ['the due date itself', '2026-02-14', 'sent'],
    ['the day after it', '2026-02-15', 'overdue'],
  ])('an annulled write-off with nothing paid, on %s, goes back to %s', async (_when, today, status) => {
    const s = await seedCompany()
    const invoiceId = await insertInvoice(s, { dueDate: '2026-02-14' })
    const evidenceId = await insertDocument(s)
    const decisionId = randomUUID()
    const voucherId = await insertConfirmedVoucher(s, decisionId)
    await recordAsService(s, { id: decisionId, invoiceId, kind: 'confirmed', journalEntryId: voucherId, evidenceId })
    const stornoId = await insertStorno(s, voucherId)

    await withSwedishToday(today, async () => {
      const annulled = await recordAsService(s, {
        id: randomUUID(),
        invoiceId,
        kind: 'annulled',
        entryDate: '2026-06-10',
        journalEntryId: stornoId,
        reversesId: decisionId,
      })
      expect(annulled.invoice_status).toBe(status)
    })
  })

  it('gives the invoice its open status back when the konstaterad voucher is stornoed, latest decision first', async () => {
    const s = await seedCompany()
    const invoiceId = await insertInvoice(s, { status: 'partially_paid', paidAmount: 250 })
    const evidenceId = await insertDocument(s)
    const decisionId = randomUUID()
    const voucherId = await insertConfirmedVoucher(s, decisionId, '2026-06-01', { net: 800, vat: 200 })
    await recordAsService(s, {
      id: decisionId,
      invoiceId,
      kind: 'confirmed',
      amount: 1000,
      net: 800,
      vat: 200,
      journalEntryId: voucherId,
      evidenceId,
    })

    // A recovery after the write-off.
    const recoveryId = randomUUID()
    const recoveryVoucher = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
      entryDate: '2026-06-05',
      sourceType: 'customer_loss',
      sourceId: recoveryId,
      lines: [
        { accountNumber: '1930', debitAmount: 125, creditAmount: 0 },
        { accountNumber: '3950', debitAmount: 0, creditAmount: 100 },
        { accountNumber: '2611', debitAmount: 0, creditAmount: 25 },
      ],
    })
    await recordAsService(s, {
      id: recoveryId,
      invoiceId,
      kind: 'recovered',
      entryDate: '2026-06-05',
      amount: 125,
      net: 100,
      vat: 25,
      journalEntryId: recoveryVoucher,
    })

    // The konstaterad decision cannot be annulled while the recovery stands.
    const confirmedStorno = await insertStorno(s, voucherId)
    await expect(
      recordAsService(s, {
        id: randomUUID(),
        invoiceId,
        kind: 'annulled',
        entryDate: '2026-06-10',
        amount: 1000,
        net: 800,
        vat: 200,
        journalEntryId: confirmedStorno,
        reversesId: decisionId,
      }),
    ).rejects.toThrow(/CUSTOMER_LOSS_ANNUL_NOT_LATEST/)

    // Annul the recovery first (its storno), then the konstaterad decision.
    const recoveryStorno = await insertStorno(s, recoveryVoucher)
    // The annulment must name the storno of the reversed decision's voucher.
    await expect(
      recordAsService(s, {
        id: randomUUID(),
        invoiceId,
        kind: 'annulled',
        entryDate: '2026-06-10',
        amount: 125,
        net: 100,
        vat: 25,
        journalEntryId: confirmedStorno,
        reversesId: recoveryId,
      }),
    ).rejects.toThrow(/CUSTOMER_LOSS_VOUCHER_MISMATCH/)
    const recoveryAnnul = await recordAsService(s, {
      id: randomUUID(),
      invoiceId,
      kind: 'annulled',
      entryDate: '2026-06-10',
      amount: 125,
      net: 100,
      vat: 25,
      journalEntryId: recoveryStorno,
      reversesId: recoveryId,
    })
    expect(recoveryAnnul.invoice_status).toBe('written_off')
    const confirmedAnnul = await recordAsService(s, {
      id: randomUUID(),
      invoiceId,
      kind: 'annulled',
      entryDate: '2026-06-10',
      amount: 1000,
      net: 800,
      vat: 200,
      journalEntryId: confirmedStorno,
      reversesId: decisionId,
    })
    expect(confirmedAnnul.invoice_status).toBe('partially_paid')
    expect(await invoiceStatus(invoiceId)).toBe('partially_paid')
    // One annulment per decision.
    await expect(
      recordAsService(s, {
        id: randomUUID(),
        invoiceId,
        kind: 'annulled',
        entryDate: '2026-06-10',
        amount: 1000,
        net: 800,
        vat: 200,
        journalEntryId: confirmedStorno,
        reversesId: decisionId,
      }),
    ).rejects.toThrow(/CUSTOMER_LOSS_ANNUL_INVALID/)
  })

  it('refuses an inline rättelse or a new date on a kundförlust voucher', async () => {
    const s = await seedCompany()
    const voucherId = await insertConfirmedVoucher(s, randomUUID())
    const client = await getPool().connect()
    try {
      // correct_entry_metadata opens the posted row for a new date this way.
      await client.query('BEGIN')
      await client.query("SELECT set_config('gnubok.allow_metadata_rattelse', 'true', true)")
      await expect(
        client.query("UPDATE public.journal_entries SET entry_date = '2026-06-02' WHERE id = $1", [voucherId]),
      ).rejects.toThrow(/CUSTOMER_LOSS_VOUCHER_LOCKED/)
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query("SELECT set_config('gnubok.allow_line_rattelse', 'true', true)")
      await expect(
        client.query(
          `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
           VALUES ($1, '6351', 1, 0, 'SEK', 9)`,
          [voucherId],
        ),
      ).rejects.toThrow(/CUSTOMER_LOSS_VOUCHER_LOCKED/)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    // Other vouchers keep their rättelse path: the guard looks only at kundförlust vouchers.
    const other = await insertPostedJournalEntry({
      userId: s.userId,
      companyId: s.companyId,
      fiscalPeriodId: s.fiscalPeriodId,
    })
    const client2 = await getPool().connect()
    try {
      await client2.query('BEGIN')
      await client2.query("SELECT set_config('gnubok.allow_line_rattelse', 'true', true)")
      await client2.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
         VALUES ($1, '1930', 0, 0, 'SEK', 9)`,
        [other],
      ).catch((error: Error) => {
        expect(error.message).not.toMatch(/CUSTOMER_LOSS_VOUCHER_LOCKED/)
      })
    } finally {
      await client2.query('ROLLBACK').catch(() => {})
      client2.release()
    }
  })

  it('accepts the record_customer_loss pending operation type', async () => {
    const s = await seedCompany()
    await getPool().query(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
       VALUES ($1, $2, 'record_customer_loss', 'Bokför kundförlust')`,
      [s.userId, s.companyId],
    )
  })
})
