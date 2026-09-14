import {randomUUID} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {fork} from 'node:child_process'
import assert from 'node:assert/strict'
import dotenv from 'dotenv'
import pg from 'pg'
import {createClient} from '@supabase/supabase-js'

async function main(){
// Committed synthetic fixtures on the designated staging branch. Retained
// with their accounting history; never uses production or a local database.
Object.assign(process.env,dotenv.parse(readFileSync('.env.sie-runtime.local')),{SIE_IMPORT_JOBS:'true'})
const branch=dotenv.parse(readFileSync('.env.sie.branch.local'))
const url=new URL(branch.POSTGRES_URL)
if(process.env.NEXT_PUBLIC_SUPABASE_URL!=='https://metjnjrhvujscngnpzdv.supabase.co' ||
  !url.username.endsWith('.metjnjrhvujscngnpzdv') || !url.hostname.endsWith('.pooler.supabase.com')) throw new Error('Staging only')
url.searchParams.delete('sslmode')
const database={connectionString:url.toString(),connectionTimeoutMillis:10000,query_timeout:30000,application_name:'sie-acceptance',ssl:{rejectUnauthorized:true,ca:readFileSync('.env.sie-ca.crt','utf8')}}
const db=new pg.Client(database),other=new pg.Client(database)
await db.connect();await other.connect()
const timings:Array<{rpc:string;ms:number}>=[]
const supabase=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{
  auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
    const started=performance.now(),response=await fetch(input,init)
    const path=String(input).split('/rpc/')[1]
    if(path) timings.push({rpc:path,ms:performance.now()-started})
    return response
  }},
})
const {submitSIEJob,requestSIEJobAction}=await import('../../lib/import/sie-jobs')
const {runSIEWorker}=await import('../../lib/import/sie-job-worker')
const report:Record<string,unknown>={startedAt:new Date().toISOString(),project:'metjnjrhvujscngnpzdv',checks:[]}
const checks=report.checks as string[]
type Fixture={company:string;actor:string;period:string}
const resumed=process.argv[2] ? JSON.parse(readFileSync(process.argv[2],'utf8')) as {project:string;fixtures:Fixture[];jobs:string[];checks:string[];rpcTimings:typeof timings} : null
if(resumed && resumed.project!=='metjnjrhvujscngnpzdv') throw new Error('Staging report required')
async function seed(label:string){
  const [company,actor,period]=Array.from({length:3},()=>randomUUID())
  await db.query('BEGIN')
  try {
    await db.query("INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')",[actor,`sie-acceptance-${actor}@test.invalid`])
    await db.query("INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,$2,'aktiebolag',$3)",[company,`SIE acceptance ${label} ${company.slice(0,8)}`,actor])
    await db.query("INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')",[company,actor])
    await db.query("INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')",[period,company,actor])
    await db.query('COMMIT')
    return {company,actor,period}
  } catch(error){await db.query('ROLLBACK');throw error}
}
async function current(id:string){return (await db.query('SELECT * FROM sie_imports WHERE id=$1',[id])).rows[0]}
async function drive(id:string){
  for(let n=0;n<5;n++){
    await runSIEWorker({supabase,importId:id})
    const row=await current(id)
    if(row.job_state==='completed'||row.job_state==='undone') return row
    if(row.error_message) throw new Error(row.error_message)
  }
  throw new Error('Worker did not finish within five bounded invocations')
}
try {
  const first=resumed?.fixtures[0] ?? await seed('recovery'),second=resumed?.fixtures[1] ?? await seed('parallel')
  for(const fixture of [first,second]) {
    const safe=(await db.query("SELECT id FROM companies WHERE id=$1 AND name LIKE 'SIE acceptance%'",[fixture.company])).rowCount
    assert.equal(safe,1,'Synthetic company required')
    await db.query('INSERT INTO company_settings(company_id,user_id) VALUES($1,$2) ON CONFLICT(company_id) DO NOTHING',[fixture.company,fixture.actor])
  }
  report.fixtures=[first,second]
  let job:{id:string},parallel:{id:string}
  if(resumed){
    job={id:resumed.jobs[0]};parallel={id:resumed.jobs[1]}
    report.jobs=resumed.jobs;checks.push(...resumed.checks);timings.push(...resumed.rpcTimings)
    delete report.failure
  } else {
  const content='#FLAGGA 0\n#PROGRAM "SIE acceptance" 1\n#SIETYP 4\n#FNAMN "Synthetic AB"\n#RAR 0 20260101 20261231\n#KONTO 1930 "Bank"\n#KONTO 3001 "Sales"\n'+
    Array.from({length:6000},(_,i)=>`#VER A ${i+1} 20260201 "Synthetic ${i+1}"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}`).join('\n')
  const mappings=['1930','3001'].map(number=>({sourceAccount:number,targetAccount:number,sourceName:number==='1930'?'Bank':'Sales',targetName:'Account',confidence:1,matchType:'exact' as const,isOverride:false}))
  const options={filename:'acceptance-6000.se',createFiscalPeriod:false,importOpeningBalances:false,importTransactions:true,updateAccountNames:true}
  const submitted=await Promise.all([1,2].map(()=>submitSIEJob(supabase,first.company,first.actor,content,mappings,options)))
  assert.equal(submitted[0].id,submitted[1].id)
  checks.push('Concurrent identical submissions return one execution')
  job=submitted[0];parallel=await submitSIEJob(supabase,second.company,second.actor,content,mappings,options)
  report.jobs=[job.id,parallel.id]
  writeFileSync('.env.sie-acceptance.json',JSON.stringify(report,null,2))

  console.log('Submitted both jobs; starting worker fault injection')
  const child=fork('scripts/sie-import/acceptance-worker.ts',[job.id],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']})
  child.stdout?.resume()
  let childError=''
  child.stderr?.on('data',data=>{childError+=String(data).slice(-1500)})
  const killed=new Promise<void>((resolve,reject)=>{
    let requested=false
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Worker never reached third chunk: '+childError))},240_000)
    child.on('message',(message:unknown)=>{
      const event=message as {event?:string;number?:number}
      if(event.event==='chunk-start'&&event.number===3){requested=true;setTimeout(()=>child.kill('SIGKILL'),50)}
    })
    child.on('exit',()=>{clearTimeout(timeout);if(requested) resolve();else reject(new Error('Worker exited before fault injection: '+childError))})
  })
  const parallelResult=drive(parallel.id).then(value=>({value}),error=>({error}))
  await killed
  console.log('Worker terminated; reclaiming expired synthetic lease')
  const dead=await current(job.id)
  assert.ok(dead.chunks_done>=2 && dead.chunks_done<30)
  // Accelerate only the synthetic dead lease; production recovery waits for
  // its real lease timeout plus cron cadence.
  await db.query("UPDATE sie_imports SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND company_id=$2",[job.id,first.company])
  const replacement=randomUUID()
  const claim=await supabase.rpc('claim_sie_import_job',{p_worker_id:replacement,p_import_id:job.id})
  assert.equal(claim.error,null);assert.equal(claim.data.id,job.id)
  const stale=await supabase.rpc('import_sie_chunk',{p_company_id:first.company,p_import_id:job.id,p_worker_id:dead.worker_id,p_attempt:dead.job_attempt,p_phase:'vouchers',p_chunk_no:dead.chunks_done})
  assert.ok(stale.error,'Stale worker must be rejected')
  checks.push('Process killed during chunk request; takeover fences old worker')
  const active=claim.data
  const args={p_company_id:first.company,p_import_id:job.id,p_worker_id:replacement,p_attempt:active.job_attempt,p_phase:'vouchers',p_chunk_no:active.chunks_done}
  const committed=await supabase.rpc('import_sie_chunk',args)
  assert.equal(committed.error,null)
  const replay=await supabase.rpc('import_sie_chunk',args)
  assert.deepEqual(replay.data,committed.data)
  const reconciled=await supabase.rpc('reconcile_sie_import',{p_company_id:first.company,p_import_id:job.id,p_actor:first.actor})
  assert.equal(reconciled.error,null);assert.equal(reconciled.data.job_state,'running')
  const delayed=await supabase.rpc('import_sie_chunk',args)
  assert.ok(delayed.error)
  checks.push('Lost response after commit replays the receipt; reconciliation fences delayed attempts')
  process.env.SIE_IMPORT_JOBS='false'
  console.log('Attempt fencing passed; draining jobs with admission disabled')
  const [finished,parallelOutcome]=await Promise.all([drive(job.id),parallelResult])
  if('error' in parallelOutcome) throw parallelOutcome.error
  const parallelFinished=parallelOutcome.value
  assert.equal(finished.job_state,'completed');assert.equal(parallelFinished.job_state,'completed')
  checks.push('Admission flag off drains both existing jobs')
  for(const [fixture,id] of [[first,job.id],[second,parallel.id]] as const){
    const counts=(await db.query('SELECT count(*)::int n,count(DISTINCT source_ordinal)::int ordinals,min(voucher_number) lo,max(voucher_number) hi FROM journal_entries WHERE import_batch_id=$1 AND company_id=$2',[id,fixture.company])).rows[0]
    assert.deepEqual(counts,{n:6000,ordinals:6000,lo:1,hi:6000})
  }
  checks.push('Both jobs have exactly 6000 vouchers and contiguous numbers 1..6000')
  }

  // Reproduce the lock inversion from review: ordinary booking owns its
  // sequence while the SIE transaction owns the period. Native posting must
  // finish without waiting for the SIE period lock.
  const native=randomUUID()
  await other.query('BEGIN')
  await other.query("SET LOCAL statement_timeout='5s'")
  await other.query("INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,source_type,status) VALUES($1,$2,$3,$4,0,'A','2026-02-02','Concurrent native booking','manual','draft')",[native,first.actor,first.company,first.period])
  await other.query("INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount) VALUES($1,'1930',100,0),($1,'3001',0,100)",[native])
  // Real draft creation commits before the separate posting RPC. Keeping the
  // fixture INSERT open would retain an FK key-share lock on the period and
  // test a different ordering before commit_journal_entry even starts.
  await other.query('COMMIT')
  await other.query('BEGIN')
  await other.query("SET LOCAL statement_timeout='5s'")
  await other.query('SELECT 1 FROM voucher_sequences WHERE company_id=$1 AND fiscal_period_id=$2 FOR UPDATE',[first.company,first.period])
  await db.query('BEGIN')
  await db.query('SELECT 1 FROM fiscal_periods WHERE id=$1 FOR UPDATE',[first.period])
  await other.query('SELECT commit_journal_entry($1,$2)',[first.company,native])
  await other.query('COMMIT');await db.query('COMMIT')
  checks.push('Native same-series commit succeeds while another transaction holds the period')
  await other.query('BEGIN')
  await other.query("SET LOCAL statement_timeout='5s'")
  await other.query('SELECT 1 FROM company_settings WHERE company_id=$1 FOR UPDATE',[first.company])
  await db.query('BEGIN')
  await db.query('SELECT 1 FROM fiscal_periods WHERE id=$1 FOR UPDATE',[first.period])
  await assert.rejects(()=>other.query("UPDATE company_settings SET bookkeeping_locked_through='2026-01-31' WHERE company_id=$1",[first.company]),(error:unknown)=>(error as {code:string}).code==='55P03')
  await other.query('ROLLBACK');await db.query('ROLLBACK')
  checks.push('Lock-date update returns retryable conflict without deadlocking the worker')

  await requestSIEJobAction(supabase,first.company,first.actor,job.id,'undo')
  const undone=await drive(job.id)
  assert.equal(undone.job_state,'undone')
  assert.equal((await db.query("SELECT count(*)::int n FROM journal_entries WHERE company_id=$1 AND import_batch_id=$2 AND status='posted'",[first.company,job.id])).rows[0].n,0)
  assert.equal((await db.query('SELECT status FROM journal_entries WHERE id=$1',[native])).rows[0].status,'posted')
  checks.push('Batch undo leaves the concurrent native voucher posted')
  const chunkMs=timings.filter(t=>t.rpc==='import_sie_chunk').map(t=>t.ms)
  report.maxChunkHttpMs=Math.max(...chunkMs)
  assert.ok(Number(report.maxChunkHttpMs)<10_000,'Chunk HTTP budget exceeded')
  report.finishedAt=new Date().toISOString();report.rpcTimings=timings
  console.log(JSON.stringify({...report,rpcTimings:undefined}))
} catch(error){report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;console.error(report.failure)}
finally {
  await Promise.all([db.query('ROLLBACK').catch(()=>{}),other.query('ROLLBACK').catch(()=>{})])
  report.rpcTimings=timings
  writeFileSync('.env.sie-acceptance.json',JSON.stringify(report,null,2))
  await db.end();await other.end()
}
}
void main().catch(error=>{console.error(error.message);process.exitCode=1})
