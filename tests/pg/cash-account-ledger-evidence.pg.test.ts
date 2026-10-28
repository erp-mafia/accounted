import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertCashAccount,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from './fixtures'

// pg-real coverage for 20261010210000_cash_account_ledger_evidence (crm#1066):
// what the books say about which 19xx ledger account a connected bank account
// belongs on. cash_account_ledger_evidence returns two kinds of row:
// 'transactions' (unbooked bank rows matching a posted line by date and signed
// amount) and 'balance' (the rolled-back bank balance equals a ledger balance
// to the ore). cash_account_booked_rows counts the rows already linked on the
// current ledger account. Both only read.

type Owner = Awaited<ReturnType<typeof seedCompany>>
type Evidence = { cash_account_id: string; kind: string; ledger_account: string; hits: number | null; balance_date: string | null }

const EVIDENCE = `SELECT cash_account_id, kind, ledger_account, hits, balance_date::text AS balance_date
  FROM public.cash_account_ledger_evidence($1)`

async function evidence(companyId: string): Promise<Evidence[]> {
  return (await getPool().query<Evidence>(EVIDENCE, [companyId])).rows
}

function of(rows: Evidence[], cashAccountId: string, kind: string): Record<string, number | string | null> {
  return Object.fromEntries(
    rows
      .filter((r) => r.cash_account_id === cashAccountId && r.kind === kind)
      .map((r) => [r.ledger_account, kind === 'balance' ? r.balance_date : r.hits]),
  )
}

async function bookedRows(companyId: string, cashAccountId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT public.cash_account_booked_rows($1, $2) AS n`,
    [companyId, cashAccountId],
  )
  return rows[0].n
}

async function insertConnection(owner: Owner): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.bank_connections (id, company_id, user_id, session_id, status, accounts_data)
     VALUES ($1, $2, $3, $4, 'active', '[]'::jsonb)`,
    [id, owner.companyId, owner.userId, `session-${id}`],
  )
  return id
}

/** An enabled cash account a bank connection syncs onto. */
async function connectedAccount(
  owner: Owner,
  ledgerAccount: string,
  options: { balance?: number; currency?: string; enabled?: boolean; connected?: boolean } = {},
): Promise<string> {
  const id = await insertCashAccount({
    companyId: owner.companyId,
    ledgerAccount,
    currency: options.currency ?? 'SEK',
    enabled: options.enabled ?? true,
    source: 'enable_banking',
    externalUid: `uid-${randomUUID()}`,
    bankConnectionId: options.connected === false ? null : await insertConnection(owner),
  })
  if (options.balance !== undefined) {
    await getPool().query(
      `UPDATE public.cash_accounts SET balance = $2, balance_updated_at = now() WHERE id = $1`,
      [id, options.balance],
    )
  }
  return id
}

/** A posted verifikat with one line on a bank ledger account: money in is a debit there. */
function bankVoucher(
  owner: Owner,
  ledgerAccount: string,
  amount: number,
  entryDate: string,
  options: { sourceType?: string; fiscalPeriodId?: string } = {},
) {
  const abs = Math.abs(amount)
  return insertPostedJournalEntry({
    ...owner,
    fiscalPeriodId: options.fiscalPeriodId ?? owner.fiscalPeriodId,
    entryDate,
    sourceType: options.sourceType ?? 'manual',
    lines: [
      { accountNumber: ledgerAccount, debitAmount: amount > 0 ? abs : 0, creditAmount: amount > 0 ? 0 : abs },
      { accountNumber: '2999', debitAmount: amount > 0 ? 0 : abs, creditAmount: amount > 0 ? abs : 0 },
    ],
  })
}

/**
 * Money in on a foreign bank ledger account: the debit column holds SEK and
 * the line carries the foreign amount, as lib/bookkeeping/currency-utils.ts
 * writes it. Lines go in while the verifikat is a draft; posted lines are
 * immutable.
 */
