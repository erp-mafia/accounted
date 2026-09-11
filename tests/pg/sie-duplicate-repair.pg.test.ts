import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from './setup'

let client: PoolClient
let company: string, actor: string, period: string, keep: string, reverse: string, worker: string
let pairs: Array<{keepId:string;reverseId:string;contentHash:string;keepLinks:unknown[];reverseLinks:unknown[]}>

beforeAll(async () => { client=await getPool().connect();await client.query('BEGIN') })
afterAll(async () => { if(client){await client.query('ROLLBACK');client.release()} })
beforeEach(async () => {
  await client.query('SAVEPOINT scenario')
  ;[company,actor,period,keep,reverse,worker]=Array.from({length:6},()=>randomUUID())
  await client.query("INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')",[actor,`sie-repair-${actor}@test.invalid`])
  await client.query("INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic legacy repair','aktiebolag',$2)",[company,actor])
  await client.query("INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')",[company,actor])
  await client.query("INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')",[period,company,actor])
  for(const [number,type,klass,side] of [['1930','asset',1,'debit'],['3001','revenue',3,'credit']]) await client.query(
    'INSERT INTO chart_of_accounts(company_id,user_id,account_number,account_name,account_type,account_class,normal_balance) VALUES($1,$2,$3,$3,$4,$5,$6)',
    [company,actor,number,type,klass,side])
  // Simulate rows predating this change. Only the NEW provenance guard is
  // temporarily disabled, inside a rollback-only fixture transaction. Every
  // accounting enforcement trigger stays active, including balance/locks.
  await client.query('ALTER TABLE journal_entries DISABLE TRIGGER guard_sie_entry_provenance')
  for(const [index,id] of [keep,reverse].entries()) {
    await client.query("INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,voucher_series,voucher_number,source_type,source_voucher_series,source_voucher_number,entry_date,description,status) VALUES($1,$2,$3,$4,'A',$5,'import','A',1,'2026-02-01','Legacy duplicate','draft')",[id,company,actor,period,index+1])
    await client.query("INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount) VALUES($1,'1930',100,0),($1,'3001',0,100)",[id])
  }
  await client.query('ALTER TABLE journal_entries ENABLE TRIGGER guard_sie_entry_provenance')
  await client.query("UPDATE journal_entries SET status='posted' WHERE id=ANY($1)",[[keep,reverse]])
  await client.query("INSERT INTO voucher_sequences(company_id,user_id,fiscal_period_id,voucher_series,last_number) VALUES($1,$2,$3,'A',2)",[company,actor,period])
  const hash=(await client.query('SELECT sie_repair_content_hash($1) hash',[keep])).rows[0].hash
  pairs=[{keepId:keep,reverseId:reverse,contentHash:hash,keepLinks:[],reverseLinks:[]}]
  await client.query("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")
  await client.query("SELECT set_config('request.jwt.claim.role','service_role',true)")
  await client.query('SET LOCAL ROLE service_role')
})
afterEach(async () => { await client.query('ROLLBACK TO SAVEPOINT scenario') })

