import { describe, expect, it } from 'vitest'
import {
  insertCashAccount,
  insertPostedBankJournalEntry,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261021001900_bulk_book_link_bank_leg_room.
 *
 * Linking bank rows to a posted verifikat (existing_journal_entry_id):
 *   - the rows must fit in what other bank rows leave of the verifikat's bank
 *     leg, per ledger and in their direction (GitHub #3507, the rule of the
 *     single-link doors in src/lib/transactions/voucher-bank-leg.ts), else
 *     VOUCHER_BANK_LEG_CONSUMED and nothing is written;
 *   - every linked row records reconciliation_method 'manual' (PH 194), so
 *     koppla-bort can undo the link, except a row put back on the verifikat
 *     booked from it.
 */

interface RpcResult {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  mode?: 'link_existing' | 'create_new'
  journal_entry_id?: string
  linked_tx_count?: number
  tx_sum?: number
}

async function seedTenant() {
  const tenant = await seedCompany()
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     SELECT $1, $2, n, name, cls, atype, nbal, true
     FROM (VALUES
       ('1930', 'Företagskonto',                1, 'asset',   'debit'),
       ('3001', 'Försäljning inom Sverige 25%', 3, 'revenue', 'credit'),
       ('5010', 'Lokalhyra',                    5, 'expense', 'debit'),
       ('6570', 'Bankkostnader',                6, 'expense', 'debit')
     ) AS t(n, name, cls, atype, nbal)
     ON CONFLICT DO NOTHING`,
    [tenant.userId, tenant.companyId],
  )
  const bank = await insertCashAccount({ companyId: tenant.companyId, ledgerAccount: '1930', source: 'manual' })
  return { ...tenant, bank }
}

type Tenant = Awaited<ReturnType<typeof seedTenant>>

function row(tenant: Tenant, amount: number, date = '2026-06-05', journalEntryId: string | null = null) {
  return insertTransaction({ ...tenant, amount, date, cashAccountId: tenant.bank, journalEntryId })
}

/** Rent paid out of 1930: debit 5010, credit 1930. */
function rentVoucher(tenant: Tenant, amount: number) {
  return insertPostedJournalEntry({
    ...tenant,
    entryDate: '2026-06-05',
    voucherNumber: 1,
    description: 'Hyra juni',
    lines: [
      { accountNumber: '5010', debitAmount: amount, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: amount },
    ],
  })
}

/**
 * A day booked as one verifikat that moves 1930 both ways: sales in
 * (debit 1930) and a fee out (credit 1930). Its bank net is in - out.
 */
function dayVoucher(tenant: Tenant, moneyIn: number, moneyOut: number) {
  return insertPostedJournalEntry({
    ...tenant,
    entryDate: '2026-06-05',
    voucherNumber: 2,
    description: 'Dagskassa',
    lines: [
      { accountNumber: '1930', debitAmount: moneyIn, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: moneyIn },
      ...(moneyOut > 0
        ? [
            { accountNumber: '6570', debitAmount: moneyOut, creditAmount: 0 },
            { accountNumber: '1930', debitAmount: 0, creditAmount: moneyOut },
          ]
        : []),
    ],
  })
}

/** A bank_line slice of another row on the verifikat (a 1:N split). */
async function slice(tenant: Tenant, transactionId: string, journalEntryId: string, amount: number) {
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links
       (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, 'bank_line')`,
    [tenant.userId, tenant.companyId, transactionId, journalEntryId, amount],
  )
}

/** The RPC as the member, rolled back afterwards: enough for a refusal. */
async function tryLink(tenant: Tenant, txIds: string[], journalEntryId: string): Promise<RpcResult> {
  return withUserContext(tenant.userId, async (client) => {
    const r = await client.query<{ result: RpcResult }>(
      `SELECT bulk_book_transactions($1::uuid[], $2, NULL, $3) AS result`,
      [txIds, journalEntryId, tenant.companyId],
    )
    return r.rows[0]!.result
  })
}

