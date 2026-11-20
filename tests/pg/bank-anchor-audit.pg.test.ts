import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertCashAccount, insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'
import { getPool, withUserContext } from './setup'

/**
 * Covers 20261120180000_bank_anchor_audit (#2407): a bank row's booking that
 * moves to another verifikat or is released leaves an audit_log row, on the
 * pointer (transactions.journal_entry_id) and on the junction
 * (transaction_voucher_links, with role and allocated_amount), under the
 * person who moved it. These run the statements the correction
 * (relinkTransactionsToEntry), the storno (release_reversed_entry_transactions
 * plus the engine's junction cleanup) and delete_last_voucher issue. A first
 * booking and every other update of the row write nothing.
 */

interface AuditRow {
  action: string
  company_id: string | null
  user_id: string | null
  actor_type: string | null
  old_state: Record<string, unknown> | null
  new_state: Record<string, unknown> | null
}

async function auditRows(table: string, recordId: string, db: Pick<PoolClient, 'query'> = getPool()): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT action, company_id, user_id, actor_type, old_state, new_state
       FROM public.audit_log
      WHERE table_name = $1 AND record_id = $2
      ORDER BY created_at, id`,
    [table, recordId],
  )
  return rows
}

async function company() {
  const seeded = await seedCompany()
  const cash = await insertCashAccount({ companyId: seeded.companyId, ledgerAccount: '1930', currency: 'SEK', isPrimary: true })
  return { ...seeded, cash }
}

type Seed = Awaited<ReturnType<typeof company>>

function bankEntry(s: Seed) {
  return insertPostedJournalEntry({
    userId: s.userId,
    companyId: s.companyId,
    fiscalPeriodId: s.fiscalPeriodId,
    entryDate: '2026-03-10',
    description: 'Verifikat',
    lines: [
      { accountNumber: '1930', debitAmount: 700, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 700 },
    ],
  })
}

/** A bank row booked on `entry` through both anchors, written as INSERTs (a first booking). */
async function bookedRow(s: Seed, entry: string): Promise<{ tx: string; link: string }> {
  const tx = await insertTransaction({
    companyId: s.companyId,
    userId: s.userId,
    date: '2026-03-10',
    amount: 700,
    cashAccountId: s.cash,
    journalEntryId: entry,
  })
  const link = randomUUID()
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, 700, 'bank_line')`,
    [link, s.userId, s.companyId, tx, entry],
  )
  return { tx, link }
}

