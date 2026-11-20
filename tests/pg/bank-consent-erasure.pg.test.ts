import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let connectionId: string

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
  connectionId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,provider,status,session_id,authorization_id,oauth_state,accounts_data)
    VALUES($1,$2,$3,'seb-se','active',$4,'synthetic-authorization','synthetic-state','[]')`,
  [connectionId, owner.companyId, owner.userId, randomUUID()])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

async function afterMembershipRemoval(db = client) {
  await db.query('DELETE FROM company_members WHERE company_id=$1 AND user_id=$2', [owner.companyId, owner.userId])
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [owner.userId, JSON.stringify({ sub: owner.userId, role: 'authenticated' })])
}
async function revoke(db = client) {
  return db.query(`UPDATE bank_connections SET status='revoked',session_id=NULL,authorization_id=NULL,oauth_state=NULL,accounts_data=NULL
    WHERE id=$1`, [connectionId])
}
async function state(db = client) {
  return (await db.query('SELECT status,session_id,authorization_id,oauth_state,accounts_data,bank_name FROM bank_connections WHERE id=$1', [connectionId])).rows[0]
}

describe('bank consent erasure configuration boundary', () => {
  it('allows the privileged erasure context to revoke after removing memberships', async () => {
    await afterMembershipRemoval()
    await revoke()
    expect(await state()).toMatchObject({ status: 'revoked', session_id: null, authorization_id: null, oauth_state: null, accounts_data: null })
  })

  it.each(['anon', 'authenticated', 'service_role'])('keeps the private erasure capability unavailable to %s', async role => {
    const result = await client.query("SELECT has_function_privilege($1,'public.erase_user_personal_data(uuid)','EXECUTE') AS allowed", [role])
    expect(result.rows[0].allowed).toBe(false)
  })

  it('does not grant a former member direct access to the privileged revoke path', async () => {
    await afterMembershipRemoval()
    await client.query('SET LOCAL ROLE authenticated')
    expect((await revoke()).rowCount).toBe(0)
    await client.query('RESET ROLE')
    expect((await state()).status).toBe('active')
  })

  it('rejects the revoke path without erasure privilege even when the role bypasses RLS', async () => {
    await afterMembershipRemoval()
    const before = await state()
    await client.query('SAVEPOINT unauthorized_revoke')
    await client.query('SET LOCAL ROLE service_role')
    await expect(revoke()).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT unauthorized_revoke')
    expect(await state()).toEqual(before)
  })

  it.each(["bank_name='changed'", "last_synced_at=now()", "provider='changed'"])('does not permit unrelated changes during erasure: %s', async extra => {
    await afterMembershipRemoval()
    await expect(client.query(`UPDATE bank_connections SET status='revoked',session_id=NULL,authorization_id=NULL,
      oauth_state=NULL,accounts_data=NULL,${extra} WHERE id=$1`, [connectionId])).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses a repair-first conflict and rolls back membership removal', async () => {
    await client.query('COMMIT')
    await client.query('BEGIN')
    const other = await getClient()
    try {
      await client.query('SELECT lock_cash_account_company($1)', [owner.companyId])
      await other.query('BEGIN')
      await afterMembershipRemoval(other)
      await expect(revoke(other)).rejects.toMatchObject({ code: 'PT409' })
      await other.query('ROLLBACK')
      expect((await state()).status).toBe('active')
      expect((await client.query('SELECT count(*)::int n FROM company_members WHERE company_id=$1 AND user_id=$2', [owner.companyId, owner.userId])).rows[0].n).toBe(1)
    } finally {
      await other.query('ROLLBACK')
      other.release()
    }
  })

  it('holds the company boundary until an erasure-first revoke commits', async () => {
    await client.query('COMMIT')
    await client.query('BEGIN')
    const other = await getClient()
    let pending: Promise<unknown> | undefined
    try {
      await afterMembershipRemoval()
      await revoke()
      await other.query('BEGIN')
      const pid = (await other.query('SELECT pg_backend_pid() pid')).rows[0].pid
      pending = other.query('SELECT lock_cash_account_company($1)', [owner.companyId])
      void pending.catch(() => {})
      let blocked = false
      for (let n = 0; n < 300; n++) {
        blocked = (await getPool().query('SELECT cardinality(pg_blocking_pids($1)) > 0 blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await client.query('COMMIT')
      await pending
      expect((await state(other)).status).toBe('revoked')
    } finally {
      await client.query('ROLLBACK')
      await pending?.catch(() => {})
      await other.query('ROLLBACK')
      other.release()
    }
  })
})
