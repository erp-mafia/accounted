/**
 * pg-real tests for 20261018131100_kontantmetod_cutoff_per_invoice_carry.sql
 * (#3440): the kontantmetod year end as årsomföring, one year_end verifikat
 * per open invoice, marked per invoice and linked to it.
 *
 * Covers the marker table and its guard (a, b), the atomic marker-and-link
 * RPC (c) and the storno trigger (f). The payment-row and cash-entry guards
 * (d, e) live in kontantmetod-carried-settlement-guard.pg.test.ts.
 *
 * Also covers 20261018131120_kontantmetod_carry_link_integrity.sql: one
 * posted carry per invoice, the link restored with a carry whose storno
 * delete_last_voucher deletes, the link of a posted carry locked against a
 * hand edit, a posted carry never deleted, and the storno test narrowed to
 * payments after the carry.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { insertPostedJournalEntry } from './fixtures'
import {
  PERIOD_END,
  carryCustomerInvoice,
  carrySupplierInvoice,
  entryStatus,
  insertCustomerInvoice,
  insertInvoicePaymentRow,
  insertSupplierInvoice,
  insertSupplierPaymentRow,
  invoiceLink,
  liveCarry,
  markReversed,
  markerKinds,
  nextSeq,
  postCarry,
  postStorno,
  recordLink,
  seedCashCompany,
  stornoEntry,
  supplierInvoiceLink,
} from './kontantmetod-carry-fixtures'

const INSERT_MARKER = `INSERT INTO public.kontantmetod_cutoff_entries
    (company_id, fiscal_period_id, kind, journal_entry_id, invoice_id, supplier_invoice_id)
  VALUES ($1, $2, $3, $4, $5, $6)`

describe('per-invoice carry marker: guard refusals (a, b)', () => {
  it('refuses a per-invoice marker on a verifikat that is not a year_end entry', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const entryId = await postCarry(company, { sourceType: 'manual', sourceId: null })

    await expect(
      recordLink(company, { journalEntryId: entryId, invoiceId }),
    ).rejects.toThrow(/must reference a year_end journal entry/)
    expect(await invoiceLink(invoiceId)).toBeNull()
    expect(await markerKinds(company.companyId)).toEqual([])
  })

  it('refuses a carry not dated on period_end', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const entryId = await postCarry(company, { entryDate: '2026-12-30' })

    await expect(
      recordLink(company, { journalEntryId: entryId, invoiceId }),
    ).rejects.toThrow(/dated on the closed period's last day/)
    expect(await invoiceLink(invoiceId)).toBeNull()
  })

  it('refuses a carry anchored to another period', async () => {
    // source_id names the 2027 period while the marker claims 2026.
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const entryId = await postCarry(company, { sourceId: company.nextPeriodId })

    await expect(
      recordLink(company, { journalEntryId: entryId, invoiceId }),
    ).rejects.toThrow(/anchored to the closed period/)
  })

  it('refuses an invoice of another company', async () => {
    const company = await seedCashCompany()
    const other = await seedCashCompany()
    const foreignInvoice = await insertCustomerInvoice(other)
    const entryId = await postCarry(company)

    // Through the RPC the other company's row is simply not found ...
    expect(await recordLink(company, { journalEntryId: entryId, invoiceId: foreignInvoice }))
      .toMatchObject({ ok: false, code: 'CUTOFF_INVOICE_NOT_FOUND' })
    // ... and a direct marker INSERT naming it is refused by the guard.
    await expect(
      getPool().query(INSERT_MARKER, [
        company.companyId, company.fiscalPeriodId, 'receivable_invoice', entryId, foreignInvoice, null,
      ]),
    ).rejects.toThrow(/invoice in the same company/)
  })

  it('refuses an invoice dated after period_end', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company, { invoiceDate: '2027-01-02' })
    const entryId = await postCarry(company)

    await expect(
      recordLink(company, { journalEntryId: entryId, invoiceId }),
    ).rejects.toThrow(/after the closed period ending/)
  })

  it('refuses a carry without the receivable or payable leg', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    // A cash-shaped verifikat: no 1510, no 2440.
    const noReceivable = await postCarry(company, {
      lines: [
        { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
        { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
      ],
    })
    const noPayable = await postCarry(company, {
      supplier: true,
      lines: [
        { accountNumber: '6110', debitAmount: 400, creditAmount: 0 },
        { accountNumber: '2641', debitAmount: 100, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
      ],
    })

    await expect(
      recordLink(company, { journalEntryId: noReceivable, invoiceId }),
    ).rejects.toThrow(/must hold its 151x debit leg/)
    await expect(
      recordLink(company, { journalEntryId: noPayable, supplierInvoiceId }),
    ).rejects.toThrow(/must hold its 244x credit leg/)
  })

  it('takes a credit note on the opposite side, and only there', async () => {
    const company = await seedCashCompany()
    const original = await insertCustomerInvoice(company)
    const creditNote = await insertCustomerInvoice(company, {
      subtotal: -200,
      vat: -50,
      creditedInvoiceId: original,
    })
    const debitShaped = await postCarry(company)
    const creditShaped = await postCarry(company, {
      lines: [
        { accountNumber: '3001', debitAmount: 200, creditAmount: 0 },
        { accountNumber: '2611', debitAmount: 50, creditAmount: 0 },
        { accountNumber: '1510', debitAmount: 0, creditAmount: 250 },
      ],
    })

    await expect(
      recordLink(company, { journalEntryId: debitShaped, invoiceId: creditNote }),
    ).rejects.toThrow(/must hold its 151x credit leg/)
    expect(await recordLink(company, { journalEntryId: creditShaped, invoiceId: creditNote }))
      .toMatchObject({ ok: true, kind: 'receivable_invoice' })

    const supplierOriginal = await insertSupplierInvoice(company)
    const supplierCredit = await insertSupplierInvoice(company, {
      subtotal: 400,
      vat: 100,
      isCreditNote: true,
      creditedInvoiceId: supplierOriginal,
    })
    const supplierCreditShaped = await postCarry(company, {
      supplier: true,
      lines: [
        { accountNumber: '2440', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '6110', debitAmount: 0, creditAmount: 400 },
        { accountNumber: '2641', debitAmount: 0, creditAmount: 100 },
      ],
    })
    expect(
      await recordLink(company, { journalEntryId: supplierCreditShaped, supplierInvoiceId: supplierCredit }),
    ).toMatchObject({ ok: true, kind: 'payable_invoice' })
  })

  it('refuses a carry that is not posted', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const entryId = await postCarry(company)
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [entryId],
    )

    await expect(
      recordLink(company, { journalEntryId: entryId, invoiceId }),
    ).rejects.toThrow(/requires a posted verifikat/)
  })

  it('refuses a marker for an invoice linked to another verifikat', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const elsewhere = await postCarry(company)
    await getPool().query(`UPDATE public.invoices SET journal_entry_id = $1 WHERE id = $2`, [
      elsewhere,
      invoiceId,
    ])
    const entryId = await postCarry(company)

    await expect(
      getPool().query(INSERT_MARKER, [
        company.companyId, company.fiscalPeriodId, 'receivable_invoice', entryId, invoiceId, null,
      ]),
    ).rejects.toThrow(/already linked to verifikat/)
  })

  it('ties kind and invoice reference together (CHECK)', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const entryId = await postCarry(company)

    // receivable_invoice naming a supplier invoice as well. (The guard runs
    // first and proves the customer side, so the CHECK is what refuses.)
    await expect(
      getPool().query(INSERT_MARKER, [
        company.companyId, company.fiscalPeriodId, 'receivable_invoice', entryId, invoiceId, supplierInvoiceId,
      ]),
    ).rejects.toThrow(/kontantmetod_cutoff_entries_invoice_ref_check/)
    // A legacy kind naming an invoice.
    await expect(
      getPool().query(INSERT_MARKER, [
        company.companyId, company.fiscalPeriodId, 'receivable', entryId, invoiceId, null,
      ]),
    ).rejects.toThrow(/kontantmetod_cutoff_entries_invoice_ref_check/)
    // An unknown kind fails both CHECKs; either may be reported first.
    await expect(
      getPool().query(INSERT_MARKER, [
        company.companyId, company.fiscalPeriodId, 'receivable_carry', entryId, invoiceId, null,
      ]),
    ).rejects.toThrow(/kontantmetod_cutoff_entries_(kind|invoice_ref)_check/)
  })

  it('refuses a new vändning marker from the API roles', async () => {
    const company = await seedCashCompany()
    const entryId = await postCarry(company, {
      entryDate: '2027-01-01',
      fiscalPeriodId: company.nextPeriodId,
      lines: [
        { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
        { accountNumber: '3001', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '2611', debitAmount: 250, creditAmount: 0 },
      ],
    })

    await withUserContext(company.userId, async (client) => {
      await expect(
        client.query(INSERT_MARKER, [
          company.companyId, company.fiscalPeriodId, 'receivable_reversal', entryId, null, null,
        ]),
      ).rejects.toThrow(/vändning markers are retired/)
    })
    await expect(
      runAsServiceRole((client) =>
        client.query(INSERT_MARKER, [
          company.companyId, company.fiscalPeriodId, 'payable_reversal', entryId, null, null,
        ]),
      ),
    ).rejects.toThrow(/vändning markers are retired/)
  })
})

describe('per-invoice carry marker: legacy kinds and grants', () => {
  it('still takes a legacy receivable marker from a member session', async () => {
    const company = await seedCashCompany()
    const entryId = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate: PERIOD_END,
      description: 'Kundfordringar vid bokslut (kontantmetoden)',
      sourceType: 'year_end',
      sourceId: company.fiscalPeriodId,
    })

    const kinds = await withUserContext(company.userId, async (client) => {
      await client.query(INSERT_MARKER, [
        company.companyId, company.fiscalPeriodId, 'receivable', entryId, null, null,
      ])
      const res = await client.query<{ kind: string }>(
        `SELECT kind FROM public.kontantmetod_cutoff_entries WHERE company_id = $1`,
        [company.companyId],
      )
      return res.rows.map((row) => row.kind)
    })
    expect(kinds).toEqual(['receivable'])
  })

  it('keeps the table append-only and the RPC closed to anon', async () => {
    const { rows } = await getPool().query<Record<string, boolean>>(
      `SELECT
         has_table_privilege('authenticated', 'public.kontantmetod_cutoff_entries', 'UPDATE') AS auth_update,
         has_table_privilege('authenticated', 'public.kontantmetod_cutoff_entries', 'DELETE') AS auth_delete,
         has_table_privilege('service_role', 'public.kontantmetod_cutoff_entries', 'UPDATE') AS service_update,
         has_table_privilege('service_role', 'public.kontantmetod_cutoff_entries', 'DELETE') AS service_delete,
         has_function_privilege('anon', 'public.record_kontantmetod_cutoff_link(uuid,uuid,uuid,uuid,uuid)', 'EXECUTE') AS anon_rpc,
         has_function_privilege('authenticated', 'public.record_kontantmetod_cutoff_link(uuid,uuid,uuid,uuid,uuid)', 'EXECUTE') AS auth_rpc,
         has_function_privilege('service_role', 'public.record_kontantmetod_cutoff_link(uuid,uuid,uuid,uuid,uuid)', 'EXECUTE') AS service_rpc,
         has_function_privilege('authenticated', 'public.kontantmetod_live_carry(uuid,uuid)', 'EXECUTE') AS auth_live`,
    )
    expect(rows[0]).toEqual({
      auth_update: false,
      auth_delete: false,
      service_update: false,
      service_delete: false,
      anon_rpc: false,
      auth_rpc: true,
      service_rpc: true,
      auth_live: false,
    })
  })

  it('keeps a carried invoice from being deleted while its marker exists', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    await carryCustomerInvoice(company, invoiceId)

    await expect(
      getPool().query(`DELETE FROM public.invoices WHERE id = $1`, [invoiceId]),
    ).rejects.toThrow(/foreign key|violates/)
  })
})

describe('record_kontantmetod_cutoff_link (c)', () => {
  it('writes the marker and the link together from a member session', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const entryId = await postCarry(company)

    const seen = await withUserContext(company.userId, async (client) => {
      const result = await recordLink(company, { journalEntryId: entryId, invoiceId }, client)
      const link = await client.query<{ journal_entry_id: string }>(
        `SELECT journal_entry_id FROM public.invoices WHERE id = $1`,
        [invoiceId],
      )
      const marker = await client.query<{ kind: string; invoice_id: string; fiscal_period_id: string }>(
        `SELECT kind, invoice_id, fiscal_period_id FROM public.kontantmetod_cutoff_entries
          WHERE journal_entry_id = $1`,
        [entryId],
      )
      return { result, link: link.rows[0].journal_entry_id, marker: marker.rows }
    })

    expect(seen.result).toMatchObject({ ok: true, kind: 'receivable_invoice', journal_entry_id: entryId })
    expect(seen.link).toBe(entryId)
    expect(seen.marker).toEqual([
      { kind: 'receivable_invoice', invoice_id: invoiceId, fiscal_period_id: company.fiscalPeriodId },
    ])
  })

  it('links a supplier invoice through registration_journal_entry_id as the service role', async () => {
    const company = await seedCashCompany()
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const entryId = await postCarry(company, { supplier: true })

    const result = await runAsServiceRole((client) =>
      recordLink(company, { journalEntryId: entryId, supplierInvoiceId }, client),
    )

    expect(result).toMatchObject({ ok: true, kind: 'payable_invoice' })
    expect(await supplierInvoiceLink(supplierInvoiceId)).toBe(entryId)
    expect(await liveCarry(null, supplierInvoiceId)).toEqual([entryId])
  })

  it('answers CUTOFF_INVOICE_ALREADY_LINKED on a second carry and writes no marker', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const first = await carryCustomerInvoice(company, invoiceId)
    const second = await postCarry(company)

    const result = await recordLink(company, { journalEntryId: second, invoiceId })

    expect(result).toMatchObject({
      ok: false,
      code: 'CUTOFF_INVOICE_ALREADY_LINKED',
      details: { journal_entry_id: first },
    })
    expect(await invoiceLink(invoiceId)).toBe(first)
    expect(await markerKinds(company.companyId)).toEqual(['receivable_invoice'])
  })

  it('refuses a call naming both sides or neither', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const entryId = await postCarry(company)

    expect(await recordLink(company, { journalEntryId: entryId, invoiceId, supplierInvoiceId }))
      .toMatchObject({ ok: false, code: 'CUTOFF_LINK_INVALID_INPUT' })
    expect(await recordLink(company, { journalEntryId: entryId }))
      .toMatchObject({ ok: false, code: 'CUTOFF_LINK_INVALID_INPUT' })
  })

  it('serialises two racing carries of one invoice: one links, the other is told', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const carryA = await postCarry(company)
    const carryB = await postCarry(company)

    const a = await getClient()
    const b = await getClient()
    try {
      await a.query('BEGIN')
      const first = await recordLink(company, { journalEntryId: carryA, invoiceId }, a)
      expect(first.ok).toBe(true)

      await b.query('BEGIN')
      // Blocks on the FOR UPDATE until A commits, then sees A's link.
      const pending = recordLink(company, { journalEntryId: carryB, invoiceId }, b)
      await new Promise((resolve) => setTimeout(resolve, 200))
      await a.query('COMMIT')
      const second = await pending
      await b.query('COMMIT')

      expect(second).toMatchObject({ ok: false, code: 'CUTOFF_INVOICE_ALREADY_LINKED' })
    } finally {
      await a.query('ROLLBACK').catch(() => {})
      await b.query('ROLLBACK').catch(() => {})
      a.release()
      b.release()
    }

    expect(await invoiceLink(invoiceId)).toBe(carryA)
    expect(await markerKinds(company.companyId)).toEqual(['receivable_invoice'])
  })
})

describe('storno of a carry (f)', () => {
  it('releases the link on a storno dated period_end and keeps the marker', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    const supplierCarry = await carrySupplierInvoice(company, supplierInvoiceId)

    await stornoEntry(company, carry)
    await stornoEntry(company, supplierCarry)

    expect(await entryStatus(carry)).toBe('reversed')
    expect(await invoiceLink(invoiceId)).toBeNull()
    expect(await supplierInvoiceLink(supplierInvoiceId)).toBeNull()
    expect(await markerKinds(company.companyId)).toEqual(['payable_invoice', 'receivable_invoice'])
    expect(await liveCarry(invoiceId, null)).toEqual([])
    expect(await liveCarry(null, supplierInvoiceId)).toEqual([])

    // The invoice is a plain kontantmetod invoice again: a re-run carries it.
    const rerun = await postCarry(company)
    expect(await recordLink(company, { journalEntryId: rerun, invoiceId }))
      .toMatchObject({ ok: true })
    expect(await liveCarry(invoiceId, null)).toEqual([rerun])
  })

  it('refuses a storno dated outside the carry date, in either year', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)

    const sameYear = await postStorno(company, carry, { date: '2026-12-30' })
    await expect(markReversed(carry, sameYear)).rejects.toThrow(/CUTOFF_CARRY_REVERSAL_DATE/)
    const nextYear = await postStorno(company, carry, {
      date: '2027-01-01',
      fiscalPeriodId: company.nextPeriodId,
    })
    await expect(markReversed(carry, nextYear)).rejects.toThrow(/CUTOFF_CARRY_REVERSAL_DATE/)

    expect(await entryStatus(carry)).toBe('posted')
    expect(await invoiceLink(invoiceId)).toBe(carry)
  })

  it('refuses while the invoice has a payment row', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    const supplierCarry = await carrySupplierInvoice(company, supplierInvoiceId)
    await insertInvoicePaymentRow(company, invoiceId, '2027-02-01', 500)
    await insertSupplierPaymentRow(company, supplierInvoiceId, '2027-02-01', 200)

    const storno = await postStorno(company, carry)
    await expect(markReversed(carry, storno)).rejects.toThrow(/KONTANTMETOD_CARRY_HAS_SETTLEMENTS/)
    const supplierStorno = await postStorno(company, supplierCarry)
    await expect(markReversed(supplierCarry, supplierStorno)).rejects.toThrow(
      /KONTANTMETOD_CARRY_HAS_SETTLEMENTS/,
    )

    expect(await invoiceLink(invoiceId)).toBe(carry)
    expect(await supplierInvoiceLink(supplierInvoiceId)).toBe(supplierCarry)
  })

  it('refuses while a credit note against the invoice has a posted verifikat', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    const creditNote = await insertCustomerInvoice(company, {
      subtotal: -1000,
      vat: -250,
      invoiceDate: '2027-03-10',
      creditedInvoiceId: invoiceId,
    })
    const creditEntry = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.nextPeriodId,
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate: '2027-03-10',
      description: 'Kreditfaktura',
      sourceType: 'credit_note',
      sourceId: creditNote,
      lines: [
        { accountNumber: '3001', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '2611', debitAmount: 250, creditAmount: 0 },
        { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    await getPool().query(`UPDATE public.invoices SET journal_entry_id = $1 WHERE id = $2`, [
      creditEntry,
      creditNote,
    ])

    const storno = await postStorno(company, carry)
    await expect(markReversed(carry, storno)).rejects.toThrow(/KONTANTMETOD_CARRY_HAS_SETTLEMENTS/)
    expect(await invoiceLink(invoiceId)).toBe(carry)
  })

  it('refuses when a rättelse of the carry is posted (correctEntry)', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)

    // correctEntry posts its storno and its correction before the CAS.
    const storno = await postStorno(company, carry)
    const correction = randomUUID()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, correction_of_id, status)
         VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Rättelse: kundfaktura', 'correction', $7, 'draft')`,
        [
          correction, company.userId, company.companyId, company.fiscalPeriodId,
          nextSeq() % 1_000_000_000, PERIOD_END, carry,
        ],
      )
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
         VALUES ($1, '1510', 1000, 0, 0), ($1, '3001', 0, 800, 1), ($1, '2611', 0, 200, 2)`,
        [correction],
      )
      await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [correction])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    await expect(markReversed(carry, storno)).rejects.toThrow(/CUTOFF_CARRY_CORRECTION_REFUSED/)
    expect(await entryStatus(carry)).toBe('posted')
    expect(await invoiceLink(invoiceId)).toBe(carry)
  })

  it('refuses to cancel a live carry, even through the cleanup GUC', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_posted_cancel', 'true', true)`)
      await expect(
        client.query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [carry]),
      ).rejects.toThrow(/KONTANTMETOD_CARRY_CANCEL_REFUSED/)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(await entryStatus(carry)).toBe('posted')
  })

  it('leaves a legacy aggregate cut-off storno alone', async () => {
    // No per-invoice marker: the trigger does nothing, whatever the date.
    const company = await seedCashCompany()
    const legacy = await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate: PERIOD_END,
      description: 'Kundfordringar vid bokslut (kontantmetoden)',
      sourceType: 'year_end',
      sourceId: company.fiscalPeriodId,
      lines: [
        { accountNumber: '1510', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '2618', debitAmount: 0, creditAmount: 250 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    await getPool().query(
      `INSERT INTO public.kontantmetod_cutoff_entries (company_id, fiscal_period_id, kind, journal_entry_id)
       VALUES ($1, $2, 'receivable', $3)`,
      [company.companyId, company.fiscalPeriodId, legacy],
    )

    await stornoEntry(company, legacy, { date: '2026-12-30' })
    expect(await entryStatus(legacy)).toBe('reversed')
  })
})

/**
 * Like withUserContext, but COMMITs: the RPC's effects (delete_last_voucher)
 * must be visible to the superuser pool and to a later carry.
 */
