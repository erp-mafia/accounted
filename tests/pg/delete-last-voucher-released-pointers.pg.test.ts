import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, type PostedJournalEntryLine } from '@/tests/pg/fixtures'
import { insertSupplierInvoice, seedCashCompany, type CashCompany } from '@/tests/pg/kontantmetod-carry-fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261127180000_delete_last_voucher_returns_released_pointers.
 *
 * Three steps release or move a register pointer when a verifikat is reversed
 * or corrected, and deleting that storno or correction as the last voucher in
 * its series now puts the pointer back:
 *  1. a correction that a tax account row moved to
 *     (skattekonto_transactions.journal_entry_id) hands the row back to the
 *     original when the correction is deleted;
 *  2. a storno of a tax account booking (source_type 'tax_account' or
 *     'system', source_id = the row) whose row reverseEntry released: deleting
 *     the storno posts the original again and the row names it again, its
 *     proposal cleared;
 *  3. a storno of a supplier invoice registration
 *     (source_type 'supplier_invoice_registered', source_id = the invoice)
 *     whose pointer the reversal hook cleared: deleting the storno posts the
 *     registration again and the invoice names it again.
 * Each is named in the audit snapshot's register_effects.
 *
 * And left as they are: a tax row linked to another verifikat or ignored
 * since, an invoice booked on another verifikat since, a retired ('reversed')
 * invoice, another company's rows, the rows a storno of another source type
 * names, and a system verifikat with no tax row behind it.
 *
 * The storno and the releases are written the way the engine leaves them
 * (reverseEntry, the registration reversal hook, the correction consumer);
 * only delete_last_voucher runs as the signed-in owner.
 */

type Queryable = Pick<PoolClient, 'query'>

const TAX_LINES: PostedJournalEntryLine[] = [
  { accountNumber: '2510', debitAmount: 1000, creditAmount: 0 },
  { accountNumber: '1630', debitAmount: 0, creditAmount: 1000 },
]

const REGISTRATION_LINES: PostedJournalEntryLine[] = [
  { accountNumber: '4010', debitAmount: 400, creditAmount: 0 },
  { accountNumber: '2641', debitAmount: 100, creditAmount: 0 },
  { accountNumber: '2440', debitAmount: 0, creditAmount: 500 },
]

async function entryStatus(id: string, db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM public.journal_entries WHERE id = $1`, [id])
  return rows[0]?.status ?? null
}

/** Storno of a posted entry as the engine leaves it: swapped lines, posted, original reversed. */
async function stornoOf(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  originalId: string
  voucherNumber: number
}): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, reverses_id, status, bank_booking_context)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-06-01', 'Storno', 'storno', $6, 'draft', '[]'::jsonb)`,
      [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber, params.originalId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       SELECT $1, account_number, credit_amount, debit_amount, currency, sort_order
         FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [id, params.originalId],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query(
      `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
      [params.originalId, id],
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

/** The corrected verifikat correctEntry posts: source_type 'correction', correction_of_id, its own lines. */
async function correctionOf(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  originalId: string
  voucherNumber: number
}): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, correction_of_id, status, bank_booking_context)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-06-01', 'Correction', 'correction', $6, 'draft', '[]'::jsonb)`,
      [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber, params.originalId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '2510', 900, 0, 'SEK', 0), ($1, '1630', 0, 900, 'SEK', 1)`,
      [id],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** A settled Skatteverket event as the sync writes it: unlinked, not ignored, no proposal. */
async function insertTaxRow(companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.skattekonto_transactions
       (id, company_id, dedup_key, transaktionsdatum, transaktionstext, belopp_skatteverket, status)
     VALUES ($1, $2, $3, '2026-06-01', 'Debiterad preliminärskatt', -1000, 'booked')`,
    [id, companyId, `pg-real-${id}`],
  )
  return id
}

async function setTaxRowPointer(rowId: string, entryId: string | null): Promise<void> {
  await getPool().query(`UPDATE public.skattekonto_transactions SET journal_entry_id = $2 WHERE id = $1`, [
    rowId,
    entryId,
  ])
}

interface TaxRowState {
  journal_entry_id: string | null
  is_ignored: boolean
  suggested_journal_entry_id: string | null
  suggested_at: string | null
}

async function taxRowState(id: string, db: Queryable): Promise<TaxRowState | null> {
  const { rows } = await db.query<TaxRowState>(
    `SELECT journal_entry_id, is_ignored, suggested_journal_entry_id, suggested_at
       FROM public.skattekonto_transactions WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

async function setRegistrationPointer(invoiceId: string, entryId: string | null): Promise<void> {
  await getPool().query(`UPDATE public.supplier_invoices SET registration_journal_entry_id = $2 WHERE id = $1`, [
    invoiceId,
    entryId,
  ])
}

async function registrationPointer(invoiceId: string, db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ pointer: string | null }>(
    `SELECT registration_journal_entry_id AS pointer FROM public.supplier_invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]?.pointer ?? null
}

/** register_effects of the audit snapshot delete_last_voucher wrote for the entry. */
async function registerEffects(entryId: string, db: Queryable): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query<{ effects: Record<string, unknown> | null }>(
    `SELECT old_state -> 'register_effects' AS effects
       FROM public.audit_log
      WHERE record_id = $1 AND action = 'DELETE' AND table_name = 'journal_entries'
        AND old_state ? 'register_effects'`,
    [entryId],
  )
  return rows[0]?.effects ?? null
}

