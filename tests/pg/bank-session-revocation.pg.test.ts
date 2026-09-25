import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient } from './setup'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let sessionId: string
const provider = 'enablebanking'

beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN'); sessionId = randomUUID()
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })
async function connection(status = 'active', db = client, company = owner, bankProvider = 'seb-se') {
  return (await db.query(`INSERT INTO bank_connections(company_id,user_id,provider,session_id,status)
    VALUES($1,$2,$3,$4,$5) RETURNING id`, [company.companyId, company.userId, bankProvider, sessionId, status])).rows[0].id
}
async function claim(db = client) {
  return (await db.query('SELECT claim_bank_session_revocation($1,$2) AS result', [provider, sessionId])).rows[0].result
}
async function finish(token: string, success: boolean) {
  return (await client.query('SELECT finish_bank_session_revocation($1,$2,$3,$4) AS applied', [provider, sessionId, token, success])).rows[0].applied
}
async function asRole(role: 'service_role' | 'authenticated' | 'anon') {
  const sub = role === 'service_role' ? '' : owner.userId
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [sub, JSON.stringify({ role, ...(sub ? { sub } : {}) })])
  await client.query(`SET LOCAL ROLE ${role}`)
}

describe('provider session revocation claims', () => {
  it.each(['active', 'pending_selection', 'expired', 'error'])('retains a consent with a %s holder', async status => {
    await connection(status)
    expect(await claim()).toEqual({ claimed: false, reason: 'shared' })
  })

  it('checks a holder in another company even when the original company released it', async () => {
    const otherCompany = await seedCompany()
    await connection('revoked')
    await connection('active', client, otherCompany)
    await asRole('service_role')
    expect(await claim()).toEqual({ claimed: false, reason: 'shared' })
  })

  it('counts every holder even when stored ASPSP names differ across companies', async () => {
    const otherCompany = await seedCompany()
    await connection('revoked', client, owner, 'nordea-se')
    await connection('active', client, otherCompany, 'nordea-corporate-se')
    expect(await claim()).toEqual({ claimed: false, reason: 'shared' })
  })

  it('does not let a changed bank label bypass an existing revocation marker', async () => {
    await claim()
    await expect(connection('active', client, owner, 'lunar-se'))
      .rejects.toMatchObject({ code: 'PT409', message: 'BANK_SESSION_REVOCATION_STARTED' })
  })

  it('refuses an ASPSP label passed as the service namespace', async () => {
    await expect(client.query('SELECT claim_bank_session_revocation($1,$2)', ['seb-se',sessionId]))
      .rejects.toMatchObject({ code: '22023', message: 'BANK_SESSION_PROVIDER_INVALID' })
  })

  it('lets the service role claim an unused consent, finish it and refuse a duplicate', async () => {
    await asRole('service_role')
    const claimed = await claim()
    expect(claimed).toMatchObject({ claimed: true, token: expect.any(String) })
    expect(await claim()).toEqual({ claimed: false, reason: 'in-progress' })
    expect(await finish(claimed.token, true)).toBe(true)
    expect(await claim()).toEqual({ claimed: false, reason: 'already-revoked' })
  })

  it('retains the marker after failure and gives a retry a new completion token', async () => {
    const first = await claim()
    expect(await finish(first.token, false)).toBe(true)
    const retry = await claim()
    expect(retry).toMatchObject({ claimed: true })
    expect(retry.token).not.toBe(first.token)
    expect(await finish(first.token, true)).toBe(false)
    expect(await finish(retry.token, true)).toBe(true)
    expect((await client.query('SELECT attempts FROM bank_session_revocations WHERE provider=$1 AND session_id=$2', [provider, sessionId])).rows[0].attempts).toBe(2)
  })

  it('allows a retry only after a pending lease expires', async () => {
    const first = await claim()
    expect(await claim()).toEqual({ claimed: false, reason: 'in-progress' })
    await client.query("UPDATE bank_session_revocations SET lease_until=clock_timestamp()-interval '1 second' WHERE provider=$1 AND session_id=$2", [provider, sessionId])
    const retry = await claim()
    expect(retry.claimed).toBe(true)
    expect(retry.token).not.toBe(first.token)
  })

  it.each(['pending', 'succeeded', 'failed'])('refuses a new attachment after a %s revocation claim', async outcome => {
    const claimed = await claim()
    if (outcome !== 'pending') await finish(claimed.token, outcome === 'succeeded')
    await expect(connection()).rejects.toMatchObject({ code: 'PT409', message: 'BANK_SESSION_REVOCATION_STARTED' })
  })

  it('refuses revival of a revoked row after the consent was claimed', async () => {
    const id = await connection('revoked')
    await claim()
    await expect(client.query("UPDATE bank_connections SET status='active' WHERE id=$1", [id]))
      .rejects.toMatchObject({ code: 'PT409', message: 'BANK_SESSION_REVOCATION_STARTED' })
  })

  it('allows authenticated normal attachment through the narrow trigger', async () => {
    await asRole('authenticated')
    expect(await connection()).toEqual(expect.any(String))
  })

  it.each(['authenticated', 'anon'] as const)('denies %s access to claims and completion', async role => {
    const claimed = await claim()
    await asRole(role)
    await client.query('SAVEPOINT denied_claim')
    await expect(claim()).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT denied_claim')
    await expect(finish(claimed.token, true)).rejects.toMatchObject({ code: '42501' })
  })

  it('does not let an authenticated caller read the cross-company marker table', async () => {
    await claim(); await asRole('authenticated')
    await expect(client.query('SELECT * FROM bank_session_revocations')).rejects.toMatchObject({ code: '42501' })
  })
})

describe('cross-company attachment and revocation races', () => {
  it.each(['attach-first', 'claim-first'])('serializes %s without holding a transaction across HTTP', async order => {
    const other = await getClient()
    try {
      await other.query('BEGIN'); await other.query("SET LOCAL statement_timeout='3s'")
      if (order === 'attach-first') {
        await connection()
        await expect(claim(other)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_SESSION_BUSY' })
        await other.query('ROLLBACK')
        await client.query('COMMIT')
        expect(await claim(other)).toEqual({ claimed: false, reason: 'shared' })
      } else {
        await claim()
        await expect(connection('active', other)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_SESSION_BUSY' })
        await other.query('ROLLBACK')
        await client.query('COMMIT')
        await expect(connection('active', other)).rejects.toMatchObject({ code: 'PT409', message: 'BANK_SESSION_REVOCATION_STARTED' })
      }
    } finally { await client.query('ROLLBACK'); await other.query('ROLLBACK'); other.release(); await client.query('BEGIN') }
  })
})