/** A posted correction of `original`, which is reversed first. */
async function correctionOf(s: Seed, original: string, voucherNumber: number): Promise<string> {
  await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [original])
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, correction_of_id)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-03-10', 'Rättelse', 'manual', 'draft', $6)`,
      [id, s.userId, s.companyId, s.fiscalPeriodId, voucherNumber, original],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '1930', 700, 0, 'SEK', 0), ($1, '3001', 0, 700, 'SEK', 1)`,
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

describe('bank-anchor audit (#2407)', () => {
  it('a first booking and other updates of the bank row write nothing', async () => {
    const s = await company()
    const { tx, link } = await bookedRow(s, await bankEntry(s))

    await withUserContext(s.userId, async (client) => {
      await client.query(`UPDATE public.transactions SET is_business = true, description = 'Ny titel' WHERE id = $1`, [tx])
      await client.query(`UPDATE public.transaction_voucher_links SET updated_at = now() WHERE id = $1`, [link])
      expect(await auditRows('transactions', tx, client)).toEqual([])
      expect(await auditRows('transaction_voucher_links', link, client)).toEqual([])
    })
  })

  it('a correction moving both anchors is logged once each, under the person, with role and amount', async () => {
    const s = await company()
    const original = await bankEntry(s)
    const { tx, link } = await bookedRow(s, original)
    // A counterparty that is an individual: its org number is a personnummer.
    await getPool().query(
      `UPDATE public.transactions SET counterparty_org_number = '198001011234', counterparty_iban = 'SE4550000000058398257466' WHERE id = $1`,
      [tx],
    )
    const correction = await correctionOf(s, original, 2)

    await withUserContext(s.userId, async (client) => {
      // relinkTransactionsToEntry's two statements.
      await client.query(
        `UPDATE public.transactions SET journal_entry_id = $3 WHERE company_id = $1 AND journal_entry_id = $2`,
        [s.companyId, original, correction],
      )
      await client.query(
        `UPDATE public.transaction_voucher_links SET journal_entry_id = $3 WHERE company_id = $1 AND journal_entry_id = $2`,
        [s.companyId, original, correction],
      )

      const pointer = await auditRows('transactions', tx, client)
      expect(pointer).toHaveLength(1)
      expect(pointer[0]).toMatchObject({ action: 'UPDATE', company_id: s.companyId, user_id: s.userId, actor_type: 'user' })
      expect([pointer[0].old_state?.journal_entry_id, pointer[0].new_state?.journal_entry_id]).toEqual([original, correction])
      // Only the columns that name the row and its booking: the counterparty's
      // org number (a personnummer for an individual) and IBAN never enter the log.
      for (const state of [pointer[0].old_state, pointer[0].new_state]) {
        expect(Object.keys(state ?? {}).sort()).toEqual(
          ['amount', 'cash_account_id', 'company_id', 'currency', 'date', 'description', 'id', 'journal_entry_id', 'user_id'],
        )
      }
      expect(JSON.stringify(pointer[0])).not.toMatch(/198001011234|SE4550000000058398257466/)

      const junction = await auditRows('transaction_voucher_links', link, client)
      expect(junction).toHaveLength(1)
      expect(junction[0]).toMatchObject({ action: 'UPDATE', company_id: s.companyId, user_id: s.userId })
      expect(junction[0].old_state).toMatchObject({ transaction_id: tx, journal_entry_id: original, role: 'bank_line' })
      expect(junction[0].new_state).toMatchObject({ journal_entry_id: correction, role: 'bank_line' })
      expect(Number(junction[0].old_state?.allocated_amount)).toBe(700)
    })
  })

  it('a storno release and the junction cleanup are logged, the dropped link with its role and amount', async () => {
    const s = await company()
    const entry = await bankEntry(s)
    const { tx, link } = await bookedRow(s, entry)
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [entry])

    await withUserContext(s.userId, async (client) => {
      const released = await client.query<{ r: { released: number } }>(
        `SELECT public.release_reversed_entry_transactions($1, $2) AS r`,
        [s.companyId, entry],
      )
      expect(released.rows[0]!.r.released).toBe(1)
      // The engine's junction cleanup for the reversed verifikat.
      await client.query(
        `DELETE FROM public.transaction_voucher_links WHERE company_id = $1 AND journal_entry_id = $2`,
        [s.companyId, entry],
      )

      const pointer = await auditRows('transactions', tx, client)
      expect(pointer).toHaveLength(1)
      expect([pointer[0].old_state?.journal_entry_id, pointer[0].new_state?.journal_entry_id]).toEqual([entry, null])

      const junction = await auditRows('transaction_voucher_links', link, client)
      expect(junction).toHaveLength(1)
      expect(junction[0]).toMatchObject({ action: 'DELETE', company_id: s.companyId, user_id: s.userId, new_state: null })
      expect(junction[0].old_state).toMatchObject({ transaction_id: tx, journal_entry_id: entry, role: 'bank_line' })
      expect(Number(junction[0].old_state?.allocated_amount)).toBe(700)
    })
  })

  it('behandlingshistorik_sources returns the rows', async () => {
    const s = await company()
    const original = await bankEntry(s)
    const { tx } = await bookedRow(s, original)
    const correction = await correctionOf(s, original, 2)
    const { rows } = await withUserContext(s.userId, async (client) => {
      await client.query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx, correction])
      return client.query<{ audit: Array<{ table_name: string; record_id: string }> }>(
        `SELECT audit FROM public.behandlingshistorik_sources($1, $2, now() - interval '1 hour', now() + interval '1 hour', false)`,
        [s.companyId, s.fiscalPeriodId],
      )
    })
    expect(rows[0]!.audit.some((a) => a.table_name === 'transactions' && a.record_id === tx)).toBe(true)
  })
})
