import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { z } from 'zod'

// Dry review by default. Production execution additionally requires Emil's
// approval of this exact digest in the operator's session, per AGENTS.md.
// This script never reads .env.local and never rewrites posted provenance.
const link = z.object({relationship:z.string(),record_id:z.string().nullable(),record_hash:z.string().regex(/^[a-f0-9]{64}$/)})
const reviewSchema = z.object({version:z.literal(1),reviewHash:z.string().regex(/^[a-f0-9]{64}$/),
  candidates:z.array(z.object({companyId:z.string().uuid(),periodId:z.string().uuid(),
    keep:z.object({id:z.string().uuid()}),reverse:z.object({id:z.string().uuid()}),
    contentHash:z.string().regex(/^[a-f0-9]{64}$/),keepLinks:z.array(link),reverseLinks:z.array(link)})),
  excluded:z.array(z.unknown()),treatment:z.literal('storno')})

async function main() {
  const args=process.argv.slice(2)
  const option=(name:string)=>args[args.indexOf(name)+1]
  if(!args.includes('--review')) throw new Error('Provide --review path; execution also needs --execute --approved-review-hash HASH --company UUID --actor UUID --project REF --env PATH')
  const raw=JSON.parse(readFileSync(option('--review'),'utf8'))
  const {reviewHash,...signed}=raw
  if(createHash('sha256').update(JSON.stringify(signed)).digest('hex')!==reviewHash) throw new Error('The repair review was changed after its digest was recorded')
  const review=reviewSchema.parse(raw)
  console.log(JSON.stringify({reviewHash:review.reviewHash,candidates:review.candidates.length,excluded:review.excluded.length,executing:args.includes('--execute')}))
  if(!args.includes('--execute')) return
  if(option('--approved-review-hash')!==review.reviewHash) throw new Error('Explicit approval of the exact review digest is required')
  const company=z.string().uuid().parse(option('--company')),actor=z.string().uuid().parse(option('--actor'))
  const project=z.enum(['metjnjrhvujscngnpzdv','pwxtzglxptnnvjrpixpg']).parse(option('--project'))
  if(!args.includes('--env') || option('--env').replaceAll('\\','/').split('/').at(-1)==='.env.local') throw new Error('An explicit separate repair environment file is required')
  const env=dotenv.parse(readFileSync(option('--env')))
  if(env.NEXT_PUBLIC_SUPABASE_URL!==`https://${project}.supabase.co` || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Repair target does not match the explicit project')
  const selected=review.candidates.filter(row=>row.companyId===company)
  const periods=[...new Set(selected.map(row=>row.periodId))]
  if(periods.length!==1) throw new Error('Execute exactly one reviewed company and fiscal period at a time')
  const items=selected.map(row=>({keepId:row.keep.id,reverseId:row.reverse.id,contentHash:row.contentHash,
    keepLinks:row.keepLinks,reverseLinks:row.reverseLinks}))
  if(Buffer.byteLength(JSON.stringify(items),'utf8')>900_000) throw new Error('Repair input exceeds the bounded request; split and approve separate reviews')
  const supabase=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
  if(args.includes('--stop-job')) {
    const importId=z.string().uuid().parse(option('--stop-job'))
    const reason=z.string().trim().min(10).max(2000).parse(option('--reason'))
    const stopped=await supabase.rpc('stop_sie_duplicate_repair',{p_company_id:company,p_import_id:importId,
      p_actor:actor,p_review_hash:review.reviewHash,p_reason:reason})
    if(stopped.error) throw new Error(stopped.error.message)
    console.log(JSON.stringify({jobId:importId,state:stopped.data.job_state,result:stopped.data.job_result}))
    return
  }
  const staged=await supabase.rpc('stage_sie_duplicate_repair',{p_company_id:company,p_actor:actor,
    p_period_id:periods[0],p_review_hash:review.reviewHash,p_items:items})
  if(staged.error) throw new Error(staged.error.message)
  console.log(JSON.stringify({jobId:staged.data.id,companyId:company,state:staged.data.job_state}))
  // The same lease, engine facade and cron recovery as an ordinary import.
  const {runSIEWorker}=await import('../../lib/import/sie-job-worker')
  await runSIEWorker({supabase,importId:staged.data.id,budgetMs:220_000})
  const current=await supabase.from('sie_imports').select('id,job_state,chunks_done,chunks_total,error_message')
    .eq('company_id',company).eq('id',staged.data.id).single()
  if(current.error) throw new Error(current.error.message)
  console.log(JSON.stringify(current.data))
  if(current.data.error_message) process.exitCode=1
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Repair failed');process.exitCode=1})