function deleteLast(db: Queryable, companyId: string, entryId: string) {
  return db.query<{ result: { deleted: boolean } }>(
    `SELECT public.delete_last_voucher($1::uuid, $2::uuid) AS result`,
    [companyId, entryId],
  )
}

/** A verifikat in series B, so the storno stays the last A voucher. */
function otherVerifikat(company: CashCompany, params: { sourceType?: string; sourceId?: string; lines: PostedJournalEntryLine[] }) {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    voucherSeries: 'B',
    voucherNumber: 1,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    lines: params.lines,
  })
}

interface ReversedOriginal {
  company: CashCompany
  originalId: string
  stornoId: string
}

/**
 * A1 posted with this source, reversed by the storno A2 (the last A voucher).
 * `link` runs before the storno, `release` after it, as the engine orders them.
 */
async function reversedOriginal(params: {
  company?: CashCompany
  sourceType: string
  sourceId: string | null
  lines: PostedJournalEntryLine[]
  link?: (originalId: string) => Promise<void>
  release?: () => Promise<void>
}): Promise<ReversedOriginal> {
  const company = params.company ?? (await seedCashCompany('accrual'))
  const { userId, companyId, fiscalPeriodId } = company
  const originalId = await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    voucherNumber: 1,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    lines: params.lines,
  })
  if (params.link) await params.link(originalId)
  const stornoId = await stornoOf({ userId, companyId, fiscalPeriodId, originalId, voucherNumber: 2 })
  if (params.release) await params.release()
  return { company, originalId, stornoId }
}

/** A tax account booking of its row, reversed by reverseEntry: the row's pointer cleared. */
async function reversedTaxBooking(sourceType: 'tax_account' | 'system') {
  const company = await seedCashCompany('accrual')
  const rowId = await insertTaxRow(company.companyId)
  const reversed = await reversedOriginal({
    company,
    sourceType,
    sourceId: rowId,
    lines: TAX_LINES,
    link: (originalId) => setTaxRowPointer(rowId, originalId),
    release: () => setTaxRowPointer(rowId, null),
  })
  return { ...reversed, rowId }
}

/** A supplier invoice's registration, reversed: the reversal hook cleared the invoice's pointer. */
async function reversedRegistration() {
  const company = await seedCashCompany('accrual')
  const invoiceId = await insertSupplierInvoice(company)
  const reversed = await reversedOriginal({
    company,
    sourceType: 'supplier_invoice_registered',
    sourceId: invoiceId,
    lines: REGISTRATION_LINES,
    link: (originalId) => setRegistrationPointer(invoiceId, originalId),
    release: () => setRegistrationPointer(invoiceId, null),
  })
  return { ...reversed, invoiceId }
}