async function stage(items=pairs,hash='d'.repeat(64)) {
  return (await client.query('SELECT j.* FROM stage_sie_duplicate_repair($1,$2,$3,$4,$5) j',
    [company,actor,period,hash,JSON.stringify(items)])).rows[0]
}
async function stop(id:string) {
  return (await client.query('SELECT j.* FROM stop_sie_duplicate_repair($1,$2,$3,$4,$5) j',
    [company,id,actor,'d'.repeat(64),'Stop for a new reviewed scope'])).rows[0]
}
async function claim(id:string) {return (await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j',[worker,id])).rows[0]}
async function undo(id:string,attempt:number) {
  return (await client.query('SELECT undo_sie_duplicate_repair_chunk($1,$2,$3,$4) result',[company,id,worker,attempt])).rows[0].result
}
async function rejects(fn:()=>Promise<unknown>,message:RegExp) {
  await client.query('SAVEPOINT refusal');await expect(fn()).rejects.toThrow(message);await client.query('ROLLBACK TO SAVEPOINT refusal')
}

describe('reviewed legacy duplicate repair', () => {
  it('replays the exact repair without changing provenance or reversing the keeper', async () => {
    const job=await stage()
    expect((await stage()).id).toBe(job.id)
    const owned=await claim(job.id)
    await rejects(()=>client.query('SELECT undo_sie_import_chunk($1,$2,$3,$4)',[company,job.id,worker,owned.job_attempt]),/not undoing/)
    expect(await undo(job.id,owned.job_attempt)).toEqual({reversed:1,done:false})
    expect(await undo(job.id,owned.job_attempt)).toEqual({reversed:0,done:true})
    const rows=(await client.query('SELECT id,status,import_batch_id,reversed_by_id FROM journal_entries WHERE id=ANY($1) ORDER BY id',[[keep,reverse]])).rows
    expect(rows.find(r=>r.id===keep).status).toBe('posted')
    expect(rows.find(r=>r.id===reverse).status).toBe('reversed')
    expect(rows.every(r=>r.import_batch_id===null)).toBe(true)
    expect((await client.query('SELECT reversal_id FROM sie_duplicate_repair_items WHERE import_id=$1',[job.id])).rows[0].reversal_id).toBe(rows.find(r=>r.id===reverse).reversed_by_id)
    expect((await client.query('SELECT last_number FROM voucher_sequences WHERE company_id=$1',[company])).rows[0].last_number).toBe(3)
  })
  it('refuses a changed content review before creating any storno', async () => {
    const job=await stage([{...pairs[0],contentHash:'f'.repeat(64)}])
    const owned=await claim(job.id)
    await rejects(()=>undo(job.id,owned.job_attempt),/review changed/)
    expect((await client.query("SELECT count(*)::int n FROM journal_entries WHERE company_id=$1 AND source_type='storno'",[company])).rows[0].n).toBe(0)
    const stopped=await stop(job.id)
    expect(stopped.job_result).toMatchObject({repairOutcome:'stopped',reversed:0,cancelled:1})
    await rejects(()=>client.query('SELECT request_sie_import_undo($1,$2,$3)',[company,job.id,actor]),/reviewed stop action/)
    await rejects(()=>client.query('SELECT replace_sie_import_job($1,$2,$3,$4,$5,$6,$7)',
      [company,actor,period,'cannot-replace-repair.se','b'.repeat(64),'{}',job.id]),/reviewed reconciliation/)
    expect((await client.query('SELECT import_hold FROM fiscal_periods WHERE id=$1',[period])).rows[0].import_hold).toBeNull()
    await rejects(()=>undo(job.id,owned.job_attempt),/stale/)
    const replacement=await stage(pairs,'e'.repeat(64))
    expect(replacement.id).not.toBe(job.id)
    expect((await client.query('SELECT cancelled_at FROM sie_duplicate_repair_items WHERE import_id=$1',[job.id])).rows[0].cancelled_at).not.toBeNull()
    const next=await claim(replacement.id)
    expect(await undo(replacement.id,next.job_attempt)).toEqual({reversed:1,done:false})
  })
  it('stopping preserves completed reversal receipts and cannot change the reviewed digest', async () => {
    const job=await stage(),owned=await claim(job.id)
    await undo(job.id,owned.job_attempt)
    await rejects(()=>client.query('SELECT stop_sie_duplicate_repair($1,$2,$3,$4,$5)',
      [company,job.id,actor,'f'.repeat(64),'Stop for a new reviewed scope']),/exact approved review/)
    const stopped=await stop(job.id)
    expect(stopped.job_result).toMatchObject({repairOutcome:'stopped',reversed:1,cancelled:0})
    expect((await stop(job.id)).job_result).toEqual(stopped.job_result)
    const item=(await client.query('SELECT reversal_id,cancelled_at FROM sie_duplicate_repair_items WHERE import_id=$1',[job.id])).rows[0]
    expect(item.reversal_id).not.toBeNull();expect(item.cancelled_at).toBeNull()
  })
  it('refuses linked-record changes made after the reviewed snapshot', async () => {
    await client.query("INSERT INTO transactions(company_id,user_id,date,amount,description,journal_entry_id) VALUES($1,$2,'2026-02-01',100,'Changed after review',$3)",[company,actor,reverse])
    const job=await stage(),owned=await claim(job.id)
    await rejects(()=>undo(job.id,owned.job_attempt),/review changed/)
    await stop(job.id)
  })
  it('holds both legacy targets against inline changes and new bank matches', async () => {
    const job=await stage()
    await rejects(()=>client.query("UPDATE journal_entries SET description='Changed' WHERE id=$1",[keep]),/SIE_IMPORT_HOLD|immutable/i)
    await rejects(()=>client.query('UPDATE journal_entry_lines SET sort_order=1 WHERE journal_entry_id=$1',[reverse]),/SIE_IMPORT_HOLD|posted journal/i)
    const line=(await client.query("SELECT id FROM journal_entry_lines WHERE journal_entry_id=$1 AND account_number='1930'",[reverse])).rows[0].id
    await rejects(()=>client.query('SELECT correct_entry_lines_inline($1,$2,$3,$4,$5)',[company,reverse,[line],
      JSON.stringify([{account_number:'1930',debit_amount:100,credit_amount:0,line_description:'Reviewed correction'}]),actor]),/SIE_IMPORT_HOLD/)
    // Direct invocation of the same trigger through a minimal bank row.
    await rejects(()=>client.query("INSERT INTO transactions(company_id,user_id,date,amount,description,journal_entry_id) VALUES($1,$2,'2026-02-01',100,'Repair race',$3)",[company,actor,keep]),/SIE_IMPORT_HOLD/)
    await rejects(()=>client.query('DELETE FROM sie_duplicate_repair_items WHERE import_id=$1',[job.id]),/permission denied/)
  })
  it('rejects overlapping targets and foreign entry identities', async () => {
    await rejects(()=>stage([pairs[0],pairs[0]]),/overlap/)
    await rejects(()=>stage([{...pairs[0],keepId:randomUUID()}]),/exact legacy duplicate/)
    expect((await client.query("SELECT has_function_privilege('authenticated','stage_sie_duplicate_repair(uuid,uuid,uuid,text,jsonb)','EXECUTE') allowed")).rows[0].allowed).toBe(false)
  })
})
