import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry as insertPostedFixture, insertTransaction, seedCompany } from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260920191000_release_bank_rows_on_entry_delete (refs #2057).
 *
 * The invariant: a bank row whose LAST booking anchor disappears because its
 * verifikat is DELETED must stop claiming to be handled. "Att bokfora" is
 * is_business IS NULL AND is_ignored = false (lib/worklist/categories.ts), so
 * a row left at is_business = true with no anchor is unbooked AND invisible.
 *
 * The fix lives on the journal_entries DELETE event, so it holds for every
 * door at once. Two doors are live for an application role today and both are
 * exercised for real: reset_fiscal_year and delete_last_voucher. The raw
 * delete under the gnubok.allow_delete escape hatch is the mechanism they
 * share, and stands in for a door nobody has written yet.
 *
 * Deliberately NOT exercised: undo_sie_import and replace_sie_import. They
 * stranded most of the rows measured on prod, but since 20260911140532 no
 * network role can execute them (the SIE job pipeline stornos the batch and
 * releases its bank rows itself). lib/import/__tests__/
 * sie-import.replace.pg.test.ts pins that closure; calling them here as a
 * superuser would test a path production cannot reach.
 *
 * Also pinned, because each is a way this could go wrong:
 *  - a row still anchored elsewhere is NOT released;
 *  - a private row (is_business = false) is never touched;
 *  - storno and the correction relink are not deletion and are not fought;
 *  - the 1:N split's lock write (pointer NULL with is_business = true, junction
 *    rows inserted by a LATER request) keeps is_business = true. That last one
 *    is why the invariant is NOT a trigger on transactions: the lock write is
 *    indistinguishable from the FK's SET NULL.
 */

interface TxState {
  is_business: boolean | null
  category: string | null
  reconciliation_method: string | null
  is_ignored: boolean
  journal_entry_id: string | null
}

type Queryable = Pick<PoolClient, 'query'>

// These bank sources are outgoing. Their voucher must use the same bank side
// before the test can exercise removal of that otherwise valid anchor.
function insertPostedJournalEntry(params: Parameters<typeof insertPostedFixture>[0]) {
  return insertPostedFixture({
    lines: [
      { accountNumber: '1930', debitAmount: 0, creditAmount: 100 },
      { accountNumber: '2999', debitAmount: 100, creditAmount: 0 },
    ],
    ...params,
  })
}

async function txState(id: string, db: Queryable = getPool()): Promise<TxState> {
  const { rows } = await db.query<TxState>(
    `SELECT is_business, category, reconciliation_method, is_ignored, journal_entry_id
       FROM public.transactions WHERE id = $1`,
    [id],
  )
  return rows[0]
}

const RELEASED = {
  is_business: null,
  category: null,
  reconciliation_method: null,
  journal_entry_id: null,
}

/** A bank row in the state every booking flow leaves it in. */
async function insertHandledTx(params: {
  companyId: string
  userId: string
  journalEntryId?: string | null
  isBusiness?: boolean
  method?: string | null
  category?: string
}): Promise<string> {
  const id = await insertTransaction({ companyId: params.companyId, userId: params.userId })
  await getPool().query(
    `UPDATE public.transactions
        SET journal_entry_id = $2, is_business = $3, category = $4, reconciliation_method = $5
      WHERE id = $1`,
    [
      id,
      params.journalEntryId ?? null,
      params.isBusiness ?? true,
      params.category ?? 'expense_office',
      params.method === undefined ? 'auto_exact' : params.method,
    ],
  )
  return id
}

async function insertVoucherLink(params: {
  companyId: string
  userId: string
  transactionId: string
  journalEntryId: string
  amount?: number
  role?: 'bank_line' | 'clearing' | 'other'
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links
       (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.userId,
      params.companyId,
      params.transactionId,
      params.journalEntryId,
      params.amount ?? -100,
      params.role ?? 'bank_line',
    ],
  )
}

/** The mechanism every deletion door shares: the BFL escape hatch, then DELETE. */
async function hardDeleteEntries(entryIds: string[]): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
    await client.query(`DELETE FROM public.journal_entries WHERE id = ANY($1::uuid[])`, [entryIds])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

