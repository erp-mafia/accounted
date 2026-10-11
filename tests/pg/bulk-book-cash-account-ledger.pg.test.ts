import { describe, expect, it } from 'vitest'
import {
  insertCashAccount,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261010200000_bulk_book_transactions_cash_account_ledger (crm#1136).
 *
 * bulk_book_transactions compared the selected rows' sum with the verifikat's
 * net over accounts 1900-1999, so a cash account kept outside 19xx (the
 * Stripe balance on 1686) always answered BULK_BOOK_AMOUNT_MISMATCH. The bank
 * net is now measured on the ledgers the rows settle on, as
 * capture_bank_booking_context resolves them:
 *
 *   - a ledger outside 19xx is measured on that ledger alone;
 *   - a 19xx ledger keeps the rule it had (the whole 1900-1999 range must
 *     move by the rows' sum; BANK_BOOKING_SETTLEMENT_CHANGED still refuses a
 *     line on another 19xx account than the row's own);
 *   - a row with no cash account settles where it always did: the company's
 *     only enabled account in its currency, else 1930.
 */

const DATE = '2026-06-05'

interface RpcResult {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  mode?: 'link_existing' | 'create_new'
  journal_entry_id?: string
  linked_tx_count?: number
  tx_sum?: number
}

interface Line {
  account_number: string
  debit_amount: number
  credit_amount: number
}

const line = (account_number: string, debit_amount: number, credit_amount: number): Line & { currency: string } => ({
  account_number,
  debit_amount,
  credit_amount,
  currency: 'SEK',
})

/** A company with the accounts these tests book on, and no cash accounts yet. */
async function seedTenant() {
  const tenant = await seedCompany()
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     SELECT $1, $2, n, name, cls, atype, nbal, true
     FROM (VALUES
       ('1686', 'Fordringar för kontokort och kuponger', 1, 'asset',     'debit'),
       ('1930', 'Företagskonto',                         1, 'asset',     'debit'),
       ('1940', 'Övriga bankkonton',                     1, 'asset',     'debit'),
       ('2611', 'Utgående moms 25%',                     2, 'liability', 'credit'),
       ('3001', 'Försäljning 25% moms',                  3, 'revenue',   'credit'),
       ('6570', 'Bankkostnader',                         6, 'expense',   'debit')
     ) AS t(n, name, cls, atype, nbal)`,
    [tenant.userId, tenant.companyId],
  )
  return tenant
}

/** The Stripe balance as the Stripe sync sets it up: a manual SEK cash account on 1686. */
const stripeBalance = (companyId: string) =>
  insertCashAccount({ companyId, ledgerAccount: '1686', source: 'manual' })
const bankAccount = (companyId: string, ledgerAccount = '1930') =>
  insertCashAccount({ companyId, ledgerAccount, source: 'manual' })

function row(tenant: { userId: string; companyId: string }, amount: number, cashAccountId: string | null) {
  return insertTransaction({ ...tenant, amount, date: DATE, cashAccountId })
}

async function bookNew(userId: string, companyId: string, txIds: string[], lines: Line[]) {
  return withUserContext(userId, async (client) => {
    const r = await client.query<{ result: RpcResult }>(
      `SELECT bulk_book_transactions($1::uuid[], NULL, $2::jsonb, $3) AS result`,
      [txIds, JSON.stringify({ description: 'Samlingsverifikation', lines }), companyId],
    )
    const result = r.rows[0]!.result
    if (!result.ok) return { result, lines: [] as Line[], context: [] as Array<Record<string, unknown>>, links: 0 }
    const posted = await client.query<Line>(
      `SELECT account_number, debit_amount::float8 AS debit_amount, credit_amount::float8 AS credit_amount
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [result.journal_entry_id],
    )
    const entry = await client.query<{ status: string; bank_booking_context: Array<Record<string, unknown>> }>(
      `SELECT status, bank_booking_context FROM public.journal_entries WHERE id = $1`,
      [result.journal_entry_id],
    )
    expect(entry.rows[0]!.status).toBe('posted')
    const links = await client.query(
      `SELECT 1 FROM public.transaction_voucher_links WHERE journal_entry_id = $1 AND role = 'bank_line'`,
      [result.journal_entry_id],
    )
    return { result, lines: posted.rows, context: entry.rows[0]!.bank_booking_context, links: links.rowCount ?? 0 }
  })
}

