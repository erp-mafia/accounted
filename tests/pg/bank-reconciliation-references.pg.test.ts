import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool } from './setup'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string; let keeperId: string; let twinId: string
const iban = 'SE0000000000000000000061'
type Kind = 'sign-off' | 'attachment'
const kinds: Kind[] = ['sign-off', 'attachment']

beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  connectionId = randomUUID(); keeperId = randomUUID(); twinId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,session_id,status,accounts_data)
    VALUES($1,$2,$3,'reconciliation-reference-session','active',$4)`, [connectionId, owner.companyId, owner.userId,
    JSON.stringify([{ uid: 'reconciliation-reference-uid', iban, currency: 'SEK', enabled: true, ledger_account: '1931' }])])
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,iban,source)
    VALUES($1,$2,'1930','SEK',$3,'manual')`, [keeperId, owner.companyId, iban])
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,iban,bank_connection_id,external_uid)
    VALUES($1,$2,'1931','SEK',$3,$4,'reconciliation-reference-uid')`, [twinId, owner.companyId, iban, connectionId])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

async function reference(kind: Kind, key = `bank:${twinId}`, db = client) {
  const id = randomUUID()
  if (kind === 'sign-off') await db.query(`INSERT INTO account_reconciliations(id,company_id,account_key,through_date,signed_by)
    VALUES($1,$2,$3,'2026-06-01',$4)`, [id, owner.companyId, key, owner.userId])
  else await db.query(`INSERT INTO account_reconciliation_attachments(id,company_id,account_key,through_date,uploaded_by,
    file_name,mime_type,size_bytes,storage_bucket,storage_path,sha256)
    VALUES($1::uuid,$2,$3,'2026-06-01',$4,'synthetic.txt','text/plain',0,'pg-reference-fixture',$1::uuid::text,repeat('a',64))`,
  [id, owner.companyId, key, owner.userId])
  return id
}
async function promote(db = client) {
  return db.query('SELECT promote_psd2_cash_account($1,$2)', [owner.companyId, JSON.stringify({
    bank_connection_id: connectionId, external_uid: 'reconciliation-reference-uid', expected_session_id: 'reconciliation-reference-session',
    currency: 'SEK', ledger_account: '1930', iban, reuse_cash_account_id: keeperId,
  })])
}
async function asRole(role: string) {
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [owner.userId, JSON.stringify({ role, sub: owner.userId })])
  await client.query(`SET LOCAL ROLE ${role}`)
}

describe('bank reconciliation text references', () => {
  it.each(kinds)('retains a valid %s as a retirement dependency', async kind => {
    await asRole('authenticated')
    await reference(kind)
    await expect(promote()).rejects.toMatchObject({ code: '23514', message: 'CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES' })
  })

  it.each(kinds)('refuses a %s for an absent cash row', async kind => {
    await expect(reference(kind, `bank:${randomUUID()}`)).rejects.toMatchObject({ code: 'PT409', message: 'CASH_ACCOUNT_REFERENCE_CHANGED' })
  })

  it.each(kinds)('refuses a %s whose cash row belongs to another company', async kind => {
    const foreign = await seedCompany(); const foreignCash = randomUUID()
    await getPool().query("INSERT INTO cash_accounts(id,company_id,ledger_account,currency) VALUES($1,$2,'1930','SEK')", [foreignCash, foreign.companyId])
    await expect(reference(kind, `bank:${foreignCash}`)).rejects.toMatchObject({ code: 'PT409' })
  })

  it.each(kinds)('accepts existing non-bank keys for %s', async kind => {
    await reference(kind, 'skattekonto')
    await reference(kind, 'manual:2440')
  })

  it.each(kinds)('denies a viewer creating a %s', async kind => {
    await client.query("UPDATE company_members SET role='viewer' WHERE company_id=$1", [owner.companyId])
    await asRole('authenticated')
    await expect(reference(kind)).rejects.toMatchObject({ code: '42501' })
  })

  it('validates a changed sign-off key before moving its reference', async () => {
    const id = await reference('sign-off')
    await expect(client.query('UPDATE account_reconciliations SET account_key=$2 WHERE id=$1', [id, `bank:${randomUUID()}`]))
      .rejects.toMatchObject({ code: 'PT409' })
  })

  it.each(kinds)('allows the existing %s reopen/removal stamp without changing its reference', async kind => {
    const id = await reference(kind)
    if (kind === 'sign-off') await client.query(`UPDATE account_reconciliations SET reopened_at=now(),reopened_by=$2,reopen_reason='PG fixture' WHERE id=$1`, [id, owner.userId])
    else await client.query(`UPDATE account_reconciliation_attachments SET removed_at=now(),removed_by=$2,removed_reason='PG fixture' WHERE id=$1`, [id, owner.userId])
    await expect(promote()).rejects.toMatchObject({ code: '23514' })
  })
})

describe('reconciliation reference and retirement concurrency', () => {
  it.each(kinds)('rejects a new %s when retirement wins first', async kind => {
    await client.query('COMMIT')
    const other = await getClient()
    try {
      await client.query('BEGIN'); await promote()
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='3s'")
      await expect(reference(kind, `bank:${twinId}`, other)).rejects.toMatchObject({ code: 'PT409' })
      await other.query('ROLLBACK')
      await client.query('COMMIT')
      await expect(reference(kind, `bank:${twinId}`, other)).rejects.toMatchObject({ code: 'PT409', message: 'CASH_ACCOUNT_REFERENCE_CHANGED' })
    } finally { await client.query('ROLLBACK'); await other.query('ROLLBACK'); other.release(); await client.query('BEGIN') }
  })

  it.each(kinds)('retains the twin when a %s wins first', async kind => {
    await client.query('COMMIT')
    const other = await getClient()
    let pending: ReturnType<typeof promote> | undefined
    try {
      await client.query('BEGIN'); await reference(kind)
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='8s'")
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = promote(other); void pending.catch(() => {})
      let blocked = false
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (await getPool().query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked).toBe(true)
      await client.query('COMMIT')
      await expect(pending).rejects.toMatchObject({ code: '23514', message: 'CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES' })
      expect((await client.query('SELECT id FROM cash_accounts WHERE id=$1', [twinId])).rows).toEqual([{ id: twinId }])
    } finally {
      await client.query('ROLLBACK'); await pending?.catch(() => {}); await other.query('ROLLBACK'); other.release(); await client.query('BEGIN')
    }
  })
})
