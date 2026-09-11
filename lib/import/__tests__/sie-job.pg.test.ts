import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from '@/tests/pg/setup'
import { stagingSIEClient } from '@/tests/pg/sie-client'
import { prepareSIEJob } from '../sie-job-preparation'
import { runSIEWorker } from '../sie-job-worker'
import { createHash } from 'node:crypto'
import type { SIEJob } from '../sie-job-contract'

// Fixtures and optional migration dry run always roll back on staging.
let client: PoolClient
let company: string
let actor: string
let period: string
let worker: string
let job: string
let attempt: number
let accounts: string[]
const manifest = { input: { filename: 'synthetic.se', options: {}, mappings: [], fiscalYear:{start:'2026-01-01',end:'2026-12-31'} }, file_storage_path:'synthetic.se' }

beforeAll(async () => {
  client = await getPool().connect()
  await client.query('BEGIN')
  if (process.env.SIE_MIGRATION_DRY_RUN === '1') {
    await client.query("SET LOCAL lock_timeout = '3s'")
    for (const name of ['20260911140515_sie_import_job_backbone.sql', '20260911140523_sie_import_chunk_writer.sql',
      '20260911140525_sie_import_job_metadata_and_recovery.sql', '20260911140528_sie_import_atomic_batch_storno.sql',
      '20260911140531_sie_import_period_holds.sql', '20260911140532_sie_import_replacement_handoff.sql']) {
      await client.query(readFileSync(`supabase/migrations/${name}`, 'utf8'))
    }
  }
})
afterAll(async () => {
  if (client) { await client.query('ROLLBACK'); client.release() }
})
beforeEach(async () => {
  await client.query('SAVEPOINT scenario')
  ;[company, actor, period, worker] = Array.from({ length: 4 }, () => randomUUID())
  await client.query(`INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`, [actor, `sie-${actor}@test.invalid`])
  await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic SIE AB','aktiebolag',$2)`, [company, actor])
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
  await client.query(`INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')`, [period, company, actor])
  accounts = [randomUUID(), randomUUID()]
  for (const [i, number] of ['1930','3001'].entries()) {
    await client.query(`INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance) VALUES($1,$2,$3,$4,'Synthetic account',$5,$6,$7)`, [accounts[i], company, actor, number, i ? 'revenue' : 'asset', i ? 3 : 1, i ? 'credit' : 'debit'])
  }
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
  const started = await client.query(`SELECT (start_sie_import_job($1,$2,$3,'synthetic.se',$4,$5)).id`, [company, actor, period, 'a'.repeat(64), JSON.stringify(manifest)])
  job = started.rows[0].id
  const claimed = await client.query(`SELECT j.* FROM claim_sie_import_job($1,$2) j`, [worker, job])
  attempt = claimed.rows[0].job_attempt
})
afterEach(async () => { await client.query('ROLLBACK TO SAVEPOINT scenario') })

function voucher(ordinal: number, amount = 100) {
  return { sourceId: `A${ordinal + 1}`, sourceOrdinal: ordinal, sieImportId: job,
    series: 'A', date: '2026-02-01', description: 'Synthetic voucher', sourceSeries: 'A',
    sourceNumber: ordinal + 1, sourceType: 'import', lines: [
      { account_number: '1930', account_id: accounts[0], debit_amount: amount, credit_amount: 0, dimensions: {} },
      { account_number: '3001', account_id: accounts[1], debit_amount: 0, credit_amount: amount, dimensions: {} },
    ] }
}
async function prepare(payloads = [[voucher(0)], [voucher(1)]]) {
  for (const [index, payload] of payloads.entries()) {
    await client.query('SELECT save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)', [company,job,worker,attempt,'vouchers',index,JSON.stringify(payload)])
  }
  await client.query('SELECT seal_sie_import_preparation($1,$2,$3,$4,$5,$6)', [company,job,worker,attempt,JSON.stringify(manifest),payloads.length])
}
async function chunk(index: number) {
  return (await client.query('SELECT import_sie_chunk($1,$2,$3,$4,$5,$6) result', [company,job,worker,attempt,'vouchers',index])).rows[0].result
}
async function rejects(query: () => Promise<unknown>, message: RegExp) {
  await client.query('SAVEPOINT expected_error')
  await expect(query()).rejects.toThrow(message)
  await client.query('ROLLBACK TO SAVEPOINT expected_error')
}

