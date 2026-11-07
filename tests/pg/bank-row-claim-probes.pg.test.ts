import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient } from './setup'
import { seedCompany } from './fixtures'

// posted_entries_naming_bank_row answers "which posted verifikat name this
// bank row" (source_id or bank booking context) on the two indexes instead of
// a scan of every verifikat of the company (crm#1683, crm#1702). The rows it
// returns, and so what cash_transaction_is_movable and
// guard_cash_transaction_binding refuse, stay the same.

let owner: Awaited<ReturnType<typeof seedCompany>>
let other: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let keeperId: string; let twinId: string; let connectionId: string
const iban = 'SE0000000000000000000017'
const uid = 'pg-claim-probe-uid'

async function bankRow(amount = -25) {
  const id = randomUUID()
  await client.query(`INSERT INTO transactions(id,company_id,user_id,date,amount,currency,description,cash_account_id)
    VALUES ($1,$2,$3,'2026-06-01',$4,'SEK','PG claim probe',$5)`, [id, owner.companyId, owner.userId, amount, twinId])
  return id
}
async function postedEntry(opts: { context?: unknown[]; sourceType?: string; sourceId?: string | null; status?: 'posted' | 'draft' } = {}) {
  const id = randomUUID()
  await client.query(`INSERT INTO journal_entries(id, company_id, user_id, fiscal_period_id, voucher_number,
    entry_date, description, source_type, source_id, status, bank_booking_context)
    VALUES ($1,$2,$3,$4,0,'2026-06-01','PG claim probe',$5,$6,'draft',$7)`,
  [id, owner.companyId, owner.userId, owner.fiscalPeriodId, opts.sourceType ?? 'manual', opts.sourceId ?? null,
    JSON.stringify(opts.context ?? [])])
  await client.query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
    VALUES ($1,'1931',0,25),($1,'2999',25,0)`, [id])
  if ((opts.status ?? 'posted') === 'posted') await client.query('SELECT * FROM commit_journal_entry($1,$2)', [owner.companyId, id])
  return id
}
function contextFor(txId: string) {
  return [{ transaction_id: txId, cash_account_id: twinId, settlement_account: '1931', date: '2026-06-01', amount: -25, currency: 'SEK' }]
}
async function naming(companyId: string, txId: string): Promise<string[]> {
  // DISTINCT: a bank_transaction verifikat names its row by source and by context.
  const { rows } = await client.query('SELECT DISTINCT e FROM posted_entries_naming_bank_row($1,$2) e', [companyId, txId])
  return rows.map((r) => r.e as string).sort()
}
async function movable(txId: string): Promise<boolean> {
  return (await client.query('SELECT cash_transaction_is_movable($1,$2) AS ok', [owner.companyId, txId])).rows[0].ok
}

beforeEach(async () => {
  owner = await seedCompany(); other = await seedCompany()
  client = await getClient(); await client.query('BEGIN')
  keeperId = randomUUID(); twinId = randomUUID(); connectionId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,accounts_data)
    VALUES ($1,$2,$3,'pg-claim-probe-session','active',$4)`, [connectionId, owner.companyId, owner.userId,
    JSON.stringify([{ uid, currency: 'SEK', iban, enabled: true, ledger_account: '1931' }])])
  // The history row (a manual import on 1930) and the connected account's own row on 1931.
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,source)
    VALUES ($1,$2,'1930','SEK','manual')`, [keeperId, owner.companyId])
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,iban,bank_connection_id,external_uid)
    VALUES ($1,$2,'1931','SEK',$3,$4,$5)`, [twinId, owner.companyId, iban, connectionId, uid])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

describe('posted_entries_naming_bank_row', () => {
  it('names a posted verifikat by its bank booking context and by its source', async () => {
    const tx = await bankRow()
    const byContext = await postedEntry({ context: contextFor(tx) })
    expect(await naming(owner.companyId, tx)).toEqual([byContext])

    const tx2 = await bankRow()
    const bySource = await postedEntry({ sourceType: 'bank_transaction', sourceId: tx2, context: contextFor(tx2) })
    expect(await naming(owner.companyId, tx2)).toEqual([bySource])
  })

  it('names nothing for a draft, an unrelated row or another company', async () => {
    const tx = await bankRow()
    await postedEntry({ context: contextFor(tx), status: 'draft' })
    expect(await naming(owner.companyId, tx)).toEqual([])

    const named = await bankRow()
    await postedEntry({ context: contextFor(named) })
    expect(await naming(owner.companyId, tx)).toEqual([])
    expect(await naming(other.companyId, named)).toEqual([])
  })
})

describe('the movers keep their refusals', () => {
  it('a row named by a posted context is not movable and its binding cannot move', async () => {
    const tx = await bankRow()
    expect(await movable(tx)).toBe(true)
    await postedEntry({ context: contextFor(tx) })
    expect(await movable(tx)).toBe(false)
    await expect(client.query('UPDATE transactions SET cash_account_id=$2 WHERE id=$1', [tx, keeperId]))
      .rejects.toMatchObject({ code: 'PT409', message: 'BANK_ANCHOR_BINDING_IN_USE' })
  })

  it('moving the account onto the history ledger moves the open rows and leaves the named one', async () => {
    const open = await Promise.all(Array.from({ length: 25 }, () => bankRow()))
    const named = await bankRow()
    await postedEntry({ context: contextFor(named) })

    const { rows } = await client.query('SELECT promote_psd2_cash_account($1,$2) AS result', [owner.companyId, JSON.stringify({
      bank_connection_id: connectionId, external_uid: uid, currency: 'SEK', ledger_account: '1930', iban,
      expected_session_id: 'pg-claim-probe-session', user_chosen_ledger: true,
    })])
    expect(rows[0].result.moved).toBe(open.length)
    const bound = await client.query('SELECT id, cash_account_id FROM transactions WHERE company_id=$1', [owner.companyId])
    const where = new Map(bound.rows.map((r) => [r.id as string, r.cash_account_id as string]))
    for (const id of open) expect(where.get(id)).toBe(keeperId)
    expect(where.get(named)).toBe(twinId)
  })
})

describe('the context index', () => {
  it('keeps no pending list, so a lookup reads the index proper', async () => {
    const { rows } = await client.query(`SELECT reloptions FROM pg_class WHERE oid = 'public.journal_entries_posted_bank_context_idx'::regclass`)
    expect(rows[0].reloptions).toContain('fastupdate=off')
  })
})
