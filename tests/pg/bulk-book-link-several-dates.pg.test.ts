import { describe, expect, it } from 'vitest'
import {
  insertCashAccount,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261015081500_bulk_book_link_rows_of_several_dates (crm#1171).
 *
 * Linking bank rows to a posted verifikat (existing_journal_entry_id) no
 * longer requires one date: one document, such as Stripe's monthly fee
 * invoice, is settled by fee rows of many days on the Stripe balance (1686).
 * Building a NEW samlingsverifikat from rows keeps the one-day rule, and a
 * link keeps the one-direction rule, the sum check and the not-yet-booked
 * check.
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
       ('1686', 'Fordringar för kontokort och kuponger', 1, 'asset',   'debit'),
       ('6570', 'Bankkostnader',                         6, 'expense', 'debit')
     ) AS t(n, name, cls, atype, nbal)`,
    [tenant.userId, tenant.companyId],
  )
  const stripe = await insertCashAccount({ companyId: tenant.companyId, ledgerAccount: '1686', source: 'manual' })
  return { ...tenant, stripe }
}

type Tenant = Awaited<ReturnType<typeof seedTenant>>

function feeRow(tenant: Tenant, amount: number, date: string) {
  return insertTransaction({ ...tenant, amount, date, cashAccountId: tenant.stripe })
}

/** Stripe's monthly fee invoice booked as its own verifikat: debit 6570, credit 1686. */
function feeInvoiceVoucher(tenant: Tenant, total: number) {
  return insertPostedJournalEntry({
    ...tenant,
    entryDate: '2026-09-30',
    voucherNumber: 1,
    description: 'Stripe avgifter september',
    lines: [
      { accountNumber: '6570', debitAmount: total, creditAmount: 0 },
      { accountNumber: '1686', debitAmount: 0, creditAmount: total },
    ],
  })
}

async function link(tenant: Tenant, txIds: string[], journalEntryId: string): Promise<RpcResult> {
  return withUserContext(tenant.userId, async (client) => {
    const r = await client.query<{ result: RpcResult }>(
      `SELECT bulk_book_transactions($1::uuid[], $2, NULL, $3) AS result`,
      [txIds, journalEntryId, tenant.companyId],
    )
    return r.rows[0]!.result
  })
}

async function linkAndCommit(tenant: Tenant, txIds: string[], journalEntryId: string): Promise<RpcResult> {
  // withUserContext always rolls back, so the commit case runs on its own
  // connection with the same JWT context and commits.
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

describe('bulk_book_transactions: linking rows of several dates to one posted verifikat', () => {
  it('links a month of Stripe fee rows, and the next month\'s late post-payment fee, to the fee invoice verifikat', async () => {
    const tenant = await seedTenant()
    const fees = [
      await feeRow(tenant, -3.25, '2026-09-03'),
      await feeRow(tenant, -4.5, '2026-09-17'),
      await feeRow(tenant, -3.25, '2026-09-17'),
      // A September usage fee Stripe draws on 2 October.
      await feeRow(tenant, -12, '2026-10-02'),
    ]
    const voucher = await feeInvoiceVoucher(tenant, 23)

    const result = await linkAndCommit(tenant, fees, voucher)

    expect(result).toMatchObject({
      ok: true,
      mode: 'link_existing',
      journal_entry_id: voucher,
      linked_tx_count: 4,
      tx_sum: -23,
    })
    const links = await bankLineLinks(voucher)
    expect(links.map((l) => l.transaction_id).sort()).toEqual([...fees].sort())
    expect(links.map((l) => Number(l.allocated_amount)).sort((a, b) => a - b)).toEqual([-12, -4.5, -3.25, -3.25])
    // Several rows on one verifikat: the junction carries the link, not the pointer.
    const rows = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.transactions WHERE id = ANY($1::uuid[])`,
      [fees],
    )
    expect(rows.rows.every((r) => r.journal_entry_id === null)).toBe(true)

    // Linked rows are booked: a second link of any of them is refused.
    const again = await link(tenant, [fees[0]!], voucher)
    expect(again).toMatchObject({ ok: false, code: 'BULK_BOOK_TX_ALREADY_BOOKED' })
  })

  it('still refuses rows of several dates whose sum is not the verifikat\'s 1686 net, and links none', async () => {
    const tenant = await seedTenant()
    const fees = [await feeRow(tenant, -3.25, '2026-09-03'), await feeRow(tenant, -4.5, '2026-09-17')]
    const voucher = await feeInvoiceVoucher(tenant, 23)

    const result = await link(tenant, fees, voucher)

    expect(result).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_AMOUNT_MISMATCH',
      details: { tx_sum: -7.75, voucher_bank_net: -23 },
    })
    expect(await bankLineLinks(voucher)).toEqual([])
  })

  it('still refuses a link that mixes money in and money out', async () => {
    const tenant = await seedTenant()
    const rows = [await feeRow(tenant, -30, '2026-09-03'), await feeRow(tenant, 7, '2026-09-17')]
    const voucher = await feeInvoiceVoucher(tenant, 23)

    const result = await link(tenant, rows, voucher)

    expect(result).toMatchObject({ ok: false, code: 'BULK_BOOK_DIRECTION_MISMATCH' })
    expect(await bankLineLinks(voucher)).toEqual([])
  })

  it('still refuses a row that is already booked', async () => {
    const tenant = await seedTenant()
    const other = await insertPostedJournalEntry({
      ...tenant,
      entryDate: '2026-09-03',
      voucherNumber: 2,
      lines: [
        { accountNumber: '6570', debitAmount: 3.25, creditAmount: 0 },
        { accountNumber: '1686', debitAmount: 0, creditAmount: 3.25 },
      ],
    })
    const booked = await insertTransaction({
      ...tenant,
      amount: -3.25,
      date: '2026-09-03',
      cashAccountId: tenant.stripe,
      journalEntryId: other,
    })
    const free = await feeRow(tenant, -19.75, '2026-09-17')
    const voucher = await feeInvoiceVoucher(tenant, 23)

    const result = await link(tenant, [booked, free], voucher)

    expect(result).toMatchObject({ ok: false, code: 'BULK_BOOK_TX_ALREADY_BOOKED', details: { tx_id: booked } })
  })
})

describe('bulk_book_transactions: a new samlingsverifikat keeps the one-day rule', () => {
  it('refuses rows of two dates with BULK_BOOK_DATE_MISMATCH', async () => {
    const tenant = await seedTenant()
    const fees = [await feeRow(tenant, -3.25, '2026-09-03'), await feeRow(tenant, -4.5, '2026-09-17')]

    const result = await withUserContext(tenant.userId, async (client) => {
      const r = await client.query<{ result: RpcResult }>(
        `SELECT bulk_book_transactions($1::uuid[], NULL, $2::jsonb, $3) AS result`,
        [
          fees,
          JSON.stringify({
            description: 'Stripe-avgifter',
            lines: [
              { account_number: '6570', debit_amount: 7.75, credit_amount: 0, currency: 'SEK' },
              { account_number: '1686', debit_amount: 0, credit_amount: 7.75, currency: 'SEK' },
            ],
          }),
          tenant.companyId,
        ],
      )
      return r.rows[0]!.result
    })

    expect(result).toMatchObject({ ok: false, code: 'BULK_BOOK_DATE_MISMATCH' })
  })
})