describe('bulk_book_transactions: a cash account outside 19xx', () => {
  it('books the rows of a 1686 cash account into one samlingsverifikat', async () => {
    const tenant = await seedTenant()
    const stripe = await stripeBalance(tenant.companyId)
    await bankAccount(tenant.companyId)
    const charges = [await row(tenant, 100, stripe), await row(tenant, 25, stripe)]

    const booked = await bookNew(tenant.userId, tenant.companyId, charges, [
      line('1686', 125, 0),
      line('3001', 0, 100),
      line('2611', 0, 25),
    ])

    expect(booked.result).toMatchObject({ ok: true, mode: 'create_new', linked_tx_count: 2, tx_sum: 125 })
    expect(booked.lines).toEqual([
      { account_number: '1686', debit_amount: 125, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 100 },
      { account_number: '2611', debit_amount: 0, credit_amount: 25 },
    ])
    expect(booked.context.map((c) => c.settlement_account)).toEqual(['1686', '1686'])
    expect(booked.links).toBe(2)
  })

  it('books a fee row on 1686 (money out credits the ledger)', async () => {
    const tenant = await seedTenant()
    const stripe = await stripeBalance(tenant.companyId)
    const fee = await row(tenant, -3.75, stripe)

    const booked = await bookNew(tenant.userId, tenant.companyId, [fee], [line('6570', 3.75, 0), line('1686', 0, 3.75)])

    expect(booked.result).toMatchObject({ ok: true, tx_sum: -3.75 })
  })

  it('links a payout row on 1686, and the bank row it arrives as, to the one verifikat that moved the money', async () => {
    const tenant = await seedTenant()
    const stripe = await stripeBalance(tenant.companyId)
    const bank = await bankAccount(tenant.companyId)
    const payoutOut = await row(tenant, -1000, stripe)
    const payoutIn = await row(tenant, 1000, bank)
    // Debit 1930 / credit 1686: for the 1686 row the 1930 debit is the other
    // end of the transfer, not its bank side.
    const voucher = await insertPostedJournalEntry({
      ...tenant,
      entryDate: DATE,
      voucherNumber: 1,
      description: 'Utbetalning från betalleverantör',
      lines: [
        { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '1686', debitAmount: 0, creditAmount: 1000 },
      ],
    })

    await withUserContext(tenant.userId, async (client) => {
      const link = async (txId: string) =>
        (await client.query<{ result: RpcResult }>(
          `SELECT bulk_book_transactions($1::uuid[], $2, NULL, $3) AS result`,
          [[txId], voucher, tenant.companyId],
        )).rows[0]!.result

      expect(await link(payoutOut)).toMatchObject({ ok: true, mode: 'link_existing', journal_entry_id: voucher, tx_sum: -1000 })
      expect(await link(payoutIn)).toMatchObject({ ok: true, mode: 'link_existing', journal_entry_id: voucher, tx_sum: 1000 })

      const linked = await client.query<{ journal_entry_id: string }>(
        `SELECT journal_entry_id FROM public.transactions WHERE id = ANY($1::uuid[])`,
        [[payoutOut, payoutIn]],
      )
      expect(linked.rows.map((r) => r.journal_entry_id)).toEqual([voucher, voucher])
    })
  })

  it('measures a 1686 row on 1686 alone: a bank line on 1930 instead is a mismatch', async () => {
    const tenant = await seedTenant()
    const stripe = await stripeBalance(tenant.companyId)
    await bankAccount(tenant.companyId)
    const charge = await row(tenant, 125, stripe)

    const booked = await bookNew(tenant.userId, tenant.companyId, [charge], [line('1930', 125, 0), line('3001', 0, 125)])

    expect(booked.result).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_AMOUNT_MISMATCH',
      details: { tx_sum: 125, lines_bank_net: 0 },
    })
  })
})