async function commitAsUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function deleteLastVoucher(company: { userId: string; companyId: string }, entryId: string) {
  return commitAsUser(company.userId, async (client) => {
    const { rows } = await client.query<{ result: { deleted: boolean } }>(
      `SELECT public.delete_last_voucher($1, $2) AS result`,
      [company.companyId, entryId],
    )
    return rows[0].result
  })
}

async function accountBalance(companyId: string, account: string): Promise<number> {
  const { rows } = await getPool().query<{ net: string }>(
    `SELECT COALESCE(SUM(l.debit_amount - l.credit_amount), 0)::text AS net
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.status IN ('posted', 'reversed') AND l.account_number = $2`,
    [companyId, account],
  )
  return Number(rows[0].net)
}

/** Move a link with every trigger off: the damage the guards now prevent. */
async function forceUnlink(invoiceId: string): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL session_replication_role = replica`)
    await client.query(`UPDATE public.invoices SET journal_entry_id = NULL WHERE id = $1`, [invoiceId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

describe('carry link integrity (20261018131120)', () => {
  it('restores the link when delete_last_voucher deletes the storno, and refuses a second carry', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    const storno = await stornoEntry(company, carry)
    expect(await invoiceLink(invoiceId)).toBeNull()

    expect(await deleteLastVoucher(company, storno)).toMatchObject({ deleted: true })

    expect(await entryStatus(carry)).toBe('posted')
    expect(await invoiceLink(invoiceId)).toBe(carry)
    expect(await liveCarry(invoiceId, null)).toEqual([carry])

    const second = await postCarry(company)
    expect(await recordLink(company, { journalEntryId: second, invoiceId }))
      .toMatchObject({ ok: false, code: 'CUTOFF_INVOICE_ALREADY_LINKED' })
    expect(await markerKinds(company.companyId)).toEqual(['receivable_invoice'])

    // The supplier side restores the same way.
    const supplierCarry = await carrySupplierInvoice(company, supplierInvoiceId)
    const supplierStorno = await stornoEntry(company, supplierCarry)
    expect(await supplierInvoiceLink(supplierInvoiceId)).toBeNull()
    expect(await deleteLastVoucher(company, supplierStorno)).toMatchObject({ deleted: true })
    expect(await supplierInvoiceLink(supplierInvoiceId)).toBe(supplierCarry)
  })

  it('refuses to restore a carry whose invoice was paid while the carry stood stornoed', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    const storno = await stornoEntry(company, carry)
    // Unlinked, the payment is a plain kontantmetod cash payment: restoring
    // the carry would declare its moms again.
    await insertInvoicePaymentRow(company, invoiceId, '2027-02-01')

    await expect(deleteLastVoucher(company, storno)).rejects.toThrow(/KONTANTMETOD_CARRY_RESTORE_REFUSED/)
    expect(await entryStatus(carry)).toBe('reversed')
    expect(await entryStatus(storno)).toBe('posted')
    expect(await invoiceLink(invoiceId)).toBeNull()
  })

  it('refuses a second posted carry marker for an invoice whose link was lost', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    await forceUnlink(invoiceId)
    expect(await liveCarry(invoiceId, null)).toEqual([])

    const second = await postCarry(company)
    await expect(recordLink(company, { journalEntryId: second, invoiceId }))
      .rejects.toThrow(/KONTANTMETOD_CARRY_ALREADY_LIVE/)
    await withUserContext(company.userId, async (client) => {
      await expect(recordLink(company, { journalEntryId: second, invoiceId }, client))
        .rejects.toThrow(/KONTANTMETOD_CARRY_ALREADY_LIVE/)
    })
    expect(await markerKinds(company.companyId)).toEqual(['receivable_invoice'])
    expect(await invoiceLink(invoiceId)).toBeNull()
    expect(await entryStatus(carry)).toBe('posted')
  })

  it('refuses a hand edit of a posted carry\'s link, from a member and from the superuser', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    const supplierCarry = await carrySupplierInvoice(company, supplierInvoiceId)

    await withUserContext(company.userId, async (client) => {
      await expect(
        client.query(`UPDATE public.invoices SET journal_entry_id = NULL WHERE id = $1`, [invoiceId]),
      ).rejects.toThrow(/KONTANTMETOD_CARRY_LINK_LOCKED/)
    })
    await withUserContext(company.userId, async (client) => {
      await expect(
        client.query(
          `UPDATE public.supplier_invoices SET registration_journal_entry_id = NULL WHERE id = $1`,
          [supplierInvoiceId],
        ),
      ).rejects.toThrow(/KONTANTMETOD_CARRY_LINK_LOCKED/)
    })
    const other = await postCarry(company)
    await expect(
      getPool().query(`UPDATE public.invoices SET journal_entry_id = $1 WHERE id = $2`, [other, invoiceId]),
    ).rejects.toThrow(/KONTANTMETOD_CARRY_LINK_LOCKED/)

    expect(await invoiceLink(invoiceId)).toBe(carry)
    expect(await supplierInvoiceLink(supplierInvoiceId)).toBe(supplierCarry)
  })

  it('refuses delete_last_voucher of a carry, settled or not, and leaves 1510 and the link alone', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const carry = await carryCustomerInvoice(company, invoiceId)
    await expect(deleteLastVoucher(company, carry)).rejects.toThrow(/KONTANTMETOD_CARRY_DELETE_REFUSED/)

    // Cleared in 2027, as every payment door books it.
    await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.nextPeriodId,
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate: '2027-02-01',
      description: 'Betalning kundfaktura',
      sourceType: 'invoice_paid',
      sourceId: invoiceId,
      lines: [
        { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
        { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
      ],
    })
    await insertInvoicePaymentRow(company, invoiceId, '2027-02-01')
    const before = await accountBalance(company.companyId, '1510')

    await expect(deleteLastVoucher(company, carry)).rejects.toThrow(/KONTANTMETOD_CARRY_DELETE_REFUSED/)
    expect(await entryStatus(carry)).toBe('posted')
    expect(await invoiceLink(invoiceId)).toBe(carry)
    expect(await accountBalance(company.companyId, '1510')).toBe(before)
    expect(before).toBe(0)
  })

  it('lets the sandbox teardown window delete a carry, and nothing else', async () => {
    const attempt = async (sandbox: boolean) => {
      const company = await seedCashCompany('cash', { sandbox })
      const invoiceId = await insertCustomerInvoice(company)
      const carry = await carryCustomerInvoice(company, invoiceId)
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
        await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
        await client.query(`DELETE FROM public.journal_entries WHERE id = $1`, [carry])
        const { rows } = await client.query(`SELECT 1 FROM public.journal_entries WHERE id = $1`, [carry])
        return rows.length
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }
    // The flag alone opens nothing for a real company.
    await expect(attempt(false)).rejects.toThrow(/KONTANTMETOD_CARRY_DELETE_REFUSED/)
    expect(await attempt(true)).toBe(0)
  })

  it('stornoes a carry whose invoice was part paid in the closed year (payment before the carry)', async () => {
    const company = await seedCashCompany()
    const invoiceId = await insertCustomerInvoice(company)
    const supplierInvoiceId = await insertSupplierInvoice(company)
    // Paid in part before period end, then the residual carried.
    await insertInvoicePaymentRow(company, invoiceId, '2026-12-01', 250)
    await insertSupplierPaymentRow(company, supplierInvoiceId, PERIOD_END, 100)
    const carry = await carryCustomerInvoice(company, invoiceId, [
      { accountNumber: '1510', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 800 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 200 },
    ])
    const supplierCarry = await carrySupplierInvoice(company, supplierInvoiceId, [
      { accountNumber: '6110', debitAmount: 320, creditAmount: 0 },
      { accountNumber: '2641', debitAmount: 80, creditAmount: 0 },
      { accountNumber: '2440', debitAmount: 0, creditAmount: 400 },
    ])

    await stornoEntry(company, carry)
    await stornoEntry(company, supplierCarry)
    expect(await entryStatus(carry)).toBe('reversed')
    expect(await entryStatus(supplierCarry)).toBe('reversed')
    expect(await invoiceLink(invoiceId)).toBeNull()
    expect(await supplierInvoiceLink(supplierInvoiceId)).toBeNull()
  })
})
