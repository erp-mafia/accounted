import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  seedCompany,
  insertCashAccount,
  insertTransaction,
  insertDraftJournalEntry,
} from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for transactions.cash_account_id
 * (20260606120000_transactions_cash_account_id.sql + the paired backfill
 * 20260606120100_..._backfill.sql).
 *
 * Locks in:
 *   - FK ON DELETE SET NULL — deleting a cash account never deletes the bank
 *     transaction (räkenskapsinformation, BFL 7 kap), only nulls the link.
 *   - The four backfill passes (booked single 19xx line, PSD2 external_id,
 *     single-account-of-currency, leave NULL) and their guards.
 *   - The headline isolation: a query scoped to one account (with the
 *     NULL→currency fallback) never returns another same-currency account's
 *     rows. This is the regression test for "shows 1930 even when you switch /
 *     sums all transactions".
 *   - Cross-company isolation of the backfill.
 */

// Run the real backfill migration SQL (idempotent: only touches NULL rows) so
// the test exercises exactly what ships, not a re-implementation.
const BACKFILL_SQL = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260606120100_transactions_cash_account_id_backfill.sql',
  ),
  'utf8',
)
async function runBackfill(): Promise<void> {
  await getPool().query(BACKFILL_SQL)
}

// The repair migration re-derives cash_account_id and CORRECTS mis-assignments
// (the NULL-only original backfill could not). Run the real SQL so the test
// exercises exactly what ships.
const REPAIR_SQL = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260609120000_transactions_cash_account_id_repair_backfill.sql',
  ),
  'utf8',
)
async function runRepair(): Promise<void> {
  await getPool().query(REPAIR_SQL)
}

// Insert a journal entry (draft) with the given bank-class line account
// numbers. One line per account at amount 100 (debit). Balance isn't required
// for a draft entry — the balance trigger only fires on draft→posted.
async function insertEntryWithBankLines(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  bankAccounts: string[]
}): Promise<string> {
  const jeId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
  })
  for (const acct of params.bankAccounts) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, 100, 0)`,
      [jeId, acct],
    )
  }
  return jeId
}

async function getCashAccountId(txId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT cash_account_id FROM public.transactions WHERE id = $1`,
    [txId],
  )
  return rows[0]?.cash_account_id ?? null
}