describe('a deleted verifikat releases the bank rows it anchored', () => {
  it('pointer anchor: the row returns to Att bokfora, whole', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: entryId })

    await hardDeleteEntries([entryId])

    expect(await txState(tx)).toMatchObject(RELEASED)
    // The canonical worklist predicate sees it again.
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.transactions
        WHERE company_id = $1 AND is_business IS NULL AND is_ignored = false`,
      [companyId],
    )
    expect(Number(rows[0].n)).toBe(1)
    // And the repair RPC's predicate no longer finds a stranded row.
    const stranded = await getPool().query(
      `SELECT 1 FROM public.transactions t
        WHERE t.company_id = $1 AND t.is_business = true AND t.is_ignored = false
          AND t.journal_entry_id IS NULL AND NOT public.is_transaction_booked(t.id)`,
      [companyId],
    )
    expect(stranded.rowCount).toBe(0)
  })

  it('junction-only anchor (samlingsverifikat, N>1): every row is released', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const a = await insertHandledTx({ companyId, userId, method: 'manual' })
    const b = await insertHandledTx({ companyId, userId, method: 'manual' })
    await insertVoucherLink({ companyId, userId, transactionId: a, journalEntryId: entryId })
    await insertVoucherLink({ companyId, userId, transactionId: b, journalEntryId: entryId })

    await hardDeleteEntries([entryId])

    expect(await txState(a)).toMatchObject(RELEASED)
    expect(await txState(b)).toMatchObject(RELEASED)
  })

  it('bulk-book N=1 (pointer AND a link to the same verifikat): released', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: entryId })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: entryId })

    await hardDeleteEntries([entryId])

    expect(await txState(tx)).toMatchObject(RELEASED)
  })

  it('a row split over two verifikat is released only when the last one goes', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const first = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const second = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })
    const tx = await insertHandledTx({ companyId, userId, method: 'manual' })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: first, amount: -60 })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: second, amount: -40 })

    await hardDeleteEntries([first])
    expect(await txState(tx)).toMatchObject({ is_business: true, category: 'expense_office' })

    await hardDeleteEntries([second])
    expect(await txState(tx)).toMatchObject(RELEASED)
  })

  it('both verifikat of a split deleted in ONE statement: released', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const first = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const second = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })
    const tx = await insertHandledTx({ companyId, userId, method: 'manual' })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: first, amount: -60 })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: second, amount: -40 })

    await hardDeleteEntries([first, second])

    expect(await txState(tx)).toMatchObject(RELEASED)
  })
})

describe('a row that is still anchored, or was never the lie, is left alone', () => {
  it('pointer deleted while a link to ANOTHER verifikat remains: not released', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const main = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const residual = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: main })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: residual, role: 'other' })

    await hardDeleteEntries([main])

    // Mirrors is_transaction_booked(): every junction role counts as an anchor.
    expect(await txState(tx)).toMatchObject({
      journal_entry_id: null,
      is_business: true,
      category: 'expense_office',
    })
  })

  it('a link deleted while the pointer names ANOTHER verifikat: not released', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const main = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const residual = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: main })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: residual, role: 'other' })

    await hardDeleteEntries([residual])

    expect(await txState(tx)).toMatchObject({ journal_entry_id: main, is_business: true })
  })

  it('a payment row still names the bank row: not released (the payment register owns that)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: entryId })
    const customerId = randomUUID()
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Kund')`,
      [customerId, userId, companyId],
    )
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, status, total)
       VALUES ($1, $2, $3, $4, 'F-1', '2026-06-01', '2026-06-30', 'paid', 100)`,
      [invoiceId, userId, companyId, customerId],
    )
    await getPool().query(
      `INSERT INTO public.invoice_payments
         (user_id, company_id, invoice_id, payment_date, amount, journal_entry_id, transaction_id)
       VALUES ($1, $2, $3, '2026-06-01', 100, $4, $5)`,
      [userId, companyId, invoiceId, entryId, tx],
    )

    await hardDeleteEntries([entryId])

    // The FK nulls the payment row's verifikat but the row stays, and
    // is_transaction_booked() keeps calling the bank row booked. Releasing it
    // here would recreate the half-anchored state of #2061 (worklist says att
    // bokfora, payment readers say booked). Deciding the invoice's fate is the
    // payment register's job, so this boundary is asserted, not hidden.
    const state = await txState(tx)
    expect(state.journal_entry_id).toBeNull()
    expect(state.is_business).toBe(true)
    const { rows } = await getPool().query<{ booked: boolean }>(
      `SELECT public.is_transaction_booked($1) AS booked`,
      [tx],
    )
    expect(rows[0].booked).toBe(true)
  })

  it('a private row (is_business = false) is never touched', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const tx = await insertHandledTx({
      companyId,
      userId,
      journalEntryId: entryId,
      isBusiness: false,
      category: 'private',
      method: null,
    })

    await hardDeleteEntries([entryId])

    expect(await txState(tx)).toMatchObject({
      journal_entry_id: null,
      is_business: false,
      category: 'private',
    })
  })

  it('is_ignored is never written', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: entryId })

    await hardDeleteEntries([entryId])

    expect((await txState(tx)).is_ignored).toBe(false)
  })

  it('another company is out of reach even with a colliding link', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    const entryId = await insertPostedJournalEntry({
      userId: mine.userId,
      companyId: mine.companyId,
      fiscalPeriodId: mine.fiscalPeriodId,
    })
    const theirEntry = await insertPostedJournalEntry({
      userId: theirs.userId,
      companyId: theirs.companyId,
      fiscalPeriodId: theirs.fiscalPeriodId,
    })
    const theirTx = await insertHandledTx({
      companyId: theirs.companyId,
      userId: theirs.userId,
      journalEntryId: theirEntry,
    })

    await hardDeleteEntries([entryId])

    expect(await txState(theirTx)).toMatchObject({ journal_entry_id: theirEntry, is_business: true })
  })
})

describe('every live deletion door releases its bank rows', () => {
  it('reset_fiscal_year', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const pointer = await insertHandledTx({ companyId, userId, journalEntryId: entryId })
    const viaLink = await insertHandledTx({ companyId, userId, method: 'manual' })
    await insertVoucherLink({ companyId, userId, transactionId: viaLink, journalEntryId: entryId })

    const res = await runAsServiceRole((c) =>
      c.query<{ result: { ok: boolean; code?: string } }>(
        `SELECT public.reset_fiscal_year($1::uuid, $2::uuid, '2026', $3::uuid) AS result`,
        [companyId, fiscalPeriodId, userId],
      ),
    )
    expect(res.rows[0].result.ok).toBe(true)

    expect(await txState(pointer)).toMatchObject(RELEASED)
    expect(await txState(viaLink)).toMatchObject(RELEASED)
  })

  it('reset_fiscal_year with a main verifikat AND its residual verifikat in the same year', async () => {
    // The whole year goes in ONE statement. A per-row BEFORE DELETE rule would
    // see the residual link while deleting the main verifikat, and the pointer
    // while deleting the residual, release on neither, and strand the row once
    // both referential actions had run. Judging the final state is what makes
    // this pass.
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const main = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const residual = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: main })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: residual, role: 'other' })

    const res = await runAsServiceRole((c) =>
      c.query<{ result: { ok: boolean } }>(
        `SELECT public.reset_fiscal_year($1::uuid, $2::uuid, '2026', $3::uuid) AS result`,
        [companyId, fiscalPeriodId, userId],
      ),
    )
    expect(res.rows[0].result.ok).toBe(true)

    expect(await txState(tx)).toMatchObject(RELEASED)
  })

  it('delete_last_voucher, called by an owner session (function not edited here)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: entryId })

    // withUserContext always rolls back, so assert inside the same transaction.
    const state = await withUserContext(userId, async (c) => {
      await c.query(`SELECT public.delete_last_voucher($1::uuid, $2::uuid)`, [companyId, entryId])
      return txState(tx, c)
    })

    expect(state).toMatchObject(RELEASED)
  })
})

describe('what is NOT deletion is not fought', () => {
  it('storno release: same end state, supplementary link dropped, no error', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const main = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const residual = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: main })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: residual, role: 'other' })

    const { rows } = await getPool().query<{ r: { released: number; dropped: number } }>(
      `SELECT public.release_reversed_entry_transactions($1::uuid, $2::uuid) AS r`,
      [companyId, main],
    )

    expect(rows[0].r).toEqual({ released: 1, dropped: 1 })
    expect(await txState(tx)).toMatchObject(RELEASED)
  })

  it('correction relink (pointer swapped A to B in one write): stays handled', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const original = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const correction = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: original })

    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $2 WHERE company_id = $3 AND journal_entry_id = $1`,
      [original, correction, companyId],
    )

    expect(await txState(tx)).toMatchObject({
      journal_entry_id: correction,
      is_business: true,
      category: 'expense_office',
      reconciliation_method: 'auto_exact',
    })
  })

  it('a link removed by an application write, its verifikat still there: untouched', async () => {
    // The split's rollback and koppla-bort delete junction rows and own the
    // row's state themselves. The verifikat still exists, so this is not the
    // deletion class and the trigger's write must not fire.
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const tx = await insertHandledTx({ companyId, userId, method: 'manual' })
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: entryId })

    await getPool().query(
      `DELETE FROM public.transaction_voucher_links WHERE company_id = $1 AND transaction_id = $2`,
      [companyId, tx],
    )

    expect(await txState(tx)).toMatchObject({
      is_business: true,
      category: 'expense_office',
      reconciliation_method: 'manual',
    })
  })

  it('the 1:N split lock write keeps is_business = true until its links land', async () => {
    // lib/reconciliation/bank-reconciliation.ts linkTransactionToVouchers writes
    // pointer NULL together with is_business = true, and inserts the junction
    // rows in a LATER request. For a row that was 1:1 linked, that write differs
    // from the FK's SET NULL in nothing but intent. A trigger on transactions
    // keyed on "pointer went NULL, no anchor left" would reset this row mid
    // split and leave it booked AND in Att bokfora. This test is the guard
    // against moving the invariant there.
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const previous = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const sliceA = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })
    const tx = await insertHandledTx({ companyId, userId, journalEntryId: previous, method: 'manual' })

    // Request 1: the lock write, committed on its own.
    await getPool().query(
      `UPDATE public.transactions
          SET journal_entry_id = NULL, reconciliation_method = 'manual', is_business = true
        WHERE id = $1 AND journal_entry_id = $2`,
      [tx, previous],
    )
    expect(await txState(tx)).toMatchObject({ journal_entry_id: null, is_business: true })

    // Request 2: the junction rows land.
    await insertVoucherLink({ companyId, userId, transactionId: tx, journalEntryId: sliceA })
    expect(await txState(tx)).toMatchObject({ is_business: true, category: 'expense_office' })
  })
})

