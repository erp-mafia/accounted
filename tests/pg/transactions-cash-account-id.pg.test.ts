import { describe, expect, it } from 'vitest'
import { seedCompany, insertCashAccount, insertTransaction } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

// Current-schema coverage. Historical backfills run only against temporary
// relations in transactions-cash-account-backfill.pg.test.ts.

describe('transactions.cash_account_id: schema + FK', () => {
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

describe('transactions.cash_account_id: account-scoped query isolation', () => {
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
    // what belongs to 1930: the user-reported "1930 works but the other
    // accounts go wonky" bug, where 1930's unassigned rows inflated 1931's bank
    // total and produced a large bogus difference.
    const for1931 = await scoped(ca1931, 'SEK', false)
    expect(for1931).toContain(tx1931)
    expect(for1931).not.toContain(txNullSek) // the fix: no double-count onto 1931
    expect(for1931).not.toContain(tx1930)
  })
})