describe('transactions.cash_account_id — schema + FK', () => {
  it('ON DELETE SET NULL keeps the transaction when its cash account is deleted', async () => {
    const { userId, companyId } = await seedCompany()
    const caId = await insertCashAccount({ companyId, ledgerAccount: '1930' })
    const txId = await insertTransaction({ companyId, userId, cashAccountId: caId })

    await getPool().query(`DELETE FROM public.cash_accounts WHERE id = $1`, [caId])

    const { rows } = await getPool().query(
      `SELECT id, cash_account_id FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(rows).toHaveLength(1) // transaction survived
    expect(rows[0].cash_account_id).toBeNull() // link was nulled, not cascaded
  })
})

describe('transactions.cash_account_id — backfill pass (a) booked rows', () => {
  it('binds a booked transaction via its single bank line; skips multi-bank-line vouchers', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    // Two SEK accounts so the single-account fallback (pass c) cannot fire.
    await insertCashAccount({ companyId, ledgerAccount: '1930' })
    const ca1931 = await insertCashAccount({ companyId, ledgerAccount: '1931' })

    // Single 1931 line → should bind to the 1931 cash account.
    const jeSingle = await insertEntryWithBankLines({
      userId,
      companyId,
      fiscalPeriodId,
      bankAccounts: ['1931'],
    })
    const txSingle = await insertTransaction({
      companyId,
      userId,
      journalEntryId: jeSingle,
    })

    // Two bank lines (1930 + 1931) → ambiguous transfer, must stay NULL.
    const jeTransfer = await insertEntryWithBankLines({
      userId,
      companyId,
      fiscalPeriodId,
      bankAccounts: ['1930', '1931'],
    })
    const txTransfer = await insertTransaction({
      companyId,
      userId,
      journalEntryId: jeTransfer,
    })

    await runBackfill()

    expect(await getCashAccountId(txSingle)).toBe(ca1931)
    expect(await getCashAccountId(txTransfer)).toBeNull()
  })
})

describe('transactions.cash_account_id — backfill pass (b) PSD2 external_id', () => {
  it('routes by IBAN and by external_uid embedded in external_id', async () => {
    const { userId, companyId } = await seedCompany()
    // Two SEK accounts → pass (c) cannot fire, so only the PSD2 identity binds.
    const caIban = await insertCashAccount({
      companyId,
      ledgerAccount: '1930',
      iban: 'SE4550000000058398257466',
    })
    const caUid = await insertCashAccount({
      companyId,
      ledgerAccount: '1931',
      externalUid: 'psd2-uid-b',
    })

    const txIban = await insertTransaction({
      companyId,
      userId,
      externalId: 'eb_SE4550000000058398257466_tx1',
    })
    const txUid = await insertTransaction({
      companyId,
      userId,
      externalId: 'eb_psd2-uid-b_tx2',
    })
    const txUnknown = await insertTransaction({
      companyId,
      userId,
      externalId: 'eb_nomatch_tx3',
    })

    await runBackfill()

    expect(await getCashAccountId(txIban)).toBe(caIban)
    expect(await getCashAccountId(txUid)).toBe(caUid)
    expect(await getCashAccountId(txUnknown)).toBeNull()
  })
})

describe('transactions.cash_account_id — backfill pass (c) single-account-of-currency', () => {
  it('binds when the company has exactly one enabled account of the currency', async () => {
    const { userId, companyId } = await seedCompany()
    const ca = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK' })
    // CSV-style row: no external_id, unbooked.
    const tx = await insertTransaction({ companyId, userId, currency: 'SEK' })

    await runBackfill()

    expect(await getCashAccountId(tx)).toBe(ca)
  })

  it('leaves NULL when the company has two same-currency accounts', async () => {
    const { userId, companyId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK' })
    await insertCashAccount({ companyId, ledgerAccount: '1931', currency: 'SEK' })
    const tx = await insertTransaction({ companyId, userId, currency: 'SEK' })

    await runBackfill()

    expect(await getCashAccountId(tx)).toBeNull()
  })
})

describe('transactions.cash_account_id — account-scoped query isolation', () => {
  it('only the primary account claims NULL rows; a secondary same-currency account stays strict', async () => {
    const { userId, companyId } = await seedCompany()
    const ca1930 = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK' })
    const ca1931 = await insertCashAccount({ companyId, ledgerAccount: '1931', currency: 'SEK' })

    const tx1930 = await insertTransaction({ companyId, userId, currency: 'SEK', cashAccountId: ca1930 })
    const tx1931 = await insertTransaction({ companyId, userId, currency: 'SEK', cashAccountId: ca1931 })
    const txNullSek = await insertTransaction({ companyId, userId, currency: 'SEK' })
    const txNullEur = await insertTransaction({ companyId, userId, currency: 'EUR' })

    // Mirror the runtime predicate from scopeTransactionsToAccount(). The
    // `includeUnassigned` flag is the account's cash_accounts.is_primary in the
    // real code: ONLY the primary account claims unassigned (NULL) rows.
    //   primary:    cash_account_id = X OR (cash_account_id IS NULL AND currency = cur)
    //   secondary:  cash_account_id = X AND currency = cur
    const scoped = async (
      cashAccountId: string,
      currency: string,
      includeUnassigned: boolean,
    ): Promise<string[]> => {
      const predicate = includeUnassigned
        ? `(cash_account_id = $2 OR (cash_account_id IS NULL AND currency = $3))`
        : `(cash_account_id = $2 AND currency = $3)`
      const { rows } = await getPool().query(
        `SELECT id FROM public.transactions
         WHERE company_id = $1 AND ${predicate}`,
        [companyId, cashAccountId, currency],
      )
      return rows.map((r) => r.id)
    }

    // Primary (1930) claims the legacy NULL SEK row via the fallback.
    const for1930 = await scoped(ca1930, 'SEK', true)
    expect(for1930).toContain(tx1930)
    expect(for1930).toContain(txNullSek) // legacy NULL row visible via fallback
    expect(for1930).not.toContain(tx1931) // the other account never leaks
    expect(for1930).not.toContain(txNullEur) // wrong-currency NULL excluded

    // Secondary (1931) is strict. Pulling in the NULL row would double-count
    // what belongs to 1930 — the user-reported "1930 works but the other
    // accounts go wonky" bug, where 1930's unassigned rows inflated 1931's bank
    // total and produced a large bogus difference.
    const for1931 = await scoped(ca1931, 'SEK', false)
    expect(for1931).toContain(tx1931)
    expect(for1931).not.toContain(txNullSek) // the fix: no double-count onto 1931
    expect(for1931).not.toContain(tx1930)
  })
})

describe('transactions.cash_account_id — repair backfill (20260609120000)', () => {
  it('re-seeds a default 1930 SEK cash account for a company that has none', async () => {
    const { companyId } = await seedCompany()
    // seedCompany inserts the company directly (no cash account).

    await runRepair()

    const { rows } = await getPool().query(
      `SELECT ledger_account, currency, is_primary
         FROM public.cash_accounts WHERE company_id = $1`,
      [companyId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].ledger_account).toBe('1930')
    expect(rows[0].currency).toBe('SEK')
    expect(rows[0].is_primary).toBe(true)
  })

  it('CORRECTS a booked row mis-assigned to the wrong cash account', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const ca1930 = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK' })
    const ca1931 = await insertCashAccount({ companyId, ledgerAccount: '1931', currency: 'SEK' })

    // The voucher settled on 1930, but the row was wrongly bound to 1931 — the
    // exact mis-assignment the NULL-only original backfill can never undo.
    const je = await insertEntryWithBankLines({
      userId,
      companyId,
      fiscalPeriodId,
      bankAccounts: ['1930'],
    })
    const tx = await insertTransaction({ companyId, userId, journalEntryId: je, cashAccountId: ca1931 })

    await runRepair()

    expect(await getCashAccountId(tx)).toBe(ca1930)
  })

  it('CORRECTS a mis-assigned unbooked row in a single-SEK-account company', async () => {
    // The headline Arcim regression: one SEK account; a buggy backfill bound a
    // SEK row to the wrong account, so per-account scoping dropped it and
    // Bankavstämning showed 0 transactions. Repair rebinds it to the sole SEK account.
    const { userId, companyId } = await seedCompany()
    const caSek = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK' })
    const caEur = await insertCashAccount({ companyId, ledgerAccount: '1932', currency: 'EUR' })
    const tx = await insertTransaction({ companyId, userId, currency: 'SEK', cashAccountId: caEur })

    await runRepair()

    expect(await getCashAccountId(tx)).toBe(caSek)
  })

  it('binds NULL unbooked rows to the single account of their currency', async () => {
    const { userId, companyId } = await seedCompany()
    const ca = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK' })
    const tx = await insertTransaction({ companyId, userId, currency: 'SEK' })

    await runRepair()

    expect(await getCashAccountId(tx)).toBe(ca)
  })

  it('does NOT touch an unbooked row when two same-currency accounts exist', async () => {
    const { userId, companyId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK' })
    await insertCashAccount({ companyId, ledgerAccount: '1931', currency: 'SEK' })
    const tx = await insertTransaction({ companyId, userId, currency: 'SEK' })

    await runRepair()

    expect(await getCashAccountId(tx)).toBeNull()
  })

  it('is idempotent — a second run changes nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const ca = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK' })
    const tx = await insertTransaction({ companyId, userId, currency: 'SEK' })

    await runRepair()
    const first = await getCashAccountId(tx)
    await runRepair()

    expect(first).toBe(ca)
    expect(await getCashAccountId(tx)).toBe(ca)
  })

  it('never rebinds across companies', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const caA = await insertCashAccount({ companyId: a.companyId, ledgerAccount: '1930', currency: 'SEK' })
    await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1930', currency: 'SEK' })
    const txA = await insertTransaction({ companyId: a.companyId, userId: a.userId, currency: 'SEK' })

    await runRepair()

    expect(await getCashAccountId(txA)).toBe(caA)
  })
})

describe('transactions.cash_account_id — cross-company isolation', () => {
  it('backfill never binds a transaction to another company\'s cash account', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    const caA = await insertCashAccount({ companyId: a.companyId, ledgerAccount: '1930' })
    const caB = await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1930' })

    const jeA = await insertEntryWithBankLines({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
      bankAccounts: ['1930'],
    })
    const txA = await insertTransaction({ companyId: a.companyId, userId: a.userId, journalEntryId: jeA })

    await runBackfill()

    const boundA = await getCashAccountId(txA)
    expect(boundA).toBe(caA)
    expect(boundA).not.toBe(caB)
  })
})
