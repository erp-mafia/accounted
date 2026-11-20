import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient } from './setup'

// Migration 20261012120000: Open Payments beside Enable Banking. Every
// existing row is 'enable_banking' and must behave exactly as before; the
// Enable Banking contracts themselves stay pinned by the bank-*.pg.test.ts
// suites, which run unchanged against this migration.

type Aggregator = 'enable_banking' | 'open_payments'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
const iban = 'SE8050000000052131234567'

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

async function connection(input: {
  aggregator?: Aggregator; status?: string; session?: string | null; accounts?: unknown[]
  bank?: string; provider?: string; company?: string; expires?: string | null; bic?: string | null
  consentAttempt?: Record<string, unknown> | null
} = {}): Promise<string> {
  const id = randomUUID()
  const columns = ['id', 'company_id', 'user_id', 'provider', 'bank_name', 'status', 'session_id', 'accounts_data', 'consent_expires']
  const values: unknown[] = [id, input.company ?? owner.companyId, owner.userId, input.provider ?? 'seb-se', input.bank ?? 'SEB',
    input.status ?? 'active', input.session === undefined ? randomUUID() : input.session,
    JSON.stringify(input.accounts ?? []), input.expires ?? null]
  if (input.aggregator) { columns.push('aggregator'); values.push(input.aggregator) }
  const bic = input.bic === undefined ? (input.aggregator === 'open_payments' ? 'ESSESESS' : null) : input.bic
  if (bic !== null) { columns.push('bic'); values.push(bic) }
  if (input.consentAttempt) { columns.push('consent_attempt'); values.push(JSON.stringify(input.consentAttempt)) }
  await client.query(`INSERT INTO bank_connections(${columns.join(',')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(',')})`, values)
  return id
}
async function asRole(role: 'service_role' | 'authenticated') {
  const sub = role === 'service_role' ? '' : owner.userId
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.jwt.claim.role',$3,true)",
    [sub, JSON.stringify({ role, ...(sub ? { sub } : {}) }), role])
  await client.query(`SET LOCAL ROLE ${role}`)
}
async function savepoint<T>(name: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SAVEPOINT ${name}`)
  try {
    return await run()
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
  }
}
async function row(id: string) {
  return (await client.query('SELECT * FROM bank_connections WHERE id=$1', [id])).rows[0]
}

describe('bank_connections.aggregator', () => {
  it('defaults every row to enable_banking and accepts only the two aggregators', async () => {
    const id = await connection()
    expect((await row(id)).aggregator).toBe('enable_banking')
    await expect(savepoint('bad_aggregator', () => connection({ aggregator: 'tink' as Aggregator })))
      .rejects.toMatchObject({ code: '23514' })
  })

  it('requires the bank BIC on an Open Payments row and a valid one on any row', async () => {
    await connection({ aggregator: 'open_payments' })
    await connection({ bic: null })
    await expect(savepoint('op_no_bic', () => connection({ aggregator: 'open_payments', bic: null })))
      .rejects.toMatchObject({ code: '23514' })
    await expect(savepoint('bad_bic', () => connection({ bic: 'seb' })))
      .rejects.toMatchObject({ code: '23514' })
  })

  it('keeps the sparbank id and the consent attempt as plain columns with shape checks', async () => {
    const id = await connection({ aggregator: 'open_payments', bic: 'SWEDSESS', consentAttempt: { method: 'qr', state: 'pending' } })
    await client.query("UPDATE bank_connections SET affiliated_aspsp_id='08999' WHERE id=$1", [id])
    expect(await row(id)).toMatchObject({ affiliated_aspsp_id: '08999', consent_attempt: { method: 'qr', state: 'pending' } })
    await expect(savepoint('attempt_array', () => client.query("UPDATE bank_connections SET consent_attempt='[]' WHERE id=$1", [id])))
      .rejects.toMatchObject({ code: '23514' })
    await expect(savepoint('affiliate_empty', () => client.query("UPDATE bank_connections SET affiliated_aspsp_id='' WHERE id=$1", [id])))
      .rejects.toMatchObject({ code: '23514' })
  })

  it('never changes after insert', async () => {
    const id = await connection()
    await expect(savepoint('flip', () => client.query("UPDATE bank_connections SET aggregator='open_payments' WHERE id=$1", [id])))
      .rejects.toMatchObject({ code: '23514', message: 'BANK_CONNECTION_AGGREGATOR_IMMUTABLE' })
    await client.query("UPDATE bank_connections SET status='expired' WHERE id=$1", [id])
  })

  it('holds one Open Payments consent in one row, while Enable Banking sessions stay shareable', async () => {
    const consent = randomUUID()
    await connection({ aggregator: 'open_payments', session: consent })
    await expect(savepoint('dup_consent', () => connection({ aggregator: 'open_payments', session: consent, bank: 'Other' })))
      .rejects.toMatchObject({ code: '23505' })
    const other = await seedCompany()
    const shared = randomUUID()
    await connection({ session: shared })
    await connection({ session: shared, company: other.companyId })
    // The same string under the other aggregator is a different session.
    await connection({ session: consent })
  })

  it('names the aggregator and the bank in the configuration snapshot without changing its token', async () => {
    const eb = await connection()
    const op = await connection({ aggregator: 'open_payments' })
    const read = async (id: string) => (await client.query('SELECT read_bank_configuration($1,$2) AS snapshot', [owner.companyId, id])).rows[0].snapshot
    const [ebSnapshot, opSnapshot] = [await read(eb), await read(op)]
    expect(ebSnapshot.connection).toMatchObject({ aggregator: 'enable_banking', bic: null })
    expect(opSnapshot.connection).toMatchObject({ aggregator: 'open_payments', bic: 'ESSESESS' })
    expect(ebSnapshot.token).toBe(opSnapshot.token)
  })

  it('lets cash_accounts carry an Open Payments source', async () => {
    await client.query("INSERT INTO cash_accounts(company_id,ledger_account,currency,source) VALUES($1,'1931','SEK','open_payments')", [owner.companyId])
    await expect(savepoint('bad_source', () => client.query("INSERT INTO cash_accounts(company_id,ledger_account,currency,source) VALUES($1,'1932','SEK','tink')", [owner.companyId])))
      .rejects.toMatchObject({ code: '23514' })
  })
})

describe('provider session namespaces', () => {
  async function claim(namespace: string, session: string) {
    return (await client.query('SELECT claim_bank_session_revocation($1,$2) AS result', [namespace, session])).rows[0].result
  }

  it('counts only holders of the namespace being revoked', async () => {
    const session = randomUUID()
    await connection({ aggregator: 'open_payments', session })
    expect(await savepoint('op_claim', () => claim('openpayments', session))).toEqual({ claimed: false, reason: 'shared' })
    // Enable Banking never counts an Open Payments holder, and the reverse.
    expect(await savepoint('eb_claim', () => claim('enablebanking', session))).toMatchObject({ claimed: true })
    const ebSession = randomUUID()
    await connection({ session: ebSession })
    expect(await savepoint('eb_shared', () => claim('enablebanking', ebSession))).toEqual({ claimed: false, reason: 'shared' })
    expect(await savepoint('op_free', () => claim('openpayments', ebSession))).toMatchObject({ claimed: true })
  })

  it('fences a revoked consent only within its own namespace', async () => {
    const session = randomUUID()
    const started = await claim('openpayments', session)
    expect(started).toMatchObject({ claimed: true })
    await expect(savepoint('op_fenced', () => connection({ aggregator: 'open_payments', session })))
      .rejects.toMatchObject({ code: 'PT409', message: 'BANK_SESSION_REVOCATION_STARTED' })
    await connection({ session })
    expect((await client.query('SELECT finish_bank_session_revocation($1,$2,$3,$4) AS applied',
      ['openpayments', session, started.token, true])).rows[0].applied).toBe(true)
  })

  it('still refuses a bank label passed as a namespace', async () => {
    await expect(savepoint('label', () => claim('seb-se', randomUUID()))).rejects.toMatchObject({ code: '22023', message: 'BANK_SESSION_PROVIDER_INVALID' })
    await expect(savepoint('null_ns', () => claim(null as unknown as string, randomUUID()))).rejects.toMatchObject({ code: '22023' })
  })
})

describe('bank transaction insertion per aggregator', () => {
  const uid = 'ACC003'
  async function routed(aggregator: Aggregator, ledger = '1930') {
    const connectionId = await connection({ aggregator, accounts: [{ uid, currency: 'SEK', iban, enabled: true, ledger_account: ledger }] })
    await client.query(`INSERT INTO cash_accounts(company_id,ledger_account,currency,source,bank_connection_id,external_uid,iban,enabled)
      VALUES($1,$6,'SEK',$2,$3,$4,$5,true)`, [owner.companyId, aggregator, connectionId, uid, iban, ledger])
    const route = (await client.query('SELECT resolve_bank_ingest_route($1,$2,$3,$4) AS route', [owner.companyId, connectionId, uid, 'SEK'])).rows[0].route
    return { connectionId, route }
  }
  async function insert(target: { connectionId: string; route: { token: string } }, payload: Record<string, unknown>) {
    return (await client.query('SELECT insert_bank_transaction($1,$2,$3,$4,$5,$6,$7) AS tx', [
      owner.companyId, owner.userId, target.connectionId, uid, 'SEK', target.route.token,
      JSON.stringify({ external_id: randomUUID(), date: '2026-09-28', amount: -29, currency: 'SEK', description: 'BANK FEE', ...payload }),
    ])).rows[0].tx
  }
  async function rawDocument() {
    const id = randomUUID()
    await client.query(`INSERT INTO document_attachments(id,user_id,company_id,file_name,mime_type,file_size_bytes,storage_path,sha256_hash,upload_source)
      VALUES ($1,$2,$3,'psd2-response.json','application/json',2,$4,$5,'api')`,
    [id, owner.userId, owner.companyId, `documents/${owner.companyId}/${id}.json`, randomUUID().replace(/-/g, '').padEnd(64, '0')])
    return id
  }

  it('names the aggregator and the bank in the ingest route, with the token unchanged in shape', async () => {
    const eb = await routed('enable_banking')
    expect(eb.route).toMatchObject({ aggregator: 'enable_banking', bic: null, connectionId: eb.connectionId, ledgerAccount: '1930' })
    const op = await routed('open_payments', '1931')
    expect(op.route).toMatchObject({ aggregator: 'open_payments', bic: 'ESSESESS', ledgerAccount: '1931' })
    expect(op.route.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('labels an Enable Banking row enable_banking whatever the payload claims', async () => {
    const eb = await routed('enable_banking')
    expect(await insert(eb, { import_source: 'enable_banking' })).toMatchObject({ import_source: 'enable_banking', end_to_end_id: null, value_date: null })
    expect(await insert(eb, { import_source: 'open_payments' })).toMatchObject({ import_source: 'enable_banking' })
    expect(await insert(eb, {})).toMatchObject({ import_source: 'enable_banking', provider_transaction_id: null })
  })

  it('labels an Open Payments row open_payments and keeps what the aggregator reported, the archive link included', async () => {
    const op = await routed('open_payments')
    const page = await rawDocument()
    const tx = await insert(op, {
      import_source: 'enable_banking', value_date: '2026-09-29', end_to_end_id: 'E2E-4711',
      provider_transaction_id: 'SBX-TX-20260818-0042', reference: '4711000000009', raw_document_id: page,
    })
    expect(tx).toMatchObject({
      import_source: 'open_payments', value_date: '2026-09-29', end_to_end_id: 'E2E-4711',
      provider_transaction_id: 'SBX-TX-20260818-0042', reference: '4711000000009', bank_connection_id: op.connectionId,
      raw_document_id: page,
    })
  })

  it('still refuses a raw document of another company', async () => {
    const op = await routed('open_payments')
    const stranger = await seedCompany()
    const foreign = randomUUID()
    await client.query(`INSERT INTO document_attachments(id,user_id,company_id,file_name,mime_type,file_size_bytes,storage_path,sha256_hash,upload_source)
      VALUES ($1,$2,$3,'x.json','application/json',2,$4,$5,'api')`,
    [foreign, stranger.userId, stranger.companyId, `documents/${stranger.companyId}/${foreign}.json`, randomUUID().replace(/-/g, '').padEnd(64, '0')])
    await expect(savepoint('foreign_doc', () => insert(op, { raw_document_id: foreign })))
      .rejects.toMatchObject({ code: '22023', message: 'BANK_INGEST_TRANSACTION_INVALID' })
  })
})

describe('cash account source per aggregator', () => {
  it.each<Aggregator>(['enable_banking', 'open_payments'])('promotes a %s account with that source', async aggregator => {
    const connectionId = await connection({ aggregator, status: 'pending_selection', accounts: [{ uid: 'ACC003', currency: 'SEK', iban, enabled: true }] })
    const result = (await client.query('SELECT promote_psd2_cash_account($1,$2) AS result', [owner.companyId, JSON.stringify({
      bank_connection_id: connectionId, external_uid: 'ACC003', currency: 'SEK', ledger_account: '1930', iban, enabled: true,
    })])).rows[0].result
    expect((await client.query('SELECT source FROM cash_accounts WHERE id=$1', [result.cashAccountId])).rows[0].source).toBe(aggregator)
  })
})

describe('supersession and sharing stay within one aggregator', () => {
  const account = { uid: 'ACC003', currency: 'SEK', iban, enabled: true }
  async function supersede(survivor: string, session: string) {
    const token = (await client.query('SELECT bank_configuration_token($1) AS token', [owner.companyId])).rows[0].token
    return (await client.query('SELECT supersede_bank_connections($1,$2,$3,$4,$5,$6) AS result',
      [owner.companyId, owner.userId, survivor, token, session, []])).rows[0].result
  }
  async function status(id: string) {
    return (await row(id)).status
  }

  it('never lets one aggregator supersede the other, for the same bank and account', async () => {
    const eb = await connection({ status: 'expired', accounts: [account] })
    const opSession = randomUUID()
    const op = await connection({ aggregator: 'open_payments', status: 'pending_selection', session: opSession, accounts: [account] })
    expect((await supersede(op, opSession)).superseded).toEqual([])
    expect(await status(eb)).toBe('expired')

    const ebSession = randomUUID()
    const ebNew = await connection({ status: 'pending_selection', session: ebSession, accounts: [account] })
    const superseded = (await supersede(ebNew, ebSession)).superseded
    expect(superseded.map((r: { id: string }) => r.id)).toEqual([eb])
    expect(await status(op)).toBe('pending_selection')
  })

  it('refuses to share an Open Payments consent with another company', async () => {
    const target = await seedCompany()
    await client.query("INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')", [target.companyId, owner.userId])
    const op = await connection({ aggregator: 'open_payments', accounts: [account], expires: '2099-01-01T00:00:00Z' })
    await expect(savepoint('attach_op', () => client.query('SELECT attach_shared_bank_session($1,$2,$3)', [target.companyId, owner.userId, op])))
      .rejects.toMatchObject({ code: 'P0002', message: 'BANK_REUSABLE_SESSION_NOT_FOUND' })
    const eb = await connection({ accounts: [account], expires: '2099-01-01T00:00:00Z' })
    const attached = (await client.query('SELECT attach_shared_bank_session($1,$2,$3) AS result', [target.companyId, owner.userId, eb])).rows[0].result
    expect((await row(attached.connection_id)).aggregator).toBe('enable_banking')
  })
})

describe('finalize_open_payments_consent', () => {
  const accounts = [
    { uid: 'ACC003', iban, currency: 'SEK', name: 'Business Account', enabled: true, ledger_account: '1999', dedup_scope: 'injected' },
    { uid: 'ACC001', iban: 'SE7750000000056990607246', currency: 'SEK', name: 'Personal Checking Account', enabled: false },
  ]
  async function pending(consent: string, consentAttempt?: Record<string, unknown>) {
    return connection({ aggregator: 'open_payments', status: 'pending', session: consent, consentAttempt })
  }
  async function finalize(id: string, consent: string, input: unknown = accounts, actor = owner.userId) {
    return (await client.query('SELECT finalize_open_payments_consent($1,$2,$3,$4,$5,$6) AS result',
      [owner.companyId, actor, id, consent, '2027-03-29T00:00:00Z', JSON.stringify(input)])).rows[0].result
  }

  it('turns the pending attempt into a connection awaiting account selection, once', async () => {
    const consent = randomUUID()
    const id = await pending(consent, { method: 'qr', state: 'pending', started_at: '2026-10-12T10:00:00Z' })
    await client.query("UPDATE bank_connections SET authorization_id='auth-1' WHERE id=$1", [id])
    await asRole('service_role')
    const first = await finalize(id, consent)
    expect(first).toMatchObject({ connection_id: id, superseded: [], already_finalized: false })
    expect(first.accounts).toEqual([
      { uid: 'ACC003', iban, currency: 'SEK', name: 'Business Account', enabled: true },
      accounts[1],
    ])
    const after = await row(id)
    expect(after).toMatchObject({ status: 'pending_selection', authorization_id: null, consent_attempt: null })
    expect(new Date(after.consent_expires).toISOString()).toBe('2027-03-29T00:00:00.000Z')
    expect(await finalize(id, consent)).toMatchObject({ connection_id: id, already_finalized: true, accounts: after.accounts_data })
  })

  it('keeps what the selection step needs of the attempt and drops the rest', async () => {
    const consent = randomUUID()
    const replaced = randomUUID()
    const id = await pending(consent, { method: 'qr', state: 'pending', sca_status: 'finalised', replace_connection_id: replaced, extended_history_days: 760, listing_only: true })
    await finalize(id, consent)
    expect((await row(id)).consent_attempt).toEqual({ selection: { replace_connection_id: replaced, extended_history_days: 760, listing_only: true } })
  })

  it('supersedes an older Open Payments row for the same accounts and leaves Enable Banking alone', async () => {
    const oldConsent = randomUUID()
    const old = await connection({ aggregator: 'open_payments', status: 'expired', session: oldConsent,
      accounts: [{ uid: 'ACC003', iban, currency: 'SEK', enabled: true, dedup_scope: iban }] })
    const eb = await connection({ status: 'active', accounts: [{ uid: 'eb-uid', iban: 'SE0000000000000000000099', currency: 'SEK', enabled: true }] })
    const consent = randomUUID()
    const id = await pending(consent)
    const result = await finalize(id, consent)
    expect(result.superseded).toEqual([{ id: old, session_id: oldConsent }])
    expect(await row(old)).toMatchObject({ status: 'revoked', superseded_by: id })
    expect((await row(eb)).status).toBe('active')
    expect(result.accounts[0]).toMatchObject({ uid: 'ACC003', dedup_scope: iban })
  })

  it('keeps the dedup scope an Enable Banking feed used for the same account', async () => {
    await connection({ status: 'revoked', session: null, accounts: [{ uid: 'eb-uid', iban: 'SE80 5000 0000 0521 3123 4567', currency: 'SEK', dedup_scope: 'eb-legacy-uid' }] })
    const consent = randomUUID()
    const id = await pending(consent)
    const result = await finalize(id, consent)
    expect(result.accounts[0]).toMatchObject({ uid: 'ACC003', dedup_scope: 'eb-legacy-uid' })
    expect(result.accounts[1].dedup_scope).toBeUndefined()
  })

  it('leaves the scope open when earlier feeds disagree about it', async () => {
    await connection({ status: 'revoked', session: null, accounts: [{ uid: 'a', iban, currency: 'SEK', dedup_scope: 'scope-a' }] })
    await connection({ status: 'revoked', session: null, bank: 'SEB 2', accounts: [{ uid: 'b', iban, currency: 'SEK', dedup_scope: 'scope-b' }] })
    const consent = randomUUID()
    const id = await pending(consent)
    expect((await finalize(id, consent)).accounts[0].dedup_scope).toBeUndefined()
  })

  it('refuses an Enable Banking row, another consent, bad accounts and a stranger', async () => {
    const consent = randomUUID()
    const eb = await connection({ status: 'pending', session: consent })
    await expect(savepoint('eb_row', () => finalize(eb, consent))).rejects.toMatchObject({ code: 'P0002', message: 'BANK_CONNECTION_NOT_FOUND' })
    const opConsent = randomUUID()
    const id = await pending(opConsent)
    await expect(savepoint('other_consent', () => finalize(id, randomUUID()))).rejects.toMatchObject({ code: 'PT409', message: 'BANK_CONSENT_CHANGED' })
    await expect(savepoint('bad_accounts', () => finalize(id, opConsent, [{ uid: 'x', currency: 'sek', enabled: true }])))
      .rejects.toMatchObject({ code: '22023', message: 'BANK_CONSENT_INPUT_INVALID' })
    await expect(savepoint('dup_accounts', () => finalize(id, opConsent, [accounts[1], accounts[1]])))
      .rejects.toMatchObject({ code: '22023' })
    const stranger = await seedCompany()
    await expect(savepoint('stranger', () => finalize(id, opConsent, accounts, stranger.userId)))
      .rejects.toMatchObject({ code: '42501', message: 'BANK_CONSENT_ACTOR_DENIED' })
    await client.query("UPDATE bank_connections SET status='error' WHERE id=$1", [id])
    await expect(savepoint('not_pending', () => finalize(id, opConsent))).rejects.toMatchObject({ code: 'PT409', message: 'BANK_CONSENT_CHANGED' })
  })

  it('is not callable by a signed-in user', async () => {
    const consent = randomUUID()
    const id = await pending(consent)
    await asRole('authenticated')
    await expect(finalize(id, consent)).rejects.toMatchObject({ code: '42501' })
  })
})

describe('supersede_enable_banking_connection (switching a bank to Open Payments)', () => {
  const ebAccount = { uid: 'eb-uid', iban, currency: 'SEK', enabled: true, ledger_account: '1930', dedup_scope: 'eb-legacy-scope' }
  const opAccount = { uid: 'ACC003', iban: 'SE80 5000 0000 0521 3123 4567', currency: 'SEK', enabled: true }
  let eb: string
  let op: string
  let cashId: string
  let txId: string

  beforeEach(async () => {
    eb = await connection({ status: 'active', accounts: [ebAccount] })
    op = await connection({ aggregator: 'open_payments', status: 'pending_selection', accounts: [opAccount] })
    cashId = randomUUID()
    await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,bank_connection_id,external_uid,iban,source)
      VALUES($1,$2,'1930','SEK',$3,'eb-uid',$4,'enable_banking')`, [cashId, owner.companyId, eb, iban])
    txId = randomUUID()
    await client.query(`INSERT INTO transactions(id,company_id,user_id,currency,date,amount,description,cash_account_id,bank_connection_id,import_source)
      VALUES($1,$2,$3,'SEK','2026-09-01',-100,'Switch fixture',$4,$5,'enable_banking')`, [txId, owner.companyId, owner.userId, cashId, eb])
  })
  async function supersede(newId = op, oldId = eb, actor = owner.userId) {
    return (await client.query('SELECT supersede_enable_banking_connection($1,$2,$3,$4) AS result',
      [owner.companyId, actor, newId, oldId])).rows[0].result
  }

  it('moves the transactions, releases the cash-account claim, revokes the Enable Banking row and carries the dedup scope', async () => {
    await asRole('authenticated')
    const result = await supersede()
    expect(result).toEqual({
      superseded: [{ id: eb, session_id: expect.any(String) }],
      accounts: [{ ...opAccount, dedup_scope: 'eb-legacy-scope' }],
      moved_transactions: 1,
      released_cash_accounts: 1,
    })
    expect((await client.query('SELECT bank_connection_id, cash_account_id, import_source FROM transactions WHERE id=$1', [txId])).rows[0])
      .toEqual({ bank_connection_id: op, cash_account_id: cashId, import_source: 'enable_banking' })
    expect((await client.query('SELECT bank_connection_id, external_uid, ledger_account FROM cash_accounts WHERE id=$1', [cashId])).rows[0])
      .toEqual({ bank_connection_id: null, external_uid: null, ledger_account: '1930' })
    expect(await row(eb)).toMatchObject({ status: 'revoked', session_id: null, superseded_by: op, superseded_at: expect.any(Date) })
    expect(await row(op)).toMatchObject({ status: 'pending_selection', accounts_data: [{ ...opAccount, dedup_scope: 'eb-legacy-scope' }] })
  })

  it('leaves a cash row the selection already adopted with the Open Payments row', async () => {
    await client.query("UPDATE cash_accounts SET bank_connection_id=$2, external_uid='ACC003', source='open_payments' WHERE id=$1", [cashId, op])
    const result = await supersede()
    expect(result).toMatchObject({ moved_transactions: 1, released_cash_accounts: 0 })
    expect((await client.query('SELECT bank_connection_id FROM cash_accounts WHERE id=$1', [cashId])).rows[0].bank_connection_id).toBe(op)
  })

  it('keeps an explicit scope on the Open Payments row and refuses an ambiguous Enable Banking one', async () => {
    await client.query("UPDATE bank_connections SET accounts_data=$2 WHERE id=$1", [op, JSON.stringify([{ ...opAccount, dedup_scope: 'custom' }])])
    expect((await savepoint('explicit', () => supersede())).accounts[0].dedup_scope).toBe('custom')
    await client.query("UPDATE bank_connections SET accounts_data=$2 WHERE id=$1",
      [eb, JSON.stringify([ebAccount, { ...ebAccount, uid: 'eb-2', dedup_scope: 'other-scope' }])])
    await client.query("UPDATE bank_connections SET accounts_data=$2 WHERE id=$1", [op, JSON.stringify([opAccount])])
    await expect(savepoint('ambiguous', () => supersede())).rejects.toMatchObject({ code: 'PT409', message: 'BANK_SUPERSEDE_SCOPE_AMBIGUOUS' })
  })

  it('refuses the wrong aggregators, a revoked or superseded row, the same row twice, a stranger and an unknown row', async () => {
    await expect(savepoint('reversed', () => supersede(eb, op))).rejects.toMatchObject({ code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED' })
    await expect(savepoint('same', () => supersede(op, op))).rejects.toMatchObject({ code: 'PT409' })
    await client.query("UPDATE bank_connections SET status='revoked', session_id=NULL WHERE id=$1", [eb])
    await expect(savepoint('revoked', () => supersede())).rejects.toMatchObject({ code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED' })
    await client.query("UPDATE bank_connections SET status='active' WHERE id=$1", [eb])
    await client.query("UPDATE bank_connections SET status='pending' WHERE id=$1", [op])
    await expect(savepoint('op_pending', () => supersede())).rejects.toMatchObject({ code: 'PT409' })
    await client.query("UPDATE bank_connections SET status='pending_selection' WHERE id=$1", [op])
    const stranger = await seedCompany()
    await expect(savepoint('stranger', () => supersede(op, eb, stranger.userId))).rejects.toMatchObject({ code: '42501', message: 'BANK_SUPERSEDE_ACTOR_DENIED' })
    await expect(savepoint('unknown', () => supersede(op, randomUUID()))).rejects.toMatchObject({ code: 'P0002', message: 'BANK_CONNECTION_NOT_FOUND' })
  })
})
