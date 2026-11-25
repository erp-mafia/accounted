import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool } from './setup'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let sourceId: string
let targetId: string
let thirdId: string
let session: string
const iban = 'SE0000000000000000000091'
const account = { uid: 'free', currency: 'SEK', iban, enabled: false, ledger_account: '1935',
  dedup_scope: 'source-scope', claimed_by_company_id: 'old-claim', claimed_by_company_name: 'Old', deselected_elsewhere: true }
beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  sourceId = randomUUID(); targetId = randomUUID(); thirdId = randomUUID(); session = randomUUID()
  await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES
    ($1,'PG attachment target','aktiebolag',$3),($2,'PG attachment third','aktiebolag',$3)`, [targetId, thirdId, owner.userId])
  await client.query("INSERT INTO company_members(company_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [targetId, thirdId, owner.userId])
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,provider,bank_name,status,session_id,consent_expires,psu_type,accounts_data)
    VALUES($1,$2,$3,'seb-se','Attachment bank','active',$4,clock_timestamp()+interval '1 year','business',$5)`,
  [sourceId, owner.companyId, owner.userId, session, JSON.stringify([account])])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })
async function attach(db = client, target = targetId, actor = owner.userId, source = sourceId) {
  return (await db.query('SELECT attach_shared_bank_session($1,$2,$3) AS result', [target, actor, source])).rows[0].result
}
async function sourceAccounts(accounts: unknown[]) {
  await client.query('UPDATE bank_connections SET accounts_data=$2 WHERE id=$1', [sourceId, JSON.stringify(accounts)])
}
async function claimCash(company = owner.companyId, enabled = true, cashIban = iban) {
  await client.query("INSERT INTO cash_accounts(company_id,ledger_account,currency,iban,enabled) VALUES($1,'1930','SEK',$2,$3)", [company, cashIban, enabled])
}
async function carrier(status = 'pending_selection', enabled = true) {
  await client.query(`INSERT INTO bank_connections(company_id,user_id,provider,bank_name,status,session_id,consent_expires,accounts_data)
    VALUES($1,$2,'lunar-se','Other bank',$3,$4,clock_timestamp()+interval '1 year',$5)`,
  [thirdId, owner.userId, status, randomUUID(), JSON.stringify([{ ...account, enabled }])])
}
async function role(name: 'service_role' | 'authenticated' | 'anon') {
  const sub = name === 'service_role' ? '' : owner.userId
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [sub, JSON.stringify({ role: name, ...(sub ? { sub } : {}) })])
  await client.query(`SET LOCAL ROLE ${name}`)
}
async function rows(company = targetId) {
  return (await client.query('SELECT * FROM bank_connections WHERE company_id=$1 ORDER BY id', [company])).rows
}

