import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertCashAccount,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260815090000_link_transaction_to_vouchers.
 *
 * link_transaction_to_vouchers couples ONE bank transaction to N already-posted
 * verifikat by writing transaction_voucher_links rows. It creates no
 * bookkeeping, so the invariants worth pinning are the guards: the allocation
 * must account for the whole bank row öre-tight, every target must be a posted
 * entry in the same company carrying a line on the transaction's settlement
 * account, and an already-anchored row must be refused via all four anchors.
 *
 * The RPC is SECURITY DEFINER and reads auth.uid(), so every call runs inside
 * withUserContext. That also rolls each case back, keeping the cases isolated.
 */

/** Shorthand: a posted entry whose bank leg sits on `account` for `amount`. */
async function postedVoucher(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  amount: number
  account?: string
  voucherNumber?: number
  contraAccount?: string
}): Promise<string> {
  const account = params.account ?? '1930'
  const abs = Math.abs(params.amount)
  // amount < 0 = money out of the bank = credit the bank account.
  const lines =
    params.amount < 0
      ? [
          { accountNumber: params.contraAccount ?? '5460', debitAmount: abs, creditAmount: 0 },
          { accountNumber: account, debitAmount: 0, creditAmount: abs },
        ]
      : [
          { accountNumber: account, debitAmount: abs, creditAmount: 0 },
          { accountNumber: params.contraAccount ?? '3001', debitAmount: 0, creditAmount: abs },
        ]
  return insertPostedJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: params.voucherNumber ?? 1,
    lines,
  })
}

interface RpcResult {
  ok: boolean
  code?: string
  link_count?: number
  allocated_total?: string | number
  settlement_account?: string
  details?: Record<string, unknown>
}

async function callRpc(
  userId: string,
  transactionId: string,
  links: Array<{ journal_entry_id: string; allocated_amount: number }>,
  companyId: string,
): Promise<RpcResult> {
  return withUserContext(userId, async (client) => {
    const res = await client.query<{ result: RpcResult }>(
      `SELECT public.link_transaction_to_vouchers($1, $2::jsonb, $3) AS result`,
      [transactionId, JSON.stringify(links), companyId],
    )
    return res.rows[0].result
  })
}