describe('SIE database execution protocol', () => {
  it('pins optional chunk audit before writes and retains exact voucher identities once', async () => {
    await client.query('SELECT set_sie_import_audit_mode($1,$2,$3,$4,$5)',[company,job,worker,attempt,'chunk'])
    await prepare([[voucher(0),voucher(1)]])
    const receipt=await chunk(0)
    await chunk(0)
    const headerAudit=await client.query("SELECT count(*)::int n FROM audit_log WHERE company_id=$1 AND table_name='journal_entries'",[company])
    expect(headerAudit.rows[0].n).toBe(0)
    const chunkAudit=await client.query("SELECT new_state FROM audit_log WHERE company_id=$1 AND table_name='sie_import_chunks'",[company])
    expect(chunkAudit.rows).toHaveLength(1)
    expect(chunkAudit.rows[0].new_state.entries).toEqual(receipt.inserted_entries)
    expect(chunkAudit.rows[0].new_state.payload_hash).toMatch(/^[a-f0-9]{64}$/)
    await rejects(()=>client.query('SELECT set_sie_import_audit_mode($1,$2,$3,$4,$5)',[company,job,worker,attempt,'full']),/before journal writes/)
    expect((await client.query("SELECT has_function_privilege('authenticated','set_sie_import_audit_mode(uuid,uuid,uuid,integer,text)','EXECUTE') permitted")).rows[0].permitted).toBe(false)
  })
  it('keeps full header auditing by default', async () => {
    await prepare([[voucher(0)]])
    const result=await chunk(0)
    expect((await client.query("SELECT count(*)::int n FROM audit_log WHERE company_id=$1 AND record_id=$2 AND table_name='journal_entries'",[company,result.inserted_entries[0].id])).rows[0].n).toBeGreaterThan(0)
  })
  it('rejects a source year and voucher date outside the selected period', async () => {
    const forged = {...manifest,input:{...manifest.input,fiscalYear:{start:'2025-01-01',end:'2025-12-31'}}}
    await rejects(()=>client.query('SELECT start_sie_import_job($1,$2,$3,$4,$5,$6)',
      [company,actor,period,'wrong-year.se','b'.repeat(64),JSON.stringify(forged)]),/source fiscal year/)
    await prepare([[{...voucher(0),date:'2025-02-01'}]])
    await rejects(()=>chunk(0),/outside the target fiscal period/)
    expect((await client.query('SELECT count(*)::int n FROM journal_entries WHERE import_batch_id=$1',[job])).rows[0].n).toBe(0)
  })
  it('discards caller-supplied progress before workers read the manifest', async () => {
    await client.query('SELECT fail_sie_preparation($1,$2,$3,$4,$5)',[company,job,worker,attempt,'Test refusal'])
    const forged={...manifest,snapshotComplete:true,preparedGroups:9999,preparationTotals:{entries:1},prior_activity:true}
    const row=(await client.query('SELECT j.* FROM start_sie_import_job($1,$2,$3,$4,$5,$6) j',
      [company,actor,period,'forged.se','b'.repeat(64),JSON.stringify(forged)])).rows[0]
    expect(row.manifest).toEqual({...manifest,originalSource:null,prior_activity:false})
    expect(row.chunks_done).toBe(0)
  })
  it('rejects undo while a different year of the company is importing', async () => {
    await prepare([[voucher(0)]])
    await chunk(0)
    await client.query('SELECT complete_sie_import_job($1,$2,$3,$4,$5,$6)',
      [company,job,worker,attempt,JSON.stringify({success:true,journalEntriesCreated:1}),'{}'])
    const nextPeriod=randomUUID()
    await client.query('RESET ROLE')
    await client.query("INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2027','2027-01-01','2027-12-31')",[nextPeriod,company,actor])
    await client.query('SET LOCAL ROLE service_role')
    const nextManifest={...manifest,input:{...manifest.input,fiscalYear:{start:'2027-01-01',end:'2027-12-31'}}}
    await client.query('SELECT start_sie_import_job($1,$2,$3,$4,$5,$6)',[company,actor,nextPeriod,'2027.se','b'.repeat(64),JSON.stringify(nextManifest)])
    await rejects(()=>client.query('SELECT request_sie_import_undo($1,$2,$3)',[company,job,actor]),/Another SIE execution/)
  })
  it('prepares a file, resumes with persisted chunks, and finalizes through the real engine', async () => {
    const content = '#FLAGGA 0\n#PROGRAM "Synthetic" 1\n#SIETYP 4\n#FNAMN "Synthetic AB"\n#RAR 0 20260101 20261231\n#KONTO 1930 "Bank"\n#KONTO 3001 "Sales"\n'+
      Array.from({length:205},(_,i)=>`#VER A ${i+1} 20260201 "Test"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}`).join('\n')
    const hash = createHash('sha256').update(content).digest('hex')
    const mappings = ['1930','3001'].map(number=>({sourceAccount:number,targetAccount:number,sourceName:number === '1930' ? 'Bank' : 'Sales',
      targetName:'Account',confidence:1,matchType:'exact',isOverride:false}))
    const input = {version:1,sourceHash:hash,mappings,options:{filename:'synthetic.se',createFiscalPeriod:true,
      importOpeningBalances:false,importTransactions:true,updateAccountNames:true,markImportedNoDocRequired:true}}
    await client.query('RESET ROLE')
    await client.query('UPDATE sie_imports SET manifest=$1,file_hash=$2,file_storage_path=$3 WHERE id=$4',
      [JSON.stringify({input,prior_activity:false}),hash,`${company}/sie-jobs/${hash}.se`,job])
    await client.query('SET LOCAL ROLE service_role')
    const state = (await client.query('SELECT * FROM sie_imports WHERE id=$1',[job])).rows[0] as SIEJob
    const supabase = stagingSIEClient(client,content)
    expect(await prepareSIEJob(supabase,state,Date.now()+30_000)).toBe(true)
    await client.query('SELECT yield_sie_import_job($1,$2,$3,$4)',[company,job,worker,attempt])
    await runSIEWorker({supabase,importId:job,budgetMs:60_000})
    const finished = (await client.query('SELECT * FROM sie_imports WHERE id=$1',[job])).rows[0]
    expect(finished.error_message).toBeNull()
    expect(finished.job_state).toBe('completed')
    expect(finished.transactions_count).toBe(205)
    expect(finished.job_result.journalEntriesCreated).toBe(205)
    expect((await client.query('SELECT count(*)::int n FROM journal_entry_no_doc_required WHERE company_id=$1',[company])).rows[0].n).toBe(205)
    expect((await client.query("SELECT count(*)::int n FROM sie_import_chunks WHERE import_id=$1 AND phase='vouchers' AND payload IS NOT NULL",[job])).rows[0].n).toBe(0)
  },60_000)
  it('keeps a replacement queued through resume and hands over the hold atomically', async () => {
    await prepare([[voucher(0)]])
    await chunk(0)
    await client.query('SELECT complete_sie_import_job($1,$2,$3,$4,$5,$6)',
      [company,job,worker,attempt,JSON.stringify({success:true,journalEntriesCreated:1}),'{}'])
    const args = [company,actor,period,'synthetic.se','a'.repeat(64),JSON.stringify(manifest),job]
    const next = (await client.query('SELECT j.* FROM replace_sie_import_job($1,$2,$3,$4,$5,$6,$7) j',args)).rows[0]
    expect((await client.query('SELECT j.* FROM replace_sie_import_job($1,$2,$3,$4,$5,$6,$7) j',args)).rows[0].id).toBe(next.id)
    expect((await client.query('SELECT j.* FROM resume_sie_import_job($1,$2,$3) j',[company,next.id,actor])).rows[0].job_state).toBe('queued')
    expect((await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j',[worker,next.id])).rows[0].id).toBeNull()
    attempt = (await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j',[worker,job])).rows[0].job_attempt
    for (let i=0;i<2;i++) await client.query('SELECT undo_sie_import_chunk($1,$2,$3,$4)',[company,job,worker,attempt])
    expect((await client.query('SELECT import_hold FROM fiscal_periods WHERE id=$1',[period])).rows[0].import_hold).toBe(next.id)
    expect((await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j',[worker,next.id])).rows[0].id).toBe(next.id)
  })
  it('undoes a completed job without rewriting its completed operation', async () => {
    await prepare([[voucher(0)]])
    await chunk(0)
    await client.query('SELECT complete_sie_import_job($1,$2,$3,$4,$5,$6)',
      [company,job,worker,attempt,JSON.stringify({success:true,journalEntriesCreated:1}),'{}'])
    await client.query('SELECT request_sie_import_undo($1,$2,$3)',[company,job,actor])
    attempt = (await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j',[worker,job])).rows[0].job_attempt
    for (let i=0;i<2;i++) await client.query('SELECT undo_sie_import_chunk($1,$2,$3,$4)',[company,job,worker,attempt])
    expect((await client.query('SELECT job_state FROM sie_imports WHERE id=$1',[job])).rows[0].job_state).toBe('undone')
    expect((await client.query('SELECT status FROM operations WHERE id=$1',[job])).rows[0].status).toBe('succeeded')
    const next = await client.query('SELECT j.* FROM start_sie_import_job($1,$2,$3,$4,$5,$6,$7) j',
      [company,actor,period,'synthetic.se','a'.repeat(64),JSON.stringify(manifest),job])
    expect(next.rows[0].supersedes_import_id).toBe(job)
    expect(next.rows[0].manifest.prior_activity).toBe(false)
  })
  it('reverses only this batch and resumes without a second storno', async () => {
    await prepare()
    await chunk(0)
    await client.query('SELECT request_sie_import_undo($1,$2,$3)',[company,job,actor])
    const claimed = await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j',[worker,job])
    attempt = claimed.rows[0].job_attempt
    const undo = () => client.query('SELECT undo_sie_import_chunk($1,$2,$3,$4) result',[company,job,worker,attempt])
    expect((await undo()).rows[0].result).toEqual({reversed:1,done:false})
    expect((await undo()).rows[0].result).toEqual({reversed:0,done:true})
    const totals = await client.query(`SELECT status,count(*)::int n FROM journal_entries WHERE company_id=$1 GROUP BY status`,[company])
    expect(totals.rows).toEqual(expect.arrayContaining([{status:'posted',n:1},{status:'reversed',n:1}]))
    expect((await client.query('SELECT import_hold FROM fiscal_periods WHERE id=$1',[period])).rows[0].import_hold).toBeNull()
  })
  it('retains documents and imported dimension history while releasing bank matches on undo',async()=>{
    const dimension=(await client.query(`INSERT INTO dimensions(company_id,sie_dim_no,name,resets_annually,is_system,created_by_import_id)
      VALUES($1,20,'Imported dimension',true,false,$2) RETURNING id`,[company,job])).rows[0].id
    const value=(await client.query(`INSERT INTO dimension_values(company_id,dimension_id,code,name,created_by_import_id)
      VALUES($1,$2,'X','Imported value',$3) RETURNING id`,[company,dimension,job])).rows[0].id
    const entry=voucher(0);entry.lines[0].dimensions={'20':'X'}
    await prepare([[entry]])
    const receipt=await chunk(0),id=receipt.inserted_entries[0].id
    await client.query('SELECT complete_sie_import_job($1,$2,$3,$4,$5,$6)',[company,job,worker,attempt,'{"success":true}','{}'])
    const doc=(await client.query(`INSERT INTO document_attachments(company_id,user_id,storage_path,file_name,sha256_hash,journal_entry_id,upload_source)
      VALUES($1,$2,'test/retained.pdf','retained.pdf','synthetic',$3,'file_upload') RETURNING id`,[company,actor,id])).rows[0].id
    const bank=(await client.query(`INSERT INTO transactions(company_id,user_id,date,amount,description,journal_entry_id)
      VALUES($1,$2,'2026-02-01',100,'Matched imported voucher',$3) RETURNING id`,[company,actor,id])).rows[0].id
    await client.query('SELECT request_sie_import_undo($1,$2,$3)',[company,job,actor])
    attempt=(await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j',[worker,job])).rows[0].job_attempt
    for(let i=0;i<2;i++) await client.query('SELECT undo_sie_import_chunk($1,$2,$3,$4)',[company,job,worker,attempt])
    expect((await client.query('SELECT journal_entry_id FROM document_attachments WHERE id=$1',[doc])).rows[0].journal_entry_id).toBe(id)
    expect((await client.query('SELECT journal_entry_id FROM transactions WHERE id=$1',[bank])).rows[0].journal_entry_id).toBeNull()
    expect((await client.query('SELECT created_by_import_id FROM dimension_values WHERE id=$1',[value])).rows[0].created_by_import_id).toBe(job)
    expect((await client.query("SELECT count(*)::int n FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.company_id=$1 AND l.dimensions->>'20'='X'",[company])).rows[0].n).toBe(2)
    await rejects(()=>client.query('DELETE FROM sie_imports WHERE id=$1',[job]),/cannot be deleted/)
  })
  it('checkpoints account-name changes and restores them on undo', async () => {
    await prepare([[voucher(0)]])
    await chunk(0)
    const args = [company,job,worker,attempt,50000,'account_names',JSON.stringify([{account_number:'1930',name:'Renamed bank'}])]
    const first = await client.query('SELECT apply_sie_import_metadata($1,$2,$3,$4,$5,$6,$7) result',args)
    expect((await client.query('SELECT apply_sie_import_metadata($1,$2,$3,$4,$5,$6,$7) result',args)).rows).toEqual(first.rows)
    await client.query('SELECT request_sie_import_undo($1,$2,$3)',[company,job,actor])
    attempt = (await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j',[worker,job])).rows[0].job_attempt
    for (let i=0;i<3;i++) await client.query('SELECT undo_sie_import_chunk($1,$2,$3,$4)',[company,job,worker,attempt])
    expect((await client.query('SELECT account_name FROM chart_of_accounts WHERE id=$1',[accounts[0]])).rows[0].account_name).toBe('Synthetic account')
  })
  it('replays committed chunks without duplicate entries or consumed numbers', async () => {
    await prepare()
    const first = await chunk(0)
    expect(await chunk(0)).toEqual(first)
    expect((await client.query('SELECT count(*)::int n FROM journal_entries WHERE import_batch_id=$1',[job])).rows[0].n).toBe(1)
    expect((await client.query('SELECT last_number FROM voucher_sequences WHERE company_id=$1',[company])).rows[0].last_number).toBe(1)
    await chunk(1)
    expect((await client.query('SELECT job_state,chunks_done FROM sie_imports WHERE id=$1',[job])).rows[0]).toEqual({ job_state: 'finalizing', chunks_done: 2 })
  })
  it('reconciles a middle chunk and fences a delayed old request', async () => {
    await prepare()
    await chunk(0)
    const result = await client.query('SELECT j.* FROM reconcile_sie_import($1,$2,$3) j',[company,job,actor])
    expect(result.rows[0].job_state).toBe('running')
    expect(result.rows[0].chunks_done).toBe(1)
    await rejects(() => chunk(1), /stale/)
  })
  it('refuses out-of-order chunks and period closing under a hold', async () => {
    await prepare()
    await rejects(() => chunk(1), /out of order/)
    await rejects(() => client.query('UPDATE fiscal_periods SET is_closed=true WHERE id=$1',[period]), /unfinished/)
  })
  it('rolls back an unbalanced chunk with its reservation and completion receipt', async () => {
    const invalid = voucher(0)
    invalid.lines[1].credit_amount = 90
    await prepare([[invalid]])
    await rejects(() => chunk(0), /unbalanced|balanc/i)
    expect((await client.query('SELECT count(*)::int n FROM journal_entries WHERE import_batch_id=$1',[job])).rows[0].n).toBe(0)
    expect((await client.query('SELECT chunks_done FROM sie_imports WHERE id=$1',[job])).rows[0].chunks_done).toBe(0)
  })
  it('refuses a changed retry payload and a different-company batch', async () => {
    await client.query('SELECT save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)',[company,job,worker,attempt,'vouchers',0,JSON.stringify([voucher(0)])])
    await rejects(() => client.query('SELECT save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)',[company,job,worker,attempt,'vouchers',0,JSON.stringify([voucher(0,200)])]), /changed payload/)
    await rejects(() => client.query('SELECT import_sie_chunk($1,$2,$3,$4,$5,$6)',[randomUUID(),job,worker,attempt,'vouchers',0]), /not found/)
  })
  it('retains execution metadata even if a direct caller tries deleting it', async () => {
    await rejects(() => client.query('DELETE FROM sie_imports WHERE id=$1',[job]), /cannot be deleted/)
    await rejects(() => client.query("UPDATE sie_imports SET job_state='completed' WHERE id=$1",[job]), /authorized RPC/)
  })
  it('excludes financial downloads and new imports with a database read lease', async () => {
    await rejects(() => client.query("SELECT acquire_sie_period_read($1,'report_export')",[company]), /SIE_IMPORT_HOLD/)
    await client.query('SELECT fail_sie_preparation($1,$2,$3,$4,$5)',[company,job,worker,attempt,'Synthetic refusal'])
    const token = (await client.query("SELECT acquire_sie_period_read($1,'report_export') token",[company])).rows[0].token
    await rejects(() => client.query('SELECT start_sie_import_job($1,$2,$3,$4,$5,$6)',
      [company,actor,period,'synthetic.se','c'.repeat(64),JSON.stringify(manifest)]), /export|submission/i)
    await client.query('SELECT finish_sie_period_read($1,$2,true)',[company,token])
    await rejects(() => client.query('SELECT finish_sie_period_read($1,$2,true)',[company,token]), /expired/)
  })
})