describe('checked shared-session insertion', () => {
  it('uses current consent and unclaimed metadata while leaving mirrors to the picker', async () => {
    await role('service_role'); const receipt = await attach()
    expect(receipt).toMatchObject({ connection_id: expect.any(String), account_count: 1, bank_name: 'Attachment bank', consent_expires: expect.any(String) })
    expect(receipt).not.toHaveProperty('session_id')
    expect((await rows())[0]).toMatchObject({ id: receipt.connection_id, company_id: targetId, user_id: owner.userId,
      session_id: session, provider: 'seb-se', psu_type: 'business', status: 'pending_selection', accounts_data: [
        { uid: 'free', currency: 'SEK', iban, enabled: true, dedup_scope: 'source-scope' },
      ] })
    expect((await client.query('SELECT count(*)::int AS n FROM cash_accounts WHERE company_id=$1', [targetId])).rows[0].n).toBe(0)
    expect((await rows(owner.companyId))[0].accounts_data).toEqual([account])
  })
  it('deduplicates normalized IBANs and excludes accounts without IBANs', async () => {
    await sourceAccounts([account, { ...account, uid: 'duplicate', iban: iban.toLowerCase().replace('se','se ') },
      { ...account, uid: 'no-iban', iban: null }])
    expect((await attach()).account_count).toBe(1)
  })
  it('keeps the conservative one-resource-per-IBAN rule across currency pockets', async () => {
    await sourceAccounts([account, { ...account, uid: 'eur', currency: 'EUR' }])
    expect((await attach()).account_count).toBe(1)
  })
  it.each(['source','third'])('refuses an IBAN currently claimed by enabled cash in %s', async where => {
    await claimCash(where === 'source' ? owner.companyId : thirdId)
    await expect(attach()).rejects.toMatchObject({ code: 'P0002' })
  })
  // One-session bank: the source's new login ended the target's own session,
  // and the source's session now lists the target's account. The target's own
  // cash account is a claim only while a connection may still feed it.
  async function targetCash(status: string | null) {
    let connectionId: string | null = null
    if (status) {
      connectionId = randomUUID()
      await client.query(`INSERT INTO bank_connections(id,company_id,user_id,provider,bank_name,status,session_id,consent_expires,accounts_data)
        VALUES($1,$2,$3,'other-se','Target bank',$4,$5,clock_timestamp()+interval '1 year',$6)`,
      [connectionId, targetId, owner.userId, status, randomUUID(), JSON.stringify([{ uid: 'old-uid', currency: 'SEK', iban, enabled: true, ledger_account: '1930' }])])
    }
    const { rows: [row] } = await client.query(`INSERT INTO cash_accounts(company_id,ledger_account,currency,iban,enabled,bank_connection_id,external_uid)
      VALUES($1,'1930','SEK',$2,true,$3,$4) RETURNING id`, [targetId, iban, connectionId, connectionId ? 'old-uid' : null])
    return row.id as string
  }
  it.each(['expired','revoked',null])('offers the target its own account when the connection holding it is %s', async status => {
    await targetCash(status)
    const receipt = await attach()
    expect(receipt.account_count).toBe(1)
    expect((await rows()).find(r => r.id === receipt.connection_id).accounts_data).toEqual([
      { uid: 'free', currency: 'SEK', iban, enabled: true, dedup_scope: 'source-scope' },
    ])
  })
  it.each(['active','pending_selection','error','pending'])('refuses the target its own account while a %s connection may feed it', async status => {
    await targetCash(status)
    await expect(attach()).rejects.toMatchObject({ code: 'P0002' })
  })
  it("refuses a third company the target's account while the target's row is enabled", async () => {
    await targetCash('expired')
    await expect(attach(client, thirdId)).rejects.toMatchObject({ code: 'P0002' })
  })
  it('lets the picker save move the existing row onto the shared session', async () => {
    const cashId = await targetCash('expired')
    await client.query(`INSERT INTO chart_of_accounts(company_id,user_id,account_number,account_name,account_class,account_group,account_type,normal_balance)
      VALUES($1,$2,'1930','Företagskonto',1,'19','asset','debit') ON CONFLICT (company_id,account_number) DO NOTHING`, [targetId, owner.userId])
    const { connection_id: attached } = await attach()
    const { rows: [{ token }] } = await client.query('SELECT bank_configuration_token($1) AS token', [targetId])
    await client.query('SELECT save_bank_account_selection($1,$2,$3,$4,$5)', [targetId, owner.userId, attached, token,
      JSON.stringify([{ uid: 'free', enabled: true, currency: 'SEK', ledger_account: '1930', reuse_cash_account_id: cashId }])])
    const cash = (await client.query('SELECT id,bank_connection_id,external_uid,enabled FROM cash_accounts WHERE company_id=$1', [targetId])).rows
    expect(cash).toEqual([{ id: cashId, bank_connection_id: attached, external_uid: 'free', enabled: true }])
    expect((await rows()).find(r => r.id === attached)).toMatchObject({ status: 'active', session_id: session })
  })
  it('offers only remaining unclaimed accounts, not the stale full source array', async () => {
    await sourceAccounts([account, { ...account, uid: 'available', iban: 'SE0092' }]); await claimCash(thirdId)
    expect((await attach()).account_count).toBe(1)
    expect((await rows())[0].accounts_data[0].uid).toBe('available')
  })
  it('offers disabled cash accounts and disabled carriers', async () => {
    await claimCash(owner.companyId,false); await carrier('active',false)
    expect((await attach()).account_count).toBe(1)
  })
  it.each(['active','pending_selection'])('refuses an IBAN carried by another %s connection before any cash mirror exists', async status => {
    await carrier(status); await expect(attach()).rejects.toMatchObject({ code: 'P0002' })
  })
  it.each(['expired','error','revoked'])('preserves the existing offer rule for a %s carrier', async status => {
    await carrier(status); expect((await attach()).account_count).toBe(1)
  })
  it.each(['active','pending_selection'])('refuses a second %s target connection for the same bank', async status => {
    await client.query("INSERT INTO bank_connections(company_id,user_id,provider,status) VALUES($1,$2,'seb-se',$3)", [targetId,owner.userId,status])
    await expect(attach()).rejects.toMatchObject({ code: 'PT409', message: 'BANK_ATTACH_ALREADY_CONNECTED' })
  })
  it.each(['expired','error','pending_selection','revoked','null-session','expired-consent','archived','not-member'])('refuses a source that is %s', async invalid => {
    if (invalid === 'null-session') await client.query('UPDATE bank_connections SET session_id=null WHERE id=$1', [sourceId])
    else if (invalid === 'expired-consent') await client.query("UPDATE bank_connections SET consent_expires=clock_timestamp()-interval '1 second' WHERE id=$1", [sourceId])
    else if (invalid === 'archived') await client.query('UPDATE companies SET archived_at=now() WHERE id=$1', [owner.companyId])
    else if (invalid === 'not-member') await client.query('DELETE FROM company_members WHERE company_id=$1 AND user_id=$2', [owner.companyId,owner.userId])
    else await client.query('UPDATE bank_connections SET status=$2 WHERE id=$1', [sourceId,invalid])
    await expect(attach()).rejects.toMatchObject({ code: 'P0002' })
  })
  it('refuses its own company as source', async () => {
    await expect(attach(client,owner.companyId)).rejects.toMatchObject({ code: 'P0002' })
  })
  it('does not reuse another user consent even with company membership', async () => {
    const other = await seedCompany()
    await client.query('UPDATE bank_connections SET user_id=$2 WHERE id=$1', [sourceId,other.userId])
    await expect(attach()).rejects.toMatchObject({ code: 'P0002' })
  })
  it.each(['viewer','not-member','archived'])('denies a target where the actor is %s', async invalid => {
    if (invalid === 'viewer') await client.query("UPDATE company_members SET role='viewer' WHERE company_id=$1", [targetId])
    if (invalid === 'not-member') await client.query('DELETE FROM company_members WHERE company_id=$1', [targetId])
    if (invalid === 'archived') await client.query('UPDATE companies SET archived_at=now() WHERE id=$1', [targetId])
    await expect(attach()).rejects.toMatchObject({ code: '42501' })
  })
  it.each(['anon','authenticated'] as const)('keeps the mutation service-only for %s', async name => {
    await role(name); await expect(attach()).rejects.toMatchObject({ code: '42501' })
  })
  it('retains source read access for an actor who became a viewer there', async () => {
    await client.query("UPDATE company_members SET role='viewer' WHERE company_id=$1", [owner.companyId])
    await role('service_role'); expect((await attach()).account_count).toBe(1)
  })
  it('checks cash claims beyond a PostgREST page', async () => {
    const ibans = Array.from({ length: 1001 }, (_v,i) => `SE${String(i).padStart(22,'0')}`)
    await sourceAccounts(ibans.map((value,i) => ({ ...account, uid: `uid-${i}`, iban: value })))
    await claimCash(thirdId,true,ibans[1000]); expect((await attach()).account_count).toBe(1000)
  })
  it('refuses malformed offered source metadata without an inserted row', async () => {
    await sourceAccounts([{ ...account, currency: 'invalid' }]); await client.query('SAVEPOINT malformed')
    await expect(attach()).rejects.toMatchObject({ code: 'PT409' })
    await client.query('ROLLBACK TO SAVEPOINT malformed'); expect(await rows()).toEqual([])
  })
})