async function foreignBankVoucher(
  owner: Owner,
  ledgerAccount: string,
  amount: { sek: number; foreign: number; currency: string },
  entryDate: string,
): Promise<string> {
  const id = await insertDraftJournalEntry({ ...owner, entryDate })
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, currency, amount_in_currency, sort_order)
     VALUES ($1, $2, $3, 0, $4, $5, 0),
            ($1, '2999', 0, $3, 'SEK', NULL, 1)`,
    [id, ledgerAccount, amount.sek, amount.currency, amount.foreign],
  )
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
  return id
}

function bankRow(owner: Owner, cashAccountId: string, amount: number, date: string, extra: Partial<Parameters<typeof insertTransaction>[0]> = {}) {
  return insertTransaction({ companyId: owner.companyId, userId: owner.userId, cashAccountId, amount, date, ...extra })
}

describe('cash_account_ledger_evidence: bank rows against posted lines', () => {
  it('counts the rows booked on another 19xx account, and none on the mapped one', async () => {
    const owner = await seedCompany()
    const account = await connectedAccount(owner, '1940')
    const days = ['2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06']
    for (const [i, day] of days.entries()) {
      // Money out on even rows, money in on odd rows: both directions count.
      const amount = i % 2 === 0 ? -(100 + i) : 200 + i
      await bankVoucher(owner, '1920', amount, day)
      await bankRow(owner, account, amount, day)
    }

    const rows = await evidence(owner.companyId)
    expect(of(rows, account, 'transactions')).toEqual({ '1920': 5 })
    expect(await bookedRows(owner.companyId, account)).toBe(0)
  })

  it('matches on date and signed amount only, and counts a row once per ledger account', async () => {
    const owner = await seedCompany()
    const account = await connectedAccount(owner, '1930')
    // Two verifikat that both fit the same row: one hit.
    await bankVoucher(owner, '1920', -250, '2026-03-02')
    await bankVoucher(owner, '1920', -250, '2026-03-02')
    await bankRow(owner, account, -250, '2026-03-02')
    // Two rows that fit the same verifikat: each row has its bookkeeping, two hits.
    await bankVoucher(owner, '1921', 15, '2026-03-02')
    await bankRow(owner, account, 15, '2026-03-02')
    await bankRow(owner, account, 15, '2026-03-02')
    // Same amount, other direction: money in on the bank is not a credit on the ledger.
    await bankVoucher(owner, '1920', -75, '2026-03-03')
    await bankRow(owner, account, 75, '2026-03-03')
    // Same amount, another day.
    await bankVoucher(owner, '1920', -60, '2026-03-04')
    await bankRow(owner, account, -60, '2026-03-05')
    // One ore apart.
    await bankVoucher(owner, '1920', -40.01, '2026-03-06')
    await bankRow(owner, account, -40, '2026-03-06')
    // A line outside 19xx never counts, whatever it matches.
    await bankVoucher(owner, '1510', 900, '2026-03-09')
    await bankRow(owner, account, 900, '2026-03-09')
    // The mapped account is reported like any other.
    await bankVoucher(owner, '1930', -33, '2026-03-10')
    await bankRow(owner, account, -33, '2026-03-10')

    expect(of(await evidence(owner.companyId), account, 'transactions')).toEqual({ '1920': 1, '1921': 2, '1930': 1 })
  })

  it('reads 1900 to 1999 and nothing either side (the range the line read is indexed on, 20261028042147)', async () => {
    const owner = await seedCompany()
    const account = await connectedAccount(owner, '1930', { balance: 500 })
    for (const [i, ledger] of ['1899', '1900', '1999', '2000'].entries()) {
      const day = `2026-05-0${i + 1}`
      await bankVoucher(owner, ledger, -(10 + i), day)
      await bankRow(owner, account, -(10 + i), day)
    }
    // The balance kind reads the same lines. Rolled back over the four rows
    // (-46,00), the bank stood at 546,00 the day before the feed: 1999 holds
    // that, and so does 2000, which is no bank account.
    await bankVoucher(owner, '1999', 546, '2026-04-30')
    await bankVoucher(owner, '2000', 546, '2026-04-30')

    const rows = await evidence(owner.companyId)
    expect(of(rows, account, 'transactions')).toEqual({ '1900': 1, '1999': 1 })
    expect(of(rows, account, 'balance')).toEqual({ '1999': '2026-04-30' })
  })

  it('leaves out booked and ignored rows, and verifikat the matcher never links', async () => {
    const owner = await seedCompany()
    const account = await connectedAccount(owner, '1940')
    // An ignored row.
    await bankVoucher(owner, '1920', -10, '2026-04-01')
    await bankRow(owner, account, -10, '2026-04-01', { isIgnored: true })
    // An opening balance and a storno are not candidates for a link.
    await bankVoucher(owner, '1920', 20, '2026-01-01', { sourceType: 'opening_balance' })
    await bankRow(owner, account, 20, '2026-01-01')
    await bankVoucher(owner, '1920', -30, '2026-04-02', { sourceType: 'storno' })
    await bankRow(owner, account, -30, '2026-04-02')
    // A booked row: linked to a verifikat on the account's own ledger account,
    // while an identical line sits on 1920.
    const own = await bankVoucher(owner, '1940', -50, '2026-04-03')
    await bankVoucher(owner, '1920', -50, '2026-04-03')
    await bankRow(owner, account, -50, '2026-04-03', { journalEntryId: own })
    // The one row that counts.
    await bankVoucher(owner, '1920', -70, '2026-04-06')
    await bankRow(owner, account, -70, '2026-04-06')

    expect(of(await evidence(owner.companyId), account, 'transactions')).toEqual({ '1920': 1 })
  })

  it('reads only enabled cash accounts a bank connection syncs onto', async () => {
    const owner = await seedCompany()
    const disabled = await connectedAccount(owner, '1940', { enabled: false })
    const manual = await connectedAccount(owner, '1941', { connected: false })
    const live = await connectedAccount(owner, '1942')
    for (const account of [disabled, manual, live]) {
      await bankRow(owner, account, -80, '2026-05-04')
    }
    await bankVoucher(owner, '1920', -80, '2026-05-04')

    const rows = await evidence(owner.companyId)
    expect(new Set(rows.map((r) => r.cash_account_id))).toEqual(new Set([live]))
    expect(of(rows, live, 'transactions')).toEqual({ '1920': 1 })
  })

  it('compares a foreign account in its own currency, never against the SEK columns', async () => {
    const owner = await seedCompany()
    const account = await connectedAccount(owner, '1932', { currency: 'EUR' })
    await bankRow(owner, account, 100, '2026-06-01', { currency: 'EUR' })
    // 100 EUR in, booked as 1 150 SEK on 1933 with the foreign amount on the line.
    await foreignBankVoucher(owner, '1933', { sek: 1150, foreign: 100, currency: 'EUR' }, '2026-06-01')
    // A SEK line of the same number is not 100 EUR, and neither is a USD line.
    await bankVoucher(owner, '1934', 100, '2026-06-01')
    await foreignBankVoucher(owner, '1935', { sek: 1050, foreign: 100, currency: 'USD' }, '2026-06-01')

    expect(of(await evidence(owner.companyId), account, 'transactions')).toEqual({ '1933': 1 })
  })

  it('is scoped to the company: no other tenant is read, and no outsider can read', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const account = await connectedAccount(a, '1940')
    await bankRow(a, account, -90, '2026-07-01')
    await bankVoucher(a, '1920', -90, '2026-07-01')
    // The same day and amount in another company's books is not evidence here.
    await bankRow(a, account, -91, '2026-07-02')
    await bankVoucher(b, '1921', -91, '2026-07-02')

    expect(of(await evidence(a.companyId), account, 'transactions')).toEqual({ '1920': 1 })
    expect(await evidence(b.companyId)).toEqual([])

    // A member reads its own company through RLS.
    await withUserContext(a.userId, async (client) => {
      const own = await client.query<Evidence>(EVIDENCE, [a.companyId])
      expect(of(own.rows, account, 'transactions')).toEqual({ '1920': 1 })
    })
    // A member of another company probing this one gets nothing.
    await withUserContext(b.userId, async (client) => {
      const probe = await client.query<Evidence>(EVIDENCE, [a.companyId])
      expect(probe.rows).toEqual([])
    })
  })

  it('refuses an anonymous caller: EXECUTE is revoked from anon and PUBLIC', async () => {
    const owner = await seedCompany()
    const account = await connectedAccount(owner, '1940')
    for (const [sql, params] of [
      [EVIDENCE, [owner.companyId]],
      [`SELECT public.cash_account_booked_rows($1, $2)`, [owner.companyId, account]],
    ] as const) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`)
        await client.query('SET LOCAL ROLE anon')
        await expect(client.query(sql, [...params])).rejects.toMatchObject({ code: '42501' })
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }
  })
})

