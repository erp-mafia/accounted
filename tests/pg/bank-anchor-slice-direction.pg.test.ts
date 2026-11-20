import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { insertCashAccount, insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'

// pg-real coverage for the 1:N bank split rules (agent feedback seq 853921,
// 877706):
//   - 20261006121001: each bank_line junction slice is checked in its own
//     direction (allocated_amount) against its verifikat, so a split may net
//     verifikat booked in both directions into one bank row; whole-row
//     anchors (the pointer, the bulk-book bank_line row carrying the row
//     amount) keep the row's direction.
//   - 20261006121004: at COMMIT, a row whose bank_line slices include one
//     against its direction must have slices summing to its amount, so a lone
//     opposite-sign slice, a moved slice or a removed sibling is refused.

type Ctx = Awaited<ReturnType<typeof seed>>

async function seed() {
  const owner = await seedCompany()
  const cashAccountId = await insertCashAccount({ companyId: owner.companyId, ledgerAccount: '1930' })
  // One bulk payment of -100 out of the bank: -120 to a supplier, with a +20
  // credit note from the same supplier netted in it.
  const txId = await insertTransaction({
    companyId: owner.companyId,
    userId: owner.userId,
    amount: -100,
    date: '2026-06-01',
    cashAccountId,
  })
  const payment = await insertPostedJournalEntry({
    ...owner,
    entryDate: '2026-06-01',
    description: 'Leverantörsbetalning',
    lines: [
      { accountNumber: '2440', debitAmount: 120, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 120 },
    ],
  })
  const creditNote = await insertPostedJournalEntry({
    ...owner,
    entryDate: '2026-06-01',
    description: 'Kreditnota kvittad i betalningen',
    lines: [
      { accountNumber: '1930', debitAmount: 20, creditAmount: 0 },
      { accountNumber: '2440', debitAmount: 0, creditAmount: 20 },
    ],
  })
  return { ...owner, cashAccountId, txId, payment, creditNote }
}

type Db = Pick<PoolClient, 'query'>

function slice(ctx: Ctx, journalEntryId: string, amount: number, role = 'bank_line', transactionId = ctx.txId, db: Db = getPool()) {
  return db.query(
    `INSERT INTO public.transaction_voucher_links
       (company_id, user_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.companyId, ctx.userId, transactionId, journalEntryId, amount, role],
  )
}

/** Several writes in ONE transaction, as a single PostgREST request makes them. */
async function inOneTransaction(write: (db: Db) => Promise<unknown>): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await write(client)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** The balanced mixed split: -120 on the payment, +20 on the credit note. */
function linkMixedSplit(ctx: Ctx) {
  return inOneTransaction(async (db) => {
    await slice(ctx, ctx.payment, -120, 'bank_line', ctx.txId, db)
    await slice(ctx, ctx.creditNote, 20, 'bank_line', ctx.txId, db)
  })
}

async function slices(transactionId: string): Promise<Array<[string, number]>> {
  const { rows } = await getPool().query<{ journal_entry_id: string; allocated_amount: string }>(
    `SELECT journal_entry_id, allocated_amount FROM public.transaction_voucher_links
      WHERE transaction_id = $1 ORDER BY allocated_amount`,
    [transactionId],
  )
  return rows.map((r) => [r.journal_entry_id, Number(r.allocated_amount)])
}

// A draft that books `amount` on 1930 (debit when positive), committed later.
async function draft(ctx: Ctx, amount: number): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, company_id, user_id, fiscal_period_id, voucher_number, entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, '2026-06-01', 'PG slice draft', 'manual', 'draft')`,
    [id, ctx.companyId, ctx.userId, ctx.fiscalPeriodId],
  )
  const value = Math.abs(amount)
  await getPool().query(
    `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, $3), ($1, '2440', $3, $2)`,
    [id, amount > 0 ? value : 0, amount > 0 ? 0 : value],
  )
  return id
}

function post(ctx: Ctx, entryId: string) {
  return getPool().query('SELECT * FROM public.commit_journal_entry($1, $2)', [ctx.companyId, entryId])
}

const SETTLEMENT_CHANGED = { code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' }
const SPLIT_UNBALANCED = { code: 'PT409', message: 'BANK_ANCHOR_SPLIT_UNBALANCED' }

describe('bank_line junction slices are checked in their own direction', () => {
  it('links a mixed-sign 1:N split: -120 crediting 1930 and +20 debiting it settle a -100 row', async () => {
    const ctx = await seed()
    await linkMixedSplit(ctx)
    expect(await slices(ctx.txId)).toEqual([
      [ctx.payment, -120],
      [ctx.creditNote, 20],
    ])
  })

  it('refuses a slice whose sign contradicts its own verifikat', async () => {
    const ctx = await seed()
    // The credit note only debits 1930: a negative slice on it has no line.
    await expect(slice(ctx, ctx.creditNote, -20)).rejects.toMatchObject(SETTLEMENT_CHANGED)
    // And the payment only credits it.
    await expect(slice(ctx, ctx.payment, 120)).rejects.toMatchObject(SETTLEMENT_CHANGED)
  })

  it('still refuses a wrong-direction 1:1 link, through the pointer and through a whole-row junction row', async () => {
    const ctx = await seed()
    await expect(
      getPool().query('UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1', [ctx.txId, ctx.creditNote]),
    ).rejects.toMatchObject(SETTLEMENT_CHANGED)
    // bulk_book_transactions writes allocated_amount = the row amount.
    await expect(slice(ctx, ctx.creditNote, -100)).rejects.toMatchObject(SETTLEMENT_CHANGED)
  })

  it('re-checks a slice whose sign is flipped by an UPDATE', async () => {
    const ctx = await seed()
    await slice(ctx, ctx.payment, -120)
    await expect(
      getPool().query(
        'UPDATE public.transaction_voucher_links SET allocated_amount = 120 WHERE transaction_id = $1 AND journal_entry_id = $2',
        [ctx.txId, ctx.payment],
      ),
    ).rejects.toMatchObject(SETTLEMENT_CHANGED)
    // A same-sign change is not an anchor change.
    await getPool().query(
      'UPDATE public.transaction_voucher_links SET allocated_amount = -110 WHERE transaction_id = $1 AND journal_entry_id = $2',
      [ctx.txId, ctx.payment],
    )
  })

  it('keeps clearing and other roles free of the bank-direction and split checks', async () => {
    const ctx = await seed()
    await slice(ctx, ctx.creditNote, -20, 'other')
    await slice(ctx, ctx.payment, 50, 'clearing')
  })

  it('posts a draft linked as one slice of a balanced mixed split, in the slice direction', async () => {
    const ctx = await seed()
    const entry = await draft(ctx, 20)
    await inOneTransaction(async (db) => {
      await slice(ctx, ctx.payment, -120, 'bank_line', ctx.txId, db)
      await slice(ctx, entry, 20, 'bank_line', ctx.txId, db)
    })
    await post(ctx, entry)
    const { rows } = await getPool().query<{ status: string }>('SELECT status FROM public.journal_entries WHERE id = $1', [entry])
    expect(rows[0].status).toBe('posted')
  })

  it('refuses to post a draft whose lines were edited away from its linked slice direction', async () => {
    const ctx = await seed()
    const entry = await draft(ctx, 20)
    await inOneTransaction(async (db) => {
      await slice(ctx, ctx.payment, -120, 'bank_line', ctx.txId, db)
      await slice(ctx, entry, 20, 'bank_line', ctx.txId, db)
    })
    await getPool().query(
      'UPDATE public.journal_entry_lines SET debit_amount = credit_amount, credit_amount = debit_amount WHERE journal_entry_id = $1',
      [entry],
    )
    await expect(post(ctx, entry)).rejects.toMatchObject(SETTLEMENT_CHANGED)
    const { rows } = await getPool().query<{ status: string }>('SELECT status FROM public.journal_entries WHERE id = $1', [entry])
    expect(rows[0].status).toBe('draft')
  })
})

describe('slices against the row direction must add up to the row (20261006121004)', () => {
  it('refuses a lone opposite-sign slice at COMMIT', async () => {
    const ctx = await seed()
    // The statement itself passes the per-slice check: the credit note does
    // debit 1930. The row it would "explain" is an outflow.
    await expect(
      inOneTransaction(async (db) => {
        await slice(ctx, ctx.creditNote, 20, 'bank_line', ctx.txId, db)
      }),
    ).rejects.toMatchObject(SPLIT_UNBALANCED)
    // Same through a single autocommitted statement (a PostgREST insert).
    await expect(slice(ctx, ctx.creditNote, 20)).rejects.toMatchObject(SPLIT_UNBALANCED)
    expect(await slices(ctx.txId)).toEqual([])
    const booked = await getPool().query<{ booked: boolean }>('SELECT public.is_transaction_booked($1) AS booked', [ctx.txId])
    expect(booked.rows[0].booked).toBe(false)
  })

  it('refuses a mixed split that does not add up to the row', async () => {
    const ctx = await seed()
    await expect(
      inOneTransaction(async (db) => {
        await slice(ctx, ctx.payment, -110, 'bank_line', ctx.txId, db)
        await slice(ctx, ctx.creditNote, 20, 'bank_line', ctx.txId, db)
      }),
    ).rejects.toMatchObject(SPLIT_UNBALANCED)
  })

  it('refuses moving a slice onto a row of the opposite direction', async () => {
    const ctx = await seed()
    // A -120 row settled 1:1 through the junction, and a +120 inflow.
    const outflow = await insertTransaction({
      companyId: ctx.companyId,
      userId: ctx.userId,
      amount: -120,
      date: '2026-06-01',
      cashAccountId: ctx.cashAccountId,
    })
    const inflow = await insertTransaction({
      companyId: ctx.companyId,
      userId: ctx.userId,
      amount: 120,
      date: '2026-06-01',
      cashAccountId: ctx.cashAccountId,
    })
    await slice(ctx, ctx.payment, -120, 'bank_line', outflow)
    await expect(
      getPool().query(
        'UPDATE public.transaction_voucher_links SET transaction_id = $2 WHERE transaction_id = $1',
        [outflow, inflow],
      ),
    ).rejects.toMatchObject(SPLIT_UNBALANCED)
    expect(await slices(outflow)).toEqual([[ctx.payment, -120]])
  })

  it('refuses removing the same-sign sibling of a mixed split, but not the whole split', async () => {
    const ctx = await seed()
    await linkMixedSplit(ctx)
    await expect(
      getPool().query(
        'DELETE FROM public.transaction_voucher_links WHERE transaction_id = $1 AND journal_entry_id = $2',
        [ctx.txId, ctx.payment],
      ),
    ).rejects.toMatchObject(SPLIT_UNBALANCED)
    expect(await slices(ctx.txId)).toHaveLength(2)
    // Koppla bort removes every slice at once.
    await getPool().query('DELETE FROM public.transaction_voucher_links WHERE transaction_id = $1', [ctx.txId])
    expect(await slices(ctx.txId)).toEqual([])
  })

  it('lets a storno unwind the split: the reversed verifikat slice first, the survivor next', async () => {
    const ctx = await seed()
    await linkMixedSplit(ctx)
    // Storno of the payment, as reverseEntry leaves it: the mirrored storno
    // posted, the original marked reversed.
    const reversal = await draft(ctx, 120)
    await getPool().query("UPDATE public.journal_entries SET source_type = 'storno', reverses_id = $2 WHERE id = $1", [
      reversal,
      ctx.payment,
    ])
    await post(ctx, reversal)
    await getPool().query("UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1", [
      ctx.payment,
      reversal,
    ])
    // reverseEntry's first write: the reversed verifikat's slice goes.
    await getPool().query('DELETE FROM public.transaction_voucher_links WHERE journal_entry_id = $1', [ctx.payment])
    expect(await slices(ctx.txId)).toEqual([[ctx.creditNote, 20]])
    // Its next write: the surviving slice of the broken split.
    await getPool().query('DELETE FROM public.transaction_voucher_links WHERE transaction_id = $1', [ctx.txId])
    expect(await slices(ctx.txId)).toEqual([])
  })

  it('still accepts same-sign slices that do not (yet) add up to the row', async () => {
    const ctx = await seed()
    const second = await insertPostedJournalEntry({
      ...ctx,
      entryDate: '2026-06-01',
      description: 'Andra betalningen',
      lines: [
        { accountNumber: '2440', debitAmount: 40, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 40 },
      ],
    })
    // A full same-sign 1:N split, then a partial one (a samlingsverifikat
    // still waiting for its last bank line is legitimate).
    await inOneTransaction(async (db) => {
      await slice(ctx, ctx.payment, -60, 'bank_line', ctx.txId, db)
      await slice(ctx, second, -40, 'bank_line', ctx.txId, db)
    })
    await getPool().query(
      'DELETE FROM public.transaction_voucher_links WHERE transaction_id = $1 AND journal_entry_id = $2',
      [ctx.txId, second],
    )
    expect(await slices(ctx.txId)).toEqual([[ctx.payment, -60]])
  })
})