describe('bulk deletion stays cheap', () => {
  it(
    '1000 verifikat anchoring 2000 bank rows, one statement: all released, no runaway cost',
    async () => {
      // Every teardown and the year reset delete verifikat in bulk. Measured
      // locally for the PR: 3000 verifikat / 6000 bank rows took 3.0 s without
      // the release and 4.9 s with it, about 0.33 ms per released row, every
      // probe on an index. The ceiling here is deliberately loose: it exists to
      // catch a sequential scan or an O(n^2) slip (minutes), not to benchmark.
      const { userId, companyId, fiscalPeriodId } = await seedCompany()
      const N = 1000
      const client = await getPool().connect()
      let elapsedMs = 0
      try {
        await client.query('BEGIN')
        await client.query(`CREATE TEMP TABLE bulk_e (id uuid, g int) ON COMMIT DROP`)
        await client.query(`INSERT INTO bulk_e SELECT gen_random_uuid(), g FROM generate_series(1, $1::int) g`, [N])
        await client.query(
          `INSERT INTO public.journal_entries
             (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
              entry_date, description, source_type, status)
           SELECT id, $1, $2, $3, g, 'A', '2026-06-01', 'bulk', 'manual', 'draft' FROM bulk_e`,
          [userId, companyId, fiscalPeriodId],
        )
        await client.query(
          `INSERT INTO public.journal_entry_lines
             (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
           SELECT id, '1930', 100, 0, 'SEK', 0 FROM bulk_e
           UNION ALL
           SELECT id, '3001', 0, 100, 'SEK', 1 FROM bulk_e`,
        )
        await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE company_id = $1`, [
          companyId,
        ])
        // N rows anchored by the pointer.
        await client.query(
          `INSERT INTO public.transactions
             (company_id, user_id, currency, amount, date, description,
              journal_entry_id, is_business, category, reconciliation_method)
           SELECT $1, $2, 'SEK', 100, '2026-06-01', 'bulk ptr', id, true, 'income_services', 'auto_exact'
             FROM bulk_e`,
          [companyId, userId],
        )
        // N rows anchored by the junction alone.
        await client.query(
          `WITH t AS (
             INSERT INTO public.transactions
               (company_id, user_id, currency, amount, date, description,
                is_business, category, reconciliation_method)
             SELECT $1, $2, 'SEK', 100, '2026-06-01', 'bulk link ' || g, true, 'income_services', 'manual'
               FROM bulk_e
             RETURNING id, description
           )
           INSERT INTO public.transaction_voucher_links
             (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
           SELECT $2, $1, t.id, e.id, 100, 'bank_line'
             FROM t JOIN bulk_e e ON t.description = 'bulk link ' || e.g`,
          [companyId, userId],
        )

        await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
        const started = Date.now()
        await client.query(`DELETE FROM public.journal_entries WHERE company_id = $1`, [companyId])
        elapsedMs = Date.now() - started

        const { rows } = await client.query<{ released: string; stranded: string }>(
          `SELECT count(*) FILTER (WHERE is_business IS NULL AND category IS NULL
                                     AND reconciliation_method IS NULL
                                     AND journal_entry_id IS NULL)::text AS released,
                  count(*) FILTER (WHERE is_business = true)::text AS stranded
             FROM public.transactions WHERE company_id = $1`,
          [companyId],
        )
        expect(Number(rows[0].released)).toBe(2 * N)
        expect(Number(rows[0].stranded)).toBe(0)
        await client.query('ROLLBACK')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
      expect(elapsedMs).toBeLessThan(60_000)
    },
    180_000,
  )
})
