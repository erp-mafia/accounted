// finalize_bank_callback on a renewal: a cash row of an account the new
// consent no longer lists is released as disconnect_bank_connection releases
// one, and nothing else moves (crm#1711).
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient } from './setup'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string
let oauthState: string
let newSession: string

const kept = { uid: 'renewal-kept', currency: 'SEK', iban: 'SE0000000000000000000081', enabled: true }
const dropped = { uid: 'renewal-dropped', currency: 'SEK', iban: 'SE0000000000000000000082', enabled: true }
const chart = (ledger: string) => ({ account_number: ledger, account_name: 'Renewal bank', account_class: 1,
  account_group: '19', account_type: 'asset', normal_balance: 'debit' })

type CashRow = Record<string, unknown> & { id: string; bank_connection_id: string | null; external_uid: string | null }

beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  connectionId = randomUUID(); oauthState = randomUUID(); newSession = randomUUID()
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,bank_name,provider,status,oauth_state)
    VALUES($1,$2,$3,'Renewal bank','seb-se','pending',$4)`, [connectionId, owner.companyId, owner.userId, oauthState])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

async function token(): Promise<string> {
  return (await client.query('SELECT read_bank_callback_configuration($1,$2,$3,$4) AS result',
    [owner.companyId, owner.userId, connectionId, oauthState])).rows[0].result.token
}
async function finalize(accounts: unknown[], mirrors: unknown[], charts: unknown[]) {
  return (await client.query('SELECT finalize_bank_callback($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result', [
    owner.companyId, owner.userId, connectionId, oauthState, await token(), newSession, '2027-01-01T00:00:00Z',
    JSON.stringify(accounts), JSON.stringify(mirrors), JSON.stringify(charts), JSON.stringify({}),
  ])).rows[0].result
}
/** The row as an in-place renewal finds it: expired, the old session, the accounts it carried. */
async function renewal(prior: unknown[]) {
  await client.query("UPDATE bank_connections SET status='expired',session_id=$2,accounts_data=$3 WHERE id=$1",
    [connectionId, randomUUID(), JSON.stringify(prior)])
}
async function cash(ledger: string, uid: string | null, iban: string, conn: string | null, extra: { primary?: boolean; source?: string } = {}) {
  const id = randomUUID()
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,bank_connection_id,external_uid,iban,
      is_primary,source,name,balance,available_balance,balance_updated_at)
    VALUES($1,$2,$3,'SEK',$4,$5,$6,$7,$8,'Renewal account',35000.5,35000.5,'2026-10-26T09:01:00Z')`,
  [id, owner.companyId, ledger, conn, uid, iban, extra.primary ?? false, extra.source ?? 'enable_banking'])
  return id
}
async function cashRows(): Promise<CashRow[]> {
  return (await client.query('SELECT to_jsonb(c) AS row FROM cash_accounts c WHERE company_id=$1 ORDER BY id',
    [owner.companyId])).rows.map(r => r.row)
}
const byId = (rows: CashRow[], id: string) => rows.find(r => r.id === id) as CashRow
const withoutBinding = ({ bank_connection_id: _c, external_uid: _u, updated_at: _t, ...rest }: CashRow) => rest
const withoutStamp = ({ updated_at: _t, ...rest }: CashRow) => rest