describe('delete_last_voucher on a correction a tax account row moved to', () => {
  /** A1 the tax booking of the row, storno A2 and correction A3 posted by correctEntry, the row moved to A3. */
  async function correctedTaxBooking() {
    const company = await seedCashCompany('accrual')
    const { userId, companyId, fiscalPeriodId } = company
    const rowId = await insertTaxRow(companyId)
    const originalId = await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: 1,
      sourceType: 'tax_account',
      sourceId: rowId,
      lines: TAX_LINES,
    })
    await setTaxRowPointer(rowId, originalId)
    const stornoId = await stornoOf({ userId, companyId, fiscalPeriodId, originalId, voucherNumber: 2 })
    const correctionId = await correctionOf({ userId, companyId, fiscalPeriodId, originalId, voucherNumber: 3 })
    await setTaxRowPointer(rowId, correctionId)
    return { company, rowId, originalId, stornoId, correctionId }
  }

  it('returns the row to the original and names it in the audit snapshot', async () => {
    const { company, rowId, originalId, stornoId, correctionId } = await correctedTaxBooking()

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, correctionId)
      await c.query('RESET ROLE')
      return {
        pointer: (await taxRowState(rowId, c))?.journal_entry_id ?? null,
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        correction: await entryStatus(correctionId, c),
        returned: (await registerEffects(correctionId, c))?.returned_tax_account_row_ids ?? null,
      }
    })

    expect(result).toEqual({
      pointer: originalId,
      original: 'reversed',
      storno: 'posted',
      correction: null,
      returned: [rowId],
    })
  })

  it('still names the original once the storno is deleted too, and the storno delete moves nothing more', async () => {
    const { company, rowId, originalId, stornoId, correctionId } = await correctedTaxBooking()

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, correctionId)
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      const stornoEffects = await registerEffects(stornoId, c)
      return {
        pointer: (await taxRowState(rowId, c))?.journal_entry_id ?? null,
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        reanchoredOnStorno: stornoEffects ? 'reanchored_tax_account_row_id' in stornoEffects : null,
      }
    })

    expect(result).toEqual({ pointer: originalId, original: 'posted', storno: null, reanchoredOnStorno: false })
  })

  it("leaves another company's row that names the correction to the foreign key", async () => {
    const { company, rowId, originalId, correctionId } = await correctedTaxBooking()
    const other = await seedCashCompany('accrual')
    const otherRowId = await insertTaxRow(other.companyId)
    await setTaxRowPointer(otherRowId, correctionId)

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, correctionId)
      await c.query('RESET ROLE')
      return {
        own: (await taxRowState(rowId, c))?.journal_entry_id ?? null,
        other: (await taxRowState(otherRowId, c))?.journal_entry_id ?? null,
        returned: (await registerEffects(correctionId, c))?.returned_tax_account_row_ids ?? null,
      }
    })

    expect(result).toEqual({ own: originalId, other: null, returned: [rowId] })
  })
})

const TAX_BOOKING_SOURCE_TYPES: Array<'tax_account' | 'system'> = ['tax_account', 'system']

describe.each(TAX_BOOKING_SOURCE_TYPES)('delete_last_voucher on a storno of a %s tax account booking', (sourceType) => {
  it('names the original on its row again, clears the proposal and names the row in the audit snapshot', async () => {
    const { company, rowId, originalId, stornoId } = await reversedTaxBooking(sourceType)
    // The sync proposed a verifikat for the row while it was open.
    const proposedId = await otherVerifikat(company, { lines: TAX_LINES })
    await getPool().query(
      `UPDATE public.skattekonto_transactions SET suggested_journal_entry_id = $2, suggested_at = now() WHERE id = $1`,
      [rowId, proposedId],
    )

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      return {
        row: await taxRowState(rowId, c),
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        reanchored: (await registerEffects(stornoId, c))?.reanchored_tax_account_row_id ?? null,
      }
    })

    expect(result).toEqual({
      row: { journal_entry_id: originalId, is_ignored: false, suggested_journal_entry_id: null, suggested_at: null },
      original: 'posted',
      storno: null,
      reanchored: rowId,
    })
  })
})