describe('link_transaction_to_vouchers', () => {
  it('links one transaction to two posted verifikat and leaves the scalar NULL', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -8000 })
    const jeA = await postedVoucher({
      userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 1,
    })
    const jeB = await postedVoucher({
      userId, companyId, fiscalPeriodId, amount: -3000, voucherNumber: 2,
    })

    // Assert inside the same transactional context: withUserContext rolls back
    // on exit, so a post-hoc read on the pool would see none of these writes.
    const { result, links, scalar } = await withUserContext(userId, async (client) => {
      const res = await client.query<{ result: RpcResult }>(
        `SELECT public.link_transaction_to_vouchers($1, $2::jsonb, $3) AS result`,
        [
          txId,
          JSON.stringify([
            { journal_entry_id: jeA, allocated_amount: -5000 },
            { journal_entry_id: jeB, allocated_amount: -3000 },
          ]),
          companyId,
        ],
      )
      const linkRows = await client.query<{ journal_entry_id: string; allocated_amount: string }>(
        `SELECT journal_entry_id, allocated_amount
           FROM public.transaction_voucher_links
          WHERE transaction_id = $1
          ORDER BY allocated_amount`,
        [txId],
      )
      const txRow = await client.query<{ journal_entry_id: string | null; is_business: boolean }>(
        `SELECT journal_entry_id, is_business FROM public.transactions WHERE id = $1`,
        [txId],
      )
      return { result: res.rows[0].result, links: linkRows.rows, scalar: txRow.rows[0] }
    })

    expect(result.ok).toBe(true)
    expect(result.link_count).toBe(2)
    expect(links).toHaveLength(2)
    expect(links.map((l) => l.journal_entry_id).sort()).toEqual([jeA, jeB].sort())
    expect(links.map((l) => Number(l.allocated_amount)).sort((a, b) => a - b)).toEqual([-5000, -3000])
    // N > 1: no single verifikat is "the" entry, so the scalar stays NULL and
    // readers must go through is_transaction_booked() / is-booked.ts.
    expect(scalar.journal_entry_id).toBeNull()
    expect(scalar.is_business).toBe(true)
  })

  it('is_transaction_booked() reports a split transaction as booked', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -8000 })
    const jeA = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 1 })
    const jeB = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -3000, voucherNumber: 2 })

    const booked = await withUserContext(userId, async (client) => {
      await client.query(
        `SELECT public.link_transaction_to_vouchers($1, $2::jsonb, $3)`,
        [
          txId,
          JSON.stringify([
            { journal_entry_id: jeA, allocated_amount: -5000 },
            { journal_entry_id: jeB, allocated_amount: -3000 },
          ]),
          companyId,
        ],
      )
      const res = await client.query<{ booked: boolean }>(
        `SELECT public.is_transaction_booked($1) AS booked`,
        [txId],
      )
      return res.rows[0].booked
    })

    expect(booked).toBe(true)
  })

  it('keeps the scalar column in sync for the single-link case', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -5000 })
    const je = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000 })

    const scalar = await withUserContext(userId, async (client) => {
      await client.query(
        `SELECT public.link_transaction_to_vouchers($1, $2::jsonb, $3)`,
        [txId, JSON.stringify([{ journal_entry_id: je, allocated_amount: -5000 }]), companyId],
      )
      const res = await client.query<{ journal_entry_id: string | null; reconciliation_method: string | null }>(
        `SELECT journal_entry_id, reconciliation_method FROM public.transactions WHERE id = $1`,
        [txId],
      )
      return res.rows[0]
    })

    expect(scalar.journal_entry_id).toBe(je)
    expect(scalar.reconciliation_method).toBe('manual')
  })

  it('rejects an under-allocation (BATCH_AMOUNT_BELOW_TX)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -8000 })
    const je = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000 })

    const result = await callRpc(userId, txId, [{ journal_entry_id: je, allocated_amount: -5000 }], companyId)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('BATCH_AMOUNT_BELOW_TX')
  })

  it('rejects an over-allocation (BATCH_AMOUNT_EXCEEDS_TX)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -8000 })
    const jeA = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 1 })
    const jeB = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -4000, voucherNumber: 2 })

    const result = await callRpc(
      userId,
      txId,
      [
        { journal_entry_id: jeA, allocated_amount: -5000 },
        { journal_entry_id: jeB, allocated_amount: -4000 },
      ],
      companyId,
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe('BATCH_AMOUNT_EXCEEDS_TX')
  })

  it('accepts an allocation that is off by less than half an öre', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -100.02 })
    const jeA = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -50.01, voucherNumber: 1 })
    const jeB = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -50.01, voucherNumber: 2 })

    const result = await callRpc(
      userId,
      txId,
      [
        { journal_entry_id: jeA, allocated_amount: -50.01 },
        { journal_entry_id: jeB, allocated_amount: -50.01 },
      ],
      companyId,
    )

    expect(result.ok).toBe(true)
  })

  it('refuses a whole batch when one leg is invalid (atomicity)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -8000 })
    const jeGood = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000 })
    const jeDraft = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 2,
      lines: [
        { accountNumber: '5460', debitAmount: 3000, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 3000 },
      ],
    })
    await getPool().query(`UPDATE public.journal_entries SET status = 'draft' WHERE id = $1`, [jeDraft])

    const { result, linkCount } = await withUserContext(userId, async (client) => {
      const res = await client.query<{ result: RpcResult }>(
        `SELECT public.link_transaction_to_vouchers($1, $2::jsonb, $3) AS result`,
        [
          txId,
          JSON.stringify([
            { journal_entry_id: jeGood, allocated_amount: -5000 },
            { journal_entry_id: jeDraft, allocated_amount: -3000 },
          ]),
          companyId,
        ],
      )
      const count = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM public.transaction_voucher_links WHERE transaction_id = $1`,
        [txId],
      )
      return { result: res.rows[0].result, linkCount: Number(count.rows[0].n) }
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_JE_NOT_POSTED')
    // The valid leg must not have landed: validation completes before any insert.
    expect(linkCount).toBe(0)
  })

  it('rejects a verifikat with no line on the transaction settlement account', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const txId = await insertTransaction({ companyId, userId, amount: -5000, cashAccountId })
    // Voucher settles 1940 (a different cash account), not 1930.
    const je = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, account: '1940' })

    const result = await callRpc(userId, txId, [{ journal_entry_id: je, allocated_amount: -5000 }], companyId)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_JE_NO_SETTLEMENT_LINE')
  })

  it('resolves the settlement account from the transaction cash account', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1940' })
    const txId = await insertTransaction({ companyId, userId, amount: -5000, cashAccountId })
    const je = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, account: '1940' })

    const result = await callRpc(userId, txId, [{ journal_entry_id: je, allocated_amount: -5000 }], companyId)

    expect(result.ok).toBe(true)
    expect(result.settlement_account).toBe('1940')
  })

  it('rejects a mixed-sign allocation', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -8000 })
    const jeA = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -9000, voucherNumber: 1 })
    const jeB = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: 1000, voucherNumber: 2 })

    // -9000 + 1000 sums to the right magnitude out of two wrong legs.
    const result = await callRpc(
      userId,
      txId,
      [
        { journal_entry_id: jeA, allocated_amount: -9000 },
        { journal_entry_id: jeB, allocated_amount: 1000 },
      ],
      companyId,
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_DIRECTION_MISMATCH')
  })

  it('rejects the same verifikat twice in one payload', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -10000 })
    const je = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000 })

    const result = await callRpc(
      userId,
      txId,
      [
        { journal_entry_id: je, allocated_amount: -5000 },
        { journal_entry_id: je, allocated_amount: -5000 },
      ],
      companyId,
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_DUPLICATE_JE')
  })

  it('rejects a zero-amount leg', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -5000 })
    const jeA = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 1 })
    const jeB = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -1000, voucherNumber: 2 })

    const result = await callRpc(
      userId,
      txId,
      [
        { journal_entry_id: jeA, allocated_amount: -5000 },
        { journal_entry_id: jeB, allocated_amount: 0 },
      ],
      companyId,
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_ZERO_ALLOCATION')
  })

  it('refuses a transaction already anchored by the scalar column', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const existing = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 1 })
    const txId = await insertTransaction({
      companyId, userId, amount: -5000, journalEntryId: existing,
    })
    const je = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 2 })

    const result = await callRpc(userId, txId, [{ journal_entry_id: je, allocated_amount: -5000 }], companyId)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_TX_ALREADY_BOOKED')
    expect(result.details?.via).toBe('journal_entry_id')
  })

  it('allows re-linking when the scalar points at a REVERSED entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const stale = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 1 })
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [stale])
    const txId = await insertTransaction({
      companyId, userId, amount: -5000, journalEntryId: stale,
    })
    const je = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 2 })

    // Issue #988: the UI shows such a row as "utan koppling", so the guard must
    // agree and let it be re-linked rather than stranding it forever.
    const result = await callRpc(userId, txId, [{ journal_entry_id: je, allocated_amount: -5000 }], companyId)

    expect(result.ok).toBe(true)
  })

  it('refuses a transaction that already carries links', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -5000 })
    const jeA = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 1 })
    const jeB = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000, voucherNumber: 2 })

    const result = await withUserContext(userId, async (client) => {
      await client.query(
        `SELECT public.link_transaction_to_vouchers($1, $2::jsonb, $3)`,
        [txId, JSON.stringify([{ journal_entry_id: jeA, allocated_amount: -5000 }]), companyId],
      )
      const res = await client.query<{ result: RpcResult }>(
        `SELECT public.link_transaction_to_vouchers($1, $2::jsonb, $3) AS result`,
        [txId, JSON.stringify([{ journal_entry_id: jeB, allocated_amount: -5000 }]), companyId],
      )
      return res.rows[0].result
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_TX_ALREADY_BOOKED')
    expect(result.details?.via).toBe('transaction_voucher_links')
  })

  it('refuses a verifikat belonging to another company', async () => {
    const { userId, companyId } = await seedCompany()
    const other = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -5000 })
    const foreignJe = await postedVoucher({
      userId: other.userId,
      companyId: other.companyId,
      fiscalPeriodId: other.fiscalPeriodId,
      amount: -5000,
    })

    const result = await callRpc(userId, txId, [{ journal_entry_id: foreignJe, allocated_amount: -5000 }], companyId)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_JE_NOT_FOUND')
  })

  it('refuses a caller who is not a member of the company', async () => {
    const { companyId, fiscalPeriodId, userId: ownerId } = await seedCompany()
    const outsider = await seedCompany()
    const txId = await insertTransaction({ companyId, userId: ownerId, amount: -5000 })
    const je = await postedVoucher({ userId: ownerId, companyId, fiscalPeriodId, amount: -5000 })

    const result = await callRpc(
      outsider.userId,
      txId,
      [{ journal_entry_id: je, allocated_amount: -5000 }],
      companyId,
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_UNAUTHORIZED')
  })

  it('refuses an empty link array', async () => {
    const { userId, companyId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId, amount: -5000 })

    const result = await callRpc(userId, txId, [], companyId)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_NO_LINKS')
  })

  it('refuses an unknown transaction', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const je = await postedVoucher({ userId, companyId, fiscalPeriodId, amount: -5000 })

    const result = await callRpc(
      userId,
      randomUUID(),
      [{ journal_entry_id: je, allocated_amount: -5000 }],
      companyId,
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe('LINK_VOUCHERS_TX_NOT_FOUND')
  })

  it('links a foreign-currency transaction without inventing a rate', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const cashAccountId = await insertCashAccount({
      companyId, ledgerAccount: '1932', currency: 'EUR',
    })
    const txId = await insertTransaction({
      companyId, userId, amount: -100, currency: 'EUR', cashAccountId,
    })
    const jeA = await postedVoucher({
      userId, companyId, fiscalPeriodId, amount: -60, account: '1932', voucherNumber: 1,
    })
    const jeB = await postedVoucher({
      userId, companyId, fiscalPeriodId, amount: -40, account: '1932', voucherNumber: 2,
    })

    // Unlike bulk_book_transactions this RPC writes no ledger amounts, so a
    // non-SEK row is safe here: allocated_amount is in the tx's own currency.
    const result = await callRpc(
      userId,
      txId,
      [
        { journal_entry_id: jeA, allocated_amount: -60 },
        { journal_entry_id: jeB, allocated_amount: -40 },
      ],
      companyId,
    )

    expect(result.ok).toBe(true)
    expect(result.link_count).toBe(2)
  })
})