describe('cross-company attachment races', () => {
  async function waitBlocked(pid: number) {
    for (let i=0; i<100; i++) {
      if ((await getPool().query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked) return
      await new Promise(resolve => setTimeout(resolve,20))
    }
    throw new Error('Expected writer to block on company lock')
  }
  async function clean() {
    await client.query('DELETE FROM cash_accounts WHERE company_id=ANY($1)', [[owner.companyId,targetId,thirdId]])
    await client.query('DELETE FROM bank_connections WHERE company_id=ANY($1)', [[owner.companyId,targetId,thirdId]])
    await client.query('BEGIN')
  }
  it('serializes two destination attachments so only the first reserves an IBAN', async () => {
    await client.query('COMMIT'); const other = await getClient(); let pending: ReturnType<typeof attach> | undefined
    try {
      await client.query('BEGIN'); const receipt = await attach()
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='8s'")
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = attach(other,thirdId); void pending.catch(() => {}); await waitBlocked(pid)
      await client.query('COMMIT'); await expect(pending).rejects.toMatchObject({ code: 'P0002' })
      expect((await rows())[0].id).toBe(receipt.connection_id); expect(await rows(thirdId)).toEqual([])
    } finally {
      await client.query('ROLLBACK'); await other.query('ROLLBACK'); await pending?.catch(() => {}); other.release(); await clean()
    }
  })
  it('rechecks a source disconnected while attachment waits', async () => {
    await client.query('COMMIT'); const other = await getClient(); let pending: ReturnType<typeof attach> | undefined
    try {
      await client.query('BEGIN'); await client.query("UPDATE bank_connections SET status='revoked',session_id=null WHERE id=$1", [sourceId])
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='8s'")
      const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = attach(other); void pending.catch(() => {}); await waitBlocked(pid)
      await client.query('COMMIT'); await expect(pending).rejects.toMatchObject({ code: 'P0002' }); expect(await rows()).toEqual([])
    } finally {
      await client.query('ROLLBACK'); await other.query('ROLLBACK'); await pending?.catch(() => {}); other.release(); await clean()
    }
  })
  it('rejects a competing cash claim while attachment holds the visible companies', async () => {
    await client.query('COMMIT'); const other = await getClient()
    try {
      await client.query('BEGIN'); await attach()
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='3s'")
      await expect(other.query("INSERT INTO cash_accounts(company_id,ledger_account,currency,iban) VALUES($1,'1930','SEK',$2)", [thirdId,iban]))
        .rejects.toMatchObject({ code: 'PT409' })
    } finally {
      await other.query('ROLLBACK'); other.release(); await client.query('ROLLBACK'); await clean()
    }
  })
  it('rolls back a late provider-session contention without inserting a pending connection', async () => {
    await client.query('COMMIT'); const other = await getClient()
    try {
      await other.query('BEGIN'); await other.query("SELECT lock_bank_provider_session('enablebanking',$1)", [session])
      await expect(attach()).rejects.toMatchObject({ code: 'PT409' }); expect(await rows()).toEqual([])
    } finally { await other.query('ROLLBACK'); other.release(); await clean() }
  })
})