describe('delete_last_voucher on a storno of a tax account booking: rows left as they are', () => {
  it('leaves a row linked to another verifikat since', async () => {
    const { company, rowId, originalId, stornoId } = await reversedTaxBooking('tax_account')
    const linkedId = await otherVerifikat(company, { lines: TAX_LINES })
    await setTaxRowPointer(rowId, linkedId)

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      const effects = await registerEffects(stornoId, c)
      return {
        pointer: (await taxRowState(rowId, c))?.journal_entry_id ?? null,
        original: await entryStatus(originalId, c),
        reanchored: effects ? 'reanchored_tax_account_row_id' in effects : null,
      }
    })

    expect(result).toEqual({ pointer: linkedId, original: 'posted', reanchored: false })
  })

  it('leaves a row ignored since, and the delete goes through', async () => {
    const { company, rowId, originalId, stornoId } = await reversedTaxBooking('tax_account')
    await getPool().query(`UPDATE public.skattekonto_transactions SET is_ignored = true WHERE id = $1`, [rowId])

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      return {
        row: await taxRowState(rowId, c),
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
      }
    })

    expect(result).toMatchObject({
      row: { journal_entry_id: null, is_ignored: true },
      original: 'posted',
      storno: null,
    })
  })

  it("leaves another company's row that the original's source_id names", async () => {
    const other = await seedCashCompany('accrual')
    const otherRowId = await insertTaxRow(other.companyId)
    const { company, originalId, stornoId } = await reversedOriginal({
      sourceType: 'tax_account',
      sourceId: otherRowId,
      lines: TAX_LINES,
    })

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      const effects = await registerEffects(stornoId, c)
      return {
        pointer: (await taxRowState(otherRowId, c))?.journal_entry_id ?? null,
        original: await entryStatus(originalId, c),
        reanchored: effects ? 'reanchored_tax_account_row_id' in effects : null,
      }
    })

    expect(result).toEqual({ pointer: null, original: 'posted', reanchored: false })
  })
})

describe('delete_last_voucher on a storno of a supplier invoice registration', () => {
  it('names the original on the invoice again and names the invoice in the audit snapshot', async () => {
    const { company, invoiceId, originalId, stornoId } = await reversedRegistration()

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      return {
        pointer: await registrationPointer(invoiceId, c),
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        reanchored: (await registerEffects(stornoId, c))?.reanchored_supplier_invoice_id ?? null,
      }
    })

    expect(result).toEqual({ pointer: originalId, original: 'posted', storno: null, reanchored: invoiceId })
  })

  it('leaves an invoice booked on another registration since', async () => {
    const { company, invoiceId, originalId, stornoId } = await reversedRegistration()
    const rebookedId = await otherVerifikat(company, {
      sourceType: 'supplier_invoice_registered',
      sourceId: invoiceId,
      lines: REGISTRATION_LINES,
    })
    await setRegistrationPointer(invoiceId, rebookedId)

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      const effects = await registerEffects(stornoId, c)
      return {
        pointer: await registrationPointer(invoiceId, c),
        original: await entryStatus(originalId, c),
        reanchored: effects ? 'reanchored_supplier_invoice_id' in effects : null,
      }
    })

    expect(result).toEqual({ pointer: rebookedId, original: 'posted', reanchored: false })
  })

  it('leaves a retired invoice (status reversed) without a pointer', async () => {
    const { company, invoiceId, originalId, stornoId } = await reversedRegistration()
    // The create flow's undo of a failed registration: storno, then the invoice retired.
    await getPool().query(
      `UPDATE public.supplier_invoices SET status = 'reversed', reversed_at = now() WHERE id = $1`,
      [invoiceId],
    )

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      const effects = await registerEffects(stornoId, c)
      return {
        pointer: await registrationPointer(invoiceId, c),
        original: await entryStatus(originalId, c),
        reanchored: effects ? 'reanchored_supplier_invoice_id' in effects : null,
      }
    })

    expect(result).toEqual({ pointer: null, original: 'posted', reanchored: false })
  })

  it("leaves another company's invoice that the original's source_id names", async () => {
    const other = await seedCashCompany('accrual')
    const otherInvoiceId = await insertSupplierInvoice(other)
    const { company, originalId, stornoId } = await reversedOriginal({
      sourceType: 'supplier_invoice_registered',
      sourceId: otherInvoiceId,
      lines: REGISTRATION_LINES,
    })

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      const effects = await registerEffects(stornoId, c)
      return {
        pointer: await registrationPointer(otherInvoiceId, c),
        original: await entryStatus(originalId, c),
        reanchored: effects ? 'reanchored_supplier_invoice_id' in effects : null,
      }
    })

    expect(result).toEqual({ pointer: null, original: 'posted', reanchored: false })
  })
})