describe('bulk_book_transactions: a genuine mismatch still answers BULK_BOOK_AMOUNT_MISMATCH', () => {
  it('for the lines of a new verifikat on 1686', async () => {
    const tenant = await seedTenant()
    const stripe = await stripeBalance(tenant.companyId)
    const charges = [await row(tenant, 100, stripe), await row(tenant, 25, stripe)]

    const booked = await bookNew(tenant.userId, tenant.companyId, charges, [line('1686', 500, 0), line('3001', 0, 500)])

    expect(booked.result).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_AMOUNT_MISMATCH',
      details: { tx_sum: 125, lines_bank_net: 500 },
    })
  })

  it('for an existing verifikat whose 1686 net is not the row sum', async () => {
    const tenant = await seedTenant()
    const stripe = await stripeBalance(tenant.companyId)
    const payout = await row(tenant, -1000, stripe)
    const voucher = await insertPostedJournalEntry({
      ...tenant,
      entryDate: DATE,
      voucherNumber: 1,
      lines: [
        { accountNumber: '1930', debitAmount: 400, creditAmount: 0 },
        { accountNumber: '1686', debitAmount: 0, creditAmount: 400 },
      ],
    })

    await withUserContext(tenant.userId, async (client) => {
      const r = await client.query<{ result: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], $2, NULL, $3) AS result`,
        [[payout], voucher, tenant.companyId],
      )
      expect(r.rows[0]!.result).toMatchObject({
        ok: false,
        code: 'BULK_BOOK_AMOUNT_MISMATCH',
        details: { tx_sum: -1000, voucher_bank_net: -400 },
      })
      const links = await client.query(
        `SELECT 1 FROM public.transaction_voucher_links WHERE transaction_id = $1`,
        [payout],
      )
      expect(links.rowCount).toBe(0)
    })
  })

  it('for the lines of a new verifikat on 1930', async () => {
    const tenant = await seedTenant()
    const bank = await bankAccount(tenant.companyId)
    const deposits = [await row(tenant, 100, bank), await row(tenant, 200, bank)]

    const booked = await bookNew(tenant.userId, tenant.companyId, deposits, [line('1930', 500, 0), line('3001', 0, 500)])

    expect(booked.result).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_AMOUNT_MISMATCH',
      details: { tx_sum: 300, lines_bank_net: 500 },
    })
  })
})

describe('bulk_book_transactions: rows on 19xx ledgers keep the rule they had', () => {
  it('books the rows of a 1930 cash account', async () => {
    const tenant = await seedTenant()
    const bank = await bankAccount(tenant.companyId)
    await stripeBalance(tenant.companyId)
    const deposits = [await row(tenant, 100, bank), await row(tenant, 25, bank)]

    const booked = await bookNew(tenant.userId, tenant.companyId, deposits, [
      line('1930', 125, 0),
      line('3001', 0, 100),
      line('2611', 0, 25),
    ])

    expect(booked.result).toMatchObject({ ok: true, mode: 'create_new', linked_tx_count: 2, tx_sum: 125 })
    expect(booked.context.map((c) => c.settlement_account)).toEqual(['1930', '1930'])
  })

  it('still counts the whole 1900-1999 range, and refuses a line on another 19xx account per ledger', async () => {
    const tenant = await seedTenant()
    const bank = await bankAccount(tenant.companyId)
    const deposit = await row(tenant, 125, bank)

    // The 19xx sum is right (the first comparison passes, as before), the
    // ledger is not the row's own: BANK_BOOKING_SETTLEMENT_CHANGED, as before.
    await expect(
      bookNew(tenant.userId, tenant.companyId, [deposit], [line('1940', 125, 0), line('3001', 0, 125)]),
    ).rejects.toMatchObject({ code: 'PT409', message: 'BANK_BOOKING_SETTLEMENT_CHANGED' })
  })

  it('still answers a mismatch for a transfer whose other end is a 19xx account (unchanged)', async () => {
    const tenant = await seedTenant()
    const bank = await bankAccount(tenant.companyId)
    const transferOut = await row(tenant, -100, bank)

    const booked = await bookNew(tenant.userId, tenant.companyId, [transferOut], [line('1940', 100, 0), line('1930', 0, 100)])

    expect(booked.result).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_AMOUNT_MISMATCH',
      details: { tx_sum: -100, lines_bank_net: 0 },
    })
  })
})

describe('bulk_book_transactions: a batch across a 19xx ledger and another', () => {
  async function seedBatch() {
    const tenant = await seedTenant()
    const bank = await bankAccount(tenant.companyId)
    const stripe = await stripeBalance(tenant.companyId)
    return { tenant, rows: [await row(tenant, 100, bank), await row(tenant, 25, stripe)] }
  }

  it('books when each ledger moves by its own rows', async () => {
    const { tenant, rows } = await seedBatch()

    const booked = await bookNew(tenant.userId, tenant.companyId, rows, [
      line('1930', 100, 0),
      line('1686', 25, 0),
      line('3001', 0, 125),
    ])

    expect(booked.result).toMatchObject({ ok: true, linked_tx_count: 2, tx_sum: 125 })
    expect(booked.context.map((c) => c.settlement_account).sort()).toEqual(['1686', '1930'])
  })

  it('refuses the right total on the wrong ledgers', async () => {
    const { tenant, rows } = await seedBatch()

    await expect(
      bookNew(tenant.userId, tenant.companyId, rows, [line('1930', 25, 0), line('1686', 100, 0), line('3001', 0, 125)]),
    ).rejects.toMatchObject({ code: 'PT409', message: 'BANK_BOOKING_SETTLEMENT_CHANGED' })
  })
})

describe('bulk_book_transactions: a row with no cash account', () => {
  it('settles on 1930 when the company has several accounts in its currency, as before', async () => {
    const tenant = await seedTenant()
    await bankAccount(tenant.companyId)
    await stripeBalance(tenant.companyId)
    const unbound = await row(tenant, 125, null)

    const booked = await bookNew(tenant.userId, tenant.companyId, [unbound], [line('1930', 125, 0), line('3001', 0, 125)])

    expect(booked.result).toMatchObject({ ok: true, tx_sum: 125 })
    expect(booked.context).toMatchObject([{ cash_account_id: null, settlement_account: '1930' }])
  })

  it('settles on 1930 when the company has no cash accounts at all, as before', async () => {
    const tenant = await seedTenant()
    const unbound = await row(tenant, -80, null)

    const booked = await bookNew(tenant.userId, tenant.companyId, [unbound], [line('6570', 80, 0), line('1930', 0, 80)])

    expect(booked.result).toMatchObject({ ok: true, tx_sum: -80 })
    expect(booked.context).toMatchObject([{ cash_account_id: null, settlement_account: '1930' }])
  })

  it('settles on the only enabled account, also when that account is 1686', async () => {
    const tenant = await seedTenant()
    await stripeBalance(tenant.companyId)
    const unbound = await row(tenant, 125, null)

    const booked = await bookNew(tenant.userId, tenant.companyId, [unbound], [
      line('1686', 125, 0),
      line('3001', 0, 100),
      line('2611', 0, 25),
    ])

    expect(booked.result).toMatchObject({ ok: true, tx_sum: 125 })
    expect(booked.context).toMatchObject([{ cash_account_id: null, settlement_account: '1686' }])
  })
})
