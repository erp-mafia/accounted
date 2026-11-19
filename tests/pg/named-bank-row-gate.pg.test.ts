/**
 * #203: a bank row a posted verifikat was booked from, while no pointer or
 * link anchors it, is booked. A door posts the verifikat and claims the row in
 * a second write; when the claim and its compensating storno both failed (the
 * busy bank-account lock), the verifikat stood beside a row that read open,
 * and the row was booked a second time. The gate every booking door asks
 * (lib/transactions/is-booked.ts) now reads the posted verifikat booked from
 * the row too, on real Postgres here:
 *
 *   - the row is refused, naming the verifikat, by the gate, the categorize
 *     door and a new samlingsverifikat;
 *   - a storno of the verifikat opens the row again (the storno is 'storno',
 *     the reversed original is not posted), and a cancelled draft names nothing;
 *   - a correction of the verifikat does not: the correction books the row's
 *     money on, as public.standing_correction reads it;
 *   - linking the verifikat to the row is the way on: the row is then booked
 *     once, by its pointer;
 *   - a verifikat that names the row only in its bank booking context is not
 *     read by the gate: as the caller, that probe cannot use its index (see
 *     readBookedFromRows). The database refuses a second verifikat over the
 *     row where it is posted (guard_bank_row_single_booking, #205).
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts).
 * bank_row_anchors and the work lists still read the row as open; that is
 * #148, not this gate.
 */
import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getPool } from './setup'
import { createPgRest } from './postgrest-over-pg'
import { insertPostedBankJournalEntry, insertPostedJournalEntry, insertTransaction } from './fixtures'
import { AMOUNT, DATE, bankLines, books, correctionOf, reverse, setPointer, type Books } from './bank-row-shapes'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { createLogger } from '@/lib/logger'
import { assertTransactionBookable, decideBankRowRebooking } from '@/lib/transactions/is-booked'
import { categorizeTransaction } from '@/lib/transactions/categorize-core'
import { bulkBookTransactions } from '@/lib/transactions/bulk-book'
import { linkTransactionToJournalEntry } from '@/lib/transactions/link-journal-entry'

class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

/** The service role, for the engine's storno (RLS is the authenticated client's, below). */
function serviceClient(): SupabaseClient {
  const rest = createPgRest({ role: 'service_role' })
  return createClient('http://pg-real.invalid', 'pg-real-service-role', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: rest.fetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

/** An open row and a posted verifikat booked from it whose claim never landed. */
async function unclaimed(b: Books, amount = -AMOUNT): Promise<{ tx: string; first: string }> {
  const tx = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount, cashAccountId: b.cash })
  const first = await insertPostedBankJournalEntry({
    userId: b.userId,
    companyId: b.companyId,
    fiscalPeriodId: b.period,
    entryDate: DATE,
    voucherNumber: 31,
    transactionId: tx,
    lines: bankLines(amount),
  })
  return { tx, first }
}

const stored = async (tx: string) =>
  (await getPool().query(`SELECT id, journal_entry_id, reconciliation_method, is_ignored FROM public.transactions WHERE id = $1`, [tx])).rows[0]

const gate = async (b: Books, tx: string, replace = false) => {
  const decision = await decideBankRowRebooking(b.client, b.companyId, await stored(tx), { replace })
  return decision.outcome === 'refuse' ? { via: decision.via, journalEntryId: decision.journalEntryId, voucher: decision.voucher } : decision.outcome
}