/** The RPC as the member, committed, so the written rows can be read back. */
async function link(tenant: Tenant, txIds: string[], journalEntryId: string): Promise<RpcResult> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: tenant.userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [tenant.userId])
    await client.query('SET LOCAL ROLE authenticated')
    const r = await client.query<{ result: RpcResult }>(
      `SELECT bulk_book_transactions($1::uuid[], $2, NULL, $3) AS result`,
      [txIds, journalEntryId, tenant.companyId],
    )
    await client.query('COMMIT')
    return r.rows[0]!.result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function bankLineLinks(journalEntryId: string) {
  const r = await getPool().query<{ transaction_id: string; allocated_amount: string }>(
    `SELECT transaction_id, allocated_amount FROM public.transaction_voucher_links
      WHERE journal_entry_id = $1 AND role = 'bank_line'`,
    [journalEntryId],
  )
  return r.rows
}

async function rowState(ids: string[]) {
  const r = await getPool().query<{
    id: string
    journal_entry_id: string | null
    reconciliation_method: string | null
    is_business: boolean | null
  }>(
    `SELECT id, journal_entry_id, reconciliation_method, is_business
       FROM public.transactions WHERE id = ANY($1::uuid[])`,
    [ids],
  )
  return new Map(r.rows.map((x) => [x.id, x]))
}

describe('bulk_book_transactions link: room on the verifikat bank leg (GitHub #3507)', () => {
  it('links rows that together fit a free leg, as before', async () => {
    const tenant = await seedTenant()
    const voucher = await dayVoucher(tenant, 500, 0)
    const swish = [await row(tenant, 100), await row(tenant, 250), await row(tenant, 150)]

    const result = await link(tenant, swish, voucher)

    expect(result).toMatchObject({ ok: true, mode: 'link_existing', linked_tx_count: 3, tx_sum: 500 })
    expect((await bankLineLinks(voucher)).map((l) => l.transaction_id).sort()).toEqual([...swish].sort())
  })

  it('refuses rows summing to a leg another row already settled, and writes nothing', async () => {
    const tenant = await seedTenant()
    const voucher = await rentVoucher(tenant, 2800)
    // The month's rent, linked to its verifikat.
    await row(tenant, -2800, '2026-06-05', voucher)
    // Next month's rent, split in two transfers: its own affärshändelse.
    const next = [await row(tenant, -1400, '2026-07-03'), await row(tenant, -1400, '2026-07-03')]

    const result = await tryLink(tenant, next, voucher)

    expect(result).toMatchObject({
      ok: false,
      code: 'VOUCHER_BANK_LEG_CONSUMED',
      details: {
        journal_entry_id: voucher,
        voucher_series: 'A',
        voucher_number: 1,
        account: '1930',
        tx_sum: -2800,
        booked: -2800,
        held: -2800,
        remaining: 0,
      },
    })
    // Committed, the refusal still leaves every row as it was.
    await link(tenant, next, voucher)
    expect(await bankLineLinks(voucher)).toEqual([])
    for (const state of (await rowState(next)).values()) {
      expect(state).toMatchObject({ journal_entry_id: null, reconciliation_method: null, is_business: null })
    }
  })

  it('refuses one row of the same amount on a leg another row already settled (the second monthly payment)', async () => {
    const tenant = await seedTenant()
    const voucher = await rentVoucher(tenant, 2800)
    await row(tenant, -2800, '2026-06-05', voucher)
    const nextMonth = await row(tenant, -2800, '2026-07-03')

    const result = await tryLink(tenant, [nextMonth], voucher)

    expect(result).toMatchObject({ ok: false, code: 'VOUCHER_BANK_LEG_CONSUMED', details: { held: -2800, remaining: 0 } })
  })

  it('counts a bank_line slice of another row as held, and a row anchored both ways once', async () => {
    const tenant = await seedTenant()
    // In 1000, out 400: the bank net a link must match is 600.
    const voucher = await dayVoucher(tenant, 1000, 400)
    // Another row holds 400 of the money in through a 1:N slice.
    const split = await row(tenant, 700)
    await slice(tenant, split, voucher, 400)
    // And a row holds 300 more by its pointer, anchored by a slice too.
    const both = await row(tenant, 300, '2026-06-05', voucher)
    await slice(tenant, both, voucher, 300)
    const batch = [await row(tenant, 350), await row(tenant, 250)]

    const result = await tryLink(tenant, batch, voucher)

    // 1000 booked in, 700 held (not 1000: the pointer row counts once), 300 left for 600.
    expect(result).toMatchObject({
      ok: false,
      code: 'VOUCHER_BANK_LEG_CONSUMED',
      details: { tx_sum: 600, booked: 1000, held: 700, remaining: 300 },
    })
  })

  it('links rows that fit what a partly held leg has left', async () => {
    const tenant = await seedTenant()
    const voucher = await dayVoucher(tenant, 1000, 400)
    // One row already holds 400 of the money in.
    await row(tenant, 400, '2026-06-05', voucher)
    const batch = [await row(tenant, 350), await row(tenant, 250)]

    const result = await link(tenant, batch, voucher)

    expect(result).toMatchObject({ ok: true, linked_tx_count: 2, tx_sum: 600 })
    expect((await bankLineLinks(voucher)).map((l) => l.transaction_id).sort()).toEqual([...batch].sort())
  })

  it('counts the room per direction: rows out do not take room from rows in', async () => {
    const tenant = await seedTenant()
    const voucher = await dayVoucher(tenant, 1000, 400)
    // The fee row already holds the money out.
    await row(tenant, -400, '2026-06-05', voucher)
    const sales = [await row(tenant, 600)]

    const result = await link(tenant, sales, voucher)

    expect(result).toMatchObject({ ok: true, linked_tx_count: 1, tx_sum: 600 })
  })

  it('lets a lone earlier row off by an öresavrundning leave the batch its room, within one öre', async () => {
    const tenant = await seedTenant()
    const voucher = await dayVoucher(tenant, 1000, 400)
    // A lone row linked first, one öre above the 400 it settles.
    await row(tenant, 400.01, '2026-06-05', voucher)
    const batch = [await row(tenant, 600)]

    const result = await link(tenant, batch, voucher)

    // 1000 - 400.01 = 599.99 left: 600 fits within the one-öre tolerance.
    expect(result).toMatchObject({ ok: true, linked_tx_count: 1, tx_sum: 600 })
  })
})

