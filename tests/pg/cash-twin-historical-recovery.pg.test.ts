import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient } from './setup'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let keeperId: string
let twinId: string
let connectionId: string
let startedId: string
let transactionId: string
const iban = 'SE0000000000000000000111'
const uid = 'historical-provider-uid'
const session = 'historical-provider-session'
const actor = { type: 'system', label: 'PG historical recovery' }
function intent() {
  return { phase: 'started', keeper: { id: keeperId, ledger_account: '1930' }, live_row_id: twinId,
    bank_connection_id: connectionId, sync_ledger_before: '1931', sync_ledger_after: '1930', plan_fingerprint: 'ce4519b1b7a2',
    retired: [{ id: twinId, ledger_account: '1931', movable: 1, staying: 0, outcome: 'rekeyed-into-keeper' }] }
}
async function record(payload: unknown = intent(), id = startedId, cause: string | null = null, company = owner.companyId) {
  await client.query(`INSERT INTO processing_history(event_id,company_id,correlation_id,causation_id,aggregate_type,aggregate_id,event_type,payload,actor,occurred_at)
    VALUES($1,$2,$1,$3,'System',$2,'CashAccountTwinsMerged',$4,$5,'2026-09-01T00:00:00Z')`, [id,company,cause,JSON.stringify(payload),JSON.stringify(actor)])
}
async function inspect(company = owner.companyId, id = startedId) {
  return (await client.query('SELECT inspect_historical_cash_twin_repair($1,$2) AS result', [company,id])).rows[0].result
}
async function inventory(company: string | null = owner.companyId, id: string | null = null) {
  return (await client.query('SELECT report_historical_cash_twin_repairs($1,$2) AS result',[company,id])).rows[0].result
}
async function finish() {
  return (await client.query('SELECT promote_psd2_cash_account($1,$2) AS result',[owner.companyId,JSON.stringify({
    bank_connection_id: connectionId, external_uid: uid, expected_session_id: session, currency: 'SEK',
    ledger_account: '1930', iban, enabled: true, reuse_cash_account_id: keeperId,
  })])).rows[0].result
}
async function state() {
  return (await client.query(`SELECT jsonb_build_object(
    'cash',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM cash_accounts c WHERE company_id=$1),
    'connections',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM bank_connections b WHERE company_id=$1),
    'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM transactions t WHERE company_id=$1),
    'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY event_id) FROM processing_history h WHERE company_id=$1)) AS state`,[owner.companyId])).rows[0].state
}
beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  keeperId = randomUUID(); twinId = randomUUID(); connectionId = randomUUID(); startedId = randomUUID(); transactionId = randomUUID()
  await client.query(`INSERT INTO bank_connections(id,company_id,user_id,provider,session_id,status,accounts_data)
    VALUES($1,$2,$3,'seb-se',$4,'active',$5)`,[connectionId,owner.companyId,owner.userId,session,
    JSON.stringify([{ uid,currency:'SEK',iban,ledger_account:'1931',enabled:true }])])
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,iban,is_primary,source)
    VALUES($1,$2,'1930','SEK',$3,true,'manual')`,[keeperId,owner.companyId,iban])
  await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,iban,bank_connection_id,external_uid)
    VALUES($1,$2,'1931','SEK',$3,$4,$5)`,[twinId,owner.companyId,iban,connectionId,uid])
  await client.query(`INSERT INTO transactions(id,company_id,user_id,date,amount,currency,description,cash_account_id)
    VALUES($1,$2,$3,'2026-06-01',-100,'SEK','Private description must not appear in recovery report',$4)`,[transactionId,owner.companyId,owner.userId,twinId])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })

describe('historical started-event inspection', () => {
  it('describes an unchanged old operation as incomplete without changing history or business rows', async () => {
    await record(); const before = await state(); const report = await inspect()
    expect(report).toMatchObject({ companyId: owner.companyId, startedEventId: startedId, classification: 'partial',
      completionRecords: [], retired: [{ id: twinId, currentMovable: 1, hasProviderClaim: true }] })
    expect(report.issues.map((i: { kind: string }) => i.kind)).toEqual(expect.arrayContaining([
      'route-still-at-recorded-before-state','keeper-provider-handover-incomplete','retirement-incomplete',
    ]))
    expect(await state()).toEqual(before)
  })
  it('detects a route-first interrupted prefix without relying on duplicate discovery', async () => {
    await record()
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,ledger_account}','"1930"') WHERE id=$1`,[connectionId])
    const report = await inspect()
    expect(report.classification).toBe('partial'); expect(report.route).toMatchObject({ currentLedger:'1930',keeperOwnsUid:false })
    expect(report.issues).toContainEqual({kind:'keeper-provider-handover-incomplete',id:keeperId})
  })
  it('finds a consistent current result after all duplicate rows disappear, without inventing a commit proof', async () => {
    await record(); await finish()
    expect((await client.query('SELECT plan_cash_account_twins($1) AS plan',[owner.companyId])).rows[0].plan.groups).toEqual([])
    const report = await inspect()
    expect(report).toMatchObject({ classification:'consistent-with-completion',issues:[],completionRecords:[],retired:[{id:twinId,exists:false}] })
    expect(report.limitations).toEqual(expect.arrayContaining(['current-state-only','original-transaction-ids-and-bindings-not-recorded','no-historical-completion-time-inferred']))
    expect(report).not.toHaveProperty('completedAt')
    expect((await inventory()).map((r: {startedEventId:string})=>r.startedEventId)).toEqual([startedId])
  })
  it('does not present planned movement counts as proof that those exact transactions moved', async () => {
    const planned = intent(); planned.retired[0].movable = 999
    await record(planned); await finish(); const report = await inspect()
    expect(report.retired[0].plannedMovable).toBe(999)
    expect(report.limitations).toContain('original-transaction-ids-and-bindings-not-recorded')
    expect(report).not.toHaveProperty('movedTransactions')
  })
  it('keeps legitimately retained manual rows in a consistent result', async () => {
    const planned = intent(); planned.live_row_id = keeperId; planned.retired[0].outcome = 'kept-manual'; planned.retired[0].movable = 0
    await finish()
    await client.query(`INSERT INTO cash_accounts(id,company_id,ledger_account,currency,iban,source)
      VALUES($1,$2,'1931','SEK',$3,'manual')`,[twinId,owner.companyId,iban])
    await record(planned)
    expect(await inspect()).toMatchObject({classification:'consistent-with-completion',retired:[{exists:true,hasProviderClaim:false,currentMovable:0}]})
  })
  it.each(['keeper-missing','keeper-ledger','retained-missing','outside-route','physical-route','physical-retired','enabled-mismatch'])(
    'classifies a %s contradiction against the recorded intent', async problem => {
      const planned = intent()
      if(problem==='retained-missing') planned.retired[0].outcome='kept-manual'
      await record(planned)
      if(problem==='keeper-missing') await client.query('DELETE FROM cash_accounts WHERE id=$1',[keeperId])
      if(problem==='keeper-ledger') await client.query("UPDATE cash_accounts SET ledger_account='1939' WHERE id=$1",[keeperId])
      if(problem==='retained-missing') await finish()
      if(problem==='outside-route') await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,ledger_account}','"1939"') WHERE id=$1`,[connectionId])
      if(problem==='physical-route') await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,iban}','"SE9999"') WHERE id=$1`,[connectionId])
      if(problem==='physical-retired') await client.query("UPDATE cash_accounts SET iban='SE9999' WHERE id=$1",[twinId])
      if(problem==='enabled-mismatch') await client.query('UPDATE cash_accounts SET enabled=false WHERE id=$1',[keeperId])
      expect((await inspect()).classification).toBe('contradictory')
    })
  it.each(['revoked','missing-session','no-keeper-iban','missing-uid','duplicate-uid','no-route-iban'])(
    'reports insufficient evidence for %s rather than inferring original identities', async problem => {
      await record(); await finish()
      if(problem==='revoked') await client.query("UPDATE bank_connections SET status='revoked' WHERE id=$1",[connectionId])
      if(problem==='missing-session') await client.query('UPDATE bank_connections SET session_id=null WHERE id=$1',[connectionId])
      if(problem==='no-keeper-iban') await client.query('UPDATE cash_accounts SET iban=null WHERE id=$1',[keeperId])
      if(problem==='missing-uid') await client.query("UPDATE bank_connections SET accounts_data='[]' WHERE id=$1",[connectionId])
      if(problem==='duplicate-uid') await client.query('UPDATE bank_connections SET accounts_data=accounts_data||accounts_data WHERE id=$1',[connectionId])
      if(problem==='no-route-iban') await client.query("UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,iban}','null') WHERE id=$1",[connectionId])
      expect((await inspect()).classification).toBe('insufficient-evidence')
    })
  it.each(['missing-fields','invalid-uuid','retired-scalar','unknown-outcome','negative-count','duplicate-row'])(
    'returns an insufficient report for %s historical metadata', async problem => {
      const planned = intent()
      if(problem==='invalid-uuid') planned.keeper.id='not-a-uuid'
      if(problem==='unknown-outcome') planned.retired[0].outcome='unknown'
      if(problem==='negative-count') planned.retired[0].movable=-1
      if(problem==='duplicate-row') planned.retired.push(planned.retired[0])
      await record(problem==='missing-fields'?{phase:'started'}:problem==='retired-scalar'?{...planned,retired:{}}:planned)
      expect((await inspect()).classification).toBe('insufficient-evidence')
    })
  it('redacts physical identifiers, provider UIDs, sessions and transaction descriptions', async () => {
    await record(); const serialized = JSON.stringify(await inspect())
    for(const secret of [iban,uid,session,'Private description']) expect(serialized).not.toContain(secret)
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,ledger_account}',to_jsonb($2::text)) WHERE id=$1`,[connectionId,iban])
    expect(JSON.stringify(await inspect())).not.toContain(iban)
  })
  it('reports unfinished retirement when dependencies or movable rows remain on a released row', async () => {
    await record()
    await client.query('UPDATE cash_accounts SET bank_connection_id=null,external_uid=null,invoice_payee=true WHERE id=$1',[twinId])
    await client.query('UPDATE cash_accounts SET bank_connection_id=$2,external_uid=$3 WHERE id=$1',[keeperId,connectionId,uid])
    await client.query(`UPDATE bank_connections SET accounts_data=jsonb_set(accounts_data,'{0,ledger_account}','"1930"') WHERE id=$1`,[connectionId])
    expect(await inspect()).toMatchObject({classification:'partial',retired:[{id:twinId,currentMovable:1,dependencies:['invoice-configuration']}]})
  })
  it('counts more than a PostgREST page of remaining transactions', async () => {
    await record()
    await client.query(`INSERT INTO transactions(company_id,user_id,date,amount,currency,description,cash_account_id)
      SELECT $1,$2,'2026-06-01',-1,'SEK','PG historical bulk',$3 FROM generate_series(1,1001)`,[owner.companyId,owner.userId,twinId])
    expect((await inspect()).retired[0].currentMovable).toBe(1002)
  })
  it('recognizes current posted origins as staying even before their later link', async () => {
    await record(); const entryId=randomUUID()
    await client.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,entry_date,description,status,source_type,source_id,voucher_number,bank_booking_context)
      VALUES($1,$2,$3,$4,'2026-06-01','PG historical origin','draft','bank_transaction',$5,0,$6)`,
    [entryId,owner.companyId,owner.userId,owner.fiscalPeriodId,transactionId,JSON.stringify([{transaction_id:transactionId,cash_account_id:twinId,settlement_account:'1931',date:'2026-06-01',amount:-100,currency:'SEK'}])])
    await client.query("INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount) VALUES($1,'1931',0,100),($1,'2999',100,0)",[entryId])
    await client.query('SELECT commit_journal_entry($1,$2)',[owner.companyId,entryId])
    expect((await inspect()).retired[0]).toMatchObject({currentMovable:0,currentStaying:1})
  })
  it('excludes paired completions from the inventory but allows explicit current inspection', async () => {
    await record(); await finish(); const completed=randomUUID()
    await record({phase:'completed',keeper:intent().keeper,plan_fingerprint:intent().plan_fingerprint},completed,startedId)
    expect(await inventory()).toEqual([])
    expect((await inventory(owner.companyId,startedId))[0]).toMatchObject({classification:'consistent-with-completion',completionRecords:[{eventId:completed}]})
  })
  it('does not let an unrelated or foreign-company completion hide a started event', async () => {
    await record(); await record({phase:'completed'},randomUUID())
    const other = await seedCompany(); await record({phase:'completed'},randomUUID(),startedId,other.companyId)
    expect(await inventory()).toHaveLength(1)
  })
  it.each(['anon','authenticated'] as const)('denies both historical report functions to %s', async role => {
    await record(); await client.query('SAVEPOINT permissions'); await client.query(`SET LOCAL ROLE ${role}`)
    await expect(inspect()).rejects.toMatchObject({code:'42501'})
    await client.query('ROLLBACK TO SAVEPOINT permissions'); await client.query(`SET LOCAL ROLE ${role}`)
    await expect(inventory()).rejects.toMatchObject({code:'42501'})
  })
  it('allows service inspection while enforcing explicit company scope', async () => {
    await record(); await client.query('SET LOCAL ROLE service_role')
    expect(await inventory()).toHaveLength(1)
    await expect(inspect(randomUUID())).rejects.toMatchObject({code:'P0002'})
  })
  it('requires company scope for a specific event even through the service role', async () => {
    await record(); await expect(inventory(null,startedId)).rejects.toMatchObject({code:'22023'})
  })
  it('runs in a read-only transaction and writes no verification or recovery marker', async () => {
    await record(); await finish(); await client.query('COMMIT')
    await client.query('BEGIN READ ONLY'); await client.query('SET LOCAL ROLE service_role')
    const before=await state(); expect((await inspect()).classification).toBe('consistent-with-completion'); expect(await state()).toEqual(before)
    // This synthetic immutable history fixture intentionally survives; it is
    // the durable example for an operator's read-only CLI verification.
    console.log(JSON.stringify({historicalRecoveryFixture:{companyId:owner.companyId,startedEventId:startedId}}))
  })
})