describe('cash_account_booked_rows: what a change of ledger account leaves behind', () => {
  it('counts the rows linked to a verifikat on the current ledger account, and only those', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const account = await connectedAccount(a, '1940')
    const other = await connectedAccount(a, '1941')
    // Linked on the mapped account: these stay there after a change.
    for (const [amount, day] of [[-50, '2026-04-03'], [120, '2026-04-06']] as const) {
      const entry = await bankVoucher(a, '1940', amount, day)
      await bankRow(a, account, amount, day, { journalEntryId: entry })
    }
    // Unbooked rows and another account's rows are not this account's booked rows.
    await bankRow(a, account, -70, '2026-04-07')
    const elsewhere = await bankVoucher(a, '1941', -80, '2026-04-08')
    await bankRow(a, other, -80, '2026-04-08', { journalEntryId: elsewhere })

    expect(await bookedRows(a.companyId, account)).toBe(2)
    expect(await bookedRows(a.companyId, other)).toBe(1)
    // The company in the call must own the account.
    expect(await bookedRows(b.companyId, account)).toBe(0)

    await withUserContext(a.userId, async (client) => {
      const own = await client.query<{ n: number }>(`SELECT public.cash_account_booked_rows($1, $2) AS n`, [a.companyId, account])
      expect(own.rows[0].n).toBe(2)
    })
    await withUserContext(b.userId, async (client) => {
      const probe = await client.query<{ n: number }>(`SELECT public.cash_account_booked_rows($1, $2) AS n`, [a.companyId, account])
      expect(probe.rows[0].n).toBe(0)
    })
  })
})

