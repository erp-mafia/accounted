import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

// Uses only the existing synthetic browser company on designated staging.
// Leaves the renewed review visible for browser verification.
async function main() {
Object.assign(process.env, dotenv.parse(readFileSync('.env.sie-runtime.local')), { SIE_IMPORT_JOBS: 'true' })
assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, 'https://metjnjrhvujscngnpzdv.supabase.co')
const fixture = JSON.parse(readFileSync('.env.sie-ui.json', 'utf8'))
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) },
})
const company = await client.from('companies').select('name').eq('id', fixture.company).single()
assert.ok(company.data?.name.startsWith('SIE acceptance'))
assert.ok(fixture.email.endsWith('@test.invalid'))
const { createJournalEntry } = await import('../../lib/bookkeeping/engine')
const { submitSIEJob, requestSIEJobAction } = await import('../../lib/import/sie-jobs')
const { runSIEWorker } = await import('../../lib/import/sie-job-worker')
const reportPath = '.env.sie-manual-review.json'
let report: { sourcePeriod:string; nextPeriod:string; openingEntry:string; job?:string; staleMs?:number }
if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, 'utf8'))
else {
  const sourcePeriod=randomUUID(), nextPeriod=randomUUID()
  for (const [id,year] of [[sourcePeriod,2030],[nextPeriod,2031]] as const) {
    const period=await client.from('fiscal_periods').insert({id,company_id:fixture.company,user_id:fixture.user,
      name:String(year),period_start:`${year}-01-01`,period_end:`${year}-12-31`})
    if(period.error) throw period.error
  }
  const opening=await createJournalEntry(client,fixture.company,fixture.user,{
    fiscal_period_id:nextPeriod,entry_date:'2031-01-01',description:'Synthetic retained opening balance',
    source_type:'opening_balance',voucher_series:'IB',
    lines:[{account_number:'1930',debit_amount:100,credit_amount:0},{account_number:'2091',debit_amount:0,credit_amount:100}],
  })
  const linked=await client.from('fiscal_periods').update({opening_balance_entry_id:opening.id,opening_balances_set:true}).eq('company_id',fixture.company).eq('id',nextPeriod)
  if(linked.error) throw linked.error
  report={sourcePeriod,nextPeriod,openingEntry:opening.id}
  writeFileSync(reportPath,JSON.stringify(report,null,2))
}
async function rows() {
  const header=await client.from('journal_entries').select('*').eq('company_id',fixture.company).eq('id',report.openingEntry).single()
  const lines=await client.from('journal_entry_lines').select('*').eq('journal_entry_id',report.openingEntry).order('id')
  if(header.error || lines.error) throw header.error || lines.error
  return {header:header.data,lines:lines.data}
}
const before=await rows()
let supersedesImportId:string|undefined
if(report.job) {
  const prior=await client.from('sie_imports').select('job_state').eq('id',report.job).single()
  const target=await client.from('fiscal_periods').select('opening_balance_review_token').eq('id',report.nextPeriod).single()
  if(prior.data?.job_state==='undone' && !target.data?.opening_balance_review_token) {
    supersedesImportId=report.job
    report.job=undefined
  }
}
if(!report.job) {
  const content='#FLAGGA 0\n#PROGRAM "Manual review acceptance" 1\n#SIETYP 4\n#FNAMN "Synthetic AB"\n#RAR 0 20300101 20301231\n#KONTO 1930 "Bank"\n#KONTO 3001 "Sales"\n#VER A 1 20300201 "Test"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'
  const mappings=['1930','3001'].map(number=>({sourceAccount:number,targetAccount:number,sourceName:number,
    targetName:number,confidence:1,matchType:'exact' as const,isOverride:false}))
  const job=await submitSIEJob(client,fixture.company,fixture.user,content,mappings,{
    filename:'manual-review.se',createFiscalPeriod:false,importTransactions:true,importOpeningBalances:false,updateAccountNames:false,
    ...(supersedesImportId ? {supersedesImportId,onExistingPeriod:'replace' as const} : {}),
  })
  report.job=job.id
  writeFileSync(reportPath,JSON.stringify(report,null,2))
}
await runSIEWorker({supabase:client,importId:report.job,budgetMs:60000})
let job=(await client.from('sie_imports').select('*').eq('id',report.job).single()).data!
if(job.job_state==='completed') {
  const review=job.job_result.nextPeriodOpeningBalanceReview
  assert.equal(review.nextPeriodId,report.nextPeriod)
  assert.equal(review.openingBalanceEntryId,report.openingEntry)
  const args={p_company_id:fixture.company,p_period_id:report.nextPeriod,p_actor:fixture.user,
    p_review_token:review.reviewToken,p_expected_entry_id:report.openingEntry}
  const acknowledged=await client.rpc('acknowledge_sie_opening_balance_review',args)
  if(acknowledged.error) throw acknowledged.error
  const started=performance.now()
  const stale=await client.rpc('acknowledge_sie_opening_balance_review',args)
  report.staleMs=performance.now()-started
  assert.equal(stale.error?.code,'55000')
  assert.ok(report.staleMs<5000,'Stale response must return promptly')
  await requestSIEJobAction(client,fixture.company,fixture.user,report.job!,'undo')
  await runSIEWorker({supabase:client,importId:report.job,budgetMs:60000})
}
job=(await client.from('sie_imports').select('*').eq('id',report.job).single()).data!
assert.equal(job.job_state,'undone')
const next=(await client.from('fiscal_periods').select('*').eq('id',report.nextPeriod).single()).data!
assert.equal(next.opening_balance_review_reason,'undo')
assert.ok(next.opening_balance_review_token)
assert.equal(next.opening_balance_entry_id,report.openingEntry)
assert.deepEqual(await rows(),before)
writeFileSync(reportPath,JSON.stringify(report,null,2))
console.log(JSON.stringify({checks:'HTTP completion, acknowledgment, stale rejection, undo review renewal, unchanged next-year voucher',staleResponseMs:report.staleMs}))
}
void main().catch(error => { console.error(error); process.exitCode=1 })