describe('a row a posted verifikat names, with no pointer and no link', () => {
  it('is refused by the gate, naming the verifikat', async () => {
    const b = await books()
    const { tx, first } = await unclaimed(b)

    expect(await gate(b, tx)).toEqual({ via: 'named', journalEntryId: first, voucher: 'A31' })
    expect(await assertTransactionBookable(b.client, b.companyId, await stored(tx))).toEqual({
      ok: false,
      code: 'TRANSACTION_ALREADY_CATEGORIZED',
      journalEntryId: first,
      via: 'named',
      voucher: 'A31',
    })
  }, 30000)

  it('is refused by the categorize door before anything is written', async () => {
    const b = await books()
    const { tx, first } = await unclaimed(b)
    const before = (await getPool().query(`SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1`, [b.companyId])).rows[0].n

    const outcome = await runWithActor({ type: 'user' }, () =>
      categorizeTransaction(b.client, b.userId, b.companyId, tx, { is_business: true, category: 'expense_bank_fees' }, { onBooked: 'update_flags' }),
    )

    expect(outcome).toMatchObject({ ok: false, code: 'TRANSACTION_ALREADY_CATEGORIZED', details: { journal_entry_id: first, via: 'named' } })
    const after = (await getPool().query(`SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1`, [b.companyId])).rows[0].n
    expect(after).toBe(before)
  }, 30000)

  it('gets no new samlingsverifikat', async () => {
    const b = await books()
    const { tx, first } = await unclaimed(b)

    const outcome = await bulkBookTransactions(
      { supabase: b.client, companyId: b.companyId, userId: b.userId, log: createLogger('test') },
      {
        tx_ids: [tx],
        entry_description: 'Bankavgift',
        manual_lines: [
          { account_number: '6110', debit_amount: AMOUNT, credit_amount: 0, currency: 'SEK' },
          { account_number: '1930', debit_amount: 0, credit_amount: AMOUNT, currency: 'SEK' },
        ],
      } as never,
      { dryRun: true },
    )

    expect(outcome).toEqual({
      ok: false,
      code: 'BULK_BOOK_TX_ALREADY_BOOKED',
      details: { tx_id: tx, via: 'named', journal_entry_id: first, voucher: 'A31' },
    })
  }, 30000)

  it('reads open to the gate when a verifikat names it only in its bank booking context, and the database refuses a second verifikat', async () => {
    const b = await books()
    const tx = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: -AMOUNT, cashAccountId: b.cash })
    const { rows: context } = await getPool().query(
      `SELECT t.id AS transaction_id, t.cash_account_id, t.date::text AS date, t.amount::float8 AS amount,
              COALESCE(t.currency, 'SEK') AS currency,
              public.bank_anchor_settlement_account(t.company_id, t.cash_account_id, t.currency) AS settlement_account
         FROM public.transactions t WHERE t.id = $1`,
      [tx],
    )
    const manual = await insertPostedJournalEntry({
      userId: b.userId,
      companyId: b.companyId,
      fiscalPeriodId: b.period,
      entryDate: DATE,
      voucherNumber: 32,
      sourceType: 'manual',
      bankBookingContext: context as never,
      lines: bankLines(-AMOUNT),
    })

    // The database knows; the gate does not ask it as the caller (the GIN
    // probe reads every verifikat under row level security).
    const naming = await getPool().query(`SELECT e FROM public.posted_entries_naming_bank_row($1, $2) e`, [b.companyId, tx])
    expect(naming.rows.map((r) => r.e)).toEqual([manual])
    expect(await gate(b, tx)).toBe('open')

    // So a door gets as far as posting, and the database refuses it there
    // (#205): nothing posted, the draft keeps no number.
    await expect(
      insertPostedBankJournalEntry({
        userId: b.userId,
        companyId: b.companyId,
        fiscalPeriodId: b.period,
        entryDate: DATE,
        voucherNumber: 33,
        transactionId: tx,
        lines: bankLines(-AMOUNT),
      }),
    ).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ROW_ALREADY_BOOKED' })
    const bookedFrom = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entries WHERE source_type = 'bank_transaction' AND source_id = $1`,
      [tx],
    )
    expect(bookedFrom.rows[0].n).toBe(0)
  }, 30000)

  it('opens again once the verifikat is reversed: the storno names nothing', async () => {
    const b = await books()
    const { tx, first } = await unclaimed(b)
    // The engine's storno resolves each line's account in the chart.
    for (const [number, name, cls, type] of [
      ['1930', 'Bank', 1, 'asset'],
      ['6110', 'Kontorsmaterial', 6, 'expense'],
    ] as const) {
      await getPool().query(
        `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
         VALUES ($1, $2, $3, $4, $5, $6, 'debit') ON CONFLICT DO NOTHING`,
        [b.userId, b.companyId, number, name, cls, type],
      )
    }

    const storno = await runWithActor({ type: 'user' }, () => reverseEntry(serviceClient(), b.companyId, b.userId, first, DATE))

    const { rows } = await getPool().query(`SELECT id, status, source_type FROM public.journal_entries WHERE id = ANY($1) ORDER BY status`, [[first, storno.id]])
    expect(rows).toEqual([
      { id: storno.id, status: 'posted', source_type: 'storno' },
      { id: first, status: 'reversed', source_type: 'bank_transaction' },
    ])
    expect(await gate(b, tx)).toBe('open')
    expect(await assertTransactionBookable(b.client, b.companyId, await stored(tx))).toEqual({ ok: true })
  }, 60000)

  it('stays refused after the verifikat is corrected: the correction books the money on', async () => {
    const b = await books()
    const { tx, first } = await unclaimed(b)
    const correction = await correctionOf(b, first, -AMOUNT)
    await reverse(first)

    expect(await gate(b, tx)).toEqual({ via: 'named', journalEntryId: correction, voucher: null })
    expect(await assertTransactionBookable(b.client, b.companyId, await stored(tx))).toMatchObject({ ok: false, via: 'named', journalEntryId: correction })
  }, 30000)

  it('is open beside a draft booked from it that was cancelled before its number: a draft names nothing', async () => {
    const b = await books()
    const tx = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: -AMOUNT, cashAccountId: b.cash })
    await getPool().query(
      `INSERT INTO public.journal_entries
         (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, source_id, status)
       VALUES ($1, $2, $3, 0, 'A', $4, 'Avbrutet utkast', 'bank_transaction', $5, 'draft')`,
      [b.userId, b.companyId, b.period, DATE, tx],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE source_id = $1`, [tx])

    expect(await gate(b, tx)).toBe('open')
  }, 30000)

  it('is booked once when the verifikat is linked to it: the way on the refusal names', async () => {
    const b = await books()
    const { tx, first } = await unclaimed(b)

    const linked = await runWithActor({ type: 'user' }, () =>
      linkTransactionToJournalEntry(b.client, b.userId, b.companyId, { transactionId: tx, journalEntryId: first }),
    )

    expect(linked.ok, JSON.stringify(linked)).toBe(true)
    expect((await stored(tx)).journal_entry_id).toBe(first)
    expect(await gate(b, tx)).toEqual({ via: 'pointer', journalEntryId: first, voucher: 'A31' })
  }, 60000)
})

describe('the #203 pairs as they stand: the second booking holds the pointer, the first still names the row', () => {
  it('never replaces the second while the first books the row too', async () => {
    const b = await books()
    const { tx, first } = await unclaimed(b)
    // Posted before guard_bank_row_single_booking (#205), which refuses it now.
    await getPool().query('ALTER TABLE public.journal_entries DISABLE TRIGGER guard_bank_row_single_booking')
    let second: string
    try {
      second = await insertPostedBankJournalEntry({
        userId: b.userId,
        companyId: b.companyId,
        fiscalPeriodId: b.period,
        entryDate: DATE,
        voucherNumber: 33,
        transactionId: tx,
        lines: bankLines(-AMOUNT),
      })
    } finally {
      await getPool().query('ALTER TABLE public.journal_entries ENABLE TRIGGER guard_bank_row_single_booking')
    }
    await setPointer(tx, second)

    expect(await gate(b, tx)).toEqual({ via: 'pointer', journalEntryId: second, voucher: 'A33' })
    expect(await gate(b, tx, true)).toEqual({ via: 'named', journalEntryId: first, voucher: 'A31' })
  }, 30000)
})