describe('delete_last_voucher on a storno that the additions do not apply to', () => {
  it('changes no tax row a storno of a manual verifikat names in source_id', async () => {
    const company = await seedCashCompany('accrual')
    const rowId = await insertTaxRow(company.companyId)
    const { originalId, stornoId } = await reversedOriginal({
      company,
      sourceType: 'manual',
      sourceId: rowId,
      lines: TAX_LINES,
    })

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      return {
        pointer: (await taxRowState(rowId, c))?.journal_entry_id ?? null,
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        effects: Object.keys((await registerEffects(stornoId, c)) ?? {}).sort(),
      }
    })

    expect(result).toEqual({
      pointer: null,
      original: 'posted',
      storno: null,
      effects: ['removed_expense_claim_ids', 'removed_supplier_payments', 'reverted_supplier_invoice_ids'],
    })
  })

  it('changes no supplier invoice a storno of a manual verifikat names in source_id', async () => {
    const company = await seedCashCompany('accrual')
    const invoiceId = await insertSupplierInvoice(company)
    const { originalId, stornoId } = await reversedOriginal({
      company,
      sourceType: 'manual',
      sourceId: invoiceId,
      lines: REGISTRATION_LINES,
    })

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      return {
        pointer: await registrationPointer(invoiceId, c),
        original: await entryStatus(originalId, c),
        effects: Object.keys((await registerEffects(stornoId, c)) ?? {}).sort(),
      }
    })

    expect(result).toEqual({
      pointer: null,
      original: 'posted',
      effects: ['removed_expense_claim_ids', 'removed_supplier_payments', 'reverted_supplier_invoice_ids'],
    })
  })

  it.each([
    { name: 'no source_id (a disposal, a component replacement)', sourceId: () => null },
    { name: 'a source_id that names no tax row', sourceId: () => randomUUID() },
  ])('changes nothing for a system verifikat with $name', async ({ sourceId }) => {
    const company = await seedCashCompany('accrual')
    // An open row of the same company the delete must not touch.
    const openRowId = await insertTaxRow(company.companyId)
    const { originalId, stornoId } = await reversedOriginal({
      company,
      sourceType: 'system',
      sourceId: sourceId(),
      lines: TAX_LINES,
    })

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      return {
        openRow: await taxRowState(openRowId, c),
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        effects: Object.keys((await registerEffects(stornoId, c)) ?? {}).sort(),
      }
    })

    expect(result).toEqual({
      openRow: { journal_entry_id: null, is_ignored: false, suggested_journal_entry_id: null, suggested_at: null },
      original: 'posted',
      storno: null,
      effects: ['removed_expense_claim_ids', 'removed_supplier_payments', 'reverted_supplier_invoice_ids'],
    })
  })
})