describe('finalize_bank_callback releases what a renewed consent no longer lists', () => {
  it('keeps every row bound when the renewed consent lists all accounts', async () => {
    await renewal([kept, dropped])
    const a = await cash('1930', kept.uid, kept.iban, connectionId, { primary: true })
    const b = await cash('1932', dropped.uid, dropped.iban, connectionId)
    const before = await cashRows()
    const receipt = await finalize([kept, dropped],
      [{ uid: kept.uid, ledger_account: '1930', reuse_cash_account_id: a }, { uid: dropped.uid, ledger_account: '1932', reuse_cash_account_id: b }],
      [chart('1930'), chart('1932')])
    expect(receipt.accounts.map((x: { uid: string }) => x.uid)).toEqual([kept.uid, dropped.uid])
    const after = await cashRows()
    for (const id of [a, b]) {
      expect(byId(after, id)).toMatchObject({ bank_connection_id: connectionId, external_uid: byId(before, id).external_uid })
    }
  })

  it('keeps a row bound when the bank re-issues its uid for the same account', async () => {
    await renewal([kept])
    const a = await cash('1930', kept.uid, kept.iban, connectionId)
    const reissued = { ...kept, uid: 'renewal-kept-new-uid' }
    await finalize([reissued], [{ uid: reissued.uid, ledger_account: '1930', reuse_cash_account_id: a }], [chart('1930')])
    expect(byId(await cashRows(), a)).toMatchObject({ bank_connection_id: connectionId, external_uid: reissued.uid })
  })

  it('releases only the dropped account, keeping its row, balance, transactions and posted entries', async () => {
    await renewal([kept, dropped])
    const a = await cash('1930', kept.uid, kept.iban, connectionId, { primary: true })
    const b = await cash('1932', dropped.uid, dropped.iban, connectionId)
    const entryId = randomUUID(); const transactionId = randomUUID()
    await client.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,entry_date,description,status,source_type,voucher_number)
      VALUES($1,$2,$3,$4,'2026-06-01','PG renewal voucher','draft','manual',0)`, [entryId, owner.companyId, owner.userId, owner.fiscalPeriodId])
    await client.query(`INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount)
      VALUES($1,'1932',0,100),($1,'2999',100,0)`, [entryId])
    await client.query('SELECT commit_journal_entry($1,$2)', [owner.companyId, entryId])
    await client.query(`INSERT INTO transactions(id,company_id,user_id,currency,date,amount,description,cash_account_id,bank_connection_id,journal_entry_id)
      VALUES($1,$2,$3,'SEK','2026-06-01',-100,'PG renewal booked row',$4,$5,$6)`, [transactionId, owner.companyId, owner.userId, b, connectionId, entryId])
    const ledger = async () => (await client.query(`SELECT jsonb_build_object(
      'entry',(SELECT to_jsonb(j) FROM journal_entries j WHERE id=$1),
      'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM journal_entry_lines l WHERE journal_entry_id=$1),
      'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM transactions t WHERE company_id=$2)) AS ledger`,
    [entryId, owner.companyId])).rows[0].ledger
    const before = await cashRows(); const ledgerBefore = await ledger()

    const receipt = await finalize([kept], [{ uid: kept.uid, ledger_account: '1930', reuse_cash_account_id: a }], [chart('1930')])

    expect(receipt.accounts.map((x: { uid: string }) => x.uid)).toEqual([kept.uid])
    const after = await cashRows()
    expect(byId(after, a)).toMatchObject({ bank_connection_id: connectionId, external_uid: kept.uid, is_primary: true })
    expect(byId(after, b)).toMatchObject({ bank_connection_id: null, external_uid: null })
    // Only the binding goes: ledger, primary flag, enabled flag, source, IBAN and the last observations stay.
    expect(withoutBinding(byId(after, b))).toEqual(withoutBinding(byId(before, b)))
    expect(await ledger()).toEqual(ledgerBefore)
    expect((await ledger()).transactions[0]).toMatchObject({ id: transactionId, cash_account_id: b, bank_connection_id: connectionId, journal_entry_id: entryId })
  })

  it('leaves a first connect as it was: new rows bound, a manual row untouched', async () => {
    const manual = await cash('1940', null, 'SE0000000000000000000089', null, { source: 'manual' })
    const before = await cashRows()
    await finalize([kept, dropped],
      [{ uid: kept.uid, ledger_account: '1930', reuse_cash_account_id: null }, { uid: dropped.uid, ledger_account: '1932', reuse_cash_account_id: null }],
      [chart('1930'), chart('1932')])
    const after = await cashRows()
    expect(after.filter(r => r.bank_connection_id === connectionId).map(r => r.external_uid).sort()).toEqual([kept.uid, dropped.uid].sort())
    expect(withoutStamp(byId(after, manual))).toEqual(withoutStamp(byId(before, manual)))
  })

  it('never touches rows of another connection, even under the dropped uid', async () => {
    const other = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,bank_name,provider,status,session_id,accounts_data)
      VALUES($1,$2,$3,'Other bank','lunar-se','active',$4,$5)`, [other, owner.companyId, owner.userId, randomUUID(),
      JSON.stringify([{ uid: dropped.uid, currency: 'SEK', iban: 'SE0000000000000000000083', enabled: true },
        { uid: 'other-only', currency: 'SEK', iban: 'SE0000000000000000000084', enabled: true }])])
    const sameUid = await cash('1933', dropped.uid, 'SE0000000000000000000083', other)
    const otherOnly = await cash('1934', 'other-only', 'SE0000000000000000000084', other)
    await renewal([kept, dropped])
    const a = await cash('1930', kept.uid, kept.iban, connectionId, { primary: true })
    const b = await cash('1932', dropped.uid, dropped.iban, connectionId)
    const before = await cashRows()

    await finalize([kept], [{ uid: kept.uid, ledger_account: '1930', reuse_cash_account_id: a }], [chart('1930')])

    const after = await cashRows()
    expect(byId(after, b)).toMatchObject({ bank_connection_id: null, external_uid: null })
    for (const id of [sameUid, otherOnly]) expect(withoutStamp(byId(after, id))).toEqual(withoutStamp(byId(before, id)))
    expect(byId(after, sameUid)).toMatchObject({ bank_connection_id: other, external_uid: dropped.uid })
  })
})
