// A bank login belongs to whoever started it (bank_connections.oauth_user_id):
// a member who renews a colleague's connection completes it, and the row
// becomes theirs in the statement that stores the new consent, never earlier.
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'
import { getClient } from './setup'

let holder: Awaited<ReturnType<typeof seedCompany>>
let colleague: string
let bystander: string
let client: PoolClient
let connectionId: string
let oauthState: string
let oldSession: string
let newSession: string

const account = { uid: 'starter-main', currency: 'SEK', iban: 'SE0000000000000000000091', enabled: true }
const charts = [{ account_number: '1930', account_name: 'Starter bank', account_class: 1,
  account_group: '19', account_type: 'asset', normal_balance: 'debit' }]

beforeEach(async () => {
  // Every member exists before the transaction opens: the fixtures write on
  // their own connection.
  holder = await seedCompany()
  colleague = await insertAuthUser()
  bystander = await insertAuthUser()
  await insertCompanyMember({ companyId: holder.companyId, userId: colleague, role: 'admin' })
  await insertCompanyMember({ companyId: holder.companyId, userId: bystander, role: 'admin' })
  client = await getClient(); await client.query('BEGIN')
  connectionId = randomUUID(); oauthState = randomUUID(); oldSession = randomUUID(); newSession = randomUUID()
  // The row as an in-place renewal finds it: the holder's expired consent
  // with the account it carried, and a login pending.
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,bank_name,provider,status,session_id,accounts_data,oauth_state)
    VALUES($1,$2,$3,'Starter bank','seb-se','expired',$4,$5,$6)`,
  [connectionId, holder.companyId, holder.userId, oldSession, JSON.stringify([account]), oauthState])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

/** What the connect route records when a member starts the login. */
async function startedBy(userId: string | null) {
  await client.query('UPDATE bank_connections SET oauth_user_id=$2 WHERE id=$1', [connectionId, userId])
}
async function read(actor: string) {
  return (await client.query('SELECT read_bank_callback_configuration($1,$2,$3,$4) AS result',
    [holder.companyId, actor, connectionId, oauthState])).rows[0].result
}
async function token(): Promise<string> {
  return (await client.query('SELECT bank_configuration_token($1) AS token', [holder.companyId])).rows[0].token
}
async function finalize(actor: string, expected: string, reuseCashId: string | null = null) {
  return (await client.query('SELECT finalize_bank_callback($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result', [
    holder.companyId, actor, connectionId, oauthState, expected, newSession, '2027-01-01T00:00:00Z',
    JSON.stringify([account]), JSON.stringify([{ uid: account.uid, ledger_account: '1930', reuse_cash_account_id: reuseCashId }]),
    JSON.stringify(charts), JSON.stringify({}),
  ])).rows[0].result
}
async function row() {
  return (await client.query(`SELECT user_id, oauth_user_id, oauth_state, status, session_id
    FROM bank_connections WHERE id=$1`, [connectionId])).rows[0]
}
async function cash(conn: string) {
  const id = randomUUID()
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,bank_connection_id,external_uid,iban,is_primary)
    VALUES($1,$2,'1930','SEK',$3,$4,$5,true)`, [id, holder.companyId, conn, account.uid, account.iban])
  return id
}
async function asServiceRole() {
  await client.query("SELECT set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims',$1,true)",
    [JSON.stringify({ role: 'service_role' })])
  await client.query('SET LOCAL ROLE service_role')
}
type Refusal = { code: string; message: string }
/** The changed-attempt refusal: the actor check shares its code with others, so the message pins it. */
const CHANGED: Refusal = { code: 'PT409', message: 'BANK_CALLBACK_CHANGED' }
const ACTOR_DENIED: Refusal = { code: '42501', message: 'BANK_CALLBACK_ACTOR_DENIED' }