describe('cash_account_ledger_evidence: the bank balance against ledger balances', () => {
  /** Books for 2025 that end on the year's last day, and a feed that starts in 2026. */
  async function migratedCompany() {
    const owner = await seedCompany()
    const fy2025 = await insertFiscalPeriod({
      userId: owner.userId,
      companyId: owner.companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    const in2025 = { fiscalPeriodId: fy2025 }
    // 1920 closes 2025 at 1 000,00 + 3 210,25 = 4 210,25.
    await bankVoucher(owner, '1920', 1000, '2025-01-01', { ...in2025, sourceType: 'opening_balance' })
    await bankVoucher(owner, '1920', 3210.25, '2025-12-31', in2025)
    // 1940 closes 2025 at 250,00.
    await bankVoucher(owner, '1940', 250, '2025-12-30', in2025)
    return owner
  }

  it('finds the ledger account whose balance the rolled-back bank balance equals, on another account', async () => {
    const owner = await migratedCompany()
    // 4 210,25 at the end of 2025, then -100,00, +300,45 and +50,00 in January: 4 460,70.
    const account = await connectedAccount(owner, '1940', { balance: 4460.7 })
    await bankRow(owner, account, -100, '2026-01-02')
    // Ignored and booked rows moved the bank balance too.
    await bankRow(owner, account, 300.45, '2026-01-05', { isIgnored: true })
    const booked = await bankVoucher(owner, '1940', 50, '2026-01-07')
    await bankRow(owner, account, 50, '2026-01-07', { journalEntryId: booked })

    const rows = await evidence(owner.companyId)
    // The last booked day, not the day before the first bank row.
    expect(of(rows, account, 'balance')).toEqual({ '1920': '2025-12-31' })
    expect(of(rows, account, 'transactions')).toEqual({})
  })

  it('reads several imported years from their one opening balance (the shape of the report)', async () => {
    // Three years imported at once: an opening balance on the first day of the
    // earliest one, none in the years after it. The balance just accumulates.
    const owner = await seedCompany()
    const year = async (name: string) => ({
      fiscalPeriodId: await insertFiscalPeriod({
        userId: owner.userId,
        companyId: owner.companyId,
        name,
        periodStart: `${name}-01-01`,
        periodEnd: `${name}-12-31`,
      }),
    })
    const [in2023, in2024, in2025] = [await year('2023'), await year('2024'), await year('2025')]
    // 1920: 500,00 + 100,00 + 200,00 + 300,25 = 1 100,25 at the end of 2025.
    await bankVoucher(owner, '1920', 500, '2023-01-01', { ...in2023, sourceType: 'opening_balance' })
    await bankVoucher(owner, '1920', 100, '2023-06-15', in2023)
    await bankVoucher(owner, '1920', 200, '2024-03-10', in2024)
    await bankVoucher(owner, '1920', 300.25, '2025-12-31', in2025)
    // 1940: 80,00 + 20,00 - 10,00 = 90,00 from 2025-11-28 on.
    await bankVoucher(owner, '1940', 80, '2023-01-01', { ...in2023, sourceType: 'opening_balance' })
    await bankVoucher(owner, '1940', 20, '2024-09-01', in2024)
    await bankVoucher(owner, '1940', -10, '2025-11-28', in2025)

    // The two bank accounts landed on each other's ledger account, and their
    // feeds start in the newest year.
    const onWrong1940 = await connectedAccount(owner, '1940', { balance: 1000.25 })
    await bankRow(owner, onWrong1940, -100, '2026-01-02')
    const onWrong1920 = await connectedAccount(owner, '1920', { balance: 140 })
    await bankRow(owner, onWrong1920, 50, '2026-01-05')

    const rows = await evidence(owner.companyId)
    // 2025 alone moved 300,25 on 1920 and -10,00 on 1940: a read from the first
    // day of the year holding the day finds neither balance.
    expect(of(rows, onWrong1940, 'balance')).toEqual({ '1920': '2025-12-31' })
    expect(of(rows, onWrong1920, 'balance')).toEqual({ '1940': '2025-11-28' })
  })

  it('reads from the latest opening balance when every year has one, never across it', async () => {
    const owner = await migratedCompany()
    // The 2026 opening balance restates 2025: 4 210,25 on 1920.
    await bankVoucher(owner, '1920', 4210.25, '2026-01-01', { sourceType: 'opening_balance' })
    const account = await connectedAccount(owner, '1940', { balance: 4110.25 })
    await bankRow(owner, account, -100, '2026-01-02')

    // On 2026-01-01 the ledger holds 4 210,25, the opening balance alone. A sum
    // over all history would read 8 420,50 and find nothing.
    expect(of(await evidence(owner.companyId), account, 'balance')).toEqual({ '1920': '2026-01-01' })
  })

  it('treats an opening_balance verifikat dated inside a year as an ordinary entry, not a floor', async () => {
    const owner = await seedCompany()
    await bankVoucher(owner, '1920', 700, '2026-01-10')
    // An import labelled a mid-year payment as an opening balance.
    await bankVoucher(owner, '1920', 50, '2026-03-15', { sourceType: 'opening_balance' })
    const account = await connectedAccount(owner, '1940', { balance: 720 })
    await bankRow(owner, account, -30, '2026-04-01')

    // 700,00 + 50,00 = 750,00. Floored at the mislabelled entry it would be 50,00.
    expect(of(await evidence(owner.companyId), account, 'balance')).toEqual({ '1920': '2026-03-15' })
  })

  it('does not floor at opening balances that cancel on the account', async () => {
    const owner = await migratedCompany()
    // A duplicated opening balance for 2026 and the entry that undoes it: both
    // labelled opening_balance, both posted, zero together on 1920.
    await bankVoucher(owner, '1920', 900, '2026-01-01', { sourceType: 'opening_balance' })
    await bankVoucher(owner, '1920', -900, '2026-01-01', { sourceType: 'opening_balance' })
    const account = await connectedAccount(owner, '1940', { balance: 4185.25 })
    await bankRow(owner, account, -25, '2026-01-02')

    // Nothing restates 2025, so on 2026-01-01 the balance still runs from the
    // 2025 opening balance: 1 000,00 + 3 210,25 + 900,00 - 900,00 = 4 210,25.
    // Floored at the pair it would be 0,00 and never match.
    expect(of(await evidence(owner.companyId), account, 'balance')).toEqual({ '1920': '2026-01-01' })
  })

  it('reads an account with no opening balance over its whole history', async () => {
    const owner = await migratedCompany()
    // 1950 was opened during 2025 and never appears in an opening balance.
    const fy2025 = (await getPool().query<{ id: string }>(
      `SELECT id FROM public.fiscal_periods WHERE company_id = $1 AND period_start = '2025-01-01'`,
      [owner.companyId],
    )).rows[0].id
    await bankVoucher(owner, '1950', 640, '2025-08-20', { fiscalPeriodId: fy2025 })
    await bankVoucher(owner, '1950', -15.5, '2026-01-01')
    const account = await connectedAccount(owner, '1940', { balance: 604.5 })
    await bankRow(owner, account, -20, '2026-01-02')

    expect(of(await evidence(owner.companyId), account, 'balance')).toEqual({ '1950': '2026-01-01' })
  })

  it('finds nothing when the balance is one ore off', async () => {
    const owner = await migratedCompany()
    const account = await connectedAccount(owner, '1940', { balance: 4110.26 })
    await bankRow(owner, account, -100, '2026-01-02')

    expect(of(await evidence(owner.companyId), account, 'balance')).toEqual({})
  })

  it('reports a match on the mapped account like any other', async () => {
    const owner = await migratedCompany()
    const account = await connectedAccount(owner, '1940', { balance: 150 })
    await bankRow(owner, account, -100, '2026-01-02')

    // 250,00 on 1940 at its last booked day, 2025-12-30.
    expect(of(await evidence(owner.companyId), account, 'balance')).toEqual({ '1940': '2025-12-30' })
  })

  it('finds the latest booked day when the books start after the bank feed', async () => {
    const owner = await seedCompany()
    // Books from 2026-01-01: 1 000,00 in, then -200,00 on the 15th.
    await bankVoucher(owner, '1920', 1000, '2026-01-01', { sourceType: 'opening_balance' })
    await bankVoucher(owner, '1920', -200, '2026-01-15')
    // The feed reaches back into December, before the first fiscal year.
    const account = await connectedAccount(owner, '1940', { balance: 750 })
    await bankRow(owner, account, 300, '2025-12-20')
    await bankRow(owner, account, -200, '2026-01-15')
    await bankRow(owner, account, -50, '2026-02-01')

    // 750,00 + 50,00 = 800,00 at the end of 2026-01-15, the ledger's 800,00.
    // The rows of that day stay unbooked here on purpose: 1920 is not the
    // mapped account, so nothing has linked them.
    const rows = await evidence(owner.companyId)
    expect(of(rows, account, 'balance')).toEqual({ '1920': '2026-01-15' })
    expect(of(rows, account, 'transactions')).toEqual({ '1920': 1 })
  })

  it('never matches a zero balance', async () => {
    const owner = await seedCompany()
    // 1950 nets to zero, and so does the bank account before its first row.
    await bankVoucher(owner, '1950', 400, '2026-02-02')
    await bankVoucher(owner, '1950', -400, '2026-02-03')
    const account = await connectedAccount(owner, '1940', { balance: 75 })
    await bankRow(owner, account, 75, '2026-02-10')

    expect(of(await evidence(owner.companyId), account, 'balance')).toEqual({})
  })

  it('needs a stored balance, and bank rows in the account currency only', async () => {
    const owner = await migratedCompany()
    const noBalance = await connectedAccount(owner, '1941')
    await bankRow(owner, noBalance, -100, '2026-01-02')
    const mixed = await connectedAccount(owner, '1942', { balance: 4110.25 })
    await bankRow(owner, mixed, -100, '2026-01-02')
    await bankRow(owner, mixed, 0, '2026-01-03', { currency: 'EUR' })

    const rows = await evidence(owner.companyId)
    expect(of(rows, noBalance, 'balance')).toEqual({})
    expect(of(rows, mixed, 'balance')).toEqual({})
  })
})
