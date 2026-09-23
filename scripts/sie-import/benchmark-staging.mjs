import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import dotenv from 'dotenv'
import pg from 'pg'

// Controlled synthetic benchmark. Both schemas and business data roll back.
// It measures WAL generated, not physical disk bytes; checkpoint/disk metrics
// must be reviewed separately. No production target or local fallback exists.
const config = dotenv.parse(readFileSync('.env.sie.branch.local'))
const url = new URL(config.POSTGRES_URL)
if (!url.username.endsWith('.metjnjrhvujscngnpzdv') || !url.hostname.endsWith('.pooler.supabase.com')) throw new Error('Staging only')
url.searchParams.delete('sslmode')
const client = new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca:readFileSync('.env.sie-ca.crt','utf8')}})
await client.connect()
const migrationNames = readdirSync('supabase/migrations').filter(name=>/^20260911\d{6}_sie_(import_|job_)/.test(name)).sort()
const installed = (await client.query("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sie_imports' AND column_name='job_state') installed")).rows[0].installed
const measurements = []
const modes = installed && process.argv.includes('--compare-audit') ? ['durable','chunk-audit'] : installed ? ['durable'] : ['baseline','durable']
try {
  for (const mode of modes) {
    await client.query('BEGIN')
    try {
      await client.query("SET LOCAL lock_timeout='3s'")
      await client.query("SET LOCAL statement_timeout='60s'")
      if (mode === 'durable' && !installed) for (const file of migrationNames) await client.query(readFileSync('supabase/migrations/'+file,'utf8'))
      const [company,actor,period,worker] = Array.from({length:4},()=>randomUUID())
      await client.query("INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')",[actor,`sie-bench-${actor}@test.invalid`])
      await client.query("INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'SIE synthetic benchmark','aktiebolag',$2)",[company,actor])
      await client.query("INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')",[company,actor])
      await client.query("INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')",[period,company,actor])
      const accountIds = [randomUUID(),randomUUID()]
      for (const [i,number] of ['1930','3001'].entries()) await client.query(
        'INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',
        [accountIds[i],company,actor,number,i?'revenue':'asset',i?3:1,i?'credit':'debit'])
      await client.query("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")
      await client.query('SET LOCAL ROLE service_role')
      let job,attempt
      const manifest = {input:{version:1,sourceHash:'b'.repeat(64),options:{},mappings:[],fiscalYear:{start:'2026-01-01',end:'2026-12-31'}},file_storage_path:'synthetic.se'}
      if (mode !== 'baseline') {
        job = (await client.query("SELECT (start_sie_import_job($1,$2,$3,'synthetic.se',$4,$5)).id",[company,actor,period,'b'.repeat(64),JSON.stringify(manifest)])).rows[0].id
        attempt = (await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j',[worker,job])).rows[0].job_attempt
        if (mode === 'chunk-audit') await client.query('SELECT set_sie_import_audit_mode($1,$2,$3,$4,$5)',[company,job,worker,attempt,'chunk'])
      }
      const entries = Array.from({length:6000},(_,i)=>({sourceId:`A${i+1}`,sourceOrdinal:i,sieImportId:job,
        series:'A',date:'2026-02-01',description:'Synthetic benchmark voucher',sourceSeries:'A',sourceNumber:i+1,sourceType:'import',
        lines:[{account_number:'1930',account_id:accountIds[0],debit_amount:100,credit_amount:0,currency:'SEK',dimensions:{}},
          {account_number:'3001',account_id:accountIds[1],debit_amount:0,credit_amount:100,currency:'SEK',dimensions:{}}]}))
      const before = (await client.query('SELECT pg_current_wal_insert_lsn()::text AS lsn')).rows[0].lsn
      const started = performance.now(),durations=[]
      let plan
      if (mode === 'baseline') {
        const result = await client.query('EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT import_sie_journal_entries($1,$2,$3,$4)',[company,actor,period,JSON.stringify(entries)])
        plan = result.rows[0]['QUERY PLAN'][0]
        await client.query('SET CONSTRAINTS ALL IMMEDIATE')
        durations.push(performance.now()-started)
      } else {
        for(let n=0;n<30;n++) await client.query('SELECT save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)',[company,job,worker,attempt,'vouchers',n,JSON.stringify(entries.slice(n*200,(n+1)*200))])
        await client.query('SELECT seal_sie_import_preparation($1,$2,$3,$4,$5,$6)',[company,job,worker,attempt,JSON.stringify(manifest),30])
        const plans=[]
        for(let n=0;n<30;n++) {
          const start=performance.now()
          const result=await client.query('EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT import_sie_chunk($1,$2,$3,$4,$5,$6)',[company,job,worker,attempt,'vouchers',n])
          await client.query('SET CONSTRAINTS ALL IMMEDIATE')
          durations.push(performance.now()-start)
          plans.push(result.rows[0]['QUERY PLAN'][0])
        }
        plan=plans
      }
      const elapsedMs=performance.now()-started
      const walBytes=Number((await client.query('SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1)::text bytes',[before])).rows[0].bytes)
      const counts=(await client.query('SELECT count(*)::int headers,count(DISTINCT source_voucher_number)::int sources,min(voucher_number) lo,max(voucher_number) hi FROM journal_entries WHERE company_id=$1',[company])).rows[0]
      if(counts.headers!==6000 || counts.sources!==6000 || counts.lo!==1 || counts.hi!==6000) throw new Error('Benchmark correctness failed')
      const sorted=[...durations].sort((a,b)=>a-b)
      const measurement={mode,vouchers:6000,lines:12000,elapsedMs,maxRpcMs:Math.max(...durations),p95RpcMs:sorted[Math.ceil(sorted.length*.95)-1],
        walBytesObserved:walBytes,walMiBPer1000:walBytes/1024/1024/6,counts,plans:plan}
      measurements.push(measurement)
      console.log(JSON.stringify({...measurement,plans:undefined}))
    } catch (error) {
      measurements.push({mode,error:error.message,code:error.code})
      console.log(JSON.stringify(measurements.at(-1)))
      if (mode === 'durable') process.exitCode=1
    } finally {await client.query('ROLLBACK')}
  }
  writeFileSync('.env.sie-benchmark.json',JSON.stringify({at:new Date().toISOString(),project:'metjnjrhvujscngnpzdv',
    note:'Single connection, rollback-only; WAL LSN includes any concurrent background writes. RPC plans contain query-attributed buffers and WAL. Not concurrent/HTTP acceptance.',measurements},null,2))
} finally {await client.end()}
