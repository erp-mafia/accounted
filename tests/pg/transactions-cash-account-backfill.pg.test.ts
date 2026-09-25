import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient } from '@/tests/pg/setup'

// These migrations describe a historical data conversion. Replaying them on
// public tables can change unrelated tenants and is incompatible with newer
// anchor protections. Keep the original statements, substituting only the
// four qualified relation names, and roll back all temporary fixture state.
// These minimal relations represent the columns the migrations read/write;
// they are not a model of the current bookkeeping schema or its enforcement.
let client: PoolClient
const fixtureRelations = new Set(['companies', 'cash_accounts', 'transactions', 'journal_entry_lines'])
function isolateMigration(sql: string): string {
  const scoped = sql.replace(/\bpublic\.([a-z_]+)/g, (_, relation: string) => {
    if (!fixtureRelations.has(relation)) throw new Error(`Unexpected historical migration relation: ${relation}`)
    return `pg_temp.${relation}`
  })
  if (/\bpublic\./.test(scoped)) throw new Error('Historical migration escaped its fixture relations')
  return scoped
}
beforeEach(async () => {
  client = await getClient()
  await client.query('BEGIN')
  await client.query(`
    SET LOCAL search_path = pg_temp, pg_catalog;
    CREATE TEMP TABLE companies (id uuid PRIMARY KEY) ON COMMIT DROP;
    CREATE TEMP TABLE cash_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES pg_temp.companies(id),
      ledger_account text NOT NULL, currency text NOT NULL DEFAULT 'SEK', name text,
      enabled boolean NOT NULL DEFAULT true, is_primary boolean NOT NULL DEFAULT false,
      source text DEFAULT 'manual', iban text, external_uid text,
      UNIQUE(company_id,ledger_account)
    ) ON COMMIT DROP;
    CREATE TEMP TABLE transactions (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES pg_temp.companies(id), user_id uuid NOT NULL,
      currency text NOT NULL DEFAULT 'SEK', external_id text, journal_entry_id uuid,
      cash_account_id uuid REFERENCES pg_temp.cash_accounts(id) ON DELETE SET NULL
    ) ON COMMIT DROP;
    CREATE TEMP TABLE journal_entry_lines (journal_entry_id uuid NOT NULL, account_number text NOT NULL) ON COMMIT DROP;
  `)
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })
async function seedCompany() {
  const fixture = { userId: randomUUID(), companyId: randomUUID(), fiscalPeriodId: randomUUID() }
  await client.query('INSERT INTO pg_temp.companies(id) VALUES($1)', [fixture.companyId])
  return fixture
}
async function insertCashAccount(params: {companyId:string;ledgerAccount:string;currency?:string;iban?:string;externalUid?:string}) {
  const id = randomUUID()
  await client.query(`INSERT INTO pg_temp.cash_accounts(id,company_id,ledger_account,currency,iban,external_uid)
    VALUES($1,$2,$3,$4,$5,$6)`,[id,params.companyId,params.ledgerAccount,params.currency??'SEK',params.iban??null,params.externalUid??null])
  return id
}
async function insertTransaction(params: {companyId:string;userId:string;currency?:string;externalId?:string;journalEntryId?:string;cashAccountId?:string}) {
  const id = randomUUID()
  await client.query(`INSERT INTO pg_temp.transactions(id,company_id,user_id,currency,external_id,journal_entry_id,cash_account_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,params.companyId,params.userId,params.currency??'SEK',params.externalId??null,params.journalEntryId??null,params.cashAccountId??null])
  return id
}
async function insertEntryWithBankLines(params: {userId:string;companyId:string;fiscalPeriodId:string;bankAccounts:string[]}) {
  const id = randomUUID()
  for (const account of params.bankAccounts) {
    await client.query('INSERT INTO pg_temp.journal_entry_lines(journal_entry_id,account_number) VALUES($1,$2)',[id,account])
  }
  return id
}
async function getCashAccountId(id:string): Promise<string|null> {
  return (await client.query('SELECT cash_account_id FROM pg_temp.transactions WHERE id=$1',[id])).rows[0]?.cash_account_id??null
}
const BACKFILL_SQL = isolateMigration(readFileSync(join(process.cwd(),
  'supabase/migrations/20260606120100_transactions_cash_account_id_backfill.sql'), 'utf8'))
const REPAIR_SQL = isolateMigration(readFileSync(join(process.cwd(),
  'supabase/migrations/20260609120000_transactions_cash_account_id_repair_backfill.sql'), 'utf8'))
async function runBackfill() { await client.query(BACKFILL_SQL) }
async function runRepair() { await client.query(REPAIR_SQL) }

describe('transactions.cash_account_id: backfill pass (a) booked rows', () => {
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

describe('transactions.cash_account_id: backfill pass (b) PSD2 external_id', () => {
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

describe('transactions.cash_account_id: backfill pass (c) single-account-of-currency', () => {
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

describe('transactions.cash_account_id: repair backfill (20260609120000)', () => {
  it('re-seeds a default 1930 SEK cash account for a company that has none', async () => {
    const { companyId } = await seedCompany()
    // Historical company fixture begins without a cash account.

    await runRepair()

    const { rows } = await client.query(
      `SELECT ledger_account, currency, is_primary
         FROM pg_temp.cash_accounts WHERE company_id = $1`,
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

    // The voucher settled on 1930, but the row was wrongly bound to 1931: the
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

  it('is idempotent: a second run changes nothing', async () => {
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

describe('transactions.cash_account_id: cross-company isolation', () => {
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