describe('bulk_book_transactions link: every linked row records its method (PH 194)', () => {
  it('records reconciliation_method manual on each row of a multi-row link, which carries no pointer', async () => {
    const tenant = await seedTenant()
    const voucher = await dayVoucher(tenant, 500, 0)
    const swish = [await row(tenant, 100), await row(tenant, 400)]

    expect(await link(tenant, swish, voucher)).toMatchObject({ ok: true, linked_tx_count: 2 })

    for (const state of (await rowState(swish)).values()) {
      expect(state).toMatchObject({ journal_entry_id: null, reconciliation_method: 'manual', is_business: true })
    }
  })

  it('records manual on a one-row link, as before', async () => {
    const tenant = await seedTenant()
    const voucher = await rentVoucher(tenant, 2800)
    const rent = await row(tenant, -2800)

    expect(await link(tenant, [rent], voucher)).toMatchObject({ ok: true, linked_tx_count: 1 })

    expect((await rowState([rent])).get(rent)).toMatchObject({
      journal_entry_id: voucher,
      reconciliation_method: 'manual',
      is_business: true,
    })
  })

  it('records no method for a row put back on the verifikat booked from it', async () => {
    const tenant = await seedTenant()
    const rent = await row(tenant, -2800)
    const voucher = await insertPostedBankJournalEntry({
      ...tenant,
      transactionId: rent,
      entryDate: '2026-06-05',
      voucherNumber: 3,
      description: 'Hyra juni',
      lines: [
        { accountNumber: '5010', debitAmount: 2800, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 2800 },
      ],
    })

    expect(await link(tenant, [rent], voucher)).toMatchObject({ ok: true, linked_tx_count: 1 })

    expect((await rowState([rent])).get(rent)).toMatchObject({
      journal_entry_id: voucher,
      reconciliation_method: null,
      is_business: true,
    })
  })
})