/** Both functions refuse the actor, and the row is as it was. */
async function expectRefused(actor: string, refusals: { read: Refusal; finalize: Refusal }) {
  const expected = await token(); const before = await row()
  await client.query('SAVEPOINT refusal')
  await expect(read(actor)).rejects.toMatchObject(refusals.read)
  await client.query('ROLLBACK TO SAVEPOINT refusal')
  await expect(finalize(actor, expected)).rejects.toMatchObject(refusals.finalize)
  await client.query('ROLLBACK TO SAVEPOINT refusal')
  expect(await row()).toEqual(before)
}

describe('a bank login belongs to whoever started it', () => {
  it('lets a colleague complete the renewal they started, and the connection becomes theirs with the new consent', async () => {
    const cashId = await cash(connectionId)
    await startedBy(colleague)
    await asServiceRole()
    const receipt = await finalize(colleague, (await read(colleague)).token, cashId)
    expect(receipt).toMatchObject({
      connection: { id: connectionId, company_id: holder.companyId, user_id: colleague },
      old_session_id: oldSession, superseded: [],
    })
    expect(await row()).toEqual({
      user_id: colleague, oauth_user_id: null, oauth_state: null, status: 'pending_selection', session_id: newSession,
    })
    // The same row, so its account keeps its cash row and with it its history.
    expect((await client.query('SELECT bank_connection_id, external_uid FROM cash_accounts WHERE id=$1', [cashId])).rows[0])
      .toEqual({ bank_connection_id: connectionId, external_uid: account.uid })
  })

  it('refuses a member who neither started the login nor holds the connection', async () => {
    await startedBy(colleague)
    await expectRefused(bystander, { read: CHANGED, finalize: CHANGED })
  })

  it('refuses a colleague on a login nobody is recorded as starting', async () => {
    await expectRefused(colleague, { read: CHANGED, finalize: CHANGED })
  })

  it.each(['viewer', 'removed'])('refuses a starter who is %s by the time the bank answers', async kind => {
    await startedBy(colleague)
    if (kind === 'viewer') {
      await client.query("UPDATE company_members SET role='viewer' WHERE company_id=$1 AND user_id=$2", [holder.companyId, colleague])
    } else {
      await client.query('DELETE FROM company_members WHERE company_id=$1 AND user_id=$2', [holder.companyId, colleague])
    }
    await expectRefused(colleague, { read: CHANGED, finalize: ACTOR_DENIED })
  })

  it('keeps a login staged without a starter with its holder', async () => {
    const receipt = await finalize(holder.userId, (await read(holder.userId)).token)
    expect(receipt.connection.user_id).toBe(holder.userId)
    expect(await row()).toEqual({
      user_id: holder.userId, oauth_user_id: null, oauth_state: null, status: 'pending_selection', session_id: newSession,
    })
  })

  // An app version that binds the browser to the holder (one that does not
  // read the column) must not be locked out by a starter an abandoned login
  // left behind.
  it('lets the holder complete a login another member is recorded as starting, and it stays the holder\'s', async () => {
    await startedBy(colleague)
    const receipt = await finalize(holder.userId, (await read(holder.userId)).token)
    expect(receipt.connection.user_id).toBe(holder.userId)
    expect(await row()).toMatchObject({ user_id: holder.userId, oauth_user_id: null, session_id: newSession })
  })

  it('leaves the connection with its holder when the login fails after the row was written', async () => {
    // A cash row a live connection still holds cannot be taken over: the
    // refusal comes after the UPDATE that stores the consent.
    const other = randomUUID()
    await client.query(`INSERT INTO bank_connections(id,company_id,user_id,provider,bank_name,status,session_id,accounts_data)
      VALUES($1,$2,$3,'lunar-se','Other bank','active',$4,$5)`,
    [other, holder.companyId, holder.userId, randomUUID(), JSON.stringify([account])])
    const claimed = await cash(other)
    await startedBy(colleague)
    const expected = (await read(colleague)).token; const before = await row()
    await client.query('SAVEPOINT refusal')
    await expect(finalize(colleague, expected, claimed)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_CALLBACK_MIRROR_CLAIMED' })
    await client.query('ROLLBACK TO SAVEPOINT refusal')
    expect(await row()).toEqual(before)
    expect(before).toMatchObject({ user_id: holder.userId, oauth_user_id: colleague, session_id: oldSession })
  })
})
